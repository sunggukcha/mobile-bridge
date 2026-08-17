import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WakeServer } from './ws-link.mjs';

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'lost',
]);

export class DetachedWorkerBroker extends EventEmitter {
  constructor({
    bus,
    bridgeConfig,
    repoRoot,
    dbPath,
    token,
    host = '127.0.0.1',
    port,
    workerLogRoot,
    workerMode = 'agent',
    instanceId = `worker-broker-${randomUUID()}`,
    pollIntervalMs = 250,
    workerHeartbeatMs = 3_000,
    launchGraceMs = 5_000,
    maxWorkerLaunchAttempts = 3,
    workerLostAfterMs = null,
    // A terminal job's `worker.*` messages are still owed to the Workbench
    // until it reattaches and replays them, which happens seconds after a
    // restart. Only a run older than this can safely be treated as abandoned.
    orphanMessageMinAgeMs = 30 * 60_000,
    onLog = null,
  } = {}) {
    super();
    if (
      !bus
      || !bridgeConfig
      || !repoRoot
      || !dbPath
      || !token
      || !workerLogRoot
    ) {
      throw new Error('DetachedWorkerBroker runtime configuration is incomplete');
    }
    this.bus = bus;
    this.bridgeConfig = bridgeConfig;
    this.repoRoot = path.resolve(repoRoot);
    this.dbPath = path.resolve(dbPath);
    this.token = token;
    this.workerLogRoot = path.resolve(workerLogRoot);
    this.workerMode = workerMode;
    this.instanceId = instanceId;
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 250);
    this.workerHeartbeatMs = Math.max(
      250,
      Number(workerHeartbeatMs) || 3_000,
    );
    this.launchGraceMs = Math.max(250, Number(launchGraceMs) || 5_000);
    this.launchHardTimeoutMs = Math.max(30_000, this.launchGraceMs * 6);
    this.maxWorkerLaunchAttempts = Math.max(
      1,
      Number(maxWorkerLaunchAttempts) || 3,
    );
    this.workerLostAfterMs = Math.max(
      2_000,
      Number(workerLostAfterMs) || this.workerHeartbeatMs * 4,
    );
    this.workerHardLostAfterMs = Math.max(
      120_000,
      this.workerLostAfterMs * 12,
    );
    this.orphanMessageMinAgeMs = Math.max(0, Number(orphanMessageMinAgeMs) || 0);
    this.onLog = onLog;
    this.running = false;
    this.pollTimer = null;
    this.drainRequest = null;
    this.waiters = new Map();
    this.server = new WakeServer({
      host,
      port,
      token,
      allowedRoles: ['worker'],
      onWake: () => this.requestDrain(),
      onError: (error) => this.log('worker-broker-link-error', {
        error: error.message,
      }),
    });
  }

  async start() {
    if (this.running) return this.status();
    const address = await this.server.start();
    this.running = true;
    this.pollTimer = setInterval(() => {
      this.requestDrain();
      this.reconcileWorkerLiveness();
      this.reconcileWaiters();
      this.reconcileLaunchingJobs().catch((error) => {
        this.log('worker-broker-launch-reconcile-failed', {
          error: error.message,
        }).catch(() => {});
      });
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
    await this.reconcileLaunchingJobs();
    await this.sweepOrphanWorkerMessages().catch((error) => {
      this.log('worker-broker-orphan-sweep-failed', {
        error: error.message,
      }).catch(() => {});
    });
    this.requestDrain();
    await this.log('worker-broker-started', {
      instanceId: this.instanceId,
      address,
    });
    return this.status();
  }

  async execute({
    config: _config,
    job,
    prompt,
    search = false,
    onUpdate = null,
    onWorkerStart = null,
    signal = null,
  } = {}) {
    if (!this.running) await this.start();
    const legacyJobId = String(job?.id || '').trim();
    if (!legacyJobId) throw new Error('detached Worker requires job.id');
    const jobId = detachedWorkerExecutionId(job);
    if (this.waiters.has(jobId)) {
      throw new Error(`detached Worker job is already attached: ${jobId}`);
    }
    let stored = this.bus.getJob(jobId);
    if (!stored) {
      stored = this.bus.createJob({
        jobId,
        inboundMessageId: `worker-execution:${jobId}`,
        channelId: String(job.channelId),
        threadId: String(job.threadId),
        concurrencyKey: String(
          job.concurrencyKey || `${job.channelId}:${job.threadId}`,
        ),
        priority: Number(job.priority) || 2,
        spec: {
          protocolVersion: 2,
          legacyJobId,
          legacyAttempt: normalizedAttempt(job?.attempt),
          workerMode: job.workerMode || this.workerMode,
          job: serializableJob(job),
          prompt: String(prompt || ''),
          search: Boolean(search),
          mockPlan: job.mockPlan || null,
        },
        createdAt: String(job.event?.timestamp || new Date().toISOString()),
      });
    }
    if (
      stored.status === 'lost'
      && stored.launchAttempts < this.maxWorkerLaunchAttempts
    ) {
      this.bus.requeueLostJob(jobId);
      stored = this.bus.getJob(jobId);
    }
    const terminal = terminalOutcome(stored);
    if (terminal) {
      await this.replayPendingWorkerMessages(jobId, {
        onUpdate,
        onWorkerStart,
      });
      const replayedOutcome = terminalOutcome(this.bus.getJob(jobId));
      if (replayedOutcome instanceof Error) throw replayedOutcome;
      return replayedOutcome || terminal;
    }

    const result = new Promise((resolve, reject) => {
      const waiter = {
        jobId,
        resolve,
        reject,
        onUpdate,
        onWorkerStart,
        signal,
        abortListener: null,
      };
      if (signal) {
        waiter.abortListener = () => {
          const reason = String(signal.reason || 'cancel requested by Workbench');
          this.bus.requestCancel(jobId, { reason });
          this.server.wake('worker', {
            jobId,
            action: 'cancel',
            reason,
          });
          this.log('worker-broker-cancel-requested', {
            jobId,
            reason,
          }).catch(() => {});
        };
        signal.addEventListener('abort', waiter.abortListener, { once: true });
        if (signal.aborted) waiter.abortListener();
      }
      this.waiters.set(jobId, waiter);
    });

    try {
      await this.ensureLaunched(jobId);
      this.requestDrain();
      this.reconcileWaiters();
      return await result;
    } finally {
      this.removeWaiter(jobId);
    }
  }

  async consume(message) {
    if (!String(message.kind || '').startsWith('worker.')) return false;
    const waiter = this.waiters.get(message.jobId);
    if (!waiter) return this.dropOrphanWorkerMessage(message);
    await this.dispatchWorkerMessage(message, waiter);
    return true;
  }

  // A `worker.*` message whose in-memory waiter is gone (the Workbench
  // generation that attached the job exited) is only replayable while its job
  // can still be reattached by execute(). Once the job is terminal — or has no
  // row at all — nothing will ever consume it, and leaving it unacknowledged
  // parks it in the queue permanently while inflating pendingWork.
  async dropOrphanWorkerMessage(message) {
    const dropped = this.acknowledgeOrphanWorkerMessages(message.jobId);
    if (dropped === 0) return false;
    await this.log('worker-broker-orphan-messages-dropped', {
      jobId: message.jobId,
      jobStatus: this.bus.getJob(message.jobId)?.status || null,
      dropped,
    });
    return true;
  }

  // Messages orphaned by earlier generations predate this broker, so reclaim
  // them once at start instead of waiting for a same-job message to arrive.
  async sweepOrphanWorkerMessages({ limit = 500 } = {}) {
    let dropped = 0;
    const seen = new Set();
    for (const message of this.bus.pending('workbench', { limit })) {
      if (!String(message.kind || '').startsWith('worker.')) continue;
      if (seen.has(message.jobId)) continue;
      seen.add(message.jobId);
      dropped += this.acknowledgeOrphanWorkerMessages(message.jobId);
    }
    if (dropped > 0) {
      await this.log('worker-broker-orphan-messages-swept', { dropped });
    }
    return dropped;
  }

  // `pending()` only surfaces the head message per job, so acknowledge the
  // whole orphaned run at once rather than one message per drain cycle.
  acknowledgeOrphanWorkerMessages(jobId, { nowMs = Date.now() } = {}) {
    if (this.waiters.has(jobId)) return 0;
    // All-or-nothing on the newest message in the run: a replay must see the
    // whole run or none of it, and a run with any recent message may still be
    // waiting for a Workbench generation that is about to reattach.
    // DurableBus performs the count/newest check and bulk ACK in one SQLite
    // transaction, avoiding the public 200-row read limit and partial runs.
    return this.bus.acknowledgeOrphanWorkerRun(
      'workbench',
      jobId,
      this.instanceId,
      {
        minAgeMs: this.orphanMessageMinAgeMs,
        nowMs,
      },
    );
  }

  async dispatchWorkerMessage(message, waiter) {
    if (message.kind === 'worker.started') {
      await waiter.onWorkerStart?.(message.payload?.workerInfo || {});
    } else if (message.kind === 'worker.update') {
      await waiter.onUpdate?.(message.payload?.update || {});
    } else if (message.kind === 'worker.progress') {
      await waiter.onUpdate?.({
        worker: 'worker',
        type: 'response_text',
        text: String(message.payload?.content || ''),
      });
    } else if (message.kind === 'worker.completed') {
      waiter.resolve(message.payload?.result || message.payload || {});
    } else if (message.kind === 'worker.failed') {
      waiter.reject(workerFailure(message.payload));
    }
  }

  async replayPendingWorkerMessages(jobId, {
    onUpdate = null,
    onWorkerStart = null,
  } = {}) {
    let terminalResult = null;
    let terminalError = null;
    const replay = {
      onUpdate,
      onWorkerStart,
      resolve: (result) => {
        terminalResult = result;
      },
      reject: (error) => {
        terminalError = error;
      },
    };
    for (;;) {
      const message = this.bus
        .unacknowledgedForJob('workbench', jobId, { limit: 1 })
        .find((entry) => String(entry.kind || '').startsWith('worker.'));
      if (!message) break;
      await this.dispatchWorkerMessage(message, replay);
      this.bus.acknowledge(message.rowId, this.instanceId);
    }
    if (terminalError) throw terminalError;
    return terminalResult;
  }

  requestDrain() {
    this.emit('drain.requested');
  }

  reconcileWaiters() {
    for (const [jobId, waiter] of this.waiters) {
      const job = this.bus.getJob(jobId);
      if (job?.status === 'queued') {
        this.ensureLaunched(jobId).catch((error) => {
          this.log('worker-broker-relaunch-failed', {
            jobId,
            error: error.message,
          }).catch(() => {});
        });
        continue;
      }
      const outcome = terminalOutcome(job);
      if (!outcome) continue;
      // Worker terminal state and terminal event are committed together. Let
      // FullWorkbenchRuntime drain every stored update before settling from
      // the jobs-table fallback; otherwise a fast status poll could resolve
      // the waiter first and strand the terminal event with no consumer.
      const pendingWorkerEvent = this.bus
        .unacknowledgedForJob('workbench', jobId, { limit: 1 })
        .some((entry) => String(entry.kind || '').startsWith('worker.'));
      if (pendingWorkerEvent) {
        this.requestDrain();
        continue;
      }
      if (outcome instanceof Error) waiter.reject(outcome);
      else waiter.resolve(outcome);
    }
  }

  reconcileWorkerLiveness({ nowMs = Date.now() } = {}) {
    for (const job of this.bus.activeJobs()) {
      if (!['running', 'cancel_requested'].includes(job.status)) continue;
      const heartbeatAtMs = Number(job.heartbeatAtMs || 0);
      if (!heartbeatAtMs || nowMs - heartbeatAtMs < this.workerLostAfterMs) {
        continue;
      }
      const workerAlive = job.workerPid && isPidAlive(job.workerPid);
      if (
        workerAlive
        && nowMs - heartbeatAtMs < this.workerHardLostAfterMs
      ) continue;

      if (job.status === 'cancel_requested') {
        if (this.bus.forceCancelJob(job.jobId)) {
          this.log('worker-broker-cancelled-missing-worker', {
            jobId: job.jobId,
            workerPid: job.workerPid,
            heartbeatAtMs,
          }).catch(() => {});
        }
        continue;
      }

      if (!this.bus.markJobLost(job.jobId, {
        error: `detached Worker ${job.workerPid || '(unknown pid)'} stopped heartbeating`,
      })) continue;
      const canRetry = job.launchAttempts < this.maxWorkerLaunchAttempts;
      this.log('worker-broker-worker-lost', {
        jobId: job.jobId,
        workerPid: job.workerPid,
        heartbeatAtMs,
        launchAttempts: job.launchAttempts,
        canRetry,
      }).catch(() => {});
      if (canRetry && this.waiters.has(job.jobId)) {
        this.bus.requeueLostJob(job.jobId);
        this.ensureLaunched(job.jobId).catch((error) => {
          this.log('worker-broker-relaunch-failed', {
            jobId: job.jobId,
            error: error.message,
          }).catch(() => {});
        });
      }
    }
  }

  async ensureLaunched(jobId) {
    let job = this.bus.getJob(jobId);
    if (!job) throw new Error(`detached Worker job disappeared: ${jobId}`);
    if (job.status === 'running' || job.status === 'cancel_requested') return job;
    const terminal = terminalOutcome(job);
    if (terminal) return job;
    if (job.status === 'launching') {
      const updatedAtMs = Date.parse(job.updatedAt || '');
      const withinGrace = Number.isFinite(updatedAtMs)
        && Date.now() - updatedAtMs < this.launchGraceMs;
      if (withinGrace || (job.lastSpawnPid && isPidAlive(job.lastSpawnPid))) {
        return job;
      }
      this.bus.requeueOrphanedLaunch(jobId);
      job = this.bus.getJob(jobId);
    }
    if (job.status !== 'queued') return job;
    if (job.launchAttempts >= this.maxWorkerLaunchAttempts) {
      this.bus.markPendingJobLost(jobId, {
        error: `detached Worker launch failed after ${job.launchAttempts} attempts`,
      });
      return this.bus.getJob(jobId);
    }
    if (!this.bus.reserveLaunch(jobId, { launcherId: this.instanceId })) {
      return this.bus.getJob(jobId);
    }
    try {
      const launched = await this.launchWorker(jobId);
      this.bus.recordSpawn(jobId, {
        launcherId: this.instanceId,
        pid: launched.pid,
      });
      await this.log('worker-broker-launched', {
        jobId,
        pid: launched.pid,
        logPath: launched.logPath,
      });
      return this.bus.getJob(jobId);
    } catch (error) {
      this.bus.releaseLaunch(jobId, {
        launcherId: this.instanceId,
        error,
      });
      throw error;
    }
  }

  async launchWorker(jobId) {
    const workerUrl = this.server.address()?.url;
    if (!workerUrl) throw new Error('Worker wake server is not listening');
    fs.mkdirSync(this.workerLogRoot, { recursive: true });
    const logPath = path.join(
      this.workerLogRoot,
      `${safeFilePart(jobId)}-${Date.now()}.log`,
    );
    const logDescriptor = fs.openSync(logPath, 'a', 0o600);
    const workerScript = path.join(this.repoRoot, 'v3', 'worker.mjs');
    const child = spawn(process.execPath, [workerScript, '--job', jobId], {
      cwd: this.repoRoot,
      detached: true,
      stdio: ['ignore', logDescriptor, logDescriptor],
      env: detachedWorkerEnvironment(process.env, {
        BRIDGE_STATE_ROOT: this.bridgeConfig.stateRoot,
        PROJECT_ROOT: this.bridgeConfig.projectRoot,
        V3_STATE_ROOT: path.dirname(this.dbPath),
        V3_DB_PATH: this.dbPath,
        V3_INTERNAL_TOKEN: this.token,
        V3_WORKBENCH_URL: workerUrl,
        V3_WORKER_HEARTBEAT_MS: String(this.workerHeartbeatMs),
      }),
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
    for (const job of this.bus.activeJobs()) {
      if (job.status !== 'launching') continue;
      const updatedAtMs = Date.parse(job.updatedAt || '');
      const launchAgeMs = Number.isFinite(updatedAtMs)
        ? Date.now() - updatedAtMs
        : Number.POSITIVE_INFINITY;
      if (launchAgeMs < this.launchGraceMs) continue;
      if (
        job.lastSpawnPid
        && isPidAlive(job.lastSpawnPid)
        && launchAgeMs < this.launchHardTimeoutMs
      ) continue;
      if (job.launchAttempts >= this.maxWorkerLaunchAttempts) {
        if (this.bus.markPendingJobLost(job.jobId, {
          error: `detached Worker did not claim after ${job.launchAttempts} launch attempts`,
        })) {
          await this.log('worker-broker-launch-attempts-exhausted', {
            jobId: job.jobId,
            lastSpawnPid: job.lastSpawnPid,
            launchAttempts: job.launchAttempts,
            launchAgeMs,
          });
        }
        continue;
      }
      if (this.bus.requeueOrphanedLaunch(job.jobId)) {
        await this.log('worker-broker-orphaned-launch-requeued', {
          jobId: job.jobId,
          lastSpawnPid: job.lastSpawnPid,
          launchAgeMs,
        });
      }
    }
  }

  removeWaiter(jobId) {
    const waiter = this.waiters.get(jobId);
    if (!waiter) return;
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
    this.waiters.delete(jobId);
  }

  status() {
    return {
      running: this.running,
      instanceId: this.instanceId,
      address: this.server.address(),
      attachedJobs: this.waiters.size,
      durableActiveJobs: this.bus.activeJobs().length,
    };
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.server.stop();
    const error = new Error(
      'Workbench stopped while detached Worker continues running',
    );
    error.serviceShutdown = true;
    for (const waiter of this.waiters.values()) waiter.reject(error);
    for (const jobId of [...this.waiters.keys()]) this.removeWaiter(jobId);
    await this.log('worker-broker-stopped', {
      instanceId: this.instanceId,
      activeWorkersLeftRunning: this.bus.activeJobs().length,
    });
  }

  async log(type, payload = {}) {
    this.emit('log', type, payload);
    await this.onLog?.(type, payload);
  }
}

function serializableJob(job = {}) {
  const {
    abortController: _abortController,
    previousWorkerDurationMs: _previousWorkerDurationMs,
    ...rest
  } = job;
  return JSON.parse(JSON.stringify(rest));
}

export function detachedWorkerExecutionId(job = {}) {
  const legacyJobId = String(job?.id || '').trim();
  if (!legacyJobId) return '';
  const attempt = normalizedAttempt(job?.attempt);
  return attempt <= 1
    ? legacyJobId
    : `${legacyJobId}:attempt:${attempt}`;
}

function normalizedAttempt(value) {
  return Math.max(1, Number.parseInt(value, 10) || 1);
}

function terminalOutcome(job) {
  if (!job || !TERMINAL_STATUSES.has(job.status)) return null;
  if (job.status === 'completed') return job.result || {};
  return workerFailure({
    error: job.result?.error || job.lastError || `Worker ${job.status}`,
    cancelled: job.status === 'cancelled',
    errorMeta: job.status === 'cancelled'
      ? {
          aborted: true,
          cancelled: true,
          abortReason: job.cancelReason || job.lastError || 'cancel requested by Workbench',
        }
      : null,
    result: job.result,
  });
}

export function detachedWorkerEnvironment(baseEnv = {}, overrides = {}) {
  const env = {
    ...baseEnv,
    ...overrides,
    BRIDGE_RUNTIME_ROLE: 'v3-worker',
  };
  // Reception is the only process allowed to own external platform
  // credentials. Workers retain provider/GitHub credentials required for the
  // requested job, but cannot directly impersonate the Discord/Slack bridge.
  for (const key of [
    'DISCORD_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_BOT_TOKEN',
  ]) {
    delete env[key];
  }
  return env;
}

export function workerFailure(payload = {}) {
  const error = new Error(String(payload.error || 'detached Worker failed'));
  const metadata = payload.errorMeta || payload.result?.errorMeta || {};
  if (metadata && typeof metadata === 'object') {
    for (const [key, value] of Object.entries(metadata)) {
      if (key === 'message') continue;
      try {
        error[key] = value;
      } catch {
        // Error fields are ordinarily writable; keep the normalized message
        // even if a future runtime exposes a read-only property.
      }
    }
  }
  error.worker = payload.result?.worker || payload.worker || null;
  error.workerAttempts = payload.result?.attempts
    || payload.workerAttempts
    || [];
  error.workerTranscripts = payload.result?.workerTranscripts
    || payload.workerTranscripts
    || [];
  if (payload.cancelled) {
    error.aborted = true;
    error.cancelled = true;
  }
  return error;
}

function safeFilePart(value) {
  return String(value || 'job')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 100) || 'job';
}

function isPidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
