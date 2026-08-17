import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const V3_PROMOTION_STATE_FILE = 'v3-promotion.json';

export async function maybeScheduleV3Promotion({
  repoRoot,
  stateRoot,
  env = process.env,
  runtimeRole = env.BRIDGE_RUNTIME_ROLE || '',
  spawnProcess = spawn,
  nodeBin = process.execPath,
  pidAlive = isProcessAlive,
  now = () => new Date(),
} = {}) {
  const target = String(env.BRIDGE_RUNTIME_VERSION || '').trim().toLowerCase();
  const requestId = String(env.V3_PROMOTION_REQUEST_ID || '').trim();
  if (runtimeRole !== 'v2-service') {
    return { requested: false, scheduled: false, reason: 'runtime-role-not-authorized' };
  }
  if (target !== 'v3') {
    return { requested: false, scheduled: false, reason: 'target-is-not-v3' };
  }
  if (!requestId) {
    return { requested: false, scheduled: false, reason: 'request-id-missing' };
  }
  if (!String(repoRoot || '').trim() || !String(stateRoot || '').trim()) {
    throw new Error('v3 promotion requires repository and state roots');
  }

  const resolvedRepoRoot = path.resolve(String(repoRoot));
  const resolvedStateRoot = path.resolve(String(stateRoot));
  const helperPath = path.join(
    resolvedRepoRoot,
    'scripts',
    'v3-promotion-launcher.mjs',
  );
  await fs.access(helperPath);
  await fs.mkdir(path.join(resolvedStateRoot, '_system'), { recursive: true });

  const statePath = path.join(
    resolvedStateRoot,
    '_system',
    V3_PROMOTION_STATE_FILE,
  );
  const previous = await readJson(statePath);
  if (previous?.requestId === requestId) {
    const terminal = previous.status === 'succeeded' || previous.status === 'failed';
    const coordinatorAlive = Number(previous.coordinatorPid) > 0
      && pidAlive(Number(previous.coordinatorPid));
    if (terminal || coordinatorAlive) {
      return {
        requested: true,
        scheduled: false,
        reason: terminal ? `already-${previous.status}` : 'already-running',
        requestId,
        state: previous,
      };
    }
  }

  const child = spawnProcess(nodeBin, [helperPath], {
    cwd: resolvedRepoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...env,
      DATA_DIR: resolvedStateRoot,
      BRIDGE_STATE_ROOT: resolvedStateRoot,
      BRIDGE_RUNTIME_VERSION: 'v3',
      BRIDGE_RESTART_SCOPE: 'runtime',
      V3_PLATFORM_MODE: String(env.V3_PLATFORM_MODE || 'live').trim() || 'live',
      V3_PROMOTION_REPO_ROOT: resolvedRepoRoot,
      V3_PROMOTION_REQUEST_ID: requestId,
    },
  });
  if (!Number(child?.pid)) {
    throw new Error('v3 promotion coordinator did not return a PID');
  }
  child.unref?.();

  const scheduled = {
    requestId,
    target: 'v3',
    status: 'scheduled',
    scheduledAt: now().toISOString(),
    scheduledByPid: process.pid,
    coordinatorPid: child.pid,
    repoRoot: resolvedRepoRoot,
    stateRoot: resolvedStateRoot,
  };
  await writeJsonAtomic(statePath, scheduled);
  return {
    requested: true,
    scheduled: true,
    reason: 'scheduled',
    requestId,
    state: scheduled,
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
