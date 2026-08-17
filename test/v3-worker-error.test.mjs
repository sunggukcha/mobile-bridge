import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workerFailure } from '../v3/lib/detached-worker-broker.mjs';
import { DurableBus } from '../v3/lib/durable-bus.mjs';
import { WorkerRuntime, workerErrorMetadata } from '../v3/lib/worker-runtime.mjs';

test('detached Worker errors preserve retry and classification metadata', () => {
  const source = new Error('provider quota exhausted');
  source.code = 'WORKER_COOLDOWN_ACTIVE';
  source.workerAvailabilityRetryAtMs = 1_800_000_000_000;
  source.inputLimit = true;
  source.promptChars = 123_456;
  source.timedOut = false;
  source.noProgressKilled = true;
  source.abortReason = 'provider stalled';
  source.workerAttempts = [{ worker: 'codex', status: 'failed' }];
  source.workerTranscripts = [{ worker: 'codex', output: 'bounded transcript' }];

  const metadata = workerErrorMetadata(source);
  assert.equal(metadata.code, 'WORKER_COOLDOWN_ACTIVE');
  assert.equal(metadata.inputLimit, true);
  assert.equal(metadata.promptChars, 123_456);
  assert.equal(metadata.workerAttempts, undefined);
  assert.equal(metadata.workerTranscripts, undefined);

  const restored = workerFailure({
    error: source.message,
    errorMeta: metadata,
    worker: 'codex',
    workerAttempts: source.workerAttempts,
    workerTranscripts: source.workerTranscripts,
  });
  assert.equal(restored.code, 'WORKER_COOLDOWN_ACTIVE');
  assert.equal(restored.workerAvailabilityRetryAtMs, 1_800_000_000_000);
  assert.equal(restored.inputLimit, true);
  assert.equal(restored.promptChars, 123_456);
  assert.equal(restored.noProgressKilled, true);
  assert.equal(restored.abortReason, 'provider stalled');
  assert.deepEqual(restored.workerAttempts, source.workerAttempts);
  assert.deepEqual(restored.workerTranscripts, source.workerTranscripts);
});

test('WorkerRuntime publishes the original failure through the synchronous durable bus', async () => {
  const fixture = await workerRuntimeFailureFixture();
  try {
    const outcome = await fixture.runtime.run();
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, fixture.failure);

    const job = fixture.bus.getJob(fixture.jobId);
    assert.equal(job.status, 'failed');
    assert.match(job.result.error, /provider failed code=1 stderr=provider stack/);
    assert.deepEqual(job.result.attempts, fixture.failure.workerAttempts);
    assert.deepEqual(job.result.workerTranscripts, fixture.failure.workerTranscripts);

    const terminal = fixture.bus
      .unacknowledgedForJob('workbench', fixture.jobId)
      .find((message) => message.kind === 'worker.failed');
    assert.ok(terminal);
    assert.match(terminal.payload.error, /provider failed code=1 stderr=provider stack/);
    assert.deepEqual(terminal.payload.workerAttempts, fixture.failure.workerAttempts);
    assert.deepEqual(terminal.payload.workerTranscripts, fixture.failure.workerTranscripts);
  } finally {
    await fixture.close();
  }
});

test('WorkerRuntime keeps the durable original failure when terminal publication throws', async () => {
  const logs = [];
  const fixture = await workerRuntimeFailureFixture({
    onLog: (type, payload) => logs.push({ type, payload }),
  });
  const publish = fixture.runtime.publish.bind(fixture.runtime);
  fixture.runtime.publish = (kind, payload) => {
    if (kind === 'worker.failed') throw new Error('terminal event write failed');
    return publish(kind, payload);
  };

  try {
    const outcome = await fixture.runtime.run();
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, fixture.failure);
    assert.equal(fixture.bus.getJob(fixture.jobId).status, 'failed');
    assert.match(fixture.bus.getJob(fixture.jobId).result.error, /provider failed/);
    assert.equal(
      fixture.bus.unacknowledgedForJob('workbench', fixture.jobId)
        .some((message) => message.kind === 'worker.failed'),
      false,
    );
    assert.deepEqual(logs.filter((entry) => entry.type === 'worker-terminal-event-persist-failed'), [{
      type: 'worker-terminal-event-persist-failed',
      payload: {
        jobId: fixture.jobId,
        status: 'failed',
        error: 'terminal event write failed',
      },
    }]);
  } finally {
    await fixture.close();
  }
});

async function workerRuntimeFailureFixture({ onLog = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-worker-error-'));
  const bus = new DurableBus(path.join(root, 'coordination.sqlite'));
  const jobId = 'worker-error-job';
  bus.createJob({
    jobId,
    inboundMessageId: 'worker-error-inbound',
    channelId: 'channel-1',
    threadId: 'thread-1',
    spec: {
      protocolVersion: 2,
      workerMode: 'agent',
      job: {
        id: jobId,
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      prompt: 'fail with preserved diagnostics',
    },
  });
  bus.reserveLaunch(jobId, { launcherId: 'test-launcher' });

  const failure = new Error('provider failed');
  failure.code = 1;
  failure.stderr = 'provider stack';
  failure.worker = 'antigravity-gemini-test';
  failure.workerAttempts = [{ worker: failure.worker, status: 'failed' }];
  failure.workerTranscripts = [{
    worker: failure.worker,
    status: 'failed',
    stderr: failure.stderr,
  }];
  const runtime = new WorkerRuntime({
    bus,
    bridgeConfig: {},
    jobId,
    token: 'worker-error-token',
    workbenchUrl: 'ws://127.0.0.1:9',
    heartbeatMs: 10_000,
    agentRunner: async () => {
      throw failure;
    },
    onLog,
  });
  runtime.client = {
    start() {},
    stop() {},
    wake() { return false; },
  };

  return {
    root,
    bus,
    jobId,
    runtime,
    failure,
    async close() {
      bus.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
