#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dotEnvAuthoritativeChildEnv, readDotEnvFile } from '../lib/config.mjs';
import { formatErrorDetail } from '../lib/error-detail.mjs';
import { JsonState } from '../lib/state.mjs';
import {
  acquirePidLock,
  releasePidLock,
  releasePidLockSync,
} from '../lib/supervisor-lock.mjs';
import { isHealthFresh } from './lib/role-health.mjs';
import { readJsonSnapshot } from './lib/json-snapshot.mjs';
import { loadV3RuntimeConfig } from './lib/runtime-config.mjs';

const RESTART_EXIT_CODE = 75;
const runtimeConfig = loadV3RuntimeConfig();
const systemRoot = path.join(
  runtimeConfig.bridgeConfig.stateRoot,
  '_system',
);
const systemState = new JsonState(systemRoot);
const lockFile = path.join(systemRoot, 'v3-watchdog.lock');
const watchdogStartedAt = new Date().toISOString();
let supervisor = null;
let stopping = false;
let monitorTimer = null;
let restartTimer = null;
let failures = 0;
let restartCount = 0;
let supervisorExitCount = 0;
let unexpectedExitCount = 0;
let everHealthy = false;
let unhealthySinceMs = null;
let unhealthyReason = '';
let lastRestartReason = '';
let lastHealthyAt = '';
let lastSupervisorExit = null;
let statusWrite = null;
let queuedStatusWrite = null;
let statusWriteTimer = null;
let lastStatusWriteAtMs = 0;
const routineStatusIntervalMs = Math.max(
  250,
  Math.min(5_000, runtimeConfig.healthStaleMs),
);

await systemState.init();
const lock = await acquirePidLock(lockFile);
if (!lock.acquired) {
  await log('v3-watchdog-duplicate-exit', { owner: lock.owner || null });
  process.exit(0);
}

startSupervisor();
monitorTimer = setInterval(
  () => monitorSupervisor().catch((error) =>
    log('v3-watchdog-monitor-error', {
      error: formatErrorDetail(error),
    })),
  Math.max(250, runtimeConfig.watchdogPollMs),
);
await writeStatusSafely('startup');

function startSupervisor() {
  if (stopping || supervisor?.child) return;
  const dotenvEnv = readDotEnvFile(path.join(runtimeConfig.repoRoot, '.env'));
  const child = spawn(
    process.execPath,
    [path.join(runtimeConfig.repoRoot, 'v3', 'supervisor.mjs')],
    {
      cwd: runtimeConfig.repoRoot,
      detached: true,
      env: {
        // Preserve explicit host-launcher and canary overrides. `.env` is a
        // default source, not authority over the already-resolved runtime —
        // except for the operational tunables, where this Watchdog holds the
        // values it booted with and would otherwise re-freeze them into every
        // Supervisor generation it spawns.
        ...dotEnvAuthoritativeChildEnv(dotenvEnv, process.env),
        BRIDGE_IGNORE_BEFORE: runtimeConfig.ignoreBefore.toISOString(),
        V3_INTERNAL_TOKEN: runtimeConfig.internalToken,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const state = {
    child,
    pid: child.pid,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    intentionalRestart: false,
    exitHandled: false,
    everHealthy: false,
  };
  supervisor = state;
  log('v3-watchdog-supervisor-started', {
    pid: child.pid,
    failures,
    restartCount,
  }).catch(() => {});
  void writeStatusSafely('supervisor-start');
  child.once('error', (error) => {
    handleSupervisorExit(state, {
      code: null,
      signal: null,
      spawnError: formatErrorDetail(error),
    }).catch(() => {});
  });
  child.once('close', (code, signal) => {
    handleSupervisorExit(state, { code, signal }).catch(() => {});
  });
}

async function handleSupervisorExit(state, result) {
  if (!state || state.exitHandled) return;
  state.exitHandled = true;
  if (supervisor !== state) return;
  const healthyForMs = Date.now() - state.startedAtMs;
  const runtimeReload = result.code === RESTART_EXIT_CODE;
  const intentionalExit = state.intentionalRestart || runtimeReload;
  supervisor = null;
  supervisorExitCount += 1;
  if (!intentionalExit) unexpectedExitCount += 1;
  if (runtimeReload) {
    restartCount += 1;
    lastRestartReason = 'runtime-source-change';
  }
  lastSupervisorExit = {
    at: new Date().toISOString(),
    pid: state.pid,
    code: result.code ?? null,
    signal: result.signal ?? null,
    spawnError: result.spawnError || null,
    intentional: intentionalExit,
    healthyForMs,
  };
  unhealthySinceMs = null;
  unhealthyReason = '';
  failures = (
    intentionalExit
    || healthyForMs >= 60_000
  ) ? 0 : failures + 1;
  await log('v3-watchdog-supervisor-exit', {
    pid: state.pid,
    ...result,
    healthyForMs,
    failures,
    intentionalRestart: intentionalExit,
    restartReason: lastRestartReason || null,
  });
  await writeStatusSafely('supervisor-exit');
  if (stopping) return;
  if (!state.intentionalRestart) {
    // Reception and Workbench are ordinary children in the supervisor's
    // process group. A supervisor crash must not leave those fenced roles
    // orphaned; detached per-job Workers are separate process-group leaders.
    signalProcessGroup(state.pid, 'SIGTERM');
  }
  const delayMs = intentionalExit
    ? 250
    : Math.min(30_000, Math.max(1_000, 1_000 * (2 ** failures)));
  scheduleSupervisorStart(delayMs);
}

function scheduleSupervisorStart(delayMs) {
  if (stopping) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startSupervisor();
  }, Math.max(20, Number(delayMs) || 250));
}

async function monitorSupervisor() {
  if (stopping) return;
  const nowMs = Date.now();
  const state = supervisor;
  if (!state?.child) {
    await writeStatusSafely('monitor-no-supervisor');
    return;
  }
  const snapshot = await readJsonSnapshot(
    path.join(systemRoot, 'v3-supervisor.json'),
  );
  const ownedSnapshot = Number(snapshot?.pid) === Number(state.pid);
  const snapshotFresh = ownedSnapshot && isHealthFresh(snapshot, {
    nowMs,
    staleAfterMs: runtimeConfig.healthStaleMs * 2,
  });
  const healthy = Boolean(snapshotFresh && snapshot?.overall?.healthy);
  const currentUnhealthyReason = !ownedSnapshot
    ? 'supervisor-state-missing'
    : !snapshotFresh
      ? 'supervisor-heartbeat-stale'
      : !snapshot?.overall?.healthy
        ? 'supervisor-roles-unhealthy'
        : '';
  if (healthy) {
    state.everHealthy = true;
    everHealthy = true;
    unhealthySinceMs = null;
    unhealthyReason = '';
    lastHealthyAt = new Date(nowMs).toISOString();
    failures = 0;
  } else if (
    unhealthySinceMs == null
    || unhealthyReason !== currentUnhealthyReason
  ) {
    unhealthySinceMs = nowMs;
    unhealthyReason = currentUnhealthyReason;
  }

  const ageMs = nowMs - state.startedAtMs;
  // A fresh supervisor heartbeat means the supervisor is alive and owns role
  // recovery. Give it a complete recovery window instead of racing it with a
  // whole-runtime restart. Missing/stale supervisor state is watchdog-owned
  // and uses the shorter unhealthy grace after first readiness.
  const graceMs = currentUnhealthyReason === 'supervisor-roles-unhealthy'
    ? runtimeConfig.watchdogRoleRecoveryMs
    : state.everHealthy
      ? runtimeConfig.unhealthyGraceMs
      : runtimeConfig.roleStartupTimeoutMs;
  if (
    unhealthySinceMs != null
    && nowMs - unhealthySinceMs > graceMs
    && ageMs > graceMs
  ) {
    await restartSupervisor(currentUnhealthyReason);
    return;
  }
  await writeStatusSafely('monitor', { snapshot, healthy });
}

async function restartSupervisor(reason) {
  const state = supervisor;
  if (!state?.child || state.intentionalRestart) return;
  state.intentionalRestart = true;
  restartCount += 1;
  lastRestartReason = String(reason || 'watchdog-requested');
  unhealthySinceMs = null;
  unhealthyReason = '';
  await log('v3-watchdog-restart-requested', {
    pid: state.pid,
    reason: lastRestartReason,
    restartCount,
  });
  signalProcessGroup(state.pid, 'SIGTERM');
  const exited = await Promise.race([
    waitForExit(state.child).then(() => true),
    delay(10_000).then(() => false),
  ]);
  if (!exited && pidAlive(state.pid)) {
    signalProcessGroup(state.pid, 'SIGKILL');
  }
}

async function writeStatus({
  snapshot = null,
  healthy = false,
} = {}) {
  const value = {
    protocolVersion: 1,
    pid: process.pid,
    startedAt: watchdogStartedAt,
    updatedAt: new Date().toISOString(),
    stopping,
    supervisorPid: supervisor?.pid || null,
    supervisorStartedAt: supervisor?.startedAt || null,
    supervisorHealthy: Boolean(healthy),
    supervisorRevision: snapshot?.revision || null,
    failures,
    restartCount,
    supervisorExitCount,
    unexpectedExitCount,
    everHealthy,
    lastHealthyAt: lastHealthyAt || null,
    unhealthySince: unhealthySinceMs == null
      ? null
      : new Date(unhealthySinceMs).toISOString(),
    unhealthyReason: unhealthyReason || null,
    lastRestartReason: lastRestartReason || null,
    lastSupervisorExit,
  };
  return systemState.writeJson(
    'v3-watchdog.json',
    value,
    { mode: 0o600 },
  );
}

function writeStatusSafely(context, options = {}) {
  return new Promise((resolve) => {
    queueStatusWrite({
      context: String(context || 'unspecified'),
      options,
      immediate: context !== 'monitor',
      waiters: [resolve],
    });
  });
}

function queueStatusWrite(request) {
  if (statusWrite) {
    queuedStatusWrite = mergeStatusWriteRequest(queuedStatusWrite, request);
    return;
  }
  if (statusWriteTimer) {
    queuedStatusWrite = mergeStatusWriteRequest(queuedStatusWrite, request);
    if (!request.immediate) return;
    clearTimeout(statusWriteTimer);
    statusWriteTimer = null;
    const queued = queuedStatusWrite;
    queuedStatusWrite = null;
    startStatusWrite(queued);
    return;
  }

  const waitMs = routineStatusIntervalMs - (Date.now() - lastStatusWriteAtMs);
  if (!request.immediate && waitMs > 0) {
    queuedStatusWrite = request;
    statusWriteTimer = setTimeout(() => {
      statusWriteTimer = null;
      const queued = queuedStatusWrite;
      queuedStatusWrite = null;
      if (queued) startStatusWrite(queued);
    }, waitMs);
    statusWriteTimer.unref?.();
    return;
  }
  startStatusWrite(request);
}

function startStatusWrite(request) {
  lastStatusWriteAtMs = Date.now();
  statusWrite = writeStatus(request.options)
    .then(() => settleStatusWaiters(request.waiters, true))
    .catch(async (error) => {
      lastStatusWriteAtMs = 0;
      await log('v3-watchdog-state-write-error', {
        context: request.context,
        error: formatErrorDetail(error),
      }).catch(() => {});
      settleStatusWaiters(request.waiters, false);
    })
    .finally(() => {
      statusWrite = null;
      const queued = queuedStatusWrite;
      queuedStatusWrite = null;
      if (queued) queueStatusWrite(queued);
    });
}

function mergeStatusWriteRequest(current, next) {
  if (!current) return next;
  return {
    context: next.context,
    options: next.options,
    immediate: Boolean(current.immediate || next.immediate),
    waiters: [...current.waiters, ...next.waiters],
  };
}

function settleStatusWaiters(waiters, result) {
  for (const resolve of waiters || []) resolve(result);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopWatchdog(signal).catch(() => process.exit(1));
  });
}

async function stopWatchdog(signal) {
  if (stopping) return;
  stopping = true;
  if (monitorTimer) clearInterval(monitorTimer);
  if (restartTimer) clearTimeout(restartTimer);
  monitorTimer = null;
  restartTimer = null;
  await log('v3-watchdog-stop', { signal }).catch(() => {});
  const state = supervisor;
  if (state?.child) {
    state.intentionalRestart = true;
    signalProcessGroup(state.pid, signal);
    const exited = await Promise.race([
      waitForExit(state.child).then(() => true),
      delay(10_000).then(() => false),
    ]);
    if (!exited && pidAlive(state.pid)) {
      signalProcessGroup(state.pid, 'SIGKILL');
    }
  }
  await writeStatusSafely('stop');
  await releasePidLock(lockFile).catch(() => {});
  process.exit(0);
}

process.on('exit', () => {
  try {
    releasePidLockSync(lockFile);
  } catch {
    // A replacement validates stale PID ownership.
  }
});

async function log(type, payload = {}) {
  await systemState.appendJsonl('v3-watchdog-events.jsonl', {
    timestamp: new Date().toISOString(),
    type,
    ...payload,
  });
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-Number(pid), signal);
  } catch {
    try {
      process.kill(Number(pid), signal);
    } catch {
      // The close handler may already have observed the exit.
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function waitForExit(child) {
  if (!child || child.exitCode != null || child.signalCode) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await new Promise(() => {});
