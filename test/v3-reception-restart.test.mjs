import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableBus } from '../v3/lib/durable-bus.mjs';
import { ReceptionService } from '../v3/lib/reception-service.mjs';

test('Reception restart resumes failed outbound messages in order without journal duplicates', {
  timeout: 10_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-reception-'));
  const dbPath = path.join(root, 'coordination.sqlite');
  const busA = new DurableBus(dbPath);
  const busB = new DurableBus(dbPath);
  let receptionA = null;
  let receptionB = null;
  const deliveries = [];

  try {
    for (const [index, content] of ['one', 'two', 'three'].entries()) {
      busA.publish({
        messageId: `outbound-${index + 1}`,
        sender: 'workbench',
        recipient: 'reception',
        jobId: 'ordered-job',
        kind: 'outbound.message',
        payload: {
          platform: 'discord',
          destination: { channelId: 'thread-1' },
          content,
          purpose: 'test',
        },
      });
    }
    const duplicate = busA.publish({
      messageId: 'outbound-1',
      sender: 'workbench',
      recipient: 'reception',
      jobId: 'ordered-job',
      kind: 'outbound.message',
      payload: {
        platform: 'discord',
        destination: { channelId: 'thread-1' },
        content: 'duplicate body must not be delivered',
      },
    });
    assert.equal(duplicate.inserted, false);

    receptionA = new ReceptionService({
      bus: busA,
      host: '127.0.0.1',
      port: 0,
      token: 'reception-restart-token',
      instanceId: 'reception-a',
      pollIntervalMs: 25,
      retryDelayMs: 100,
      leaseTtlMs: 2_000,
      leaseRenewMs: 250,
      adapters: {
        discord: {
          async deliver() {
            throw new Error('simulated platform outage');
          },
        },
      },
    });
    await receptionA.start();
    await waitFor(() => {
      const [first] = busA.unacknowledgedForJob('reception', 'ordered-job');
      return first?.deliveryAttempts >= 1;
    });
    await receptionA.stop();
    receptionA = null;

    receptionB = new ReceptionService({
      bus: busB,
      host: '127.0.0.1',
      port: 0,
      token: 'reception-restart-token',
      instanceId: 'reception-b',
      pollIntervalMs: 25,
      retryDelayMs: 100,
      leaseTtlMs: 2_000,
      leaseRenewMs: 250,
      adapters: {
        discord: {
          async deliver(message) {
            deliveries.push(message);
          },
        },
      },
    });
    await receptionB.start();
    await waitFor(() => deliveries.length === 3);

    assert.deepEqual(deliveries.map((entry) => entry.content), [
      'one',
      'two',
      'three',
    ]);
    assert.deepEqual(deliveries.map((entry) => entry.sequence), [1, 2, 3]);
    assert.equal(busB.pendingCount('reception'), 0);
  } finally {
    await receptionA?.stop().catch(() => {});
    await receptionB?.stop().catch(() => {});
    busB.close();
    busA.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Reception starts before maintenance and catches up pruning in bounded batches', {
  timeout: 5_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-reception-prune-'));
  const bus = new DurableBus(path.join(root, 'coordination.sqlite'));
  let reception = null;
  const countMessages = () => Number(bus.db.prepare(
    'SELECT COUNT(*) AS count FROM bus_messages',
  ).get().count);

  try {
    for (let index = 0; index < 300; index += 1) {
      const message = bus.publish({
        messageId: `acknowledged-${index}`,
        sender: 'workbench',
        recipient: 'reception',
        jobId: `completed-${index}`,
        kind: 'outbound.message',
        payload: { content: `completed ${index}` },
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      bus.acknowledge(message.rowId, 'reception-old');
    }

    reception = new ReceptionService({
      bus,
      host: '127.0.0.1',
      port: 0,
      token: 'reception-prune-token',
      instanceId: 'reception-prune',
      pollIntervalMs: 25,
      pruneIntervalMs: 100,
    });
    await reception.start();
    assert.equal(countMessages(), 300, 'startup must not synchronously prune');

    await waitFor(() => countMessages() === 0, { timeoutMs: 2_000 });
  } finally {
    await reception?.stop().catch(() => {});
    bus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
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
