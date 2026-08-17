import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recentlyActiveThreadIds, selectCatchupMessages } from '../lib/missed-messages.mjs';

test('selectCatchupMessages keeps in-window messages sorted oldest first', () => {
  const selected = selectCatchupMessages([
    { id: '3', timestamp: '2026-06-11T06:10:00.000Z' },
    { id: 'old', timestamp: '2026-06-11T05:00:00.000Z' },
    { id: '2', timestamp: '2026-06-11T06:05:00.000Z' },
    { id: 'broken', timestamp: 'not-a-date' },
  ], { notBefore: new Date('2026-06-11T06:00:00.000Z') });

  assert.deepEqual(selected.map((message) => message.id), ['2', '3']);
});

test('selectCatchupMessages without a floor keeps every dated message', () => {
  const selected = selectCatchupMessages([
    { id: 'b', timestamp: '2026-06-11T06:10:00.000Z' },
    { id: 'a', timestamp: '2026-06-11T06:00:00.000Z' },
  ]);

  assert.deepEqual(selected.map((message) => message.id), ['a', 'b']);
});

test('recentlyActiveThreadIds finds threads with fresh events files', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'missed-messages-'));
  const channelId = '1000000000000000002';
  const freshThread = '1000000000000000009';
  const staleThread = '1000000000000000005';
  for (const threadId of [freshThread, staleThread]) {
    const memoryDir = path.join(stateRoot, channelId, threadId, 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, 'events.jsonl'), '{}\n');
  }
  const staleEvents = path.join(stateRoot, channelId, staleThread, 'memory', 'events.jsonl');
  const oldTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  await fs.utimes(staleEvents, oldTime, oldTime);
  // Non-thread directories must be ignored.
  await fs.mkdir(path.join(stateRoot, channelId, 'artifacts'), { recursive: true });

  const threads = await recentlyActiveThreadIds(stateRoot, [channelId, 'missing-channel']);

  assert.deepEqual(threads, [{ channelId, threadId: freshThread }]);
});

test('recentlyActiveThreadIds caps the number of returned threads', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'missed-messages-'));
  const channelId = '100';
  for (let index = 0; index < 5; index += 1) {
    const memoryDir = path.join(stateRoot, channelId, `20${index}`, 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, 'events.jsonl'), '{}\n');
  }

  const threads = await recentlyActiveThreadIds(stateRoot, [channelId], { maxThreads: 3 });

  assert.equal(threads.length, 3);
});

test('recentlyActiveThreadIds includes Slack thread state directories', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'missed-messages-slack-'));
  const channelId = '1000000000000000001';
  const threadId = 'slack-T123-C123-1785218400.123456';
  const memoryDir = path.join(stateRoot, channelId, threadId, 'memory');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'events.jsonl'), '{}\n');

  const threads = await recentlyActiveThreadIds(stateRoot, [channelId]);

  assert.deepEqual(threads, [{ channelId, threadId }]);
});
