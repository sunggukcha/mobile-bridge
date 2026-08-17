import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableBus } from '../v3/lib/durable-bus.mjs';

test('DurableBus preserves stream order, deduplicates IDs, and retries without loss', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-bus-'));
  const bus = new DurableBus(path.join(root, 'bus.sqlite'));
  try {
    const first = bus.publish({
      messageId: 'message-1',
      sender: 'worker',
      recipient: 'workbench',
      jobId: 'job-1',
      kind: 'worker.progress',
      payload: { content: 'one' },
    });
    const second = bus.publish({
      messageId: 'message-2',
      sender: 'worker',
      recipient: 'workbench',
      jobId: 'job-1',
      kind: 'worker.progress',
      payload: { content: 'two' },
    });
    const duplicate = bus.publish({
      messageId: 'message-1',
      sender: 'worker',
      recipient: 'workbench',
      jobId: 'job-1',
      kind: 'worker.progress',
      payload: { content: 'ignored duplicate body' },
    });

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(duplicate.rowId, first.rowId);
    assert.equal(duplicate.inserted, false);
    assert.deepEqual(
      bus.pending('workbench').map((message) => message.payload.content),
      ['one'],
    );

    const nowMs = Date.now();
    bus.defer(first.rowId, new Error('temporary'), {
      delayMs: 1_000,
      nowMs,
    });
    assert.deepEqual(
      bus
        .unacknowledgedForJob('workbench', 'job-1')
        .map((message) => message.messageId),
      ['message-1', 'message-2'],
    );
    assert.deepEqual(
      bus.pending('workbench', { nowMs: nowMs + 500 }).map((message) => message.messageId),
      [],
    );
    assert.deepEqual(
      bus.pending('workbench', { nowMs: nowMs + 1_000 }).map((message) => message.messageId),
      ['message-1'],
    );
    assert.equal(bus.acknowledge(first.rowId, 'workbench-a'), true);
    assert.deepEqual(
      bus.pending('workbench', { nowMs: nowMs + 1_000 }).map((message) => message.messageId),
      ['message-2'],
    );
  } finally {
    bus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DurableBus indexes per-job pending-order lookups', () => {
  const bus = new DurableBus(':memory:');
  try {
    const index = bus.db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name = 'bus_messages_unacknowledged_job'
    `).get();
    assert.match(index?.sql || '', /recipient, job_id, row_id/i);
    assert.match(index?.sql || '', /WHERE acknowledged_at IS NULL/i);
  } finally {
    bus.close();
  }
});

test('DurableBus fences Workbench generations and gives one runner job ownership', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-lease-'));
  const bus = new DurableBus(path.join(root, 'bus.sqlite'));
  try {
    const leaseA = bus.acquireLease('workbench', 'generation-a', {
      ttlMs: 1_000,
      nowMs: 10_000,
    });
    assert.equal(leaseA.epoch, 1);
    assert.equal(
      bus.acquireLease('workbench', 'generation-b', {
        ttlMs: 1_000,
        nowMs: 10_500,
      }),
      null,
    );
    const leaseB = bus.acquireLease('workbench', 'generation-b', {
      ttlMs: 1_000,
      nowMs: 11_001,
    });
    assert.equal(leaseB.epoch, 2);
    assert.equal(bus.ownsLease(leaseA), false);
    assert.equal(bus.ownsLease(leaseB), true);
    assert.equal(bus.renewLease(leaseA, { nowMs: 11_002 }), null);

    bus.createJob({
      jobId: 'job-1',
      inboundMessageId: 'inbound-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      spec: { prompt: 'hello' },
    });
    assert.equal(bus.reserveLaunch('job-1', { launcherId: 'generation-b' }), true);
    assert.equal(bus.reserveLaunch('job-1', { launcherId: 'generation-b' }), false);
    const claimed = bus.claimJob('job-1', {
      runnerId: 'runner-a',
      pid: process.pid,
    });
    assert.equal(claimed.status, 'running');
    assert.equal(
      bus.claimJob('job-1', { runnerId: 'runner-b', pid: process.pid }),
      null,
    );
    assert.equal(bus.finishJob('job-1', 'runner-a', { status: 'completed' }), true);
    assert.equal(bus.getJob('job-1').status, 'completed');

    bus.createJob({
      jobId: 'job-cancelled-before-launch',
      inboundMessageId: 'inbound-cancelled-before-launch',
      channelId: 'channel-1',
      threadId: 'thread-2',
      spec: { prompt: 'never run' },
    });
    assert.equal(bus.requestCancel('job-cancelled-before-launch', {
      reason: 'cancelled-by:command-1',
    }), true);
    assert.equal(bus.getJob('job-cancelled-before-launch').status, 'cancelled');
    assert.equal(
      bus.getJob('job-cancelled-before-launch').cancelReason,
      'cancelled-by:command-1',
    );
    assert.equal(
      bus.claimJob('job-cancelled-before-launch', {
        runnerId: 'runner-cancelled',
        pid: process.pid,
      }),
      null,
    );

    bus.createJob({
      jobId: 'job-lost',
      inboundMessageId: 'inbound-lost',
      channelId: 'channel-1',
      threadId: 'thread-3',
      spec: { prompt: 'retry me' },
    });
    assert.equal(bus.reserveLaunch('job-lost', { launcherId: 'generation-b' }), true);
    assert.ok(bus.claimJob('job-lost', {
      runnerId: 'runner-lost',
      pid: 999_999,
    }));
    assert.equal(bus.markJobLost('job-lost'), true);
    assert.equal(bus.getJob('job-lost').status, 'lost');
    assert.equal(bus.requeueLostJob('job-lost'), true);
    assert.equal(bus.getJob('job-lost').status, 'queued');
    assert.equal(bus.getJob('job-lost').runnerId, null);

    bus.createJob({
      jobId: 'job-never-launched',
      inboundMessageId: 'inbound-never-launched',
      channelId: 'channel-1',
      threadId: 'thread-4',
      spec: { prompt: 'cannot launch' },
    });
    assert.equal(bus.markPendingJobLost('job-never-launched'), true);
    assert.equal(bus.getJob('job-never-launched').status, 'lost');
  } finally {
    bus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DurableBus prunes acknowledged messages in indexed bounded batches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-prune-'));
  const bus = new DurableBus(path.join(root, 'bus.sqlite'));
  try {
    const publish = (messageId, createdAt) => bus.publish({
      messageId,
      sender: 'worker',
      recipient: 'workbench',
      jobId: messageId,
      kind: 'worker.progress',
      payload: { content: messageId },
      createdAt,
    });
    const old = [
      publish('old-1', '2026-01-01T00:00:00.000Z'),
      publish('old-2', '2026-01-02T00:00:00.000Z'),
      publish('old-3', '2026-01-03T00:00:00.000Z'),
    ];
    const recent = publish('recent', '2026-03-01T00:00:00.000Z');
    publish('old-pending', '2026-01-04T00:00:00.000Z');
    for (const message of [...old, recent]) {
      assert.equal(bus.acknowledge(message.rowId, 'workbench-a'), true);
    }

    assert.equal(bus.pruneAcknowledged({
      before: '2026-02-01T00:00:00.000Z',
      limit: 2,
    }), 2);
    assert.equal(bus.pruneAcknowledged({
      before: '2026-02-01T00:00:00.000Z',
      limit: 2,
    }), 1);
    assert.equal(bus.pruneAcknowledged({
      before: '2026-02-01T00:00:00.000Z',
      limit: 2,
    }), 0);
    assert.deepEqual(
      bus.pending('workbench').map((message) => message.messageId),
      ['old-pending'],
    );
    assert.ok(bus.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name = 'bus_messages_acknowledged_created'
    `).get());
  } finally {
    bus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
