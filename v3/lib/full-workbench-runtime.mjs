import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DetachedWorkerBroker,
  detachedWorkerExecutionId,
} from './detached-worker-broker.mjs';
import { WakeClient } from './ws-link.mjs';

export class FullWorkbenchRuntime extends EventEmitter {
  constructor({
    bus,
    bridgeConfig,
    repoRoot,
    dbPath,
    token,
    receptionUrl,
    workerHost = '127.0.0.1',
    workerPort,
    workerLogRoot,
    workerMode = 'agent',
    instanceId = `full-workbench-${randomUUID()}`,
    pollIntervalMs = 250,
    reconnectMinMs = 200,
    reconnectMaxMs = 5_000,
    leaseTtlMs = 10_000,
    leaseRenewMs = 3_000,
    workerHeartbeatMs = 3_000,
    onInbound,
    onLog = null,
  } = {}) {
    super();
    if (!bus || !bridgeConfig || !token || !receptionUrl) {
      throw new Error('FullWorkbenchRuntime configuration is incomplete');
    }
    if (typeof onInbound !== 'function') {
      throw new Error('FullWorkbenchRuntime requires onInbound');
    }
    this.bus = bus;
    this.instanceId = instanceId;
    this.onInbound = onInbound;
    this.onLog = onLog;
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 250);
    this.leaseTtlMs = Math.max(1_000, Number(leaseTtlMs) || 10_000);
    this.leaseRenewMs = Math.max(
      250,
      Math.min(
        Number(leaseRenewMs) || 3_000,
        Math.floor(this.leaseTtlMs / 2),
      ),
    );
    this.running = false;
    this.paused = true;
    this.lease = null;
    this.pollTimer = null;
    this.leaseTimer = null;
    this.drainPromise = null;
    this.drainAgain = false;
    this.admissionWaiters = new Set();
    this.stopResolve = null;
    this.stopped = new Promise((resolve) => {
      this.stopResolve = resolve;
    });
    this.receptionClient = new WakeClient({
      url: receptionUrl,
      token,
      role: 'workbench',
      instanceId,
      reconnectMinMs,
      reconnectMaxMs,
      onWake: () => this.requestDrain(),
      onError: (error) => this.log('full-workbench-reception-link-error', {
        error: error.message,
      }),
    });
    this.receptionClient.on('connected', () => {
      this.receptionClient.wake({
        recipient: 'reception',
        pending: this.bus.pendingCount('reception'),
      });
      this.requestDrain();
    });
    this.broker = new DetachedWorkerBroker({
      bus,
      bridgeConfig,
      repoRoot,
      dbPath,
      token,
      host: workerHost,
      port: workerPort,
      workerLogRoot,
      workerMode,
      instanceId: `${instanceId}:broker`,
      pollIntervalMs: this.pollIntervalMs,
      workerHeartbeatMs,
      onLog: (type, payload) => this.log(type, payload),
    });
    this.broker.on('drain.requested', () => this.requestDrain());
  }

  async start({ paused = true } = {}) {
    if (this.running) return this.status();
    this.lease = this.bus.acquireLease('workbench', this.instanceId, {
      ttlMs: this.leaseTtlMs,
    });
    if (!this.lease) {
      const owner = this.bus.lease('workbench');
      throw new Error(
        `workbench lease is held by ${owner?.ownerId || 'another instance'}`,
      );
    }
    try {
      await this.broker.start();
      this.running = true;
      this.paused = Boolean(paused);
      this.receptionClient.start();
      this.pollTimer = setInterval(
        () => this.requestDrain(),
        this.pollIntervalMs,
      );
      this.pollTimer.unref?.();
      this.leaseTimer = setInterval(
        () => this.renewLease(),
        this.leaseRenewMs,
      );
      this.leaseTimer.unref?.();
      this.requestDrain();
      await this.log('full-workbench-started', this.status());
      return this.status();
    } catch (error) {
      await this.broker.stop().catch(() => {});
      this.bus.releaseLease(this.lease);
      this.lease = null;
      throw error;
    }
  }

  resume() {
    this.paused = false;
    for (const waiter of [...this.admissionWaiters]) waiter.resolve();
    this.requestDrain();
  }

  pause() {
    this.paused = true;
  }

  async executeAgentJob(options = {}) {
    if (
      this.paused
      && !this.hasDurableWorker(options.job)
    ) {
      await this.waitForAdmission(options.signal);
    }
    return this.broker.execute(options);
  }

  waitForAdmission(signal = null) {
    if (!this.running) {
      return Promise.reject(workbenchStoppedError());
    }
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.admissionWaiters.delete(waiter);
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener);
        }
        callback(value);
      };
      const waiter = {
        resolve: () => finish(resolve),
        reject: (error) => finish(reject, error),
      };
      const abortListener = signal
        ? () => waiter.reject(workerAbortError(signal.reason))
        : null;
      this.admissionWaiters.add(waiter);
      if (signal && abortListener) {
        signal.addEventListener('abort', abortListener, { once: true });
      }
      if (!this.running) waiter.reject(workbenchStoppedError());
      else if (!this.paused) waiter.resolve();
      else if (signal?.aborted) abortListener();
    });
  }

  hasDurableWorker(job) {
    const executionId = detachedWorkerExecutionId(
      typeof job === 'object' ? job : { id: job },
    );
    return Boolean(executionId && this.bus.getJob(executionId));
  }

  durableWorker(job) {
    const executionId = detachedWorkerExecutionId(
      typeof job === 'object' ? job : { id: job },
    );
    return executionId ? this.bus.getJob(executionId) : null;
  }

  requestDrain() {
    if (!this.running) return Promise.resolve();
    if (this.drainPromise) {
      this.drainAgain = true;
      return this.drainPromise;
    }
    this.drainPromise = this.drain()
      .catch((error) => this.log('full-workbench-drain-error', {
        error: error.message,
      }))
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
    if (!this.bus.ownsLease(this.lease)) {
      this.renewLease();
      return;
    }
    for (;;) {
      const messages = this.bus.pending('workbench', { limit: 500 });
      if (messages.length === 0) return;
      let acknowledged = 0;
      const blockedJobs = new Set();
      for (const message of messages) {
        if (blockedJobs.has(message.jobId)) continue;
        try {
          const consumed = await this.consume(message);
          if (!consumed) {
            blockedJobs.add(message.jobId);
            continue;
          }
          if (!this.bus.ownsLease(this.lease)) return;
          this.bus.acknowledge(message.rowId, this.instanceId);
          acknowledged += 1;
        } catch (error) {
          blockedJobs.add(message.jobId);
          const retryInMs = Math.min(
            30_000,
            500 * (2 ** Math.min(message.deliveryAttempts, 6)),
          );
          this.bus.defer(message.rowId, error, { delayMs: retryInMs });
          await this.log('full-workbench-message-deferred', {
            rowId: message.rowId,
            jobId: message.jobId,
            kind: message.kind,
            retryInMs,
            error: error.message,
          });
        }
      }
      if (acknowledged === 0) return;
    }
  }

  async consume(message) {
    if (String(message.kind || '').startsWith('worker.')) {
      return this.broker.consume(message);
    }
    if (message.kind === 'platform.event' || message.kind === 'job.requested') {
      if (this.paused) return false;
      await this.onInbound(message.payload, message);
      return true;
    }
    throw new Error(`unsupported full Workbench message: ${message.kind}`);
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
    this.log('full-workbench-lease-lost', {
      instanceId: this.instanceId,
      epoch: this.lease.epoch,
    }).catch(() => {});
    this.emit('lease.lost', this.lease);
    this.stop({ releaseLease: false }).catch(() => {});
  }

  status() {
    return {
      running: this.running,
      paused: this.paused,
      instanceId: this.instanceId,
      lease: this.lease,
      receptionConnected: this.receptionClient.connected(),
      pendingWork: this.bus.pendingCount('workbench'),
      broker: this.broker.status(),
    };
  }

  waitUntilStopped() {
    return this.stopped;
  }

  releaseLeaseOnExit() {
    if (!this.lease) return false;
    const released = this.bus.releaseLease(this.lease);
    this.lease = null;
    return released;
  }

  async stop({ releaseLease = true } = {}) {
    if (!this.running) return;
    this.running = false;
    this.paused = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.pollTimer = null;
    this.leaseTimer = null;
    this.receptionClient.stop();
    const stoppedError = workbenchStoppedError();
    for (const waiter of [...this.admissionWaiters]) {
      waiter.reject(stoppedError);
    }
    await this.broker.stop();
    if (this.drainPromise) await this.drainPromise.catch(() => {});
    if (releaseLease) this.releaseLeaseOnExit();
    else this.lease = null;
    this.stopResolve?.();
    await this.log('full-workbench-stopped', {
      instanceId: this.instanceId,
      activeWorkersLeftRunning: this.bus.activeJobs().length,
    });
  }

  async log(type, payload = {}) {
    this.emit('log', type, payload);
    await this.onLog?.(type, payload);
  }
}

function workbenchStoppedError() {
  const error = new Error(
    'Workbench stopped before Worker admission was enabled',
  );
  error.serviceShutdown = true;
  return error;
}

function workerAbortError(reason) {
  const abortReason = String(reason || 'job cancelled before Worker admission');
  const error = new Error(abortReason);
  error.aborted = true;
  error.abortReason = abortReason;
  return error;
}
