import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { flushDiscordOutbox } from '../lib/discord-outbox.mjs';
import { flushSlackOutbox } from '../lib/slack-outbox.mjs';
import { JsonState } from '../lib/state.mjs';

for (const [platform, flush, statusFile] of [
  ['Discord', flushDiscordOutbox, 'discord-outbox-status.json'],
  ['Slack', flushSlackOutbox, 'slack-outbox-status.json'],
]) {
  test(`${platform} empty outbox avoids repeated atomic status rewrites`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `bridge-${platform.toLowerCase()}-idle-`));
    const state = new JsonState(root);
    await state.init();
    await state.writeJson(`${platform.toLowerCase()}-outbox.json`, []);
    const writes = [];
    const writeJson = state.writeJson.bind(state);
    state.writeJson = async (name, value) => {
      writes.push(name);
      return writeJson(name, value);
    };
    const start = new Date('2026-08-12T00:00:00.000Z');

    try {
      await flush(state, { postMessage: async () => [] }, { now: start });
      assert.deepEqual(writes, [statusFile]);

      writes.length = 0;
      await flush(state, { postMessage: async () => [] }, {
        now: new Date(start.getTime() + 10_000),
      });
      assert.deepEqual(writes, []);

      await flush(state, { postMessage: async () => [] }, {
        now: new Date(start.getTime() + 5 * 60_000 + 1),
      });
      assert.deepEqual(writes, [statusFile]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
