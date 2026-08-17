import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { serializePlatformError } from './platform-rpc.mjs';
import { WakeServer } from './ws-link.mjs';

const ACKNOWLEDGED_PRUNE_INTERVAL_MS = 60_000;

export class ReceptionService extends EventEmitter {
  constructor({
    bus,
    host = '127.0.0.1',
    port,
    token,
    adapters = {},
    instanceId = `reception-${randomUUID()}`,
    pollIntervalMs = 1_000,
    leaseTtlMs = 10_000,
    leaseRenewMs = 3_000,
    retryDelayMs = 1_000,
    pruneIntervalMs = ACKNOWLEDGED_PRUNE_INTERVAL_MS,
    onLog = null,
  } = {}) {
    super();
    if (!bus) throw new Error('ReceptionService bus is required');
    this.bus = bus;
    this.instanceId = instanceId;
    this.adapters = new Map(Object.entries(adapters));
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 1_000);
    this.leaseTtlMs = Math.max(1_000, Number(leaseTtlMs) || 10_000);
    this.leaseRenewMs = Math.max(250, Math.min(
      Number(leaseRenewMs) || 3_000,
      Math.floor(this.leaseTtlMs / 2),
    ));
    this.retryDelayMs = Math.max(100, Number(retryDelayMs) || 1_000);
    this.pruneIntervalMs = Math.max(
      50,
      Number(pruneIntervalMs) || ACKNOWLEDGED_PRUNE_INTERVAL_MS,
    );
    this.onLog = onLog;
    this.lease = null;
    this.running = false;
    this.pollTimer = null;
    this.leaseTimer = null;
    this.pruneTimer = null;
    this.drainPromise = null;
    this.drainAgain = false;
    this.server = new WakeServer({
      host,
      port,
      token,
      allowedRoles: ['workbench', 'ingress'],
      onWake: (frame) => {
        if (frame?.recipient === 'workbench') {
          this.server.wake('workbench', frame);
          return;
        }
        this.requestDrain();
      },
      onError: (error) => this.log('reception-link-error', { error: error.message }),
    });
  }

  async start() {
    if (this.running) return this.status();
    this.lease = this.bus.acquireLease('reception', this.instanceId, {
      ttlMs: this.leaseTtlMs,
    });
    if (!this.lease) {
      const owner = this.bus.lease('reception');
      throw new Error(`reception lease is held by ${owner?.ownerId || 'another instance'}`);
    }
    try {
      const address = await this.server.start();
      this.running = true;
      this.emit('listening', address);
      this.pollTimer = setInterval(() => this.requestDrain(), this.pollIntervalMs);
      this.pollTimer.unref?.();
      this.leaseTimer = setInterval(() => this.renewLease(), this.leaseRenewMs);
      this.leaseTimer.unref?.();
      this.pruneTimer = setInterval(
        () => this.pruneAcknowledgedMessages(),
        this.pruneIntervalMs,
      );
      this.pruneTimer.unref?.();
      for (const adapter of this.adapters.values()) {
        await adapter.start?.();
      }
      this.requestDrain();
      await this.log('reception-started', {
        instanceId: this.instanceId,
        address,
        adapters: [...this.adapters.keys()],
      });
      return this.status();
    } catch (error) {
      this.running = false;
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      if (this.pruneTimer) clearInterval(this.pruneTimer);
      this.pollTimer = null;
      this.leaseTimer = null;
      this.pruneTimer = null;
      for (const adapter of this.adapters.values()) {
        await adapter.stop?.().catch(() => {});
      }
      this.bus.releaseLease(this.lease);
      this.lease = null;
      await this.server.stop().catch(() => {});
      throw error;
    }
  }

  async submitInbound({
    jobId,
    event,
    reply,
    options = {},
    messageId = '',
    kind = 'job.requested',
    platform = '',
    teamId = '',
    eventId = '',
  }) {
    const normalizedJobId = String(jobId || event?.id || '').trim();
    if (!normalizedJobId) throw new Error('inbound jobId is required');
    if (!event || typeof event !== 'object') throw new Error('inbound event is required');
    const messageKind = String(kind || 'job.requested');
    const resolvedPlatform = String(
      platform || reply?.platform || event?.platform || '',
    ).trim();
    if (!resolvedPlatform) throw new Error('inbound platform is required');
    const payload = messageKind === 'platform.event'
      ? {
          platform: resolvedPlatform,
          event,
          teamId: String(teamId || ''),
          eventId: String(eventId || ''),
        }
      : {
          event,
          reply: {
            ...reply,
            platform: resolvedPlatform,
          },
          options,
        };
    const durable = this.bus.publish({
      messageId: messageId || `inbound:${resolvedPlatform}:${normalizedJobId}`,
      sender: 'reception',
      recipient: 'workbench',
      jobId: normalizedJobId,
      kind: messageKind,
      payload,
    });
    const websocketPeers = this.server.wake('workbench', {
      recipient: 'workbench',
      rowId: durable.rowId,
      messageId: durable.messageId,
    });
    await this.log('reception-inbound-persisted', {
      jobId: normalizedJobId,
      rowId: durable.rowId,
      inserted: durable.inserted,
      websocketPeers,
    });
    return {
      ...durable,
      websocketPeers,
    };
  }

  requestDrain() {
    if (!this.running) return Promise.resolve();
    if (this.drainPromise) {
      this.drainAgain = true;
      return this.drainPromise;
    }
    this.drainPromise = this.drain()
      .catch((error) => this.log('reception-drain-error', { error: error.message }))
      .finally(() => {
        this.drainPromise = null;
        if (this.drainAgain) {
          this.drainAgain = false;
          this.requestDrain();
        }
      });
    return this.drainPromise;
  }

  async drain() {
    do {
      if (!this.bus.ownsLease(this.lease)) {
        this.renewLease();
        return;
      }
      const messages = this.bus.pending('reception', { limit: 500 });
      if (messages.length === 0) return;
      const blockedJobs = new Set();
      let acknowledged = 0;

      for (const message of messages) {
        if (blockedJobs.has(message.jobId)) continue;
        try {
          await this.deliver(message);
          if (!this.bus.ownsLease(this.lease)) return;
          this.bus.acknowledge(message.rowId, this.instanceId);
          acknowledged += 1;
        } catch (error) {
          blockedJobs.add(message.jobId);
          const backoff = retryBackoff(
            this.retryDelayMs,
            message.deliveryAttempts,
          );
          this.bus.defer(message.rowId, error, { delayMs: backoff });
          await this.log('reception-delivery-deferred', {
            jobId: message.jobId,
            rowId: message.rowId,
            attempt: message.deliveryAttempts + 1,
            retryInMs: backoff,
            error: error.message || String(error),
          });
        }
      }

      if (acknowledged === 0) return;
    } while (this.running);
  }

  async deliver(message) {
    if (message.kind === 'platform.request') {
      await this.deliverPlatformRequest(message);
      return;
    }
    if (message.kind !== 'outbound.message') {
      throw new Error(`unsupported reception message kind: ${message.kind}`);
    }
    const platform = String(message.payload?.platform || '').trim();
    const adapter = this.adapters.get(platform);
    if (!adapter?.deliver) {
      throw new Error(`no reception delivery adapter for platform: ${platform || '(empty)'}`);
    }
    const content = String(message.payload?.content ?? '');
    if (!content.trim()) throw new Error('outbound message content is empty');
    await adapter.deliver({
      ...message.payload,
      deliveryKey: message.messageId,
      sequence: message.sequence,
      jobId: message.jobId,
    });
    await this.log('reception-delivered', {
      jobId: message.jobId,
      rowId: message.rowId,
      platform,
      purpose: message.payload?.purpose || null,
    });
  }

  async deliverPlatformRequest(message) {
    const platform = String(message.payload?.platform || '').trim();
    const method = String(message.payload?.method || '').trim();
    const requestId = String(
      message.payload?.requestId || message.jobId || '',
    ).trim();
    const responseRecipient = String(
      message.payload?.responseRecipient || '',
    ).trim();
    if (!requestId || !responseRecipient || !platform || !method) {
      throw new Error('invalid platform request envelope');
    }
    const adapter = this.adapters.get(platform);
    let response;
    try {
      if (!adapter?.invoke) {
        throw new Error(`no ${platform} platform RPC adapter is available`);
      }
      const result = await adapter.invoke(
        method,
        Array.isArray(message.payload?.args) ? message.payload.args : [],
      );
      response = { requestId, ok: true, result: result ?? null };
    } catch (error) {
      response = {
        requestId,
        ok: false,
        error: serializePlatformError(error),
      };
    }
    const durable = this.bus.publish({
      messageId: `platform-response:${requestId}`,
      sender: 'reception',
      recipient: responseRecipient,
      jobId: requestId,
      kind: 'platform.response',
      payload: response,
    });
    this.server.wake('workbench', {
      recipient: responseRecipient,
      rowId: durable.rowId,
      messageId: durable.messageId,
      requestId,
    });
    await this.log('reception-platform-request-completed', {
      requestId,
      platform,
      method,
      ok: response.ok,
    });
  }

  async pruneAcknowledgedMessages() {
    try {
      const deleted = this.bus.pruneAcknowledged();
      if (deleted > 0) {
        await this.log('reception-acknowledged-messages-pruned', { deleted });
      }
    } catch (error) {
      await this.log('reception-message-prune-failed', {
        error: error.message,
      });
    }
  }

  renewLease() {
    if (!this.running || !this.lease) return;
    const renewed = this.bus.renewLease(this.lease, {
      ttlMs: this.leaseTtlMs,
    });
    if (renewed) {
      this.lease = renewed;
      return;
    }
    this.log('reception-lease-lost', {
      instanceId: this.instanceId,
      epoch: this.lease.epoch,
    }).catch(() => {});
    this.emit('lease.lost', this.lease);
    this.stop({ releaseLease: false }).catch(() => {});
  }

  status() {
    return {
      running: this.running,
      instanceId: this.instanceId,
      lease: this.lease,
      address: this.server.address(),
      workbenchConnected: this.server.connected('workbench'),
      pendingOutbound: this.bus.pendingCount('reception'),
    };
  }

  async stop({ releaseLease = true } = {}) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pollTimer = null;
    this.leaseTimer = null;
    this.pruneTimer = null;
    this.running = false;
    for (const adapter of this.adapters.values()) {
      await adapter.stop?.().catch((error) =>
        this.log('reception-adapter-stop-error', { error: error.message }),
      );
    }
    await this.server.stop();
    if (this.drainPromise) await this.drainPromise.catch(() => {});
    if (releaseLease && this.lease) this.bus.releaseLease(this.lease);
    this.lease = null;
    await this.log('reception-stopped', { instanceId: this.instanceId });
  }

  async log(type, payload = {}) {
    this.emit('log', type, payload);
    await this.onLog?.(type, payload);
  }
}

function retryBackoff(baseMs, previousAttempts) {
  return Math.min(60_000, Math.round(baseMs * (2 ** Math.min(previousAttempts, 6))));
}
