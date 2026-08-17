#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readDotEnvFile } from '../lib/config.mjs';
import { formatErrorDetail } from '../lib/error-detail.mjs';
import { JsonState } from '../lib/state.mjs';
import {
  acquirePidLock,
  releasePidLock,
  releasePidLockSync,
} from '../lib/supervisor-lock.mjs';
import { isHealthFresh } from './lib/role-health.mjs';
import { loadV3RuntimeConfig } from './lib/runtime-config.mjs';
import { RuntimeHandoffGate } from './lib/runtime-handoff.mjs';
import { runtimeRolesForChanges } from './lib/runtime-roles.mjs';

const RESTART_EXIT_CODE = 75;
const runtimeConfig = loadV3RuntimeConfig();
const systemState = new JsonState(
  path.join(runtimeConfig.bridgeConfig.stateRoot, '_system'),
);
const lockFile = path.join(
  runtimeConfig.bridgeConfig.stateRoot,
  '_system',
  'v3-supervisor.lock',
);
const supervisorStartedAt = new Date().toISOString();
const roles = new Map();
const runtimeHandoffGate = new RuntimeHandoffGate();
let stopping = false;
let monitorTimer = null;
let activeReceptionUrl = runtimeConfig.receptionPort === 0
  ? ''
  : runtimeConfig.receptionUrl;
let activeWorkbenchPort = runtimeConfig.workbenchPort;
let stateRevision = 0;
let stateWrite = null;
let queuedStateWrite = null;
let stateWriteTimer = null;
let lastStateWriteAtMs = 0;
const stateWriteIntervalMs = Math.max(
  250,
  Math.min(5_000, Math.floor(runtimeConfig.healthStaleMs / 3)),
);

await systemState.init();
const lock = await acquirePidLock(lockFile);
if (!lock.acquired) {
  await log('v3-supervisor-duplicate-exit', { owner: lock.owner || null });
  process.exit(0);
}

await persistSupervisorStateSafely('startup');
startRole('reception');
monitorTimer = setInterval(
  () => monitorRoles().catch((error) =>
    log('v3-health-monitor-error', {
      error: formatErrorDetail(error),
    })),
  Math.max(250, Math.min(runtimeConfig.healthHeartbeatMs, 2_000)),
);

function startRole(role) {
  if (stopping) return;
  if (role === 'workbench' && runtimeHandoffGate.blocked) return;
  if (role === 'workbench' && !activeReceptionUrl) {
    scheduleRoleStart(role, 250);
    return;
  }
  const previous = roles.get(role);
  // Role exit handling persists state and inspects restart metadata before it
  // schedules the replacement. A concurrent sibling health message can start
  // that replacement while those awaits are in flight. Never overwrite the
  // live generation in the role map: doing so orphans the first child and the
  // second generation then crash-loops against its still-held SQLite lease.
  if (roleChildIsActive(previous)) return;
  if (previous?.restartTimer) clearTimeout(previous.restartTimer);
  if (previous?.stopTimer) clearTimeout(previous.stopTimer);
  const dotenvEnv = readDotEnvFile(path.join(runtimeConfig.repoRoot, '.env'));
  const script = role === 'reception'
    ? path.join(runtimeConfig.repoRoot, 'v3', 'reception.mjs')
    : path.join(runtimeConfig.repoRoot, 'v3', 'workbench.mjs');
  const child = spawn(process.execPath, [script], {
    cwd: runtimeConfig.repoRoot,
    env: {
      ...dotenvEnv,
      // Explicit launcher/test/canary overrides must win over repository
      // defaults. Reversing this order silently redirected child roles back
      // to the production state root whenever a checkout had a real `.env`.
      ...process.env,
      BRIDGE_IGNORE_BEFORE: runtimeConfig.ignoreBefore.toISOString(),
      V3_INTERNAL_TOKEN: runtimeConfig.internalToken,
      ...(role === 'workbench'
        ? {
            V3_RECEPTION_URL: activeReceptionUrl,
            V3_WORKBENCH_PORT: String(activeWorkbenchPort),
            V3_SUPERVISED: '1',
          }
        : {}),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const state = {
    child,
    pid: child.pid,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    failures: previous?.failures || 0,
    restartTimer: null,
    stopTimer: null,
    intentionalRestart: false,
    restartReason: '',
    exitHandled: false,
    health: null,
    everReady: false,
    unhealthySinceMs: null,
    receptionUrl: role === 'workbench' ? activeReceptionUrl : null,
    admissionEnabled: role === 'workbench' ? null : undefined,
  };
  roles.set(role, state);
  child.on('message', (message) => {
    handleRoleMessage(role, state, message).catch((error) =>
      log('v3-role-health-message-error', {
        role,
        pid: state.pid,
        error: formatErrorDetail(error),
      }));
  });
  log('v3-role-started', {
    role,
    pid: child.pid,
    receptionUrl: state.receptionUrl,
  }).catch(() => {});
  void persistSupervisorStateSafely(`role-start:${role}`);
  child.once('error', (error) => {
    handleRoleExit(role, state, {
      code: null,
      signal: null,
      spawnError: formatErrorDetail(error),
    }).catch(() => {});
  });
  child.once('close', (code, signal) => {
    handleRoleExit(role, state, { code, signal }).catch(() => {});
  });
}

async function handleRoleMessage(role, state, message) {
  if (
    message?.type !== 'v3-role-health'
    || !message.snapshot
    || String(message.snapshot.role) !== role
    || Number(message.snapshot.pid) !== Number(state.pid)
    || roles.get(role) !== state
    || state.intentionalRestart
  ) {
    return;
  }
  const healthTransition = roleHealthTransitioned(state.health, message.snapshot);
  state.health = message.snapshot;
  if (message.snapshot.ready) {
    state.everReady = true;
    state.unhealthySinceMs = null;
    state.failures = 0;
  } else if (state.everReady && state.unhealthySinceMs == null) {
    state.unhealthySinceMs = Date.now();
  }

  if (role === 'reception') {
    const addressUrl = String(
      message.snapshot.details?.address?.url || '',
    ).trim();
    if (addressUrl) {
      activeReceptionUrl = addressUrl;
      const workbench = roles.get('workbench');
      runtimeHandoffGate.observeReceptionReady(state, message.snapshot);
      if (
        message.snapshot.ready
        && !runtimeHandoffGate.blocked
        && !workbench?.child
      ) {
        startRole('workbench');
      } else if (
        message.snapshot.ready
        && workbench.receptionUrl
        && workbench.receptionUrl !== activeReceptionUrl
      ) {
        restartRole('workbench', 'reception-address-changed');
      }
    }
  } else if (role === 'workbench') {
    const boundPort = Number(
      message.snapshot.details?.broker?.address?.port,
    );
    if (Number.isInteger(boundPort) && boundPort > 0) {
      activeWorkbenchPort = boundPort;
    }
  }
  reconcileWorkbenchAdmission(`health:${role}`);
  await persistSupervisorStateSafely(
    `${healthTransition ? 'role-transition' : 'role-health'}:${role}`,
  );
}

async function handleRoleExit(role, state, result) {
  if (state.exitHandled) return;
  state.exitHandled = true;
  if (roles.get(role) !== state) return;
  if (role === 'workbench' && result.code === RESTART_EXIT_CODE) {
    // Block synchronously, before the first await below. Otherwise an old
    // Reception heartbeat can observe child=null and start the replacement
    // Workbench while runtime impact is still being classified.
    runtimeHandoffGate.begin();
  }
  if (state.stopTimer) clearTimeout(state.stopTimer);
  state.stopTimer = null;
  state.child = null;
  state.health = null;
  const healthyForMs = Date.now() - state.startedAtMs;
  state.failures = (
    result.code === RESTART_EXIT_CODE
    || state.intentionalRestart
    || healthyForMs >= 60_000
  ) ? 0 : state.failures + 1;
  await log('v3-role-exit', {
    role,
    pid: state.pid || null,
    ...result,
    healthyForMs,
    failures: state.failures,
    intentionalRestart: state.intentionalRestart,
    restartReason: state.restartReason || null,
  });
  await persistSupervisorStateSafely(`role-exit:${role}`);
  if (stopping) return;

  if (role === 'reception' && runtimeConfig.receptionPort === 0) {
    activeReceptionUrl = '';
  }
  reconcileWorkbenchAdmission(`exit:${role}`);

  if (role === 'workbench' && result.code === RESTART_EXIT_CODE) {
    const pending = await systemState
      .readJson('pending-restart.json', null)
      .catch(() => null);
    const changedPaths = Array.isArray(pending?.runtimeChangedPaths)
      ? pending.runtimeChangedPaths
      : [];
    const affected = runtimeRolesForChanges(changedPaths);
    await log('v3-runtime-role-impact', {
      changedPaths,
      affected,
    });
    if (affected.supervisor) {
      await log('v3-supervisor-update-restart', {
        reason: 'runtime-source-change',
      });
      await stopSupervisor('SIGTERM', RESTART_EXIT_CODE);
      return;
    }
    if (affected.reception) {
      runtimeHandoffGate.waitForReceptionReplacement(roles.get('reception'));
      restartRole('reception', 'runtime-source-change');
      // The replacement Workbench calls completePendingRestart during boot.
      // Do not start it against the retiring Reception: the completion event
      // must follow the new Reception's ready health snapshot.
      return;
    }
    runtimeHandoffGate.release();
  }

  const delayMs = (
    result.code === RESTART_EXIT_CODE
    || state.intentionalRestart
  )
    ? 250
    : Math.min(30_000, Math.max(1_000, 1_000 * (2 ** state.failures)));
  scheduleRoleStart(role, delayMs);
}

function scheduleRoleStart(role, delayMs) {
  if (stopping) return;
  const current = roles.get(role) || {};
  if (roleChildIsActive(current)) {
    log('v3-role-start-suppressed', {
      role,
      pid: current.pid || null,
      reason: 'active-generation',
    }).catch(() => {});
    return;
  }
  if (current.restartTimer) clearTimeout(current.restartTimer);
  current.restartTimer = setTimeout(() => {
    current.restartTimer = null;
    startRole(role);
  }, Math.max(20, Number(delayMs) || 250));
  roles.set(role, current);
}

function roleChildIsActive(state) {
  return Boolean(
    state?.child
    && state.child.exitCode == null
    && !state.child.signalCode,
  );
}

function restartRole(role, reason) {
  const state = roles.get(role);
  if (!state?.child || state.child.killed || state.intentionalRestart) return;
  const child = state.child;
  state.intentionalRestart = true;
  state.restartReason = String(reason || 'requested');
  state.health = null;
  state.unhealthySinceMs = Date.now();
  reconcileWorkbenchAdmission(`restart:${role}`);
  log('v3-role-restart-requested', {
    role,
    reason: state.restartReason,
    pid: child.pid,
  }).catch(() => {});
  void persistSupervisorStateSafely(`role-restart:${role}`);
  child.kill('SIGTERM');
  if (state.stopTimer) clearTimeout(state.stopTimer);
  state.stopTimer = setTimeout(() => {
    if (
      roles.get(role) !== state
      || state.child !== child
      || child.exitCode != null
      || child.signalCode
    ) {
      return;
    }
    child.kill('SIGKILL');
    log('v3-role-stop-timeout', {
      role,
      pid: child.pid,
      reason: state.restartReason,
      timeoutMs: runtimeConfig.roleStopTimeoutMs,
    }).catch(() => {});
  }, Math.max(500, runtimeConfig.roleStopTimeoutMs));
}

async function monitorRoles() {
  if (stopping) return;
  const nowMs = Date.now();
  for (const role of ['reception', 'workbench']) {
    const state = roles.get(role);
    if (!state?.child || state.intentionalRestart) continue;
    const ageMs = nowMs - state.startedAtMs;
    const healthFresh = isHealthFresh(state.health, {
      nowMs,
      staleAfterMs: runtimeConfig.healthStaleMs,
    });
    if (!state.health && ageMs > runtimeConfig.roleStartupTimeoutMs) {
      restartRole(role, 'startup-health-timeout');
      continue;
    }
    if (state.health && !healthFresh) {
      restartRole(role, 'health-heartbeat-stale');
      continue;
    }
    if (!state.health?.ready) {
      if (!state.everReady && ageMs > runtimeConfig.roleStartupTimeoutMs) {
        restartRole(role, 'role-readiness-timeout');
        continue;
      }
      if (
        state.everReady
        && state.unhealthySinceMs != null
        && nowMs - state.unhealthySinceMs > runtimeConfig.unhealthyGraceMs
      ) {
        if (
          role !== 'workbench'
          || roleHealthy(roles.get('reception'), nowMs)
        ) {
          restartRole(role, 'role-unhealthy');
        }
      }
    }
  }
  reconcileWorkbenchAdmission('health-monitor');
  await persistSupervisorStateSafely('health-monitor');
}

function reconcileWorkbenchAdmission(reason = '') {
  const workbench = roles.get('workbench');
  if (
    !workbench?.child
    || workbench.child.killed
    || !workbench.child.connected
  ) {
    return false;
  }
  const nowMs = Date.now();
  const workbenchPrepared = Boolean(
    workbench.health
    && isHealthFresh(workbench.health, {
      nowMs,
      staleAfterMs: runtimeConfig.healthStaleMs,
    })
    && workbench.health.details?.initialized
    && workbench.health.details?.receptionConnected,
  );
  const enabled = roleHealthy(roles.get('reception'), nowMs)
    && workbenchPrepared;
  const observed = workbench.health?.details?.admissionEnabled;
  if (
    workbench.admissionEnabled === enabled
    && observed === enabled
  ) return false;
  try {
    workbench.child.send({
      type: 'v3-workbench-admission',
      enabled,
      reason: String(reason || ''),
    }, (error) => {
      if (!error) return;
      log('v3-workbench-admission-send-failed', {
        pid: workbench.pid,
        enabled,
        reason: String(reason || ''),
        error: formatErrorDetail(error),
      }).catch(() => {});
    });
    workbench.admissionEnabled = enabled;
    log('v3-workbench-admission-updated', {
      pid: workbench.pid,
      enabled,
      reason: String(reason || ''),
    }).catch(() => {});
    return true;
  } catch (error) {
    log('v3-workbench-admission-send-failed', {
      pid: workbench.pid,
      enabled,
      reason: String(reason || ''),
      error: formatErrorDetail(error),
    }).catch(() => {});
    return false;
  }
}

function roleHealthy(state, nowMs = Date.now()) {
  return Boolean(
    state?.child
    && state.health?.ready
    && isHealthFresh(state.health, {
      nowMs,
      staleAfterMs: runtimeConfig.healthStaleMs,
    }),
  );
}

function roleHealthTransitioned(previous, next) {
  if (!previous) return true;
  return healthTransitionKey(previous) !== healthTransitionKey(next);
}

function healthTransitionKey(snapshot) {
  const details = snapshot?.details || {};
  return JSON.stringify([
    Boolean(snapshot?.ready),
    String(snapshot?.phase || ''),
    Number(snapshot?.pid) || null,
    String(details.address?.url || ''),
    Boolean(details.initialized),
    Boolean(details.receptionConnected),
    Boolean(details.admissionEnabled),
    Number(details.broker?.address?.port) || null,
  ]);
}

function supervisorSnapshot() {
  const nowMs = Date.now();
  const roleSnapshots = {};
  for (const role of ['reception', 'workbench']) {
    const state = roles.get(role);
    roleSnapshots[role] = state
      ? {
          pid: state.pid || null,
          startedAt: state.startedAt || null,
          running: Boolean(state.child),
          failures: state.failures || 0,
          intentionalRestart: Boolean(state.intentionalRestart),
          restartReason: state.restartReason || null,
          admissionEnabled: role === 'workbench'
            ? Boolean(state.admissionEnabled)
            : undefined,
          healthFresh: isHealthFresh(state.health, {
            nowMs,
            staleAfterMs: runtimeConfig.healthStaleMs,
          }),
          ready: Boolean(state.health?.ready),
          health: state.health || null,
        }
      : null;
  }
  const healthy = ['reception', 'workbench'].every((role) =>
    roleHealthy(roles.get(role), nowMs),
  );
  return {
    protocolVersion: 1,
    revision: ++stateRevision,
    pid: process.pid,
    startedAt: supervisorStartedAt,
    updatedAt: new Date(nowMs).toISOString(),
    stopping,
    activeReceptionUrl: activeReceptionUrl || null,
    activeWorkbenchPort: activeWorkbenchPort || null,
    overall: {
      healthy,
      phase: stopping
        ? 'stopping'
        : healthy
          ? 'ready'
          : 'starting-or-recovering',
    },
    roles: roleSnapshots,
  };
}

function persistSupervisorStateSafely(context) {
  const normalizedContext = String(context || 'unspecified');
  const routineHeartbeat = normalizedContext === 'health-monitor'
    || normalizedContext.startsWith('role-health:');
  queueSupervisorStateWrite(normalizedContext, {
    immediate: !routineHeartbeat,
  });
  return Promise.resolve(true);
}

function queueSupervisorStateWrite(context, { immediate = false } = {}) {
  const request = { context, immediate: Boolean(immediate) };
  if (stateWrite) {
    queuedStateWrite = mergeStateWriteRequest(queuedStateWrite, request);
    return;
  }

  if (stateWriteTimer) {
    queuedStateWrite = mergeStateWriteRequest(queuedStateWrite, request);
    if (!immediate) return;
    clearTimeout(stateWriteTimer);
    stateWriteTimer = null;
    const queued = queuedStateWrite;
    queuedStateWrite = null;
    startSupervisorStateWrite(queued.context);
    return;
  }

  const waitMs = stateWriteIntervalMs - (Date.now() - lastStateWriteAtMs);
  if (!immediate && waitMs > 0) {
    queuedStateWrite = request;
    stateWriteTimer = setTimeout(() => {
      stateWriteTimer = null;
      const queued = queuedStateWrite;
      queuedStateWrite = null;
      if (queued) startSupervisorStateWrite(queued.context);
    }, waitMs);
    stateWriteTimer.unref?.();
    return;
  }
  startSupervisorStateWrite(context);
}

function startSupervisorStateWrite(context) {
  lastStateWriteAtMs = Date.now();
  const snapshot = supervisorSnapshot();
  const operation = systemState.writeJson(
    'v3-supervisor.json',
    snapshot,
    { mode: 0o600 },
  );
  stateWrite = operation
    .catch((error) => log('v3-supervisor-state-write-error', {
      context: String(context || 'unspecified'),
      error: formatErrorDetail(error),
    }).catch(() => {}))
    .finally(() => {
      stateWrite = null;
      const queued = queuedStateWrite;
      queuedStateWrite = null;
      if (queued) {
        queueSupervisorStateWrite(queued.context, { immediate: queued.immediate });
      }
    });
}

function mergeStateWriteRequest(current, next) {
  if (!current) return next;
  return {
    context: next.context,
    immediate: Boolean(current.immediate || next.immediate),
  };
}

async function flushSupervisorStateWrites() {
  if (stateWriteTimer) {
    clearTimeout(stateWriteTimer);
    stateWriteTimer = null;
    const queued = queuedStateWrite;
    queuedStateWrite = null;
    if (queued) startSupervisorStateWrite(queued.context);
  }
  while (stateWrite) await stateWrite;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopSupervisor(signal).catch(() => process.exit(1));
  });
}

// Operationally useful for a watchdog-owned generation handoff and exercised
// by the recovery test. Detached Workers are different process-group leaders.
process.once('SIGUSR2', () => {
  stopSupervisor('SIGTERM', RESTART_EXIT_CODE)
    .catch(() => process.exit(1));
});

async function stopSupervisor(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  const exits = [];
  const liveChildren = [];
  for (const state of roles.values()) {
    if (state.restartTimer) clearTimeout(state.restartTimer);
    if (state.stopTimer) clearTimeout(state.stopTimer);
    if (
      state.child
      && state.child.exitCode == null
      && !state.child.signalCode
    ) {
      exits.push(waitForExit(state.child));
      liveChildren.push(state.child);
      if (!state.child.killed) state.child.kill(signal);
    }
  }
  await log('v3-supervisor-stop', { signal }).catch(() => {});
  await persistSupervisorStateSafely('stop');
  await flushSupervisorStateWrites();
  const settled = await Promise.race([
    Promise.allSettled(exits),
    new Promise((resolve) =>
      setTimeout(
        () => resolve(null),
        Math.max(500, runtimeConfig.roleStopTimeoutMs),
      )),
  ]);
  if (settled === null) {
    for (const child of liveChildren) {
      if (child.exitCode == null && !child.signalCode) child.kill('SIGKILL');
    }
    await Promise.race([
      Promise.allSettled(liveChildren.map((child) => waitForExit(child))),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  await releasePidLock(lockFile).catch(() => {});
  process.exit(exitCode);
}

process.on('exit', () => {
  try {
    releasePidLockSync(lockFile);
  } catch {
    // The next supervisor validates stale PID ownership.
  }
});

async function log(type, payload = {}) {
  await systemState.appendJsonl('v3-supervisor-events.jsonl', {
    timestamp: new Date().toISOString(),
    type,
    ...payload,
  });
}

function waitForExit(child) {
  if (!child || child.exitCode != null || child.signalCode) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', resolve));
}

await new Promise(() => {});
