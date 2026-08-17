import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discordOutboxProgressFromError,
  flushDiscordOutbox,
  queueDiscordOutbox,
} from '../lib/discord-outbox.mjs';
import { JsonState } from '../lib/state.mjs';
import {
  MAX_RICH_DELIVERY_MESSAGE_ID_CHARS,
  MAX_RICH_DELIVERY_MESSAGE_IDS,
  MAX_RICH_DELIVERY_PARTS,
} from '../lib/rich-delivery-progress.mjs';

test('rich delivery handoff progress is bounded to small serializable fields', () => {
  const error = new Error('partial');
  error.discordCompletedParts = Number.MAX_SAFE_INTEGER;
  error.discordCompletedMessageIds = Array.from(
    { length: MAX_RICH_DELIVERY_MESSAGE_IDS + 50 },
    (_, index) => `${index}-${'x'.repeat(MAX_RICH_DELIVERY_MESSAGE_ID_CHARS + 50)}`,
  );
  error.discordPartialPartMessageCount = Number.MAX_SAFE_INTEGER;
  error.discordCompletedMessageCount = Number.MAX_SAFE_INTEGER;
  error.discordContinuationChannelId = 'x'.repeat(MAX_RICH_DELIVERY_MESSAGE_ID_CHARS + 1);
  const progress = discordOutboxProgressFromError(error);
  assert.equal(progress.deliveredPartCount, MAX_RICH_DELIVERY_PARTS);
  assert.equal(progress.deliveredMessageIds.length, MAX_RICH_DELIVERY_MESSAGE_IDS);
  assert.ok(progress.deliveredMessageIds.every(
    (id) => id.length <= MAX_RICH_DELIVERY_MESSAGE_ID_CHARS,
  ));
  assert.equal(progress.partialPartMessageCount, MAX_RICH_DELIVERY_PARTS);
  assert.equal(progress.deliveredMessageCount, MAX_RICH_DELIVERY_PARTS);
  assert.equal(progress.continuationChannelId, null);
  assert.doesNotMatch(JSON.stringify(progress), /Error|Buffer/);
});

test('flushDiscordOutbox retries failed Discord deliveries until they send', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-outbox-')));
  await state.init();
  await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: 'hello',
    job: { id: 'job-1', channelId: 'channel-1', threadId: 'thread-1' },
  });

  const failingApi = {
    async postMessage() {
      throw new Error('network down');
    },
  };
  const failed = await flushDiscordOutbox(state, failingApi, { now: new Date(Date.now() + 1000) });
  assert.equal(failed.sent, 0);
  assert.equal(failed.pending, 1);
  const retryOutbox = await state.readJson('discord-outbox.json', []);
  assert.equal(retryOutbox[0].attempts, 1);
  assert.match(retryOutbox[0].lastError, /network down/);
  const retryAt = new Date(Date.parse(retryOutbox[0].nextAttemptAt) + 1000);

  const sent = [];
  const okApi = {
    async postMessage(channelId, content) {
      sent.push([channelId, content]);
      return [{ id: 'message-1' }];
    },
  };
  const delivered = [];
  const ok = await flushDiscordOutbox(state, okApi, {
    now: retryAt,
    onDelivered: async (entry, messages) => delivered.push([entry.id, messages[0].id]),
  });

  assert.equal(ok.sent, 1);
  assert.equal(ok.pending, 0);
  assert.deepEqual(sent, [['thread-1', 'hello']]);
  assert.equal(delivered.length, 1);
});

test('flushDiscordOutbox does not resend a delivered message when onDelivered fails', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-outbox-')));
  await state.init();
  await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: 'hello',
    job: { id: 'job-1', channelId: 'channel-1', threadId: 'thread-1' },
  });

  const sent = [];
  const api = {
    async postMessage(channelId, content) {
      sent.push([channelId, content]);
      return [{ id: `message-${sent.length}` }];
    },
  };

  const first = await flushDiscordOutbox(state, api, {
    now: new Date(Date.now() + 1000),
    onDelivered: async () => {
      throw new Error('state write failed');
    },
  });

  assert.equal(first.sent, 1);
  assert.equal(first.pending, 0);
  assert.equal(first.callbackErrors.length, 1);
  assert.match(first.callbackErrors[0].error, /state write failed/);

  const second = await flushDiscordOutbox(state, api, {
    now: new Date(Date.now() + 60_000),
  });
  assert.equal(second.sent, 0);
  assert.deepEqual(sent, [['thread-1', 'hello']]);
});

test('queueDiscordOutbox stores sanitized message content', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-outbox-')));
  await state.init();

  await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: [
      '[codex/response_text] 작업 완료',
      'workerupdate [codex/response_text] 다음 작업',
      '[truncated]',
      '# Subtest: runAgentJob does not fall back for non-runtime worker failures',
      '최종 줄',
    ].join('\n'),
  });

  const outbox = await state.readJson('discord-outbox.json', []);
  assert.equal(outbox[0].content, '작업 완료\n다음 작업\n\n최종 줄');
});

test('Discord outbox persists only serializable style rendering options', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-style-outbox-')));
  await state.init();
  await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: 'themes',
    options: { styleId: 'minimal-light', includeStylePreview: true },
  });

  const [entry] = await state.readJson('discord-outbox.json', []);
  assert.deepEqual(entry.options, { styleId: 'minimal-light', includeStylePreview: true });
  assert.doesNotMatch(JSON.stringify(entry.options), /Buffer|dataBase64/);
  const calls = [];
  await flushDiscordOutbox(state, {
    async postMessage(channelId, content, options) {
      calls.push({ channelId, content, options });
      return [{ id: 'style-message' }];
    },
  }, { now: new Date(Date.now() + 1_000) });
  assert.deepEqual(calls[0].options, { styleId: 'minimal-light', includeStylePreview: true });
});

test('Discord direct-send progress hands off to a new outbox entry without duplicating text', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-handoff-outbox-')));
  await state.init();
  const directError = new Error('preview failed after text');
  directError.discordCompletedParts = 1;
  directError.discordCompletedMessageIds = ['direct-text-1'];
  directError.discordContinuationChannelId = 'rich-thread-1';
  const progress = discordOutboxProgressFromError(directError);
  await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: 'Rendering themes',
    options: { styleId: 'warm-noir', includeStylePreview: true },
    ...progress,
  });

  const [stored] = await state.readJson('discord-outbox.json', []);
  assert.equal(stored.deliveredPartCount, 1);
  assert.deepEqual(stored.deliveredMessageIds, ['direct-text-1']);
  assert.equal(stored.continuationChannelId, 'rich-thread-1');
  assert.doesNotMatch(JSON.stringify(stored), /"name":"Error"|"type":"Buffer"/);
  let delivered;
  const calls = [];
  await flushDiscordOutbox(state, {
    async postMessage(channelId, content, options) {
      calls.push({ channelId, content, options });
      return [{ id: 'retry-preview-1' }];
    },
  }, {
    now: new Date(Date.now() + 1_000),
    onDelivered(_entry, messages) {
      delivered = messages;
    },
  });
  assert.equal(calls[0].options.startPartIndex, 1);
  assert.equal(calls[0].options.startPartMessageCount, 1);
  assert.equal(calls[0].options.richContinuationChannelId, 'rich-thread-1');
  assert.deepEqual(delivered.map((message) => message.id), ['direct-text-1', 'retry-preview-1']);
});

test('Discord outbox dedupe preserves a partially delivered continuation thread', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-rich-dedupe-')));
  await state.init();
  const original = await queueDiscordOutbox(state, {
    channelId: 'feed',
    content: 'same rich report',
    dedupeKey: 'rich-report-1',
    deliveredMessageIds: ['message-1'],
    partialPartMessageCount: 1,
    continuationChannelId: 'rich-thread-1',
  });

  const replacement = await queueDiscordOutbox(state, {
    channelId: 'feed',
    content: 'same rich report',
    dedupeKey: 'rich-report-1',
    deliveredMessageIds: ['message-1'],
    partialPartMessageCount: 1,
    continuationChannelId: 'rich-thread-1',
  });

  assert.equal(replacement.id, original.id);
  const [stored] = await state.readJson('discord-outbox.json', []);
  assert.deepEqual(stored.deliveredMessageIds, ['message-1']);
  assert.equal(stored.partialPartMessageCount, 1);
  assert.equal(stored.continuationChannelId, 'rich-thread-1');
  const calls = [];
  await flushDiscordOutbox(state, {
    async postMessage(channelId, deliveredContent, options) {
      calls.push({ channelId, deliveredContent, options });
      return [{ id: 'message-2' }];
    },
  }, { now: new Date(Date.now() + 1_000) });
  assert.equal(calls[0].options.startPartChunkIndex, 1);
  assert.equal(calls[0].options.richContinuationChannelId, 'rich-thread-1');
});

test('Discord outbox ignores a stale dedupe snapshot from an older continuation thread', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-rich-stale-')));
  await state.init();
  await queueDiscordOutbox(state, {
    channelId: 'feed',
    content: 'same rich report',
    dedupeKey: 'rich-report-stale',
    deliveredPartCount: 2,
    deliveredMessageIds: ['message-1', 'message-2'],
    deliveredMessageCount: 2,
    continuationChannelId: 'rich-thread-new',
  });
  await queueDiscordOutbox(state, {
    channelId: 'feed',
    content: 'same rich report',
    dedupeKey: 'rich-report-stale',
    deliveredPartCount: 1,
    deliveredMessageIds: ['old-message-1'],
    deliveredMessageCount: 1,
    continuationChannelId: 'rich-thread-old',
  });

  const [stored] = await state.readJson('discord-outbox.json', []);
  assert.equal(stored.deliveredPartCount, 2);
  assert.equal(stored.deliveredMessageCount, 2);
  assert.equal(stored.continuationChannelId, 'rich-thread-new');
});

test('Discord outbox keeps a rich continuation thread across repeated retries', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-rich-retry-')));
  await state.init();
  await queueDiscordOutbox(state, {
    channelId: 'feed',
    content: 'rich report',
  });
  const firstError = new Error('image upload failed');
  firstError.discordCompletedParts = 1;
  firstError.discordCompletedMessageIds = ['message-1', 'message-2'];
  firstError.discordContinuationChannelId = 'rich-thread-1';

  await flushDiscordOutbox(state, {
    async postMessage() {
      throw firstError;
    },
  }, { now: new Date(Date.now() + 1_000) });

  const [checkpointed] = await state.readJson('discord-outbox.json', []);
  assert.equal(checkpointed.continuationChannelId, 'rich-thread-1');
  const calls = [];
  await flushDiscordOutbox(state, {
    async postMessage(channelId, content, options) {
      calls.push({ channelId, content, options });
      return [{ id: 'message-3' }];
    },
  }, { now: new Date(Date.parse(checkpointed.nextAttemptAt) + 1_000) });

  assert.equal(calls[0].options.startPartIndex, 1);
  assert.equal(calls[0].options.startPartMessageCount, 2);
  assert.equal(calls[0].options.richContinuationChannelId, 'rich-thread-1');
});

test('Discord outbox preserves immutable artifact bytes after the source file changes', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-outbox-')));
  await state.init();
  const sourcePath = path.join(state.rootDir, 'style_v2_a.png');
  const original = Buffer.from('original artifact bytes');
  await fs.writeFile(sourcePath, original);
  const options = {
    files: [{
      filename: 'style_v2_a.png',
      relativePath: 'artifacts/style_v2_a.png',
      size: original.length,
      sha256: 'abc123',
      dataBase64: original.toString('base64'),
    }],
    verifyFiles: true,
    deliveryNonce: 'ad12345678901234567890123',
  };
  await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: '이미지를 보냈습니다.',
    options,
  });
  await fs.writeFile(sourcePath, 'changed after queueing');

  const sent = [];
  const result = await flushDiscordOutbox(state, {
    async postMessage(channelId, content, deliveredOptions) {
      sent.push({ channelId, content, deliveredOptions });
      return [{ id: 'message-1' }];
    },
  }, { now: new Date(Date.now() + 1_000) });

  assert.equal(result.sent, 1);
  assert.deepEqual(sent, [{
    channelId: 'thread-1',
    content: '이미지를 보냈습니다.',
    deliveredOptions: options,
  }]);
  assert.equal(
    Buffer.from(sent[0].deliveredOptions.files[0].dataBase64, 'base64').toString(),
    original.toString(),
  );
  assert.equal('path' in sent[0].deliveredOptions.files[0], false);
});

test('flushDiscordOutbox waits for dependent outbox messages before completion marker', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'discord-outbox-')));
  await state.init();

  const finalEntry = await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: '최종 답변',
    purpose: 'job-final',
    job: { id: 'job-1', channelId: 'channel-1', threadId: 'thread-1' },
  });
  await queueDiscordOutbox(state, {
    channelId: 'thread-1',
    content: '【응답완료】',
    purpose: 'job-completion-marker',
    afterOutboxIds: [finalEntry.id],
    job: { id: 'job-1', channelId: 'channel-1', threadId: 'thread-1' },
  });

  const firstAttempt = await flushDiscordOutbox(state, {
    async postMessage(_channelId, content) {
      if (content === '최종 답변') throw new Error('network down');
      assert.fail('completion marker should not send before the final answer succeeds');
    },
  }, { now: new Date(Date.now() + 1000) });

  assert.equal(firstAttempt.sent, 0);
  assert.equal(firstAttempt.pending, 2);

  const retryOutbox = await state.readJson('discord-outbox.json', []);
  assert.equal(retryOutbox[1].content, '【응답완료】');
  assert.deepEqual(retryOutbox[1].afterOutboxIds, [finalEntry.id]);

  const sent = [];
  const retryAt = new Date(Date.parse(retryOutbox[0].nextAttemptAt) + 1000);
  const retryAttempt = await flushDiscordOutbox(state, {
    async postMessage(channelId, content) {
      sent.push([channelId, content]);
      return [{ id: `message-${sent.length}` }];
    },
  }, { now: retryAt });

  assert.equal(retryAttempt.sent, 2);
  assert.equal(retryAttempt.pending, 0);
  assert.deepEqual(sent, [
    ['thread-1', '최종 답변'],
    ['thread-1', '【응답완료】'],
  ]);
});
