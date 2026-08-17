import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonState } from '../lib/state.mjs';
import { flushDiscordOutbox, queueDiscordOutbox } from '../lib/discord-outbox.mjs';
import { flushSlackOutbox, queueSlackOutbox } from '../lib/slack-outbox.mjs';
import { verifyDiscordAttachments } from '../lib/discord-attachment-upload.mjs';

async function createState(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-outbox-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new JsonState(root);
}

function failingApi(message = 'Discord attachment missing after upload: 일정-예시-2026-08.md') {
  let calls = 0;
  return {
    calls: () => calls,
    async postMessage() {
      calls += 1;
      throw new Error(message);
    },
  };
}

test('a permanently failing Discord entry is dropped instead of retrying forever', async (t) => {
  const state = await createState(t);
  const api = failingApi();
  await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: 'final answer',
    purpose: 'job-final',
  });

  let now = Date.now() + 1_000;
  let result = null;
  // Far more flushes than the cap; each one is due because the clock advances
  // past the 5-minute retry ceiling.
  for (let index = 0; index < 40; index += 1) {
    result = await flushDiscordOutbox(state, api, { now: new Date(now), maxAttempts: 5 });
    if (result.pending === 0) break;
    now += 10 * 60_000;
  }

  assert.equal(result.pending, 0, 'the entry must not remain queued forever');
  assert.equal(result.droppedExhausted, 1);
  assert.equal(api.calls(), 5, 'the send must be attempted exactly maxAttempts times');
  assert.equal(result.exhausted[0].purpose, 'job-final');
  assert.equal(result.exhausted[0].attempts, 5);
  assert.match(result.exhausted[0].lastError, /missing after upload/);

  // Gone for good: a later flush has nothing left to send.
  const after = await flushDiscordOutbox(state, api, { now: new Date(now), maxAttempts: 5 });
  assert.equal(after.pending, 0);
  assert.equal(after.droppedExhausted, 0);
  assert.equal(api.calls(), 5, 'a dropped entry must never be sent again');
});

test('the giving-up reason survives in the outbox status after the entry is gone', async (t) => {
  const state = await createState(t);
  const api = failingApi('boom');
  await queueDiscordOutbox(state, { channelId: 'thread-1', content: 'x', purpose: 'job-final' });

  let now = Date.now() + 1_000;
  for (let index = 0; index < 10; index += 1) {
    const result = await flushDiscordOutbox(state, api, { now: new Date(now), maxAttempts: 3 });
    if (result.pending === 0) break;
    now += 10 * 60_000;
  }

  const status = await state.readJson('discord-outbox-status.json', {});
  assert.equal(status.droppedExhausted, 1);
  assert.equal(status.lastExhausted.attempts, 3);
  assert.match(status.lastExhausted.lastError, /boom/);
});

test('a successful send still clears normally and is never counted as exhausted', async (t) => {
  const state = await createState(t);
  let calls = 0;
  const api = {
    async postMessage() {
      calls += 1;
      return [{ id: 'm1' }];
    },
  };
  await queueDiscordOutbox(state, { channelId: 'thread-1', content: 'ok', purpose: 'message' });
  const result = await flushDiscordOutbox(state, api, {
    now: new Date(Date.now() + 1_000),
    maxAttempts: 3,
  });
  assert.equal(result.sent, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.droppedExhausted, 0);
  assert.equal(calls, 1);
});

test('an entry that recovers before the cap is delivered, not dropped', async (t) => {
  const state = await createState(t);
  let calls = 0;
  const api = {
    async postMessage() {
      calls += 1;
      if (calls < 3) throw new Error('temporary 500');
      return [{ id: 'm1' }];
    },
  };
  await queueDiscordOutbox(state, { channelId: 'thread-1', content: 'ok', purpose: 'job-final' });

  let now = Date.now() + 1_000;
  let result = null;
  for (let index = 0; index < 10; index += 1) {
    result = await flushDiscordOutbox(state, api, { now: new Date(now), maxAttempts: 6 });
    if (result.pending === 0) break;
    now += 10 * 60_000;
  }
  assert.equal(result.sent, 1);
  assert.equal(result.droppedExhausted, 0);
  assert.equal(calls, 3);
});

test('the Slack outbox is bounded the same way', async (t) => {
  const state = await createState(t);
  const api = failingApi('slack is down');
  await queueSlackOutbox(state, {
    channelId: 'C1',
    content: 'final answer',
    purpose: 'job-final',
  });

  let now = Date.now() + 1_000;
  let result = null;
  for (let index = 0; index < 40; index += 1) {
    result = await flushSlackOutbox(state, api, { now: new Date(now), maxAttempts: 4 });
    if (result.pending === 0) break;
    now += 10 * 60_000;
  }
  assert.equal(result.pending, 0);
  assert.equal(result.droppedExhausted, 1);
  assert.equal(api.calls(), 4);
});

test('an attachment whose filename comes back differently normalized still verifies', async () => {
  const body = Buffer.from('# 예시 일정\n');
  const sha256 = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
  const local = {
    filename: '일정-예시-2026-08.md'.normalize('NFD'),
    size: body.length,
    sha256,
  };
  const message = {
    attachments: [{
      id: 'a1',
      // Discord echoes the visually identical name in a different normal form.
      filename: '일정-예시-2026-08.md'.normalize('NFC'),
      size: body.length,
      url: 'https://cdn.example/a1',
    }],
  };
  const results = await verifyDiscordAttachments(message, [local], {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].attachmentId, 'a1');
});

test('an attachment renamed entirely by Discord is paired by size and still hash-checked', async () => {
  const body = Buffer.from('report body');
  const crypto = await import('node:crypto');
  const local = {
    filename: '일정-예시.md',
    size: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
  };
  const message = {
    attachments: [{ id: 'a1', filename: 'untitled.md', size: body.length, url: 'https://cdn/a1' }],
  };
  const results = await verifyDiscordAttachments(message, [local], {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }),
  });
  assert.equal(results[0].attachmentId, 'a1');

  // Pairing loosely must not weaken the integrity check.
  await assert.rejects(
    verifyDiscordAttachments(message, [{ ...local, sha256: 'deadbeef' }], {
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }),
    }),
    /SHA-256 mismatch/,
  );
});

test('multiple attachments are paired one-to-one without reusing an upload', async () => {
  const crypto = await import('node:crypto');
  const first = Buffer.from('first');
  const second = Buffer.from('second-longer');
  const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  const locals = [
    { filename: 'a.md'.normalize('NFD'), size: first.length, sha256: digest(first) },
    { filename: 'b.md', size: second.length, sha256: digest(second) },
  ];
  const message = {
    attachments: [
      { id: 'r1', filename: 'renamed-1.md', size: first.length, url: 'https://cdn/r1' },
      { id: 'r2', filename: 'renamed-2.md', size: second.length, url: 'https://cdn/r2' },
    ],
  };
  const bodies = new Map([['https://cdn/r1', first], ['https://cdn/r2', second]]);
  const results = await verifyDiscordAttachments(message, locals, {
    fetchImpl: async (url) => ({ ok: true, arrayBuffer: async () => bodies.get(url) }),
  });
  assert.deepEqual(results.map((entry) => entry.attachmentId), ['r1', 'r2']);
});
