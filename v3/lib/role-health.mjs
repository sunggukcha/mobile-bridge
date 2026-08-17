import fs from 'node:fs/promises';
import path from 'node:path';

export const V3_HEALTH_PROTOCOL_VERSION = 1;

export class RoleHealthReporter {
  constructor({
    role,
    stateRoot,
    getStatus,
    intervalMs = 1_000,
    fallbackIntervalMs = 5_000,
    fallbackStopDrainTimeoutMs = 2_000,
    onError = null,
    writeFallback = writeHealthFallback,
    sendHeartbeat = sendHealthIpc,
    now = () => Date.now(),
  } = {}) {
    if (!role || !stateRoot || typeof getStatus !== 'function') {
      throw new Error('RoleHealthReporter configuration is incomplete');
    }
    this.role = String(role);
    this.stateRoot = path.resolve(stateRoot);
    this.getStatus = getStatus;
    this.intervalMs = Math.max(250, Number(intervalMs) || 1_000);
    this.fallbackIntervalMs = Math.max(
      this.intervalMs,
      Number(fallbackIntervalMs) || 5_000,
    );
    this.fallbackStopDrainTimeoutMs = Math.max(
      0,
      Number(fallbackStopDrainTimeoutMs) || 0,
    );
    this.onError = onError;
    this.writeFallback = writeFallback;
    this.sendHeartbeat = sendHeartbeat;
    this.now = now;
    this.startedAt = new Date(this.now()).toISOString();
    this.timer = null;
    this.stopped = false;
    this.fallbackWrite = null;
    this.queuedFallbackSnapshot = null;
    this.fallbackWriteTimer = null;
    this.lastFallbackWriteAtMs = 0;
  }

  filePath() {
    return path.join(
      this.stateRoot,
      '_system',
      `v3-${this.role}-health.json`,
    );
  }

  async start() {
    if (this.timer) return;
    this.stopped = false;
    await this.publish(null, { forceFallback: true }).catch((error) => this.reportError(error));
    this.timer = setInterval(() => {
      this.publish().catch((error) => this.reportError(error));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  requestPublish() {
    return this.publish(null, { forceFallback: true })
      .catch((error) => this.reportError(error));
  }

  async publish(override = null, { forceFallback = false } = {}) {
    const observed = override || await this.getStatus();
    const details = observed && typeof observed === 'object'
      ? { ...observed }
      : {};
    const snapshot = {
      protocolVersion: V3_HEALTH_PROTOCOL_VERSION,
      role: this.role,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date(this.now()).toISOString(),
      ready: Boolean(details.ready),
      phase: String(
        details.phase || (details.ready ? 'ready' : 'starting'),
      ),
      details,
    };
    // IPC is the Supervisor's primary health path. Send every fresh snapshot
    // before touching the DrvFS fallback file; a slow or hung write must not
    // suppress later heartbeats or hold role startup/shutdown open.
    this.sendHeartbeat(snapshot);
    this.queueFallbackWrite(snapshot, { force: forceFallback });
    return snapshot;
  }

  queueFallbackWrite(snapshot, { force = false } = {}) {
    const nowMs = this.now();
    const request = { snapshot, force: Boolean(force) };
    if (this.fallbackWrite) {
      // Health files are latest-state snapshots. Keep only the newest value
      // while one write is in flight instead of building an unbounded queue.
      this.queuedFallbackSnapshot = mergeFallbackRequest(
        this.queuedFallbackSnapshot,
        request,
      );
      return;
    }
    if (this.fallbackWriteTimer) {
      this.queuedFallbackSnapshot = mergeFallbackRequest(
        this.queuedFallbackSnapshot,
        request,
      );
      const deadlineReached = nowMs - this.lastFallbackWriteAtMs
        >= this.fallbackIntervalMs;
      if (!force && !deadlineReached) return;
      clearTimeout(this.fallbackWriteTimer);
      this.fallbackWriteTimer = null;
      const queued = this.queuedFallbackSnapshot;
      this.queuedFallbackSnapshot = null;
      this.startFallbackWrite(queued.snapshot);
      return;
    }
    const elapsedMs = nowMs - this.lastFallbackWriteAtMs;
    if (!force && elapsedMs >= 0 && elapsedMs < this.fallbackIntervalMs) {
      this.queuedFallbackSnapshot = request;
      this.fallbackWriteTimer = setTimeout(() => {
        this.fallbackWriteTimer = null;
        const queued = this.queuedFallbackSnapshot;
        this.queuedFallbackSnapshot = null;
        if (queued) this.startFallbackWrite(queued.snapshot);
      }, this.fallbackIntervalMs - elapsedMs);
      this.fallbackWriteTimer.unref?.();
      return;
    }
    this.startFallbackWrite(snapshot);
  }

  startFallbackWrite(snapshot) {
    const nowMs = this.now();
    this.lastFallbackWriteAtMs = nowMs;
    const operation = Promise.resolve().then(() => this.writeFallback(
      this.filePath(),
      snapshot,
      { mode: 0o600 },
    ));
    this.fallbackWrite = operation
      .catch((error) => {
        this.lastFallbackWriteAtMs = 0;
        this.reportError(error);
      })
      .finally(() => {
        this.fallbackWrite = null;
        const queued = this.queuedFallbackSnapshot;
        this.queuedFallbackSnapshot = null;
        if (queued) this.queueFallbackWrite(queued.snapshot, { force: queued.force });
      });
  }

  async stop(details = {}) {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.publish({
      ...details,
      ready: false,
      phase: 'stopped',
    }, { forceFallback: true }).catch((error) => this.reportError(error));
    await Promise.race([
      this.drainFallbackWrites(),
      delay(this.fallbackStopDrainTimeoutMs),
    ]);
  }

  async drainFallbackWrites() {
    if (this.fallbackWriteTimer) {
      clearTimeout(this.fallbackWriteTimer);
      this.fallbackWriteTimer = null;
      const queued = this.queuedFallbackSnapshot;
      this.queuedFallbackSnapshot = null;
      if (queued) this.startFallbackWrite(queued.snapshot);
    }
    while (this.fallbackWrite) await this.fallbackWrite;
  }

  reportError(error) {
    this.onError?.(error);
  }
}

function mergeFallbackRequest(current, next) {
  if (!current) return next;
  return {
    snapshot: next.snapshot,
    force: Boolean(current.force || next.force),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export async function readRoleHealth(stateRoot, role) {
  try {
    return JSON.parse(await fs.readFile(path.join(
      path.resolve(stateRoot),
      '_system',
      `v3-${String(role)}-health.json`,
    ), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function isHealthFresh(snapshot, {
  nowMs = Date.now(),
  staleAfterMs = 15_000,
} = {}) {
  const updatedAtMs = Date.parse(snapshot?.updatedAt || '');
  return Number.isFinite(updatedAtMs)
    && nowMs - updatedAtMs >= 0
    && nowMs - updatedAtMs <= staleAfterMs;
}

export function sendHealthIpc(snapshot) {
  if (typeof process.send !== 'function' || !process.connected) return;
  try {
    process.send({
      type: 'v3-role-health',
      snapshot,
    }, () => {});
  } catch {
    // The state file remains the fallback when the supervisor IPC closes.
  }
}

async function writeHealthFallback(filePath, value, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // This is a volatile fallback snapshot, not authoritative job state. Direct
  // overwrite avoids Windows/DrvFS rename sharing failures; the Supervisor's
  // IPC heartbeat remains the atomic, primary liveness signal.
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}
