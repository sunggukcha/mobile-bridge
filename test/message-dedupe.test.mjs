import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  beginDurableMessageProcessing,
  completeDurableMessageProcessing,
  discordMessageReservationKey,
  reserveDiscordMessage,
} from '../lib/message-dedupe.mjs';
import { JsonState } from '../lib/state.mjs';

test('reserveDiscordMessage suppresses duplicate Discord message events', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-dedupe-')));
  await state.init();
  const message = { channel_id: 'channel-1', id: 'message-1', author: { id: 'user-1' } };

  assert.equal(await reserveDiscordMessage(state, message), true);
  assert.equal(await reserveDiscordMessage(state, message), false);
});

test('message lock cleanup is hourly and bounds repeated directory scans', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-dedupe-cleanup-'));
  const state = new JsonState(root);
  await state.init();
  const lockDirectory = path.join(root, 'message-locks');
  await fs.mkdir(lockDirectory, { recursive: true });
  const now = new Date();
  const staleTime = new Date(now.getTime() - 25 * 60 * 60_000);

  try {
    const firstStale = path.join(lockDirectory, 'stale-first.json');
    await fs.writeFile(firstStale, '{}\n');
    await fs.utimes(firstStale, staleTime, staleTime);
    await reserveDiscordMessage(state, { channel_id: 'c', id: 'first' }, now);
    await assert.rejects(fs.access(firstStale), { code: 'ENOENT' });

    const secondStale = path.join(lockDirectory, 'stale-second.json');
    await fs.writeFile(secondStale, '{}\n');
    await fs.utimes(secondStale, staleTime, staleTime);
    await reserveDiscordMessage(
      state,
      { channel_id: 'c', id: 'within-hour' },
      new Date(now.getTime() + 60_000),
    );
    await fs.access(secondStale);

    await reserveDiscordMessage(
      state,
      { channel_id: 'c', id: 'after-hour' },
      new Date(now.getTime() + 60 * 60_000 + 1),
    );
    await assert.rejects(fs.access(secondStale), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('discordMessageReservationKey is stable by channel and message id', () => {
  assert.equal(
    discordMessageReservationKey({ channel_id: 'c', id: 'm' }),
    'discord:c:m',
  );
});

test('durable message processing can be reclaimed until completion', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'durable-dedupe-')));
  await state.init();
  const message = { channel_id: 'channel-1', id: 'message-1', author: { id: 'user-1' } };

  assert.deepEqual(
    await beginDurableMessageProcessing(state, message, { ownerId: 'workbench-a' }),
    {
      accepted: true,
      reclaimed: false,
      key: 'discord:channel-1:message-1',
    },
  );
  assert.deepEqual(
    await beginDurableMessageProcessing(state, message, { ownerId: 'workbench-b' }),
    {
      accepted: true,
      reclaimed: true,
      key: 'discord:channel-1:message-1',
    },
  );
  assert.equal(
    await completeDurableMessageProcessing(state, message, { ownerId: 'workbench-b' }),
    true,
  );
  assert.deepEqual(
    await beginDurableMessageProcessing(state, message, { ownerId: 'workbench-c' }),
    {
      accepted: false,
      completed: true,
      key: 'discord:channel-1:message-1',
    },
  );
});
