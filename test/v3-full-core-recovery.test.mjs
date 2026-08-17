import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIGRATION_SENTINEL } from '../lib/state-migration.mjs';
import { DurableBus } from '../v3/lib/durable-bus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the complete bridge core recovers the same Worker after Workbench death', {
  timeout: 90_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-core-'));
  const stateRoot = path.join(root, 'state');
  const v3Root = path.join(root, 'v3');
  const dbPath = path.join(v3Root, 'coordination.sqlite');
  const env = {
    ...process.env,
    PROJECT_ROOT: root,
    DATA_DIR: stateRoot,
    BRIDGE_STATE_ROOT: stateRoot,
    CODEX_WORKING_DIR: path.join(root, 'workspace'),
    DISCORD_BOT_TOKEN: '',
    DISCORD_ALLOWED_CHANNEL_IDS: '100000',
    DISCORD_GENERAL_CHANNEL_ID: '100000',
    SLACK_ENABLED: 'false',
    DAILY_MAINTENANCE_ENABLED: 'false',
    BRIDGE_EXPLICIT_ENV_KEYS: 'DAILY_MAINTENANCE_ENABLED',
    DAILY_REPORTS_ENABLED: 'false',
    CHANNEL_PYTHON_VENV_ENABLED: 'false',
    V3_STATE_ROOT: v3Root,
    V3_DB_PATH: dbPath,
    V3_INTERNAL_TOKEN: 'full-core-test-token',
    V3_RECEPTION_PORT: '0',
    V3_WORKBENCH_PORT: '0',
    V3_SUPERVISED: '0',
    V3_PLATFORM_MODE: 'console',
    V3_WORKER_MODE: 'mock',
    V3_POLL_INTERVAL_MS: '25',
    V3_LEASE_TTL_MS: '1000',
    V3_LEASE_RENEW_MS: '250',
    V3_WORKER_HEARTBEAT_MS: '50',
    BRIDGE_CATCHUP_WINDOW_MS: '0',
    NODE_NO_WARNINGS: '1',
  };
  await prepareIsolatedState(stateRoot);
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  let reception = null;
  let workbenchA = null;
  let workbenchB = null;
  let bus = null;
  let receptionOutput = '';
  let workbenchErrors = '';
  let workerPid = null;

  try {
    reception = spawnRole('reception', env);
    reception.stdout.on('data', (chunk) => {
      receptionOutput += String(chunk);
    });
    reception.stderr.on('data', (chunk) => {
      receptionOutput += String(chunk);
    });
    await waitFor(() => receptionOutput.includes('reception-started'));
    const receptionHealthPath = path.join(
      stateRoot,
      '_system',
      'v3-reception-health.json',
    );
    const receptionHealth = await waitFor(async () => {
      const health = await readJson(receptionHealthPath).catch(() => null);
      return health?.pid === reception.pid && health.details?.address?.url
        ? health
        : null;
    });
    env.V3_RECEPTION_URL = receptionHealth.details.address.url;

    workbenchA = spawnRole('workbench', env);
    workbenchA.stderr.on('data', (chunk) => {
      workbenchErrors += String(chunk);
    });
    await waitFor(async () => fileExists(dbPath));
    bus = new DurableBus(dbPath);
    await waitFor(() => bus.lease('workbench'));
    const workbenchHealthPath = path.join(
      stateRoot,
      '_system',
      'v3-workbench-health.json',
    );
    const workbenchHealth = await waitFor(async () => {
      const health = await readJson(workbenchHealthPath).catch(() => null);
      return health?.pid === workbenchA.pid
        && health.details?.broker?.address?.port
        ? health
        : null;
    });
    env.V3_WORKBENCH_PORT = String(
      workbenchHealth.details.broker.address.port,
    );

    const timestamp = new Date().toISOString();
    bus.publish({
      messageId: 'inbound:discord:full-core-job',
      sender: 'reception',
      recipient: 'workbench',
      jobId: 'full-core-job',
      kind: 'job.requested',
      payload: {
        event: {
          id: 'full-core-job',
          timestamp,
          authorId: 'user-1',
          authorName: 'tester',
          channelId: '100000',
          threadId: '200000',
          content: 'full core recovery',
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
            startDelayMs: 20,
            updateDelayMs: 100,
            updates: ['before replacement', 'during replacement'],
            finalDelayMs: 2_000,
            output: 'full core survived; 이미지를 보내드렸습니다.',
          },
        },
      },
    });
    const running = await waitFor(() => {
      const current = bus.getJob('full-core-job');
      return current?.status === 'running' && current.workerPid
        ? current
        : null;
    }, { timeoutMs: 15_000 });
    workerPid = running.workerPid;
    assert.match(
      running.spec.job.runtimeSourceBaseline?.['bridge-service.mjs'] || '',
      /^[a-f0-9]{64}$/,
      'pre-job runtime source baseline was not stored with the detached Worker',
    );
    assert.equal(
      Array.isArray(running.spec.job.artifactDeliveryBaseline),
      true,
      'pre-job artifact baseline was not stored with the detached Worker',
    );

    workbenchA.kill('SIGKILL');
    await onceExited(workbenchA);
    workbenchA = null;
    assert.equal(pidAlive(workerPid), true, 'Worker died with the full Workbench');
    const artifactRoot = path.join(stateRoot, '100000_common', 'artifacts');
    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.writeFile(path.join(artifactRoot, 'created-during-replacement.png'), 'image');

    // The killed generation cannot release its fencing lease. Let the short
    // test lease expire before starting generation B.
    await delay(1_100);
    workbenchB = spawnRole('workbench', env);
    workbenchB.stderr.on('data', (chunk) => {
      workbenchErrors += String(chunk);
    });

    // Job completion belongs to the detached Worker and may be persisted
    // before the replacement Workbench has finished its comparatively heavy
    // startup and recovery pass. Wait for generation B itself to report ready
    // before timing delivery through Reception.
    await waitFor(async () => {
      const health = await readJson(workbenchHealthPath).catch(() => null);
      return health?.pid === workbenchB.pid && health.ready
        ? health
        : null;
    }, { timeoutMs: 30_000 });
    await waitFor(() => bus.getJob('full-core-job')?.status === 'completed', {
      timeoutMs: 15_000,
    });
    await waitFor(() => receptionOutput.includes('full core survived'), {
      timeoutMs: 15_000,
    }).catch(async (error) => {
      const systemEvents = await readJsonl(
        path.join(stateRoot, '_system', 'events.jsonl'),
      ).catch(() => []);
      throw new Error([
        error.message,
        `workbench stderr: ${workbenchErrors}`,
        `reception tail: ${receptionOutput.slice(-2_000)}`,
        `system events: ${JSON.stringify(systemEvents.slice(-20))}`,
      ].join('\n'));
    });
    assert.match(receptionOutput, /artifacts 파일 1개/);
    assert.match(receptionOutput, /전송 완료로 간주하지 않습니다/);
    const jobsFile = path.join(
      stateRoot,
      '100000',
      '200000',
      'jobs',
      'jobs.jsonl',
    );
    await waitFor(async () => {
      const entries = await readJsonl(jobsFile).catch(() => []);
      return entries.some((entry) =>
        entry.id === 'full-core-job' && entry.status === 'done',
      );
    }, { timeoutMs: 15_000 });
    assert.equal(bus.getJob('full-core-job').workerPid, workerPid);
    assert.equal(workbenchErrors, '');
  } finally {
    if (bus?.getJob('full-core-job')?.status === 'running') {
      bus.requestCancel('full-core-job');
    }
    await stopChild(workbenchA);
    await stopChild(workbenchB);
    await stopChild(reception);
    bus?.close();
    await waitFor(() => !workerPid || !pidAlive(workerPid), {
      timeoutMs: 5_000,
    }).catch(() => {});
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

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  child.kill('SIGTERM');
  await Promise.race([
    onceExited(child),
    delay(5_000).then(() => {
      if (child.exitCode == null && !child.signalCode) child.kill('SIGKILL');
    }),
  ]);
}

function onceExited(child) {
  if (child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function readJsonl(filePath) {
  return (await fs.readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

async function prepareIsolatedState(stateRoot) {
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, MIGRATION_SENTINEL),
    `${new Date().toISOString()}\n`,
  );
}
