import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { DurableBus } from '../v3/lib/durable-bus.mjs';
import { ReceptionService } from '../v3/lib/reception-service.mjs';
import { WorkbenchService } from '../v3/lib/workbench-service.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a detached Worker survives Workbench replacement and stored events resume in order', {
  timeout: 15_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-restart-'));
  const stateRoot = path.join(root, 'state');
  const dbPath = path.join(root, 'coordination.sqlite');
  const workerLogRoot = path.join(root, 'worker-logs');
  let workerPort = 0;
  const token = 'integration-test-token';
  const bridgeConfig = {
    ...loadConfig({
      PROJECT_ROOT: root,
      BRIDGE_STATE_ROOT: stateRoot,
      CODEX_WORKING_DIR: path.join(root, 'workspace'),
      DISCORD_ALLOWED_CHANNEL_IDS: 'channel-1',
      CODEX_MAX_CONCURRENT_JOBS: '1',
      DAILY_MAINTENANCE_ENABLED: 'false',
      BRIDGE_EXPLICIT_ENV_KEYS: 'DAILY_MAINTENANCE_ENABLED',
      DAILY_REPORTS_ENABLED: 'false',
      CHANNEL_PYTHON_VENV_ENABLED: 'false',
    }),
    bridgeRepoRoot: repoRoot,
    jobProgressForwardDelayMs: 0,
  };
  const receptionBus = new DurableBus(dbPath);
  const workbenchBusA = new DurableBus(dbPath);
  let workbenchBusB = null;
  const deliveries = [];
  const reception = new ReceptionService({
    bus: receptionBus,
    host: '127.0.0.1',
    port: 0,
    token,
    adapters: {
      discord: {
        async deliver(message) {
          deliveries.push(message);
        },
      },
    },
    instanceId: 'reception-test',
    pollIntervalMs: 25,
    leaseTtlMs: 2_000,
    leaseRenewMs: 250,
  });
  let workbenchA = null;
  let workbenchB = null;

  try {
    await reception.start();
    workbenchA = createWorkbench({
      bus: workbenchBusA,
      bridgeConfig,
      dbPath,
      workerLogRoot,
      workerPort,
      token,
      receptionUrl: reception.status().address.url,
      instanceId: 'workbench-a',
    });
    await workbenchA.start();
    workerPort = workbenchA.status().workerAddress.port;

    await reception.submitInbound({
      jobId: 'restart-job',
      messageId: 'inbound:discord:restart-job',
      event: {
        id: 'restart-job',
        timestamp: new Date().toISOString(),
        authorId: 'user-1',
        authorName: 'tester',
        channelId: 'channel-1',
        threadId: 'thread-1',
        content: 'prove worker survival',
        platform: 'discord',
        attachments: [],
        embeds: [],
      },
      reply: {
        platform: 'discord',
        destination: { channelId: 'thread-1' },
      },
      options: {
        workerMode: 'mock',
        mockPlan: {
          startDelayMs: 200,
          updateDelayMs: 100,
          updates: ['progress one', 'progress two'],
          finalDelayMs: 3_000,
          output: 'final result',
        },
      },
    });

    const runningJob = await waitFor(() => {
      const job = receptionBus.getJob('restart-job');
      return job?.status === 'running' && job.workerPid ? job : null;
    });
    await workbenchA.stop();
    workbenchA = null;

    assert.equal(pidAlive(runningJob.workerPid), true, 'Worker died with Workbench A');
    await waitFor(() => receptionBus.pendingCount('workbench') >= 2);
    assert.ok(
      ['running', 'completed'].includes(
        receptionBus.getJob('restart-job')?.status,
      ),
      'Worker was lost or cancelled during the Workbench patch window',
    );
    assert.equal(deliveries.length, 0);

    workbenchBusB = new DurableBus(dbPath);
    workbenchB = createWorkbench({
      bus: workbenchBusB,
      bridgeConfig,
      dbPath,
      workerLogRoot,
      workerPort,
      token,
      receptionUrl: reception.status().address.url,
      instanceId: 'workbench-b',
    });
    await workbenchB.start();
    await waitFor(() => receptionBus.getJob('restart-job')?.status === 'completed');
    await waitFor(() => deliveries.length === 4);

    assert.deepEqual(
      deliveries.map((delivery) => delivery.content),
      [
        'mock 작업을 시작했습니다.',
        'progress one',
        'progress two',
        'final result',
      ],
    );
    assert.deepEqual(
      deliveries.map((delivery) => delivery.sequence),
      [1, 2, 3, 4],
    );
    assert.equal(receptionBus.pendingCount('workbench'), 0);
    assert.equal(receptionBus.pendingCount('reception'), 0);
  } finally {
    await workbenchA?.stop().catch(() => {});
    await workbenchB?.stop().catch(() => {});
    await reception.stop().catch(() => {});
    workbenchBusA.close();
    workbenchBusB?.close();
    receptionBus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createWorkbench({
  bus,
  bridgeConfig,
  dbPath,
  workerLogRoot,
  workerPort,
  token,
  receptionUrl,
  instanceId,
}) {
  return new WorkbenchService({
    bus,
    bridgeConfig,
    repoRoot,
    dbPath,
    token,
    receptionUrl,
    workerHost: '127.0.0.1',
    workerPort,
    workerLogRoot,
    workerMode: 'mock',
    instanceId,
    pollIntervalMs: 25,
    leaseTtlMs: 2_000,
    leaseRenewMs: 250,
    launchGraceMs: 200,
    workerHeartbeatMs: 50,
    maxConcurrentJobs: 1,
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
