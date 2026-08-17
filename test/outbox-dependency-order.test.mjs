import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  flushDiscordOutbox,
  queueDiscordOutbox,
} from '../lib/discord-outbox.mjs';
import {
  flushSlackOutbox,
  queueSlackOutbox,
} from '../lib/slack-outbox.mjs';
import { JsonState } from '../lib/state.mjs';

for (const adapter of [
  {
    platform: 'Discord',
    file: 'discord-outbox.json',
    queue: queueDiscordOutbox,
    flush: flushDiscordOutbox,
    destination: { channelId: 'channel-1' },
  },
  {
    platform: 'Slack',
    file: 'slack-outbox.json',
    queue: queueSlackOutbox,
    flush: flushSlackOutbox,
    destination: { channelId: 'C1', threadTs: '1.1' },
  },
]) {
  test(`${adapter.platform} drops dependents when their prerequisite is exhausted`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-outbox-dependency-'));
    const state = new JsonState(root);
    await state.init();
    try {
      const final = await adapter.queue(state, {
        ...adapter.destination,
        content: 'FINAL',
        purpose: 'job-final',
      });
      await adapter.queue(state, {
        ...adapter.destination,
        content: 'DONE',
        purpose: 'job-completion-marker',
        afterOutboxIds: [final.id],
      });
      const calls = [];
      const api = {
        async postMessage(_channelId, content) {
          calls.push(content);
          if (content === 'FINAL') throw new Error('permanent failure');
          return [{ id: `sent-${calls.length}` }];
        },
      };
      const start = new Date(Date.now() + 1_000);
      const first = await adapter.flush(state, api, { now: start, maxAttempts: 1 });
      assert.equal(first.pending, 2);

      calls.length = 0;
      const second = await adapter.flush(state, api, {
        now: new Date(start.getTime() + 60_000),
        maxAttempts: 1,
      });
      assert.deepEqual(calls, []);
      assert.equal(second.droppedExhausted, 1);
      assert.equal(second.dependencyFailed.length, 1);
      assert.equal(second.pending, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test(`${adapter.platform} dedupe replacement preserves dependency identity and order`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-outbox-dedupe-order-'));
    const state = new JsonState(root);
    await state.init();
    try {
      const original = await adapter.queue(state, {
        ...adapter.destination,
        content: 'FINAL-v1',
        purpose: 'job-final',
        dedupeKey: 'final-job-1',
      });
      await adapter.queue(state, {
        ...adapter.destination,
        content: 'DONE',
        purpose: 'job-completion-marker',
        afterOutboxIds: [original.id],
      });
      const replacement = await adapter.queue(state, {
        ...adapter.destination,
        content: 'FINAL-v2',
        purpose: 'job-final',
        dedupeKey: 'final-job-1',
      });
      assert.equal(replacement.id, original.id);
      const queued = await state.readJson(adapter.file, []);
      assert.deepEqual(queued.map((entry) => entry.content), ['FINAL-v2', 'DONE']);
      assert.deepEqual(queued[1].afterOutboxIds, [original.id]);

      const calls = [];
      await adapter.flush(state, {
        async postMessage(_channelId, content) {
          calls.push(content);
          return [{ id: `sent-${calls.length}` }];
        },
      }, { now: new Date(Date.now() + 1_000) });
      assert.deepEqual(calls, ['FINAL-v2', 'DONE']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test(`${adapter.platform} dedupe progress snapshots are idempotent`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-outbox-dedupe-progress-'));
    const state = new JsonState(root);
    await state.init();
    try {
      const message = {
        ...adapter.destination,
        content: 'RICH',
        dedupeKey: 'rich-job-1',
        deliveredPartCount: 1,
        deliveredMessageIds: ['message-1'],
        partialPartMessageCount: 1,
        continuationChannelId: 'thread-1',
      };
      await adapter.queue(state, message);
      await adapter.queue(state, message);

      await adapter.queue(state, {
        ...message,
        deliveredPartCount: 2,
        deliveredMessageIds: ['message-1', 'message-2'],
        partialPartMessageCount: 0,
      });

      const [stored] = await state.readJson(adapter.file, []);
      assert.equal(stored.deliveredPartCount, 2);
      assert.deepEqual(stored.deliveredMessageIds, ['message-1', 'message-2']);
      assert.equal(stored.partialPartMessageCount, 0);
      assert.equal(stored.continuationChannelId, 'thread-1');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test(`${adapter.platform} fails closed when a dependency is missing`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-outbox-missing-dependency-'));
    const state = new JsonState(root);
    await state.init();
    try {
      await state.writeJson(adapter.file, [{
        id: 'done-only',
        ...adapter.destination,
        content: 'DONE',
        purpose: 'job-completion-marker',
        afterOutboxIds: ['missing-final'],
        attempts: 0,
        createdAt: new Date().toISOString(),
      }]);
      const calls = [];
      const result = await adapter.flush(state, {
        async postMessage(_channelId, content) {
          calls.push(content);
          return [{ id: 'unexpected' }];
        },
      }, { now: new Date(Date.now() - 60_000) });
      assert.deepEqual(calls, []);
      assert.equal(result.dependencyFailed.length, 1);
      assert.equal(result.pending, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test(`${adapter.platform} dedupe replacement preserves existing prerequisites`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-outbox-preserve-dependency-'));
    const state = new JsonState(root);
    await state.init();
    try {
      const prerequisite = await adapter.queue(state, {
        ...adapter.destination,
        content: 'PRIOR',
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const child = await adapter.queue(state, {
        ...adapter.destination,
        content: 'CHILD',
        dedupeKey: 'child-key',
        afterOutboxIds: [prerequisite.id],
      });
      await adapter.queue(state, {
        ...adapter.destination,
        content: 'CHILD',
        dedupeKey: 'child-key',
      });
      const queued = await state.readJson(adapter.file, []);
      assert.deepEqual(
        queued.find((entry) => entry.id === child.id).afterOutboxIds,
        [prerequisite.id],
      );
      const calls = [];
      const result = await adapter.flush(state, {
        async postMessage(_channelId, content) {
          calls.push(content);
          return [{ id: 'sent' }];
        },
      }, { now: new Date(Date.now() - 60_000) });
      assert.deepEqual(calls, []);
      assert.equal(result.pending, 2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test(`${adapter.platform} never evicts an undelivered prerequisite at 500 entries`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-outbox-capacity-'));
    const state = new JsonState(root);
    await state.init();
    try {
      const now = new Date().toISOString();
      const seeded = Array.from({ length: 500 }, (_, index) => ({
        id: index === 0 ? 'old-final' : `entry-${index}`,
        ...adapter.destination,
        content: index === 0 ? 'FINAL' : `queued-${index}`,
        afterOutboxIds: index === 499 ? ['old-final'] : [],
        attempts: 0,
        createdAt: now,
      }));
      await state.writeJson(adapter.file, seeded);
      await adapter.queue(state, { ...adapter.destination, content: 'NEW' });
      const queued = await state.readJson(adapter.file, []);
      assert.equal(queued.length, 501);
      assert.equal(queued.some((entry) => entry.id === 'old-final'), true);
      assert.deepEqual(queued[499].afterOutboxIds, ['old-final']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
