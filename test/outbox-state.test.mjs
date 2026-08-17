import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isRecoverableEmptyOutbox,
  readOutboxEntries,
  readOutboxStatus,
} from '../lib/outbox-state.mjs';
import { flushDiscordOutbox } from '../lib/discord-outbox.mjs';
import { flushSlackOutbox } from '../lib/slack-outbox.mjs';
import { JsonState } from '../lib/state.mjs';

async function createState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-outbox-state-'));
  const state = new JsonState(root);
  await state.init();
  return { root, state };
}

test('readOutboxEntries recovers a NUL-damaged encoded empty array', async () => {
  const { root, state } = await createState();
  await fs.writeFile(state.file('outbox.json'), Buffer.alloc(3));

  assert.deepEqual(await readOutboxEntries(state, 'outbox.json'), []);
  await assert.rejects(fs.access(state.file('outbox.json')), { code: 'ENOENT' });
  assert.equal(
    (await fs.readdir(root)).filter((name) => name.startsWith('outbox.json.corrupt.')).length,
    1,
  );
});

test('readOutboxEntries refuses to discard a larger corrupt outbox', async () => {
  const { state } = await createState();
  await fs.writeFile(state.file('outbox.json'), Buffer.alloc(4));

  await assert.rejects(
    readOutboxEntries(state, 'outbox.json'),
    /Unexpected token|not valid JSON/,
  );
  assert.equal((await fs.readFile(state.file('outbox.json'))).length, 4);
});

test('readOutboxStatus quarantines corrupt derived telemetry', async () => {
  const { root, state } = await createState();
  await fs.writeFile(state.file('status.json'), Buffer.alloc(189));

  assert.deepEqual(await readOutboxStatus(state, 'status.json'), {});
  await assert.rejects(fs.access(state.file('status.json')), { code: 'ENOENT' });
  assert.equal(
    (await fs.readdir(root)).filter((name) => name.startsWith('status.json.corrupt.')).length,
    1,
  );
});

test('isRecoverableEmptyOutbox accepts only short all-NUL buffers', () => {
  assert.equal(isRecoverableEmptyOutbox(Buffer.alloc(3)), true);
  assert.equal(isRecoverableEmptyOutbox(Buffer.alloc(4)), false);
  assert.equal(isRecoverableEmptyOutbox(Buffer.from('[]\n')), false);
  assert.equal(isRecoverableEmptyOutbox(Buffer.alloc(0)), false);
});

test('Discord and Slack flushes rebuild safe NUL-damaged empty state', async () => {
  const discord = await createState();
  await discord.state.writeJson('discord-outbox.json', []);
  await fs.writeFile(discord.state.file('discord-outbox-status.json'), Buffer.alloc(291));
  assert.deepEqual(
    await flushDiscordOutbox(discord.state, { postMessage: async () => [] }),
    { sent: 0, pending: 0, skippedExpired: 0, droppedExhausted: 0 },
  );
  assert.equal((await discord.state.readJson('discord-outbox-status.json')).pending, 0);

  const slack = await createState();
  await fs.writeFile(slack.state.file('slack-outbox.json'), Buffer.alloc(3));
  await fs.writeFile(slack.state.file('slack-outbox-status.json'), Buffer.alloc(189));
  assert.deepEqual(
    await flushSlackOutbox(slack.state, { postMessage: async () => [] }),
    { sent: 0, pending: 0, skippedExpired: 0, droppedExhausted: 0, exhausted: [], callbackErrors: [] },
  );
  assert.deepEqual(await slack.state.readJson('slack-outbox.json'), []);
  assert.equal((await slack.state.readJson('slack-outbox-status.json')).pending, 0);
});
