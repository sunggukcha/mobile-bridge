import assert from 'node:assert/strict';
import test from 'node:test';
import { SlackApi, chunkSlackMessage, slackMessageParts } from '../lib/slack-api.mjs';

test('SlackApi posts threaded messages with the bot token', async () => {
  const calls = [];
  const api = new SlackApi({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, ts: '1785218400.123456' });
    },
  });

  const messages = await api.postMessage('C123', 'hello', { threadTs: '1785218300.000001' });

  assert.deepEqual(messages.map((message) => message.id), ['1785218400.123456']);
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer xoxb-test');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    channel: 'C123',
    text: 'hello',
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
    thread_ts: '1785218300.000001',
  });
});

test('SlackApi uses the app token to open Socket Mode', async () => {
  const authorizations = [];
  const api = new SlackApi({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    fetchImpl: async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      return jsonResponse({ ok: true, url: 'wss://socket.slack.test/link' });
    },
  });

  const connection = await api.openSocketConnection();

  assert.equal(connection.url, 'wss://socket.slack.test/link');
  assert.deepEqual(authorizations, ['Bearer xapp-test']);
});

test('SlackApi form-encodes read methods Slack exposes as GET-style APIs', async () => {
  const calls = [];
  const api = new SlackApi({
    botToken: 'xoxb-test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        ok: true,
        user: { id: 'U123' },
        channel: { id: 'C123' },
        messages: [],
      });
    },
  });

  await api.userInfo('U123');
  await api.channelInfo('C123');
  await api.listMessages('C123', {
    oldest: '1785220000.000001',
    latest: '1785229999.999999',
    limit: 250,
  });
  await api.listReplies('C123', '1785220000.000001', {
    oldest: '1785220100.000002',
    limit: 50,
  });

  assert.deepEqual(calls.map((call) => ({
    url: call.url,
    contentType: call.options.headers['Content-Type'],
    body: call.options.body,
  })), [
    {
      url: 'https://slack.com/api/users.info',
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: 'user=U123',
    },
    {
      url: 'https://slack.com/api/conversations.info',
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: 'channel=C123',
    },
    {
      url: 'https://slack.com/api/conversations.history',
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: 'channel=C123&limit=100&inclusive=true&oldest=1785220000.000001&latest=1785229999.999999',
    },
    {
      url: 'https://slack.com/api/conversations.replies',
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: 'channel=C123&ts=1785220000.000001&limit=50&inclusive=true&oldest=1785220100.000002',
    },
  ]);
});

test('SlackApi surfaces Slack method errors without including credentials', async () => {
  const api = new SlackApi({
    botToken: ['xoxb', 'super', 'secret'].join('-'),
    fetchImpl: async () => jsonResponse({ ok: false, error: 'not_in_channel' }),
  });

  await assert.rejects(
    api.postMessage('C123', 'hello'),
    (error) => {
      assert.match(error.message, /not_in_channel/);
      assert.doesNotMatch(error.message, /super-secret/);
      assert.equal(error.slackError, 'not_in_channel');
      return true;
    },
  );
});

test('SlackApi converts Markdown to mrkdwn and uploads tables as images', async () => {
  const calls = [];
  const api = new SlackApi({
    botToken: 'xoxb-test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://slack.com/api/files.getUploadURLExternal') {
        return jsonResponse({ ok: true, upload_url: 'https://uploads.slack.test/file', file_id: 'F123' });
      }
      if (url === 'https://uploads.slack.test/file') {
        return { ok: true, status: 200 };
      }
      if (url === 'https://slack.com/api/files.completeUploadExternal') {
        return jsonResponse({ ok: true, files: [{ id: 'F123' }] });
      }
      return jsonResponse({ ok: true, ts: '1785218400.123456' });
    },
  });

  await api.postMessage('C123', '## 결과\n\n**통과** 1건\n\n| a | b |\n|---|---|\n| 1 | 2 |');

  assert.equal(JSON.parse(calls[0].options.body).text, '*결과*\n\n*통과* 1건\n\n');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://slack.com/api/chat.postMessage',
    'https://slack.com/api/files.getUploadURLExternal',
    'https://uploads.slack.test/file',
    'https://slack.com/api/files.completeUploadExternal',
  ]);
  assert.equal(
    calls[1].options.headers['Content-Type'],
    'application/x-www-form-urlencoded; charset=utf-8',
  );
  const uploadRequest = new URLSearchParams(calls[1].options.body);
  assert.match(uploadRequest.get('filename'), /^codex-table-[a-f0-9]{12}\.png$/);
  assert.ok(Number(uploadRequest.get('length')) > 0);
  assert.match(uploadRequest.get('alt_txt'), /Table:/);
  const completed = JSON.parse(calls[3].options.body);
  assert.equal(completed.channel_id, 'C123');
  assert.equal(completed.files[0].id, 'F123');
  assert.equal(completed.files[0].alt_txt, undefined);
});

test('Slack rich-message parts apply styles and include one contact-sheet preview', async () => {
  const table = '| name | value |\n| --- | --- |\n| latency | 42 |';
  const warm = (await slackMessageParts(table, { styleId: 'warm-noir' }))[0].attachment;
  const light = (await slackMessageParts(table, { styleId: 'minimal-light' }))[0].attachment;
  assert.notEqual(warm.filename, light.filename);

  const preview = await slackMessageParts('Rendering themes', {
    styleId: 'minimal-light',
    includeStylePreview: true,
  });
  assert.deepEqual(preview.map((part) => part.type), ['text', 'image']);
  assert.match(preview[1].attachment.filename, /^codex-style-preview-/);
});

test('SlackApi reports completed rich-message parts and resumes after them', async () => {
  const calls = [];
  let failUploadTicket = true;
  let textMessages = 0;
  const api = new SlackApi({
    botToken: 'xoxb-test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://slack.com/api/chat.postMessage') {
        textMessages += 1;
        return jsonResponse({ ok: true, ts: `1.00000${textMessages}` });
      }
      if (url === 'https://slack.com/api/files.getUploadURLExternal') {
        if (failUploadTicket) return jsonResponse({ ok: false, error: 'invalid_arguments' });
        return jsonResponse({
          ok: true,
          upload_url: 'https://uploads.slack.test/file',
          file_id: 'F123',
        });
      }
      if (url === 'https://uploads.slack.test/file') {
        return { ok: true, status: 200 };
      }
      if (url === 'https://slack.com/api/files.completeUploadExternal') {
        return jsonResponse({ ok: true, files: [{ id: 'F123' }] });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const content = 'before\n\n| key | value |\n|---|---|\n| one | two |\n\nafter';

  await assert.rejects(
    api.postMessage('C123', content, { threadTs: '1.000000' }),
    (error) => {
      assert.equal(error.slackCompletedParts, 1);
      assert.deepEqual(error.slackCompletedMessageIds, ['1.000001']);
      assert.deepEqual(error.slackMessageIds, ['1.000001']);
      assert.equal(error.slackTotalParts, 3);
      return true;
    },
  );
  assert.deepEqual(calls.map((call) => call.url), [
    'https://slack.com/api/chat.postMessage',
    'https://slack.com/api/files.getUploadURLExternal',
  ]);

  calls.length = 0;
  failUploadTicket = false;
  const resumed = await api.postMessage('C123', content, {
    threadTs: '1.000000',
    startPartIndex: 1,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://slack.com/api/files.getUploadURLExternal',
    'https://uploads.slack.test/file',
    'https://slack.com/api/files.completeUploadExternal',
    'https://slack.com/api/chat.postMessage',
  ]);
  assert.deepEqual(resumed.map((message) => message.id), ['F123', '1.000002']);
});

test('chunkSlackMessage closes and reopens a fenced block across a split', () => {
  const content = `\`\`\`js\n${'a'.repeat(30)}\n${'b'.repeat(30)}\n\`\`\``;
  const chunks = chunkSlackMessage(content, 40);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 40));
  assert.ok(chunks.every((chunk) => (chunk.match(/```/g) || []).length % 2 === 0));
  assert.ok(chunks[1].startsWith('```js'));
  const payload = chunks
    .join('\n')
    .split('\n')
    .filter((line) => !line.startsWith('```'))
    .join('');
  assert.equal(payload, `${'a'.repeat(30)}${'b'.repeat(30)}`);
});

test('chunkSlackMessage splits oversized content without data loss', () => {
  const content = `${'a'.repeat(12)}\n${'b'.repeat(12)}`;
  const chunks = chunkSlackMessage(content, 15);
  assert.equal(chunks.join(''), content);
  assert.ok(chunks.every((chunk) => chunk.length <= 15));
});

function jsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: () => null },
    async json() {
      return body;
    },
  };
}
