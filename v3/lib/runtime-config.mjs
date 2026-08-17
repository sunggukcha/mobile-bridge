import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from '../../lib/config.mjs';

export const v3RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadV3RuntimeConfig(env = process.env, {
  repoRoot = v3RepoRoot,
  createToken = true,
  loadEnvFile = true,
} = {}) {
  if (loadEnvFile) loadDotEnv(path.join(repoRoot, '.env'));
  const bridgeConfig = {
    ...loadConfig(env),
    // A prototype worker launched from this checkout must treat this checkout,
    // not the production bridge checkout, as the authorized bridge source.
    bridgeRepoRoot: repoRoot,
  };
  const runtimeRoot = path.resolve(
    env.V3_STATE_ROOT || defaultV3RuntimeRoot({ env, stateRoot: bridgeConfig.stateRoot }),
  );
  const host = String(env.V3_INTERNAL_HOST || '127.0.0.1');
  const receptionPort = integer(env.V3_RECEPTION_PORT, 8793);
  const workbenchPort = integer(env.V3_WORKBENCH_PORT, 8794);
  const roleStartupTimeoutMs = integer(
    env.V3_ROLE_STARTUP_TIMEOUT_MS,
    120_000,
  );
  const unhealthyGraceMs = integer(env.V3_UNHEALTHY_GRACE_MS, 30_000);
  const tokenFile = path.resolve(
    env.V3_INTERNAL_TOKEN_FILE || defaultV3TokenFile({
      env,
      runtimeRoot,
    }),
  );

  fs.mkdirSync(runtimeRoot, { recursive: true });
  const environmentToken = String(env.V3_INTERNAL_TOKEN || '').trim();
  const internalToken = environmentToken
    || (createToken ? readOrCreateToken(tokenFile) : readToken(tokenFile));

  return {
    repoRoot,
    bridgeConfig,
    runtimeRoot,
    dbPath: path.resolve(
      env.V3_DB_PATH || path.join(runtimeRoot, 'coordination.sqlite'),
    ),
    internalToken,
    tokenFile,
    tokenSource: environmentToken ? 'environment' : 'file',
    host,
    receptionPort,
    workbenchPort,
    receptionUrl: String(
      env.V3_RECEPTION_URL || `ws://${host}:${receptionPort}`,
    ),
    workbenchUrl: String(
      env.V3_WORKBENCH_URL || `ws://${host}:${workbenchPort}`,
    ),
    platformMode: normalizeChoice(
      env.V3_PLATFORM_MODE,
      ['disabled', 'console', 'live'],
      'disabled',
    ),
    workerMode: normalizeChoice(
      env.V3_WORKER_MODE,
      ['agent', 'mock'],
      'agent',
    ),
    pollIntervalMs: integer(env.V3_POLL_INTERVAL_MS, 1_000),
    reconnectMinMs: integer(env.V3_RECONNECT_MIN_MS, 200),
    reconnectMaxMs: integer(env.V3_RECONNECT_MAX_MS, 5_000),
    leaseTtlMs: integer(env.V3_LEASE_TTL_MS, 10_000),
    leaseRenewMs: integer(env.V3_LEASE_RENEW_MS, 3_000),
    workerHeartbeatMs: integer(env.V3_WORKER_HEARTBEAT_MS, 3_000),
    healthHeartbeatMs: integer(env.V3_HEALTH_HEARTBEAT_MS, 1_000),
    healthStaleMs: integer(env.V3_HEALTH_STALE_MS, 15_000),
    roleStartupTimeoutMs,
    roleStopTimeoutMs: integer(env.V3_ROLE_STOP_TIMEOUT_MS, 10_000),
    unhealthyGraceMs,
    watchdogRoleRecoveryMs: integer(
      env.V3_WATCHDOG_ROLE_RECOVERY_MS,
      Math.max(roleStartupTimeoutMs, unhealthyGraceMs * 2),
    ),
    watchdogPollMs: integer(env.V3_WATCHDOG_POLL_MS, 2_000),
    workerLogRoot: path.resolve(
      env.V3_WORKER_LOG_ROOT || path.join(runtimeRoot, 'worker-logs'),
    ),
    ignoreBefore: new Date(
      env.BRIDGE_IGNORE_BEFORE || Date.now(),
    ),
  };
}

export function defaultV3RuntimeRoot({
  env = process.env,
  stateRoot,
  wsl = isWsl(),
} = {}) {
  const resolvedStateRoot = path.resolve(stateRoot || path.join(os.tmpdir(), 'bridge-state'));
  if (!wsl || !/^\/mnt\/[a-z](?:\/|$)/i.test(resolvedStateRoot)) {
    return path.join(resolvedStateRoot, '_v3');
  }
  const nativeStateHome = path.resolve(
    env.XDG_STATE_HOME
    || path.join(env.HOME || os.homedir(), '.local', 'state'),
  );
  const stateId = createHash('sha256')
    .update(resolvedStateRoot)
    .digest('hex')
    .slice(0, 16);
  return path.join(nativeStateHome, 'mobile-codex-bridge', 'v3', stateId);
}

function isWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

export function defaultV3TokenFile({
  env = process.env,
  runtimeRoot,
} = {}) {
  const resolvedRuntimeRoot = path.resolve(
    runtimeRoot || env.V3_STATE_ROOT || path.join(os.tmpdir(), 'bridge-v3'),
  );
  if (process.platform === 'win32') {
    return path.join(resolvedRuntimeRoot, 'internal.token');
  }
  const stateHome = path.resolve(
    env.V3_RUNTIME_SECRET_ROOT
    || env.XDG_STATE_HOME
    || path.join(os.homedir(), '.local', 'state'),
  );
  const runtimeId = createHash('sha256')
    .update(resolvedRuntimeRoot)
    .digest('hex')
    .slice(0, 24);
  return path.join(
    stateHome,
    'mobile-codex-bridge',
    'runtime-secrets',
    runtimeId,
    'internal.token',
  );
}

export function inspectV3TokenFile(filePath) {
  const stat = fs.lstatSync(filePath);
  const mode = stat.mode & 0o777;
  const expectedUid = typeof process.getuid === 'function'
    ? process.getuid()
    : null;
  return {
    path: path.resolve(filePath),
    regularFile: stat.isFile() && !stat.isSymbolicLink(),
    mode,
    uid: Number.isInteger(stat.uid) ? stat.uid : null,
    expectedUid,
    secure: process.platform === 'win32'
      || (
        stat.isFile()
        && !stat.isSymbolicLink()
        && mode === 0o600
        && (expectedUid == null || stat.uid === expectedUid)
      ),
  };
}

function readOrCreateToken(filePath) {
  const existing = readToken(filePath);
  if (existing) {
    hardenTokenFile(filePath);
    return existing;
  }
  ensurePrivateDirectory(path.dirname(filePath));
  const generated = randomBytes(32).toString('base64url');
  try {
    const descriptor = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${generated}\n`, { encoding: 'utf8' });
    } finally {
      fs.closeSync(descriptor);
    }
    hardenTokenFile(filePath);
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const raced = readToken(filePath);
    if (!raced) throw new Error(`V3 token file exists but is empty: ${filePath}`);
    hardenTokenFile(filePath);
    return raced;
  }
}

function readToken(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`V3 token path must be a regular file: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`V3 token directory must be a real directory: ${directory}`);
  }
}

function hardenTokenFile(filePath) {
  fs.chmodSync(filePath, 0o600);
  const inspected = inspectV3TokenFile(filePath);
  if (!inspected.secure) {
    throw new Error(
      `V3 token file is not private: ${filePath} mode ${inspected.mode
        .toString(8)
        .padStart(3, '0')}`,
    );
  }
}

function integer(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizeChoice(value, choices, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return choices.includes(normalized) ? normalized : fallback;
}
