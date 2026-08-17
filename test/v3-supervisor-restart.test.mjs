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

test('v3 supervisor replaces Workbench while the detached Worker PID survives', {
  timeout: 60_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-supervisor-'));
  const stateRoot = path.join(root, 'state');
  const v3Root = path.join(root, 'v3');
  const dbPath = path.join(v3Root, 'coordination.sqlite');
  const eventsPath = path.join(
    stateRoot,
    '_system',
    'v3-supervisor-events.jsonl',
  );
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
    V3_INTERNAL_TOKEN: 'supervisor-restart-token',
    V3_RECEPTION_PORT: '0',
    V3_WORKBENCH_PORT: '0',
    V3_PLATFORM_MODE: 'console',
    V3_WORKER_MODE: 'mock',
    V3_POLL_INTERVAL_MS: '25',
    V3_LEASE_TTL_MS: '1000',
    V3_LEASE_RENEW_MS: '250',
    V3_HEALTH_HEARTBEAT_MS: '100',
    V3_HEALTH_STALE_MS: '1000',
    V3_UNHEALTHY_GRACE_MS: '500',
    V3_ROLE_STOP_TIMEOUT_MS: '3000',
    V3_WORKER_HEARTBEAT_MS: '50',
    BRIDGE_CATCHUP_WINDOW_MS: '0',
    NODE_NO_WARNINGS: '1',
  };
  await prepareIsolatedState(stateRoot);
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  let supervisor = null;
  let bus = null;
  let output = '';
  let workerPid = null;
  const rolePids = new Set();

  try {
    supervisor = spawn(
      process.execPath,
      [path.join(repoRoot, 'v3', 'supervisor.mjs')],
      {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    supervisor.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    supervisor.stderr.on('data', (chunk) => {
      output += String(chunk);
    });

    const firstWorkbench = await waitFor(async () => {
      const events = await readJsonl(eventsPath).catch(() => []);
      return events.find((entry) =>
        entry.type === 'v3-role-started' && entry.role === 'workbench'
      ) || null;
    });
    rolePids.add(firstWorkbench.pid);
    bus = new DurableBus(dbPath);
    await waitFor(() => bus.lease('workbench'));

    const timestamp = new Date().toISOString();
    bus.publish({
      messageId: 'inbound:discord:supervisor-restart-job',
      sender: 'reception',
      recipient: 'workbench',
      jobId: 'supervisor-restart-job',
      kind: 'job.requested',
      payload: {
        event: {
          id: 'supervisor-restart-job',
          timestamp,
          authorId: 'user-1',
          authorName: 'tester',
          channelId: '100000',
          threadId: '200000',
          content: 'supervisor replacement test',
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
            updates: ['before supervisor replacement', 'during replacement'],
            // Keep the Worker alive well beyond a loaded CI host's graceful
            // Workbench shutdown. A short delay made natural completion look
            // like a lifecycle failure in the full parallel suite.
            finalDelayMs: 20_000,
            output: 'supervisor replacement survived',
          },
        },
      },
    });
    const running = await waitFor(() => {
      const current = bus.getJob('supervisor-restart-job');
      return current?.status === 'running' && current.workerPid
        ? current
        : null;
    }, { timeoutMs: 15_000 });
    workerPid = running.workerPid;

    process.kill(firstWorkbench.pid, 'SIGTERM');
    await waitFor(
      () => !pidAlive(firstWorkbench.pid),
      { timeoutMs: 15_000 },
    );
    assert.equal(
      pidAlive(workerPid),
      true,
      `Worker died with Workbench generation A (durable status: ${
        bus.getJob('supervisor-restart-job')?.status || 'missing'
      })`,
    );

    const secondWorkbench = await waitFor(async () => {
      const events = await readJsonl(eventsPath).catch(() => []);
      return events.find((entry) =>
        entry.type === 'v3-role-started'
        && entry.role === 'workbench'
        && entry.pid !== firstWorkbench.pid
      ) || null;
    }, { timeoutMs: 15_000 });
    rolePids.add(secondWorkbench.pid);
    assert.equal(pidAlive(workerPid), true, 'Worker died during Workbench handoff');

    // Let any stale replacement timer fire. There must still be exactly one
    // replacement generation; a second child would be lost from the role map
    // and contend with the first generation's lease.
    await delay(750);
    const startsAfterHandoff = (await readJsonl(eventsPath)).filter((entry) =>
      entry.type === 'v3-role-started' && entry.role === 'workbench'
    );
    assert.deepEqual(
      startsAfterHandoff.map((entry) => entry.pid),
      [firstWorkbench.pid, secondWorkbench.pid],
    );

    await waitFor(
      () => bus.getJob('supervisor-restart-job')?.status === 'completed',
      { timeoutMs: 30_000 },
    );
    await waitFor(
      () => output.includes('supervisor replacement survived'),
      { timeoutMs: 30_000 },
    );
    assert.equal(bus.getJob('supervisor-restart-job').workerPid, workerPid);

    const events = await readJsonl(eventsPath);
    assert.ok(events.some((entry) =>
      entry.type === 'v3-role-exit'
      && entry.role === 'workbench'
      && entry.pid === firstWorkbench.pid
    ));
  } finally {
    if (bus?.activeJobs().length) {
      for (const active of bus.activeJobs()) {
        bus.requestCancel(active.jobId, { reason: 'cancelled-by:test-cleanup' });
      }
    }
    await stopChild(supervisor);
    for (const pid of rolePids) {
      await waitFor(() => !pidAlive(pid), { timeoutMs: 5_000 }).catch(() => {});
    }
    await waitFor(() => !workerPid || !pidAlive(workerPid), {
      timeoutMs: 5_000,
    }).catch(() => {});
    bus?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function readJsonl(filePath) {
  return (await fs.readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  child.kill('SIGTERM');
  await Promise.race([
    onceExited(child),
    new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => {
      if (child.exitCode == null && !child.signalCode) child.kill('SIGKILL');
    }),
  ]);
}

function onceExited(child) {
  if (child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function waitFor(probe, {
  timeoutMs = 5_000,
  intervalMs = 25,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
