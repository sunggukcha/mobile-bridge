import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableBus } from '../v3/lib/durable-bus.mjs';
import { DetachedWorkerBroker } from '../v3/lib/detached-worker-broker.mjs';

async function createBroker({ orphanMessageMinAgeMs = 0 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-orphan-'));
  const bus = new DurableBus(path.join(root, 'bus.sqlite'));
  const logs = [];
  const broker = new DetachedWorkerBroker({
    bus,
    bridgeConfig: { stateRoot: root },
    repoRoot: root,
    dbPath: path.join(root, 'bus.sqlite'),
    token: 'test-token',
    port: 0,
    workerLogRoot: path.join(root, 'worker-logs'),
    instanceId: 'broker-under-test',
    orphanMessageMinAgeMs,
    onLog: (type, payload) => logs.push({ type, payload }),
  });
  return { root, bus, broker, logs };
}

function publishWorkerMessage(bus, jobId, kind, messageId) {
  return bus.publish({
    messageId,
    sender: 'worker',
    recipient: 'workbench',
    jobId,
    kind,
    payload: {},
  });
}

function createJobRow(bus, jobId) {
  return bus.createJob({
    jobId,
    inboundMessageId: `worker-execution:${jobId}`,
    channelId: 'channel-1',
    threadId: 'thread-1',
    spec: { protocolVersion: 2, legacyJobId: jobId },
  });
}

test('orphaned worker.* messages for a terminal job are acknowledged, not parked forever', async () => {
  const { root, bus, broker, logs } = await createBroker();
  try {
    createJobRow(bus, 'job-done');
    // 3 messages for one job: `pending()` only ever surfaces the head of the
    // run, so the whole run must be reclaimed in one pass.
    publishWorkerMessage(bus, 'job-done', 'worker.started', 'm-1');
    publishWorkerMessage(bus, 'job-done', 'worker.update', 'm-2');
    publishWorkerMessage(bus, 'job-done', 'worker.completed', 'm-3');
    bus.markPendingJobLost('job-done');

    const head = bus.pending('workbench')[0];
    assert.equal(head.jobId, 'job-done');
    assert.equal(await broker.consume(head), true);
    assert.deepEqual(bus.pending('workbench'), []);
    assert.equal(bus.pendingCount('workbench'), 0);

    const dropLog = logs.find((entry) => entry.type === 'worker-broker-orphan-messages-dropped');
    assert.ok(dropLog, 'dropping an orphaned run must be logged');
    assert.equal(dropLog.payload.dropped, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('orphaned worker.* messages for a still-recoverable job stay pending for replay', async () => {
  const { root, bus, broker } = await createBroker();
  try {
    createJobRow(bus, 'job-live');
    publishWorkerMessage(bus, 'job-live', 'worker.started', 'm-1');

    const head = bus.pending('workbench')[0];
    // No waiter yet — this is the window right after a restart, before
    // execute() reattaches the job. The message must survive.
    assert.equal(await broker.consume(head), false);
    assert.equal(bus.pendingCount('workbench'), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a message whose job has no row at all is reclaimed', async () => {
  const { root, bus, broker } = await createBroker();
  try {
    publishWorkerMessage(bus, 'job-vanished', 'worker.completed', 'm-1');
    const head = bus.pending('workbench')[0];
    assert.equal(await broker.consume(head), true);
    assert.equal(bus.pendingCount('workbench'), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('sweepOrphanWorkerMessages reclaims a backlog left by earlier generations', async () => {
  const { root, bus, broker, logs } = await createBroker();
  try {
    createJobRow(bus, 'job-a');
    publishWorkerMessage(bus, 'job-a', 'worker.update', 'a-1');
    publishWorkerMessage(bus, 'job-a', 'worker.completed', 'a-2');
    bus.markPendingJobLost('job-a');

    createJobRow(bus, 'job-b');
    publishWorkerMessage(bus, 'job-b', 'worker.started', 'b-1');

    publishWorkerMessage(bus, 'job-c', 'worker.update', 'c-1');

    assert.equal(bus.pendingCount('workbench'), 4);
    const dropped = await broker.sweepOrphanWorkerMessages();

    // job-a (terminal, 2 messages) and job-c (no row, 1) go; job-b stays.
    assert.equal(dropped, 3);
    assert.equal(bus.pendingCount('workbench'), 1);
    assert.deepEqual(
      bus.pending('workbench').map((message) => message.jobId),
      ['job-b'],
    );
    const sweepLog = logs.find((entry) => entry.type === 'worker-broker-orphan-messages-swept');
    assert.ok(sweepLog, 'a non-empty sweep must be logged');
    assert.equal(sweepLog.payload.dropped, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a freshly completed job keeps its run so a restarting Workbench can replay it', async () => {
  // The reattach window: Workbench A died right after the Worker finished, and
  // Workbench B is seconds from calling execute() to replay these updates.
  // Reclaiming them here would silently lose the job's progress and answer.
  const { root, bus, broker } = await createBroker({ orphanMessageMinAgeMs: 30 * 60_000 });
  try {
    createJobRow(bus, 'job-just-finished');
    publishWorkerMessage(bus, 'job-just-finished', 'worker.update', 'm-1');
    publishWorkerMessage(bus, 'job-just-finished', 'worker.completed', 'm-2');
    bus.markPendingJobLost('job-just-finished');

    const head = bus.pending('workbench')[0];
    assert.equal(await broker.consume(head), false);
    assert.equal(bus.pendingCount('workbench'), 2);
    assert.equal(await broker.sweepOrphanWorkerMessages(), 0);
    assert.equal(bus.pendingCount('workbench'), 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a run is only reclaimed once its newest message is older than the minimum age', async () => {
  const { root, bus, broker } = await createBroker({ orphanMessageMinAgeMs: 60_000 });
  try {
    const oldAt = new Date(Date.now() - 5 * 60_000).toISOString();
    createJobRow(bus, 'job-old');
    bus.publish({
      messageId: 'old-1',
      sender: 'worker',
      recipient: 'workbench',
      jobId: 'job-old',
      kind: 'worker.completed',
      payload: {},
      createdAt: oldAt,
    });
    bus.markPendingJobLost('job-old', { at: oldAt });

    assert.equal(await broker.sweepOrphanWorkerMessages(), 1);
    assert.equal(bus.pendingCount('workbench'), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fresh terminal state protects an older worker run during the replay gap', async () => {
  const minimumAgeMs = 60_000;
  const nowMs = Date.now();
  const { root, bus, broker } = await createBroker({ orphanMessageMinAgeMs: minimumAgeMs });
  try {
    createJobRow(bus, 'job-fresh-terminal');
    bus.publish({
      messageId: 'fresh-terminal-old-message',
      sender: 'worker',
      recipient: 'workbench',
      jobId: 'job-fresh-terminal',
      kind: 'worker.completed',
      payload: {},
      createdAt: new Date(nowMs - 5 * 60_000).toISOString(),
    });
    bus.markPendingJobLost('job-fresh-terminal', {
      at: new Date(nowMs).toISOString(),
    });

    assert.equal(
      broker.acknowledgeOrphanWorkerMessages('job-fresh-terminal', { nowMs }),
      0,
    );
    assert.equal(bus.pendingCount('workbench'), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('orphan cleanup never partially acknowledges runs larger than the read limit', async () => {
  const minimumAgeMs = 60_000;
  const nowMs = Date.now();
  const { root, bus, broker } = await createBroker({ orphanMessageMinAgeMs: minimumAgeMs });
  try {
    const oldAt = new Date(nowMs - 5 * 60_000).toISOString();
    for (const jobId of ['job-mixed-large', 'job-old-large']) {
      createJobRow(bus, jobId);
      for (let index = 0; index < 201; index += 1) {
        bus.publish({
          messageId: `${jobId}-${index}`,
          sender: 'worker',
          recipient: 'workbench',
          jobId,
          kind: 'worker.update',
          payload: {},
          createdAt: oldAt,
        });
      }
      bus.markPendingJobLost(jobId, { at: oldAt });
    }
    bus.db.prepare(`
      UPDATE bus_messages
      SET created_at = ?
      WHERE message_id = 'job-mixed-large-200'
    `).run(new Date(nowMs).toISOString());

    assert.equal(
      broker.acknowledgeOrphanWorkerMessages('job-mixed-large', { nowMs }),
      0,
    );
    assert.equal(
      bus.unacknowledgedForJob('workbench', 'job-mixed-large', { limit: 500 }).length,
      201,
    );
    assert.equal(
      broker.acknowledgeOrphanWorkerMessages('job-old-large', { nowMs }),
      201,
    );
    assert.equal(
      bus.unacknowledgedForJob('workbench', 'job-old-large', { limit: 500 }).length,
      0,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an attached waiter keeps its messages even when the job row looks terminal', async () => {
  const { root, bus, broker } = await createBroker();
  try {
    createJobRow(bus, 'job-attached');
    bus.publish({
      messageId: 'm-1',
      sender: 'worker',
      recipient: 'workbench',
      jobId: 'job-attached',
      kind: 'worker.completed',
      payload: { result: { ok: true } },
    });
    bus.markPendingJobLost('job-attached');

    let resolved = null;
    broker.waiters.set('job-attached', {
      resolve: (value) => { resolved = value; },
      reject: () => {},
      onUpdate: null,
      onWorkerStart: null,
    });

    const head = bus.pending('workbench')[0];
    assert.equal(await broker.consume(head), true);
    assert.deepEqual(resolved, { ok: true });
    // Dispatched to the live waiter, so the sweep must not have eaten it.
    assert.equal(bus.pendingCount('workbench'), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
