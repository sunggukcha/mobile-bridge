import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDiscordAttachment } from '../lib/discord-attachment-upload.mjs';
import { DiscordApi, chunkDiscordMessage } from '../lib/discord-api.mjs';

test('chunkDiscordMessage preserves long content across chunks', () => {
  const content = `${'a'.repeat(1800)}🙂${'b'.repeat(1800)}\n${'c'.repeat(250)}`;
  const chunks = chunkDiscordMessage(content);

  assert.equal(chunks.join(''), content);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 1800));
  assert.equal(chunks.some((chunk) => chunk.includes('[truncated]')), false);
});

test('chunkDiscordMessage preserves multiline content without truncation markers', () => {
  const content = [
    '첫 줄',
    'x'.repeat(2400),
    '마지막 줄',
  ].join('\n');
  const chunks = chunkDiscordMessage(content);

  assert.equal(chunks.join(''), content);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 1800));
});

test('chunkDiscordMessage closes and reopens fenced code blocks across chunks', () => {
  const content = [
    'before',
    '```js',
    `const value = "${'x'.repeat(4000)}";`,
    '```',
    'after',
  ].join('\n');
  const chunks = chunkDiscordMessage(content);

  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 1800));
  assert(chunks.slice(1).every((chunk) => chunk.startsWith('```js\n')));
  assert(chunks.every((chunk) => (chunk.match(/```/g) || []).length % 2 === 0));
  assert.equal(chunks.reduce((count, chunk) => count + (chunk.match(/x/g) || []).length, 0), 4000);
  assert.equal(chunks.filter((chunk) => chunk.includes('before')).length, 1);
  assert.equal(chunks.filter((chunk) => chunk.includes('after')).length, 1);
});

test('chunkDiscordMessage closes and reopens inline code across chunks', () => {
  const content = `before \`${'q'.repeat(4000)}\` after`;
  const chunks = chunkDiscordMessage(content);

  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 1800));
  assert(chunks.every((chunk) => (chunk.match(/`/g) || []).length % 2 === 0));
  assert(chunks.slice(1).every((chunk) => chunk.startsWith('`')));
  assert.equal(chunks.reduce((count, chunk) => count + (chunk.match(/q/g) || []).length, 0), 4000);
  assert(chunks.at(-1).endsWith('` after'));
});

test('chunkDiscordMessage moves a nearby inline span instead of cutting it', () => {
  const prefix = `${'a'.repeat(1700)} `;
  const code = `\`${'b'.repeat(150)}\``;
  const chunks = chunkDiscordMessage(`${prefix}${code}`);

  assert.deepEqual(chunks, [prefix, code]);
});

test('chunkDiscordMessage does not merge inline delimiters with literal backticks', () => {
  const content = `before \`\`${'q'.repeat(1788)}\`${'z'.repeat(2200)}\`\` after`;
  const chunks = chunkDiscordMessage(content);

  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 1800));
  assert(chunks.every((chunk) => !chunk.includes('```')));
  assert.equal(chunks.reduce((count, chunk) => count + (chunk.match(/q/g) || []).length, 0), 1788);
  assert.equal(chunks.reduce((count, chunk) => count + (chunk.match(/z/g) || []).length, 0), 2200);
});

test('postMessage sends long feed messages as feed-thread-thread', async () => {
  const api = new FakeDiscordApi({
    feed: { id: 'feed', type: 0 },
  });
  const content = 'x'.repeat(4100);

  const messages = await api.postMessage('feed', content, {
    longMessageThreadName: 'Long result',
  });

  assert.equal(messages.length, 3);
  assert.deepEqual(api.sent.map((entry) => entry.channelId), ['feed', 'thread-1', 'thread-1']);
  assert.equal(api.threadCreations.length, 1);
  assert.equal(api.threadCreations[0].channelId, 'feed');
  assert.equal(api.sent.map((entry) => entry.content).join(''), content);
});

test('postMessage resumes a partially sent plain long message without duplicating chunks', async () => {
  const api = new FakeDiscordApi({
    feed: { id: 'feed', type: 0 },
  });
  const content = 'p'.repeat(4_100);
  const sendMessage = api.sendMessage.bind(api);
  let sendAttempts = 0;
  api.sendMessage = async (...args) => {
    sendAttempts += 1;
    if (sendAttempts === 2) throw new Error('temporary plain chunk failure');
    return sendMessage(...args);
  };

  let progress;
  const options = { deliveryNonce: 'plain12345678901234567890' };
  await assert.rejects(api.postMessage('feed', content, options), (error) => {
    progress = error;
    assert.deepEqual(error.discordCompletedMessageIds, ['message-1']);
    assert.equal(error.discordCompletedMessageCount, 1);
    assert.equal(error.discordPartialPartMessageCount, 1);
    assert.equal(error.discordContinuationChannelId, 'thread-1');
    return true;
  });

  api.sendMessage = sendMessage;
  const resumed = await api.postMessage('feed', content, {
    ...options,
    startPartMessageCount: progress.discordCompletedMessageCount,
    startPartChunkIndex: progress.discordPartialPartMessageCount,
    richContinuationChannelId: progress.discordContinuationChannelId,
  });

  assert.equal(api.threadCreations.length, 1);
  assert.equal(
    api.sent.reduce((count, entry) => count + (entry.content.match(/p/g) || []).length, 0),
    content.length,
  );
  assert.ok(resumed.every((message) => message.channel_id === 'thread-1'));
  assert.deepEqual(
    api.sent.map((entry) => entry.body.nonce.slice(-2)),
    ['-0', '-1', '-2'],
  );
});

test('postMessage keeps nonce progress beyond the retained message-id window', async () => {
  const api = new FakeDiscordApi({
    feed: { id: 'feed', type: 0 },
  });
  const chunkCount = 258;
  const content = 'n'.repeat(1_800 * chunkCount);
  const options = { deliveryNonce: 'nonce12345678901234567890' };
  const sendMessage = api.sendMessage.bind(api);
  let sendAttempts = 0;
  api.sendMessage = async (...args) => {
    sendAttempts += 1;
    if (sendAttempts === chunkCount) throw new Error('last chunk failed');
    return sendMessage(...args);
  };

  let progress;
  await assert.rejects(api.postMessage('feed', content, options), (error) => {
    progress = error;
    assert.equal(error.discordCompletedMessageIds.length, 256);
    assert.equal(error.discordCompletedMessageCount, chunkCount - 1);
    assert.equal(error.discordPartialPartMessageCount, chunkCount - 1);
    return true;
  });

  api.sendMessage = sendMessage;
  const resumed = await api.postMessage('feed', content, {
    ...options,
    startPartMessageCount: progress.discordCompletedMessageCount,
    startPartChunkIndex: progress.discordPartialPartMessageCount,
    richContinuationChannelId: progress.discordContinuationChannelId,
  });

  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].channel_id, 'thread-1');
  assert.match(api.sent.at(-1).body.nonce, /-75$/);
});

test('postMessage does not double-advance a nonce for a reconciled long-message attachment', async () => {
  const api = new FakeDiscordApi({
    feed: { id: 'feed', type: 0 },
    'thread-1': { id: 'thread-1', type: 11, parent_id: 'feed' },
  });
  api.reconcileAttachmentMessage = async () => ({
    id: 'attachment-existing',
    channel_id: 'feed',
  });
  const options = {
    files: [{
      filename: 'artifact.txt',
      dataBase64: Buffer.from('artifact').toString('base64'),
    }],
    deliveryNonce: 'reconcile1234567890123456',
    reconcileAttachmentMessageId: 'attachment-existing',
    startPartMessageCount: 1,
    startPartChunkIndex: 1,
    richContinuationChannelId: 'thread-1',
  };

  await api.postMessage('feed', 'r'.repeat(4_100), options);

  assert.deepEqual(api.sent.map((entry) => entry.body.nonce.slice(-2)), ['-1', '-2']);
});

test('postMessage keeps all rich long-message parts in one continuation thread', async () => {
  const api = new FakeDiscordApi({
    feed: { id: 'feed', type: 0 },
  });
  const first = 'a'.repeat(2_001);
  const second = 'z'.repeat(2_001);
  const content = [
    first,
    '',
    '| 구간 | 상태 |',
    '| --- | --- |',
    '| 이미지 | 정상 |',
    '',
    second,
  ].join('\n');

  const messages = await api.postMessage('feed', content, {
    longMessageThreadName: 'Morning report',
  });

  assert.equal(api.threadCreations.length, 1);
  assert.equal(api.threadCreations[0].channelId, 'feed');
  assert.deepEqual(
    messages.map((message) => [message.id, message.channel_id]),
    [
      ['message-1', 'feed'],
      ['message-2', 'thread-1'],
      ['attachment-1', 'thread-1'],
      ['message-3', 'thread-1'],
      ['message-4', 'thread-1'],
    ],
  );
  assert.deepEqual(
    api.sent.map((entry) => entry.channelId),
    ['feed', 'thread-1', 'thread-1', 'thread-1'],
  );
  assert.deepEqual(api.attachments.map((entry) => entry.channelId), ['thread-1']);
  assert.equal(
    api.sent.reduce((count, entry) => count + (entry.content.match(/a/g) || []).length, 0),
    first.length,
  );
  assert.equal(
    api.sent.reduce((count, entry) => count + (entry.content.match(/z/g) || []).length, 0),
    second.length,
  );
});

test('postMessage reconciles an explicit file when a later rich part fails', async () => {
  const api = new FakeDiscordApi({
    feed: { id: 'feed', type: 0 },
  });
  const content = [
    '보고서',
    '',
    '| 구간 | 상태 |',
    '| --- | --- |',
    '| 이미지 | 정상 |',
  ].join('\n');
  const options = {
    files: [{
      filename: 'artifact.txt',
      dataBase64: Buffer.from('artifact').toString('base64'),
    }],
    verifyFiles: false,
  };
  const postAttachments = api.postAttachments.bind(api);
  let attachmentAttempts = 0;
  api.postAttachments = async (...args) => {
    attachmentAttempts += 1;
    if (attachmentAttempts === 2) throw new Error('generated image upload failed');
    return postAttachments(...args);
  };

  let progress;
  await assert.rejects(api.postMessage('feed', content, options), (error) => {
    progress = error;
    assert.equal(error.discordAttachmentVerificationPending, true);
    assert.deepEqual(error.discordMessageIds, ['attachment-1']);
    assert.equal(error.discordCompletedParts, 1);
    assert.equal(error.discordCompletedMessageCount, 1);
    return true;
  });

  api.postAttachments = postAttachments;
  const reconciled = [];
  api.reconcileAttachmentMessage = async (channelId, attachments, messageId) => {
    reconciled.push({ channelId, attachments, messageId });
    return { id: messageId, channel_id: channelId };
  };
  const resumed = await api.postMessage('feed', content, {
    ...options,
    reconcileAttachmentMessageId: progress.discordMessageIds[0],
    startPartIndex: progress.discordCompletedParts,
    startPartMessageCount: progress.discordCompletedMessageCount,
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].messageId, 'attachment-1');
  assert.equal(api.attachments.length, 2);
  assert.deepEqual(resumed.map((message) => message.id), ['attachment-1', 'attachment-2']);
});

test('postMessage resumes rich parts in the existing continuation thread', async () => {
  const api = new FakeDiscordApi({
    feed: { id: 'feed', type: 0 },
  });
  const content = [
    'a'.repeat(2_001),
    '',
    '| 구간 | 상태 |',
    '| --- | --- |',
    '| 이미지 | 정상 |',
    '',
    'z'.repeat(2_001),
  ].join('\n');
  const postAttachments = api.postAttachments.bind(api);
  api.postAttachments = async () => {
    throw new Error('temporary image upload failure');
  };

  let progress;
  await assert.rejects(api.postMessage('feed', content), (error) => {
    progress = error;
    assert.equal(error.discordCompletedParts, 1);
    assert.deepEqual(error.discordCompletedMessageIds, ['message-1', 'message-2']);
    assert.equal(error.discordCompletedMessageCount, 2);
    assert.equal(error.discordContinuationChannelId, 'thread-1');
    return true;
  });
  const sentBeforeRetry = api.sent.length;

  api.postAttachments = postAttachments;
  const resumed = await api.postMessage('feed', content, {
    startPartIndex: progress.discordCompletedParts,
    startPartMessageCount: progress.discordCompletedMessageCount,
    richContinuationChannelId: progress.discordContinuationChannelId,
  });

  assert.equal(api.threadCreations.length, 1);
  assert.deepEqual(api.attachments.map((entry) => entry.channelId), ['thread-1']);
  assert.deepEqual(
    api.sent.slice(sentBeforeRetry).map((entry) => entry.channelId),
    ['thread-1', 'thread-1'],
  );
  assert.ok(resumed.every((message) => message.channel_id === 'thread-1'));
});

test('postMessage resumes a partially sent rich text part without duplicating chunks', async () => {
  const api = new FakeDiscordApi({
    feed: { id: 'feed', type: 0 },
  });
  const first = 'a'.repeat(2_001);
  const content = [
    first,
    '',
    '| 구간 | 상태 |',
    '| --- | --- |',
    '| 이미지 | 정상 |',
    '',
    '완료',
  ].join('\n');
  const sendMessage = api.sendMessage.bind(api);
  let sendAttempts = 0;
  api.sendMessage = async (...args) => {
    sendAttempts += 1;
    if (sendAttempts === 2) throw new Error('temporary text chunk failure');
    return sendMessage(...args);
  };

  let progress;
  await assert.rejects(api.postMessage('feed', content), (error) => {
    progress = error;
    assert.equal(error.discordCompletedParts, 0);
    assert.deepEqual(error.discordCompletedMessageIds, ['message-1']);
    assert.equal(error.discordCompletedMessageCount, 1);
    assert.equal(error.discordPartialPartMessageCount, 1);
    assert.equal(error.discordContinuationChannelId, 'thread-1');
    return true;
  });

  api.sendMessage = sendMessage;
  const resumed = await api.postMessage('feed', content, {
    startPartIndex: progress.discordCompletedParts,
    startPartMessageCount: progress.discordCompletedMessageCount,
    startPartChunkIndex: progress.discordPartialPartMessageCount,
    richContinuationChannelId: progress.discordContinuationChannelId,
  });

  assert.equal(api.threadCreations.length, 1);
  assert.equal(
    api.sent.reduce((count, entry) => count + (entry.content.match(/a/g) || []).length, 0),
    first.length,
  );
  assert.ok(resumed.every((message) => message.channel_id === 'thread-1'));
  assert.deepEqual(api.attachments.map((entry) => entry.channelId), ['thread-1']);
});

test('postMessage sends long thread messages into the same thread', async () => {
  const api = new FakeDiscordApi({
    thread: { id: 'thread', type: 11, parent_id: 'feed' },
  });
  const content = 'y'.repeat(4100);

  const messages = await api.postMessage('thread', content);

  assert.equal(messages.length, 3);
  assert.deepEqual(api.sent.map((entry) => entry.channelId), ['thread', 'thread', 'thread']);
  assert.equal(api.threadCreations.length, 0);
  assert.equal(api.sent.map((entry) => entry.content).join(''), content);
});

test('postMessage atomically attaches an explicitly referenced artifact and verifies Discord bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-api-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'style_v2_a.png');
  const bytes = Buffer.from('verified-image-bytes');
  await fs.writeFile(filePath, bytes);
  const local = await loadDiscordAttachment(filePath);
  const requests = [];
  const remoteMessage = {
    id: 'artifact-message-1',
    attachments: [{
      id: 'attachment-1',
      filename: local.filename,
      size: local.size,
      url: 'https://cdn.test/style_v2_a.png',
    }],
  };

  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url) === 'https://cdn.test/style_v2_a.png') {
      return new Response(bytes, { status: 200 });
    }
    return jsonResponse(remoteMessage);
  });

  const api = new DiscordApi({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
  const messages = await api.postMessage('thread-1', '이미지를 보냈습니다.', {
    files: [{
      path: filePath,
      filename: local.filename,
      size: local.size,
      sha256: local.sha256,
    }],
  });

  assert.deepEqual(messages.map((message) => message.id), ['artifact-message-1']);
  assert.equal(requests[0].url, 'https://discord.test/api/channels/thread-1/messages');
  assert(requests[0].options.body instanceof FormData);
  assert.equal(
    JSON.parse(requests[0].options.body.get('payload_json')).content,
    '이미지를 보냈습니다.',
  );
  assert.deepEqual(
    Buffer.from(await requests[0].options.body.get('files[0]').arrayBuffer()),
    bytes,
  );
  assert.equal(requests[1].url, 'https://discord.test/api/channels/thread-1/messages/artifact-message-1');
  assert.equal(requests[2].url, 'https://cdn.test/style_v2_a.png');
});

test('postMessage refuses an artifact changed after selection', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-api-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'style.png');
  await fs.writeFile(filePath, Buffer.from('before'));
  const selected = await loadDiscordAttachment(filePath);
  await fs.writeFile(filePath, Buffer.from('after!'));

  const api = new DiscordApi({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
  await assert.rejects(
    api.postMessage('thread-1', '전달', { files: [selected] }),
    /changed before upload.*SHA-256 mismatch/,
  );
});

test('postMessage accepts immutable base64 bytes while Reception rejects host paths', async (t) => {
  const bytes = Buffer.from('immutable-artifact');
  const local = await loadDiscordAttachmentFromBytes(bytes, 'artifact.png');
  const api = new DiscordApi({
    token: 'test-token',
    apiBaseUrl: 'https://discord.test/api',
    allowAttachmentFilePaths: false,
  });

  await assert.rejects(
    api.postMessage('thread-1', '전달', { files: [{ path: '/etc/passwd' }] }),
    /file paths are disabled at the Reception boundary/,
  );

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return jsonResponse({ id: 'message-1' });
  });
  await api.postMessage('thread-1', '전달', { files: [local], verifyFiles: false });

  assert.equal(requests.length, 1);
  assert.deepEqual(
    Buffer.from(await requests[0].options.body.get('files[0]').arrayBuffer()),
    bytes,
  );
});

test('post-upload verification retries reconcile the existing message without reposting', async (t) => {
  const bytes = Buffer.from('verified-after-retry');
  const local = await loadDiscordAttachmentFromBytes(bytes, 'retry.png');
  const createdByNonce = new Map();
  const postNonces = [];
  let verificationReads = 0;

  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const value = String(url);
    if (value === 'https://discord.test/api/channels/thread-1/messages') {
      const payload = JSON.parse(options.body.get('payload_json'));
      postNonces.push(payload.nonce);
      assert.equal(payload.enforce_nonce, true);
      if (!createdByNonce.has(payload.nonce)) {
        createdByNonce.set(payload.nonce, {
          id: 'message-1',
          attachments: [{
            id: 'attachment-1',
            filename: local.filename,
            size: local.size,
            url: 'https://cdn.test/retry.png',
          }],
        });
      }
      return jsonResponse(createdByNonce.get(payload.nonce));
    }
    if (value === 'https://discord.test/api/channels/thread-1/messages/message-1') {
      verificationReads += 1;
      if (verificationReads === 1) return new Response('temporary failure', { status: 503 });
      return jsonResponse(createdByNonce.values().next().value);
    }
    if (value === 'https://cdn.test/retry.png') return new Response(bytes, { status: 200 });
    throw new Error(`unexpected request ${value}`);
  });

  const api = new DiscordApi({
    token: 'test-token',
    apiBaseUrl: 'https://discord.test/api',
    allowAttachmentFilePaths: false,
  });
  const options = {
    files: [local],
    deliveryNonce: 'ad12345678901234567890123',
  };

  await assert.rejects(api.postMessage('thread-1', '이미지 전달', options), (error) => {
    assert.equal(error.discordPostCompleted, true);
    assert.deepEqual(error.discordMessageIds, ['message-1']);
    return /503/.test(error.message);
  });
  const messages = await api.postMessage('thread-1', '이미지 전달', {
    ...options,
    reconcileAttachmentMessageId: 'message-1',
  });

  assert.deepEqual(messages.map((message) => message.id), ['message-1']);
  assert.equal(postNonces.length, 1);
  assert.equal(createdByNonce.size, 1);
  assert.equal(verificationReads, 2);
});

test('delivery nonces are distinct per long-message part and stable across retries', async () => {
  const api = new FakeDiscordApi({ thread: { id: 'thread', type: 11, parent_id: 'feed' } });
  const content = 'x'.repeat(4100);
  const options = { deliveryNonce: 'ad12345678901234567890123' };

  await api.postMessage('thread', content, options);
  const firstAttempt = api.sent.map((entry) => entry.body.nonce);
  api.sent.length = 0;
  await api.postMessage('thread', content, options);
  const secondAttempt = api.sent.map((entry) => entry.body.nonce);

  assert.equal(new Set(firstAttempt).size, 3);
  assert.deepEqual(secondAttempt, firstAttempt);
  assert(api.sent.every((entry) => entry.body.enforce_nonce === true));
  assert(api.sent.every((entry) => !('deliveryNonce' in entry.body)));
});

test('postMessage sends Markdown tables as PNG image attachments', async () => {
  const api = new FakeDiscordApi({ feed: { id: 'feed', type: 0 } });

  await api.postMessage('feed', '결과\n\n| 이름 | 값 |\n|---|---:|\n| ixiparser | 1204 |');

  assert.equal(api.sent[0].content, '결과\n\n');
  assert.equal(api.attachments.length, 1);
  assert.equal(api.attachments[0].attachments[0].contentType, 'image/png');
  assert.match(api.attachments[0].attachments[0].filename, /^codex-table-[a-f0-9]{12}\.png$/);
  assert.equal(api.attachments[0].attachments[0].data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('postMessage applies a selected style and sends one contact-sheet preview', async () => {
  const api = new FakeDiscordApi({ feed: { id: 'feed', type: 0 } });
  const table = '| name | value |\n| --- | --- |\n| latency | 42 |';

  await api.postMessage('feed', table, { styleId: 'minimal-light' });
  const styledFilename = api.attachments[0].attachments[0].filename;
  await api.postMessage('feed', table, { styleId: 'warm-noir' });
  assert.notEqual(api.attachments[1].attachments[0].filename, styledFilename);

  await api.postMessage('feed', 'Rendering themes', {
    styleId: 'minimal-light',
    includeStylePreview: true,
  });
  assert.equal(api.attachments.length, 3);
  assert.equal(api.attachments[2].attachments.length, 1);
  assert.match(api.attachments[2].attachments[0].filename, /^codex-style-preview-/);
  assert.equal('styleId' in api.sent.at(-1).body, false);
  assert.equal('includeStylePreview' in api.sent.at(-1).body, false);
});

test('postMessage checkpoints completed rich parts and resumes without reposting text', async () => {
  const api = new FakeDiscordApi({ feed: { id: 'feed', type: 0 } });
  const failedAttachmentOptions = [];
  const postAttachments = api.postAttachments.bind(api);
  api.postAttachments = async (_channelId, _attachments, options) => {
    failedAttachmentOptions.push(options);
    throw new Error('preview upload failed');
  };
  const options = {
    includeStylePreview: true,
    deliveryNonce: 'ad12345678901234567890123',
  };
  let progress;
  await assert.rejects(api.postMessage('feed', 'Rendering themes', options), (error) => {
    progress = error;
    assert.equal(error.discordCompletedParts, 1);
    assert.deepEqual(error.discordCompletedMessageIds, ['message-1']);
    assert.equal(error.discordTotalParts, 2);
    return true;
  });
  assert.deepEqual(api.sent.map((entry) => entry.content), ['Rendering themes']);

  api.postAttachments = postAttachments;
  const resumed = await api.postMessage('feed', 'Rendering themes', {
    ...options,
    startPartIndex: progress.discordCompletedParts,
    startPartMessageCount: progress.discordCompletedMessageCount,
  });
  assert.deepEqual(api.sent.map((entry) => entry.content), ['Rendering themes']);
  assert.deepEqual(resumed.map((message) => message.id), ['attachment-1']);
  assert.equal(api.attachments[0].options.deliveryNonce, failedAttachmentOptions[0].deliveryNonce);
});

test('postMessage sends oversized Markdown tables as aligned fenced text, never raw GFM', async () => {
  const api = new FakeDiscordApi({ thread: { id: 'thread', type: 11, parent_id: 'feed' } });
  const rows = Array.from({ length: 24 }, (_, index) => `| row-${index} | value-${index} |`);
  const content = [
    '| Name | Value |',
    '| --- | ---: |',
    ...rows,
  ].join('\n');

  await api.postMessage('thread', content);

  const delivered = api.sent.map((entry) => entry.content).join('\n');
  assert.equal(api.attachments.length, 0);
  assert.match(delivered, /^```(?:text)?\n/);
  assert.match(delivered, /row-23/);
  assert.doesNotMatch(delivered, /\| --- \|/);
});

test('postMessage keeps trivial inline TeX as selectable Unicode text', async () => {
  const api = new FakeDiscordApi({ feed: { id: 'feed', type: 0 } });

  await api.postMessage('feed', '**전담 서빙** $\\rightarrow$ **팁 18~20%**');

  assert.deepEqual(api.sent.map((entry) => entry.content), ['**전담 서빙** → **팁 18~20%**']);
  assert.equal(api.attachments.length, 0);
});

test('postMessage inlines an arrow without consuming the following formula image slot', async () => {
  const api = new FakeDiscordApi({ feed: { id: 'feed', type: 0 } });

  await api.postMessage('feed', '흐름 $\\rightarrow$ 결과, 점수 $L=L_{x}+\\lambda$');

  assert.equal(api.attachments.length, 1);
  assert.match(api.attachments[0].attachments[0].filename, /^codex-formula-[a-f0-9]{12}\.png$/);
  assert.equal(api.sent.map((entry) => entry.content).join(''), '흐름 → 결과, 점수 ');
});

test('postMessage rasterizes SVG code blocks instead of posting their source', async () => {
  const api = new FakeDiscordApi({ feed: { id: 'feed', type: 0 } });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="navy"/></svg>';

  await api.postMessage('feed', `다이어그램\n\n\`\`\`svg\n${svg}\n\`\`\``);

  assert.deepEqual(api.sent.map((entry) => entry.content), ['다이어그램\n\n']);
  assert.equal(api.sent.some((entry) => entry.content.includes('<svg')), false);
  assert.equal(api.attachments.length, 1);
  assert.equal(api.attachments[0].attachments[0].contentType, 'image/png');
  assert.match(api.attachments[0].attachments[0].filename, /^codex-diagram-[a-f0-9]{12}\.png$/);
});

test('postMessage sends fenced architecture diagrams as PNG attachments', async () => {
  const api = new FakeDiscordApi({ thread: { id: 'thread', type: 11, parent_id: 'feed' } });
  const content = [
    '추천 구조입니다.',
    '',
    '```text',
    '[안정적인 Supervisor]',
    ' ├─ [Worker Host] ─ 진행 중 작업',
    ' ├─ [Bridge Gen A] ─ 현재 버전',
    ' └─ [Bridge Gen B] ─ 대기 버전',
    '              ↕',
    '       [SQLite/WAL 영속 상태]',
    '```',
  ].join('\n');

  await api.postMessage('thread', content);

  assert.deepEqual(api.sent.map((entry) => entry.content), ['추천 구조입니다.\n\n']);
  assert.equal(api.attachments.length, 1);
  assert.equal(api.attachments[0].attachments[0].contentType, 'image/png');
  assert.match(api.attachments[0].attachments[0].filename, /^codex-diagram-[a-f0-9]{12}\.png$/);
});

test('postMessage keeps native Discord Markdown untouched', async () => {
  const api = new FakeDiscordApi({ feed: { id: 'feed', type: 0 } });

  await api.postMessage('feed', '## 결과\n\n**통과** and `a < b`');

  assert.equal(api.sent[0].content, '## 결과\n\n**통과** and `a < b`');
});

test('listMessages clamps the limit and passes after as a query param', async () => {
  const requests = [];
  const api = new DiscordApi({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
  api.request = async (method, route) => {
    requests.push({ method, route });
    return [];
  };

  await api.listMessages('channel-1', { limit: 500, after: '12345' });
  await api.listMessages('channel-1');

  assert.deepEqual(requests, [
    { method: 'GET', route: '/channels/channel-1/messages?limit=100&after=12345' },
    { method: 'GET', route: '/channels/channel-1/messages?limit=50' },
  ]);
});

test('createThread posts a standalone public thread', async () => {
  const requests = [];
  const api = new DiscordApi({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
  api.request = async (method, route, body) => {
    requests.push({ method, route, body });
    return { id: 'thread-99', type: 11 };
  };

  const thread = await api.createThread('channel-1', 'Project launch announcement', 1440);

  assert.equal(thread.id, 'thread-99');
  assert.deepEqual(requests, [{
    method: 'POST',
    route: '/channels/channel-1/threads',
    body: { name: 'Project launch announcement', auto_archive_duration: 1440, type: 11 },
  }]);
});

test('request retries rate limits and eventually succeeds', async (t) => {
  const responses = [
    rateLimitResponse(0.001),
    rateLimitResponse(0.001),
    jsonResponse({ id: 'channel-1' }),
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return responses.shift();
  });

  const api = new DiscordApi({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
  const channel = await api.getChannel('channel-1');

  assert.equal(channel.id, 'channel-1');
  assert.equal(calls, 3);
});

test('request stops retrying persistent rate limits and throws 429', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return rateLimitResponse(0.001);
  });

  const api = new DiscordApi({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
  await assert.rejects(() => api.getChannel('channel-1'), (error) => error.status === 429);
  assert(calls > 1);
  assert(calls <= 10);
});

test('request summarizes HTML failures without logging the full proxy page', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response([
    '<!DOCTYPE html>',
    '<html><head><title>discord.com | 504: Gateway time-out</title></head>',
    '<body>Your IP: 192.0.2.10</body></html>',
  ].join(''), {
    status: 504,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  }));

  const api = new DiscordApi({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
  await assert.rejects(() => api.sendMessage('thread-1', 'progress'), (error) => {
    assert.equal(error.status, 504);
    assert.match(error.message, /discord\.com \| 504: Gateway time-out/);
    assert.doesNotMatch(error.message, /192\.0\.2\.10/);
    assert(error.message.length < 200);
    return true;
  });
});

test('postAttachments sends Discord multipart payload without exposing the token', async (t) => {
  let request = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options };
    return jsonResponse({
      id: 'message-attachment-1',
      attachments: [{ id: 'a1', filename: 'slide.png', size: 3, url: 'https://cdn.test/slide.png' }],
    });
  });

  const api = new DiscordApi({ token: 'secret-token', apiBaseUrl: 'https://discord.test/api' });
  const message = await api.postAttachments('thread-1', [{
    filename: 'slide.png',
    contentType: 'image/png',
    data: Buffer.from('png'),
  }], { content: '슬라이드' });

  assert.equal(message.id, 'message-attachment-1');
  assert.equal(request.url, 'https://discord.test/api/channels/thread-1/messages');
  assert.equal(request.options.headers.Authorization, 'Bot secret-token');
  assert.equal(request.options.headers['Content-Type'], undefined);
  assert(request.options.body instanceof FormData);
  assert.deepEqual(JSON.parse(request.options.body.get('payload_json')), {
    allowed_mentions: { parse: [] },
    content: '슬라이드',
    attachments: [{ id: 0, filename: 'slide.png' }],
  });
  assert.equal(request.options.body.get('files[0]').name, 'slide.png');
});

test('postAttachments rejects more than ten files', async () => {
  const api = new DiscordApi({ token: 'test-token' });
  const files = Array.from({ length: 11 }, (_, index) => ({
    filename: `${index}.txt`,
    data: Buffer.from('x'),
  }));
  await assert.rejects(() => api.postAttachments('thread-1', files), /at most 10 attachments/);
});

test('postAttachments retries Discord multipart rate limits', async (t) => {
  const responses = [
    rateLimitResponse(0.001),
    jsonResponse({ id: 'message-attachment-2', attachments: [] }),
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return responses.shift();
  });

  const api = new DiscordApi({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
  const message = await api.postAttachments('thread-1', [{
    filename: 'result.pdf',
    data: Buffer.from('pdf'),
  }]);

  assert.equal(message.id, 'message-attachment-2');
  assert.equal(calls, 2);
});

function rateLimitResponse(retryAfterSeconds) {
  return new Response(JSON.stringify({ retry_after: retryAfterSeconds }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function loadDiscordAttachmentFromBytes(bytes, filename) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-api-bytes-'));
  const filePath = path.join(root, filename);
  await fs.writeFile(filePath, bytes);
  const loaded = await loadDiscordAttachment(filePath);
  await fs.rm(root, { recursive: true, force: true });
  return {
    filename: loaded.filename,
    size: loaded.size,
    sha256: loaded.sha256,
    dataBase64: bytes.toString('base64'),
  };
}

class FakeDiscordApi extends DiscordApi {
  constructor(channels) {
    super({ token: 'test-token', apiBaseUrl: 'https://discord.test/api' });
    this.channels = channels;
    this.sent = [];
    this.attachments = [];
    this.threadCreations = [];
  }

  async postAttachments(channelId, attachments, options = {}) {
    this.attachments.push({ channelId, attachments, options });
    return { id: `attachment-${this.attachments.length}`, channel_id: channelId };
  }

  async request(method, route, body = null) {
    const channelMatch = route.match(/^\/channels\/([^/]+)$/);
    if (method === 'GET' && channelMatch) {
      return this.channels[channelMatch[1]] || null;
    }

    const messageMatch = route.match(/^\/channels\/([^/]+)\/messages$/);
    if (method === 'POST' && messageMatch) {
      const channelId = messageMatch[1];
      this.sent.push({ channelId, content: body.content, body });
      return { id: `message-${this.sent.length}`, channel_id: channelId };
    }

    const threadMatch = route.match(/^\/channels\/([^/]+)\/messages\/([^/]+)\/threads$/);
    if (method === 'POST' && threadMatch) {
      const thread = { id: `thread-${this.threadCreations.length + 1}`, type: 11, parent_id: threadMatch[1] };
      this.threadCreations.push({
        channelId: threadMatch[1],
        messageId: threadMatch[2],
        body,
      });
      this.channels[thread.id] = thread;
      return thread;
    }

    throw new Error(`unexpected request ${method} ${route}`);
  }
}
