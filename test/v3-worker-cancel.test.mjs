import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { DurableBus } from '../v3/lib/durable-bus.mjs';
import {
  detachedWorkerEnvironment,
} from '../v3/lib/detached-worker-broker.mjs';
import { FullWorkbenchRuntime } from '../v3/lib/full-workbench-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('cancel and supersede terminate detached Workers with their durable reason', {
  timeout: 20_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-cancel-'));
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
  const runtime = new FullWorkbenchRuntime({
    bus,
    bridgeConfig,
    repoRoot,
    dbPath,
    token: 'worker-cancel-test-token',
    receptionUrl: 'ws://127.0.0.1:9',
    workerHost: '127.0.0.1',
    workerPort,
    workerLogRoot,
    workerMode: 'mock',
    instanceId: 'worker-cancel-workbench',
    pollIntervalMs: 25,
    leaseTtlMs: 2_000,
    leaseRenewMs: 250,
    workerHeartbeatMs: 50,
    onInbound: async () => {},
  });
  const workerPids = [];

  try {
    await runtime.start({ paused: false });
    for (const [index, reason] of [
      'cancelled-by:cancel-message',
      'superseded-by:newer-message',
    ].entries()) {
      const jobId = `cancel-job-${index + 1}`;
      const controller = new AbortController();
      const execution = runtime.executeAgentJob({
        config: bridgeConfig,
        job: {
          id: jobId,
          channelId: 'channel-1',
          threadId: `thread-${index + 1}`,
          concurrencyKey: `channel-1:thread-${index + 1}`,
          priority: 1,
          event: {
            id: jobId,
            timestamp: new Date().toISOString(),
            channelId: 'channel-1',
            threadId: `thread-${index + 1}`,
            content: 'wait until cancelled',
          },
          workerMode: 'mock',
          mockPlan: {
            startDelayMs: 10,
            updateDelayMs: 10,
            updates: ['started'],
            finalDelayMs: 10_000,
            output: 'must not complete',
          },
        },
        prompt: 'cancel test',
        signal: controller.signal,
      });
      const running = await waitFor(() => {
        const current = bus.getJob(jobId);
        return current?.status === 'running' && current.workerPid
          ? current
          : null;
      });
      workerPids.push(running.workerPid);

      controller.abort(reason);
      await assert.rejects(execution, (error) => {
        assert.equal(error.aborted, true);
        assert.equal(error.cancelled, true);
        assert.equal(error.abortReason, reason);
        return true;
      });
      const cancelled = await waitFor(() => {
        const current = bus.getJob(jobId);
        return current?.status === 'cancelled' ? current : null;
      });
      assert.equal(cancelled.cancelReason, reason);
      await waitFor(() => !pidAlive(running.workerPid));
    }
  } finally {
    for (const active of bus.activeJobs()) {
      bus.requestCancel(active.jobId, { reason: 'cancelled-by:test-cleanup' });
    }
    await runtime.stop().catch(() => {});
    await Promise.all(workerPids.map((pid) =>
      waitFor(() => !pidAlive(pid), { timeoutMs: 5_000 }).catch(() => null),
    ));
    bus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('detached Worker environment excludes Reception platform credentials', () => {
  const env = detachedWorkerEnvironment({
    DISCORD_BOT_TOKEN: 'discord-secret',
    SLACK_APP_TOKEN: 'slack-app-secret',
    SLACK_BOT_TOKEN: 'slack-bot-secret',
    BRIDGE_GH_CONFIG_DIR: '/safe/gh',
  }, {
    V3_INTERNAL_TOKEN: 'internal-worker-token',
  });

  assert.equal(env.DISCORD_BOT_TOKEN, undefined);
  assert.equal(env.SLACK_APP_TOKEN, undefined);
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  assert.equal(env.BRIDGE_GH_CONFIG_DIR, '/safe/gh');
  assert.equal(env.V3_INTERNAL_TOKEN, 'internal-worker-token');
  assert.equal(env.BRIDGE_RUNTIME_ROLE, 'v3-worker');
});

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
