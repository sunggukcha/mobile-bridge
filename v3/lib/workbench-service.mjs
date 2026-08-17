import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createJobSpec } from './job-spec.mjs';
import { WakeClient, WakeServer } from './ws-link.mjs';

export class WorkbenchService extends EventEmitter {
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
    instanceId = `workbench-${randomUUID()}`,
    pollIntervalMs = 1_000,
    reconnectMinMs = 200,
    reconnectMaxMs = 5_000,
    leaseTtlMs = 10_000,
    leaseRenewMs = 3_000,
    maxConcurrentJobs = null,
    ignoreBefore = new Date(),
    launchGraceMs = 5_000,
    workerHeartbeatMs = 3_000,
    workerLauncher = null,
    onLog = null,
  } = {}) {
    super();
    if (!bus) throw new Error('WorkbenchService bus is required');
    if (!bridgeConfig) throw new Error('WorkbenchService bridgeConfig is required');
    if (!repoRoot || !dbPath || !token || !receptionUrl || !workerLogRoot) {
      throw new Error('WorkbenchService runtime paths, token, and receptionUrl are required');
    }
    this.bus = bus;
    this.bridgeConfig = bridgeConfig;
    this.repoRoot = path.resolve(repoRoot);
    this.dbPath = path.resolve(dbPath);
    this.token = token;
    this.receptionUrl = receptionUrl;
    this.workerLogRoot = path.resolve(workerLogRoot);
    this.workerMode = workerMode;
    this.instanceId = instanceId;
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 1_000);
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.leaseTtlMs = Math.max(1_000, Number(leaseTtlMs) || 10_000);
    this.leaseRenewMs = Math.max(250, Math.min(
      Number(leaseRenewMs) || 3_000,
      Math.floor(this.leaseTtlMs / 2),
    ));
    const configuredConcurrency = maxConcurrentJobs
      ?? bridgeConfig.queue?.maxConcurrentJobs
      ?? 0;
    this.maxConcurrentJobs = Number(configuredConcurrency) > 0
      ? Number(configuredConcurrency)
      : Number.POSITIVE_INFINITY;
    this.ignoreBefore = ignoreBefore;
    this.launchGraceMs = Math.max(250, Number(launchGraceMs) || 5_000);
    this.workerHeartbeatMs = Math.max(250, Number(workerHeartbeatMs) || 3_000);
    this.workerLauncher = workerLauncher;
    this.onLog = onLog;
    this.running = false;
    this.lease = null;
    this.pollTimer = null;
    this.leaseTimer = null;
    this.drainPromise = null;
    this.drainAgain = false;
    this.schedulePromise = null;
    this.workerServer = new WakeServer({
      host: workerHost,
      port: workerPort,
      token,
      allowedRoles: ['worker'],
      onWake: () => this.requestDrain(),
      onError: (error) => this.log('workbench-worker-link-error', { error: error.message }),
    });
    this.receptionClient = new WakeClient({
      url: receptionUrl,
      token,
      role: 'workbench',
      instanceId,
      reconnectMinMs,
      reconnectMaxMs,
      onWake: () => this.requestDrain(),
      onError: (error) => this.log('workbench-reception-link-error', { error: error.message }),
    });
    this.receptionClient.on('connected', () => {
      this.receptionClient.wake({
        recipient: 'reception',
        pending: this.bus.pendingCount('reception'),
      });
      this.requestDrain();
    });
  }

  async start() {
    if (this.running) return this.status();
    this.lease = this.bus.acquireLease('workbench', this.instanceId, {
      ttlMs: this.leaseTtlMs,
    });
    if (!this.lease) {
      const owner = this.bus.lease('workbench');
      throw new Error(`workbench lease is held by ${owner?.ownerId || 'another instance'}`);
    }
    try {
      await this.workerServer.start();
      this.running = true;
      this.receptionClient.start();
      this.pollTimer = setInterval(() => {
        this.requestDrain();
        this.requestSchedule();
      }, this.pollIntervalMs);
      this.pollTimer.unref?.();
      this.leaseTimer = setInterval(() => this.renewLease(), this.leaseRenewMs);
      this.leaseTimer.unref?.();
      await this.reconcileLaunchingJobs();
      this.requestDrain();
      this.requestSchedule();
      await this.log('workbench-started', this.status());
      return this.status();
    } catch (error) {
      this.running = false;
      this.receptionClient.stop();
      await this.workerServer.stop().catch(() => {});
      this.bus.releaseLease(this.lease);
      this.lease = null;
      throw error;
    }
  }

  requestDrain() {
    if (!this.running) return Promise.resolve();
    if (this.drainPromise) {
      this.drainAgain = true;
      return this.drainPromise;
    }
    this.drainPromise = this.drain()
      .catch((error) => this.log('workbench-drain-error', { error: error.message }))
      .finally(() => {
        this.drainPromise = null;
        this.requestSchedule();
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
      const messages = this.bus.pending('workbench', { limit: 500 });
      if (messages.length === 0) return;
      const blockedJobs = new Set();
      let acknowledged = 0;

      for (const message of messages) {
        if (blockedJobs.has(message.jobId)) continue;
        try {
          await this.consume(message);
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
          await this.log('workbench-message-deferred', {
            rowId: message.rowId,
            jobId: message.jobId,
            kind: message.kind,
            retryInMs,
            error: error.message || String(error),
          });
        }
      }

      if (acknowledged === 0) return;
    } while (this.running);
  }

  async consume(message) {
    if (message.kind === 'job.requested') {
      await this.acceptJob(message);
      return;
    }
    if (message.kind.startsWith('worker.')) {
      await this.forwardWorkerMessage(message);
      return;
    }
    throw new Error(`unsupported workbench message kind: ${message.kind}`);
  }

  async acceptJob(message) {
    const existing = this.bus.getJob(message.jobId);
    if (existing) return;
    const spec = await createJobSpec({
      bridgeConfig: this.bridgeConfig,
      inbound: message.payload,
      ignoreBefore: this.ignoreBefore,
      workerMode: this.workerMode,
    });
    const job = this.bus.createJob({
      jobId: message.jobId,
      inboundMessageId: message.messageId,
      channelId: spec.job.channelId,
      threadId: spec.job.threadId,
      concurrencyKey: spec.job.concurrencyKey,
      priority: spec.job.priority,
      spec,
      createdAt: spec.job.event.timestamp,
    });
    await this.log('workbench-job-accepted', {
      jobId: job.jobId,
      inserted: job.inserted,
      channelId: job.channelId,
      threadId: job.threadId,
    });
  }

  async forwardWorkerMessage(message) {
    const job = this.bus.getJob(message.jobId);
    if (!job) throw new Error(`worker event has no job record: ${message.jobId}`);
    const outbound = outboundFromWorkerMessage(message, job.spec);
    if (!outbound) return;
    const durable = this.bus.publish({
      messageId: `forwarded:${message.messageId}`,
      sender: 'workbench',
      recipient: 'reception',
      jobId: message.jobId,
      kind: 'outbound.message',
      payload: outbound,
    });
    const websocketSent = this.receptionClient.wake({
      recipient: 'reception',
      rowId: durable.rowId,
      messageId: durable.messageId,
    });
    await this.log('workbench-worker-message-forwarded', {
      jobId: message.jobId,
      workerSequence: message.sequence,
      rowId: durable.rowId,
      purpose: outbound.purpose,
      websocketSent,
    });
  }

  requestSchedule() {
    if (!this.running) return Promise.resolve();
    if (this.schedulePromise) return this.schedulePromise;
    this.schedulePromise = this.schedule()
      .catch((error) => this.log('workbench-schedule-error', { error: error.message }))
      .finally(() => {
        this.schedulePromise = null;
      });
    return this.schedulePromise;
  }

  async schedule() {
    if (!this.bus.ownsLease(this.lease)) {
      this.renewLease();
      return;
    }
    const active = this.bus.activeJobs();
    let capacity = this.maxConcurrentJobs === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.maxConcurrentJobs - active.length);
    if (capacity === 0) return;
    const blocked = new Set(active.map((job) => job.concurrencyKey));

    for (const job of this.bus.queuedJobs()) {
      if (!this.running || capacity === 0) break;
      if (!this.bus.ownsLease(this.lease)) {
        this.renewLease();
        return;
      }
      if (blocked.has(job.concurrencyKey)) continue;
      if (!this.bus.reserveLaunch(job.jobId, { launcherId: this.instanceId })) continue;
      blocked.add(job.concurrencyKey);
      try {
        const launched = await this.launchWorker(job);
        this.bus.recordSpawn(job.jobId, {
          launcherId: this.instanceId,
          pid: launched.pid,
        });
        await this.log('workbench-worker-launched', {
          jobId: job.jobId,
          pid: launched.pid,
          logPath: launched.logPath || null,
        });
      } catch (error) {
        this.bus.releaseLaunch(job.jobId, {
          launcherId: this.instanceId,
          error,
        });
        blocked.delete(job.concurrencyKey);
        await this.log('workbench-worker-launch-failed', {
          jobId: job.jobId,
          error: error.message || String(error),
        });
        continue;
      }
      if (capacity !== Number.POSITIVE_INFINITY) capacity -= 1;
    }
  }

  async launchWorker(job) {
    const workerUrl = this.workerServer.address()?.url;
    if (!workerUrl) throw new Error('worker WebSocket server is not listening');
    if (this.workerLauncher) {
      return this.workerLauncher({
        job,
        dbPath: this.dbPath,
        workbenchUrl: workerUrl,
        token: this.token,
      });
    }

    fs.mkdirSync(this.workerLogRoot, { recursive: true });
    const logPath = path.join(
      this.workerLogRoot,
      `${safeFilePart(job.jobId)}-${Date.now()}.log`,
    );
    const logDescriptor = fs.openSync(logPath, 'a', 0o600);
    const workerScript = path.join(this.repoRoot, 'v3', 'worker.mjs');
    const child = spawn(process.execPath, [
      workerScript,
      '--job',
      job.jobId,
    ], {
      cwd: this.repoRoot,
      detached: true,
      stdio: ['ignore', logDescriptor, logDescriptor],
      env: {
        ...process.env,
        BRIDGE_STATE_ROOT: this.bridgeConfig.stateRoot,
        PROJECT_ROOT: this.bridgeConfig.projectRoot,
        V3_STATE_ROOT: path.dirname(this.dbPath),
        V3_DB_PATH: this.dbPath,
        V3_INTERNAL_TOKEN: this.token,
        V3_WORKBENCH_URL: workerUrl,
        V3_WORKER_HEARTBEAT_MS: String(this.workerHeartbeatMs),
      },
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } finally {
      fs.closeSync(logDescriptor);
    }
    child.unref();
    return { pid: child.pid, logPath };
  }

  async reconcileLaunchingJobs() {
    const now = Date.now();
    for (const job of this.bus.activeJobs()) {
      if (job.status !== 'launching') continue;
      const updatedAtMs = Date.parse(job.updatedAt || '');
      if (Number.isFinite(updatedAtMs) && now - updatedAtMs < this.launchGraceMs) continue;
      if (job.lastSpawnPid && isPidAlive(job.lastSpawnPid)) continue;
      if (this.bus.requeueOrphanedLaunch(job.jobId)) {
        await this.log('workbench-orphaned-launch-requeued', {
          jobId: job.jobId,
          lastSpawnPid: job.lastSpawnPid,
        });
      }
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
    this.log('workbench-lease-lost', {
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
      workerAddress: this.workerServer.address(),
      receptionConnected: this.receptionClient.connected(),
      activeJobs: this.bus.activeJobs().length,
      queuedJobs: this.bus.queuedJobs().length,
      pendingWork: this.bus.pendingCount('workbench'),
    };
  }

  async stop({ releaseLease = true } = {}) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.pollTimer = null;
    this.leaseTimer = null;
    this.running = false;
    this.receptionClient.stop();
    await this.workerServer.stop();
    if (this.drainPromise) await this.drainPromise.catch(() => {});
    if (this.schedulePromise) await this.schedulePromise.catch(() => {});
    if (releaseLease && this.lease) this.bus.releaseLease(this.lease);
    this.lease = null;
    await this.log('workbench-stopped', {
      instanceId: this.instanceId,
      activeWorkersLeftRunning: this.bus.activeJobs().length,
    });
  }

  async log(type, payload = {}) {
    this.emit('log', type, payload);
    await this.onLog?.(type, payload);
  }
}

function outboundFromWorkerMessage(message, spec) {
  const base = {
    ...spec.reply,
    sourceMessageId: message.messageId,
    workerSequence: message.sequence,
  };
  if (message.kind === 'worker.started') {
    const worker = message.payload?.workerInfo || {};
    const label = String(worker.workerLabel || worker.label || worker.worker || 'worker');
    return {
      ...base,
      content: `${label} 작업을 시작했습니다.`,
      purpose: 'job-progress',
    };
  }
  if (message.kind === 'worker.progress') {
    const content = String(message.payload?.content || '').trim();
    return content ? { ...base, content, purpose: 'worker-progress' } : null;
  }
  if (message.kind === 'worker.completed') {
    return {
      ...base,
      content: String(message.payload?.output || '작업 결과 본문이 제공되지 않았습니다.'),
      purpose: 'job-final',
    };
  }
  if (message.kind === 'worker.failed') {
    return {
      ...base,
      content: [
        '작업 실패',
        String(message.payload?.error || '알 수 없는 worker 오류'),
      ].join('\n'),
      purpose: 'job-failed',
    };
  }
  return null;
}

function safeFilePart(value) {
  return String(value || 'job').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'job';
}

function isPidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
