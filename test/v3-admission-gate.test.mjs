import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIGRATION_SENTINEL } from '../lib/state-migration.mjs';
import { DurableBus } from '../v3/lib/durable-bus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('supervised Workbench keeps new jobs durable but unstarted until admission opens', {
  timeout: 60_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-admission-'));
  const stateRoot = path.join(root, 'state');
  const v3Root = path.join(root, 'v3');
  const dbPath = path.join(v3Root, 'coordination.sqlite');
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
    V3_STATE_ROOT: v3Root,
    V3_DB_PATH: dbPath,
    V3_INTERNAL_TOKEN: 'admission-gate-test-token',
    V3_RECEPTION_PORT: '0',
    V3_WORKBENCH_PORT: '0',
    V3_PLATFORM_MODE: 'console',
    V3_WORKER_MODE: 'mock',
    V3_SUPERVISED: '1',
    V3_POLL_INTERVAL_MS: '25',
    V3_LEASE_TTL_MS: '1000',
    V3_LEASE_RENEW_MS: '250',
    V3_WORKER_HEARTBEAT_MS: '50',
    V3_HEALTH_HEARTBEAT_MS: '100',
    BRIDGE_CATCHUP_WINDOW_MS: '0',
    NODE_NO_WARNINGS: '1',
  };
  await prepareIsolatedState(stateRoot);
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  let reception = null;
  let workbench = null;
  let bus = null;
  let receptionOutput = '';
  let workbenchOutput = '';

  try {
    reception = spawnRole('reception', env);
    reception.stdout.on('data', (chunk) => {
      receptionOutput += String(chunk);
    });
    reception.stderr.on('data', (chunk) => {
      receptionOutput += String(chunk);
    });
    const receptionHealth = await waitFor(async () => {
      const health = await readJson(path.join(
        stateRoot,
        '_system',
        'v3-reception-health.json',
      )).catch(() => null);
      return health?.ready && health.details?.address?.url ? health : null;
    });
    env.V3_RECEPTION_URL = receptionHealth.details.address.url;

    workbench = spawn(
      process.execPath,
      [path.join(repoRoot, 'v3', 'workbench.mjs')],
      {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    workbench.stdout.on('data', (chunk) => {
      workbenchOutput += String(chunk);
    });
    workbench.stderr.on('data', (chunk) => {
      workbenchOutput += String(chunk);
    });

    await waitFor(async () => {
      const health = await readJson(path.join(
        stateRoot,
        '_system',
        'v3-workbench-health.json',
      )).catch(() => null);
      return health?.pid === workbench.pid
        && health.details?.initialized
        && health.details?.admissionEnabled === false
        && health.phase === 'waiting-for-admission'
        ? health
        : null;
    }, { timeoutMs: 10_000 });

    bus = new DurableBus(dbPath);
    const timestamp = new Date().toISOString();
    bus.publish({
      messageId: 'inbound:discord:admission-job',
      sender: 'reception',
      recipient: 'workbench',
      jobId: 'admission-job',
      kind: 'job.requested',
      payload: {
        event: {
          id: 'admission-job',
          timestamp,
          authorId: 'user-1',
          authorName: 'tester',
          channelId: '100000',
          threadId: '200000',
          content: 'admission gate test',
          platform: 'discord',
          source: 'discord',
          attachments: [],
          embeds: [],
        },
        reply: {
          platform: 'discord',
          destination: { channelId: '200000' },
        },
        options: {
          repoAccess: true,
          repoPath: repoRoot,
          workerMode: 'mock',
          mockPlan: {
            startDelayMs: 10,
            updateDelayMs: 10,
            updates: ['admitted'],
            finalDelayMs: 10,
            output: 'admission opened',
          },
        },
      },
    });

    await delay(300);
    assert.equal(
      bus.getJob('admission-job'),
      null,
      'a supervised Workbench started a Worker before admission was enabled',
    );
    assert.equal(bus.pendingCount('workbench') > 0, true);

    workbench.send({
      type: 'v3-workbench-admission',
      enabled: true,
      reason: 'test-reception-ready',
    });
    await waitFor(
      () => bus.getJob('admission-job')?.status === 'completed',
      { timeoutMs: 10_000 },
    );
    await waitFor(
      () => receptionOutput.includes('admission opened'),
      { timeoutMs: 10_000 },
    );
    assert.doesNotMatch(workbenchOutput, /fatal|uncaught|unhandled/i);
  } finally {
    if (bus?.activeJobs().length) {
      for (const active of bus.activeJobs()) {
        bus.requestCancel(active.jobId, { reason: 'cancelled-by:test-cleanup' });
      }
    }
    await stopChild(workbench);
    await stopChild(reception);
    bus?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function spawnRole(role, env) {
  return spawn(process.execPath, [path.join(repoRoot, 'v3', `${role}.mjs`)], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    onceExited(child).then(() => true),
    delay(5_000).then(() => false),
  ]);
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
  timeoutMs = 15_000,
  intervalMs = 25,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareIsolatedState(stateRoot) {
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, MIGRATION_SENTINEL),
    `${new Date().toISOString()}\n`,
  );
}
