import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIGRATION_SENTINEL } from '../lib/state-migration.mjs';
import { probeV3Health } from '../v3/health.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('external watchdog restores a killed supervisor and the full health gate recovers', {
  timeout: 300_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-watchdog-'));
  const stateRoot = path.join(root, 'state');
  const env = {
    ...process.env,
    PROJECT_ROOT: root,
    DATA_DIR: stateRoot,
    BRIDGE_STATE_ROOT: stateRoot,
    CODEX_WORKING_DIR: path.join(root, 'workspace'),
    DISCORD_ENABLED: 'false',
    SLACK_ENABLED: 'false',
    DAILY_MAINTENANCE_ENABLED: 'false',
    BRIDGE_EXPLICIT_ENV_KEYS: 'DAILY_MAINTENANCE_ENABLED',
    DAILY_REPORTS_ENABLED: 'false',
    CHANNEL_PYTHON_VENV_ENABLED: 'false',
    V3_STATE_ROOT: path.join(root, 'v3'),
    V3_DB_PATH: path.join(root, 'v3', 'coordination.sqlite'),
    V3_RUNTIME_SECRET_ROOT: path.join(root, 'secrets'),
    V3_INTERNAL_TOKEN: 'watchdog-health-test-token-000000000000',
    V3_RECEPTION_PORT: '0',
    V3_WORKBENCH_PORT: '0',
    V3_PLATFORM_MODE: 'console',
    V3_WORKER_MODE: 'mock',
    V3_POLL_INTERVAL_MS: '25',
    V3_HEALTH_HEARTBEAT_MS: '100',
    V3_HEALTH_STALE_MS: '1000',
    V3_ROLE_STARTUP_TIMEOUT_MS: '30000',
    V3_UNHEALTHY_GRACE_MS: '500',
    V3_WATCHDOG_ROLE_RECOVERY_MS: '60000',
    V3_WATCHDOG_POLL_MS: '100',
    V3_LEASE_TTL_MS: '1000',
    V3_LEASE_RENEW_MS: '250',
    BRIDGE_CATCHUP_WINDOW_MS: '0',
    NODE_NO_WARNINGS: '1',
  };
  await prepareIsolatedState(stateRoot);
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  const watchdog = spawn(
    process.execPath,
    [path.join(repoRoot, 'v3', 'watchdog.mjs')],
    {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  watchdog.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  watchdog.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  try {
    const firstReport = await waitFor(async () => {
      const report = await probeV3Health({
        env,
        repoRoot,
        requireWatchdog: true,
      });
      return report.ok ? report : null;
    }, { timeoutMs: 60_000 });
    const watchdogPid = firstReport.watchdog.pid;
    const firstSupervisorPid = firstReport.supervisor.pid;
    assert.equal(watchdogPid, watchdog.pid);
    assert.equal(pidAlive(firstSupervisorPid), true);

    process.kill(firstSupervisorPid, 'SIGUSR2');
    const plannedReload = await waitFor(async () => {
      const report = await probeV3Health({
        env,
        repoRoot,
        requireWatchdog: true,
      });
      return report.ok
        && report.supervisor.pid !== firstSupervisorPid
        ? report
        : null;
    }, { timeoutMs: 60_000 });
    assert.equal(plannedReload.watchdog.pid, watchdogPid);
    assert.equal(plannedReload.watchdog.restartCount, 1);
    assert.equal(plannedReload.watchdog.unexpectedExitCount, 0);

    const activeSupervisorPid = plannedReload.supervisor.pid;
    const activeReceptionPid = plannedReload.supervisor.roles.reception.pid;
    const activeWorkbenchPid = plannedReload.supervisor.roles.workbench.pid;

    process.kill(activeReceptionPid, 'SIGTERM');
    const roleRecovery = await waitFor(async () => {
      const report = await probeV3Health({
        env,
        repoRoot,
        requireWatchdog: true,
      });
      return report.ok
        && report.supervisor.pid === activeSupervisorPid
        && report.supervisor.roles.reception.pid !== activeReceptionPid
        && report.supervisor.roles.workbench.pid !== activeWorkbenchPid
        ? report
        : null;
    }, { timeoutMs: 60_000 });
    assert.equal(roleRecovery.watchdog.pid, watchdogPid);
    assert.equal(
      roleRecovery.watchdog.restartCount,
      1,
      'the watchdog raced the supervisor while it was recovering one role',
    );

    process.kill(activeSupervisorPid, 'SIGKILL');
    await waitFor(() => !pidAlive(activeSupervisorPid));

    const recovered = await waitFor(async () => {
      const report = await probeV3Health({
        env,
        repoRoot,
        requireWatchdog: true,
      });
      return report.ok && report.supervisor.pid !== activeSupervisorPid
        ? report
        : null;
    }, { timeoutMs: 60_000 });
    assert.equal(recovered.watchdog.pid, watchdogPid);
    assert.equal(recovered.watchdog.restartCount, 1);
    assert.equal(recovered.watchdog.unexpectedExitCount >= 1, true);
    assert.equal(recovered.supervisor.overall.healthy, true);
    assert.equal(
      recovered.supervisor.activeWorkbenchPort > 0,
      true,
      'the OS-assigned Worker port was not preserved by the supervisor',
    );
  } catch (error) {
    const systemRoot = path.join(stateRoot, '_system');
    const diagnostics = await Promise.all([
      readJson(path.join(systemRoot, 'v3-supervisor.json')).catch(() => null),
      readJson(path.join(systemRoot, 'v3-watchdog.json')).catch(() => null),
      readJsonl(path.join(systemRoot, 'v3-supervisor-events.jsonl')).catch(() => []),
      readJsonl(path.join(systemRoot, 'v3-watchdog-events.jsonl')).catch(() => []),
    ]);
    throw new Error([
      error.message,
      `supervisor: ${JSON.stringify(diagnostics[0])}`,
      `watchdog: ${JSON.stringify(diagnostics[1])}`,
      `supervisor events: ${JSON.stringify(diagnostics[2].slice(-20))}`,
      `watchdog events: ${JSON.stringify(diagnostics[3].slice(-20))}`,
      `watchdog output:\n${output.slice(-4_000)}`,
    ].join('\n'));
  } finally {
    await stopChild(watchdog);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  child.kill('SIGTERM');
  let timeout = null;
  const exited = await Promise.race([
    onceExited(child).then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 10_000);
    }),
  ]);
  clearTimeout(timeout);
  if (!exited && child.exitCode == null && !child.signalCode) {
    child.kill('SIGKILL');
    await onceExited(child);
  }
}

function onceExited(child) {
  if (child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function waitFor(probe, {
  timeoutMs = 5_000,
  intervalMs = 50,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readJsonl(filePath) {
  return (await fs.readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function prepareIsolatedState(stateRoot) {
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, MIGRATION_SENTINEL),
    `${new Date().toISOString()}\n`,
  );
}
