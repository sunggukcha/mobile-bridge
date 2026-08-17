import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { DurableBus } from '../v3/lib/durable-bus.mjs';
import { detachedWorkerExecutionId } from '../v3/lib/detached-worker-broker.mjs';
import { FullWorkbenchRuntime } from '../v3/lib/full-workbench-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the full Workbench reattaches to the same detached Worker generation', {
  timeout: 15_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-full-'));
  const stateRoot = path.join(root, 'state');
  const dbPath = path.join(root, 'coordination.sqlite');
  const workerLogRoot = path.join(root, 'worker-logs');
  let workerPort = 0;
  const token = 'full-workbench-test-token';
  const bridgeConfig = {
    ...loadConfig({
      PROJECT_ROOT: root,
      BRIDGE_STATE_ROOT: stateRoot,
      CODEX_WORKING_DIR: path.join(root, 'workspace'),
      DISCORD_ALLOWED_CHANNEL_IDS: 'channel-1',
      DAILY_MAINTENANCE_ENABLED: 'false',
      BRIDGE_EXPLICIT_ENV_KEYS: 'DAILY_MAINTENANCE_ENABLED',
      DAILY_REPORTS_ENABLED: 'false',
      CHANNEL_PYTHON_VENV_ENABLED: 'false',
    }),
    bridgeRepoRoot: repoRoot,
  };
  const busA = new DurableBus(dbPath);
  let busB = null;
  let runtimeA = null;
  let runtimeB = null;
  let workerPid = null;
  let firstExecution = null;

  const job = {
    id: 'full-restart-job',
    channelId: 'channel-1',
    threadId: 'thread-1',
    concurrencyKey: 'channel-1:thread-1',
    priority: 1,
    event: {
      id: 'full-restart-job',
      timestamp: new Date().toISOString(),
      channelId: 'channel-1',
      threadId: 'thread-1',
      content: 'detached full Workbench test',
    },
    workerMode: 'mock',
    mockPlan: {
      startDelayMs: 20,
      updateDelayMs: 100,
      updates: ['one', 'two', 'three'],
      finalDelayMs: 300,
      output: 'survived result',
    },
  };

  try {
    runtimeA = createRuntime({
      bus: busA,
      bridgeConfig,
      dbPath,
      workerLogRoot,
      workerPort,
      token,
      instanceId: 'full-a',
    });
    await runtimeA.start({ paused: false });
    workerPort = runtimeA.status().broker.address.port;
    let firstUpdateResolve;
    const firstUpdate = new Promise((resolve) => {
      firstUpdateResolve = resolve;
    });
    firstExecution = runtimeA.executeAgentJob({
      config: bridgeConfig,
      job,
      prompt: 'mock prompt',
      onUpdate: (update) => firstUpdateResolve(update),
    });
    const update = await firstUpdate;
    assert.equal(update.text, 'one');
    const running = await waitFor(() => {
      const current = busA.getJob(job.id);
      return current?.status === 'running' && current.workerPid
        ? current
        : null;
    });
    workerPid = running.workerPid;

    await runtimeA.stop();
    runtimeA = null;
    await assert.rejects(
      firstExecution,
      /Workbench stopped while detached Worker continues running/,
    );
    assert.equal(pidAlive(workerPid), true, 'detached Worker died with Workbench A');
    await waitFor(() => busA.getJob(job.id)?.status === 'completed');

    busB = new DurableBus(dbPath);
    runtimeB = createRuntime({
      bus: busB,
      bridgeConfig,
      dbPath,
      workerLogRoot,
      workerPort,
      token,
      instanceId: 'full-b',
    });
    await runtimeB.start({ paused: false });
    const replayed = [];
    const result = await runtimeB.executeAgentJob({
      config: bridgeConfig,
      job,
      prompt: 'rebuilt prompt is ignored for the existing durable job',
      onUpdate: (entry) => replayed.push(entry.text),
    });

    assert.equal(result.output, 'survived result');
    assert.equal(busB.getJob(job.id).workerPid, workerPid);
    assert.equal(busB.getJob(job.id).status, 'completed');
    assert.ok(replayed.includes('two') || replayed.includes('three'));
    assert.equal(busB.pendingCount('workbench'), 0);
  } finally {
    if (busA.getJob(job.id)?.status === 'running') busA.requestCancel(job.id);
    await runtimeA?.stop().catch(() => {});
    await runtimeB?.stop().catch(() => {});
    await waitFor(() => !workerPid || !pidAlive(workerPid), {
      timeoutMs: 5_000,
    }).catch(() => {});
    busB?.close();
    busA.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a legacy retry receives a new durable Worker execution generation', {
  timeout: 10_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-retry-'));
  const stateRoot = path.join(root, 'state');
  const dbPath = path.join(root, 'coordination.sqlite');
  const workerLogRoot = path.join(root, 'worker-logs');
  const workerPort = 0;
  const bridgeConfig = {
    ...loadConfig({
      PROJECT_ROOT: root,
      BRIDGE_STATE_ROOT: stateRoot,
      CODEX_WORKING_DIR: path.join(root, 'workspace'),
      DISCORD_ALLOWED_CHANNEL_IDS: 'channel-1',
      DAILY_MAINTENANCE_ENABLED: 'false',
      BRIDGE_EXPLICIT_ENV_KEYS: 'DAILY_MAINTENANCE_ENABLED',
      DAILY_REPORTS_ENABLED: 'false',
      CHANNEL_PYTHON_VENV_ENABLED: 'false',
    }),
    bridgeRepoRoot: repoRoot,
  };
  const bus = new DurableBus(dbPath);
  const runtime = createRuntime({
    bus,
    bridgeConfig,
    dbPath,
    workerLogRoot,
    workerPort,
    token: 'retry-test-token',
    instanceId: 'retry-workbench',
  });
  const baseJob = {
    id: 'legacy-retry-job',
    channelId: 'channel-1',
    threadId: 'thread-1',
    concurrencyKey: 'channel-1:thread-1',
    priority: 1,
    event: {
      id: 'legacy-retry-job',
      timestamp: new Date().toISOString(),
      channelId: 'channel-1',
      threadId: 'thread-1',
      content: 'retry generation test',
    },
    workerMode: 'mock',
  };

  try {
    await runtime.start({ paused: false });
    await assert.rejects(
      runtime.executeAgentJob({
        config: bridgeConfig,
        job: {
          ...baseJob,
          attempt: 1,
          mockPlan: {
            startDelayMs: 5,
            updateDelayMs: 5,
            updates: [],
            finalDelayMs: 5,
            output: 'first execution failed',
            fail: true,
          },
        },
        prompt: 'first attempt',
      }),
      /first execution failed/,
    );
    assert.equal(bus.getJob('legacy-retry-job').status, 'failed');

    const retryJob = {
      ...baseJob,
      attempt: 2,
      mockPlan: {
        startDelayMs: 5,
        updateDelayMs: 5,
        updates: [],
        finalDelayMs: 5,
        output: 'second execution succeeded',
        fail: false,
      },
    };
    assert.equal(
      detachedWorkerExecutionId(retryJob),
      'legacy-retry-job:attempt:2',
    );
    const result = await runtime.executeAgentJob({
      config: bridgeConfig,
      job: retryJob,
      prompt: 'second attempt',
    });
    assert.equal(result.output, 'second execution succeeded');
    assert.equal(
      bus.getJob('legacy-retry-job:attempt:2').status,
      'completed',
    );
    await waitFor(() => bus.pendingCount('workbench') === 0);
  } finally {
    await runtime.stop().catch(() => {});
    bus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('paused Workbench blocks every new Worker launch, not only inbox draining', {
  timeout: 10_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-paused-worker-'));
  const stateRoot = path.join(root, 'state');
  const dbPath = path.join(root, 'coordination.sqlite');
  const bridgeConfig = {
    ...loadConfig({
      PROJECT_ROOT: root,
      BRIDGE_STATE_ROOT: stateRoot,
      CODEX_WORKING_DIR: path.join(root, 'workspace'),
      DISCORD_ALLOWED_CHANNEL_IDS: 'channel-1',
      DAILY_MAINTENANCE_ENABLED: 'false',
      BRIDGE_EXPLICIT_ENV_KEYS: 'DAILY_MAINTENANCE_ENABLED',
      DAILY_REPORTS_ENABLED: 'false',
      CHANNEL_PYTHON_VENV_ENABLED: 'false',
    }),
    bridgeRepoRoot: repoRoot,
  };
  const bus = new DurableBus(dbPath);
  const runtime = createRuntime({
    bus,
    bridgeConfig,
    dbPath,
    workerLogRoot: path.join(root, 'worker-logs'),
    workerPort: 0,
    token: 'paused-worker-test-token',
    instanceId: 'paused-worker-workbench',
  });
  const job = {
    id: 'paused-worker-job',
    channelId: 'channel-1',
    threadId: 'thread-1',
    concurrencyKey: 'channel-1:thread-1',
    priority: 1,
    event: {
      id: 'paused-worker-job',
      timestamp: new Date().toISOString(),
      channelId: 'channel-1',
      threadId: 'thread-1',
      content: 'paused Worker launch test',
    },
    workerMode: 'mock',
    mockPlan: {
      startDelayMs: 5,
      updateDelayMs: 5,
      updates: [],
      finalDelayMs: 5,
      output: 'launched after admission',
    },
  };

  try {
    await runtime.start({ paused: true });
    const execution = runtime.executeAgentJob({
      config: bridgeConfig,
      job,
      prompt: 'must wait',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      bus.getJob(job.id),
      null,
      'a direct scheduler/recovery path bypassed paused admission',
    );

    runtime.resume();
    const result = await execution;
    assert.equal(result.output, 'launched after admission');
    assert.equal(bus.getJob(job.id).status, 'completed');
  } finally {
    await runtime.stop().catch(() => {});
    bus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createRuntime({
  bus,
  bridgeConfig,
  dbPath,
  workerLogRoot,
  workerPort,
  token,
  instanceId,
}) {
  return new FullWorkbenchRuntime({
    bus,
    bridgeConfig,
    repoRoot,
    dbPath,
    token,
    receptionUrl: 'ws://127.0.0.1:9',
    workerHost: '127.0.0.1',
    workerPort,
    workerLogRoot,
    workerMode: 'mock',
    instanceId,
    pollIntervalMs: 25,
    leaseTtlMs: 2_000,
    leaseRenewMs: 250,
    workerHeartbeatMs: 50,
    onInbound: async () => {},
  });
}

async function waitFor(probe, {
  timeoutMs = 5_000,
  intervalMs = 20,
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
