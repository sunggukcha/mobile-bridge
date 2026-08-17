import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJobThreadContext,
  buildThreadContext,
  formatThreadMessage,
} from '../lib/discord-thread-context.mjs';

test('formatThreadMessage includes author, timestamp, content, and attachments', () => {
  const line = formatThreadMessage({
    author: { username: 'example-user' },
    timestamp: '2026-06-02T01:00:00.000Z',
    content: 'check this',
    attachments: [{ filename: 'report.png' }],
  });

  assert.equal(line, '[2026-06-02T01:00:00.000Z] example-user: check this attachments=[report.png]');
});

test('formatThreadMessage includes author id when available', () => {
  const line = formatThreadMessage({
    authorName: 'display-name',
    authorId: '12345',
    timestamp: '2026-06-02T01:00:00.000Z',
    content: 'check this',
  });

  assert.equal(line, '[2026-06-02T01:00:00.000Z] display-name [12345]: check this');
});

test('formatThreadMessage includes referenced message content when message body is empty', () => {
  const line = formatThreadMessage({
    authorName: 'requester',
    authorId: 'u1',
    timestamp: '2026-06-02T01:00:00.000Z',
    content: '',
    referencedMessage: {
      authorName: 'bridge',
      authorId: 'bot1',
      content: 'Original text\nTranslated text',
    },
  });

  assert.equal(
    line,
    '[2026-06-02T01:00:00.000Z] requester [u1]: referenced=[bridge [bot1]: Original text Translated text]',
  );
});

test('formatThreadMessage includes embed text', () => {
  const line = formatThreadMessage({
    authorName: 'requester',
    timestamp: '2026-06-02T01:00:00.000Z',
    content: 'look at this',
    embeds: [{ title: 'Embed title', description: 'Embed description', url: 'https://example.test/item' }],
  });

  assert.equal(
    line,
    '[2026-06-02T01:00:00.000Z] requester: look at this embeds=[Embed title - Embed description - https://example.test/item]',
  );
});

test('formatThreadMessage includes forwarded message snapshots when message body is empty', () => {
  const line = formatThreadMessage({
    authorName: 'requester',
    authorId: 'u1',
    timestamp: '2026-06-11T06:01:59.000Z',
    content: '',
    forwardedMessages: [{ content: 'Project launch announcement', attachments: [{ filename: 'announcement.png' }] }],
  });

  assert.equal(
    line,
    '[2026-06-11T06:01:59.000Z] requester [u1]: forwarded=[Project launch announcement attachments=announcement.png]',
  );
});

test('formatThreadMessage reads raw discord message_snapshots shape', () => {
  const line = formatThreadMessage({
    authorName: 'requester',
    timestamp: '2026-06-11T06:01:59.000Z',
    content: '이거 봐줘',
    message_snapshots: [{ message: { content: 'forwarded body' } }],
  });

  assert.equal(line, '[2026-06-11T06:01:59.000Z] requester: 이거 봐줘 forwarded=[forwarded body]');
});

test('buildThreadContext orders a backfilled thread starter chronologically', () => {
  const context = buildThreadContext([
    { authorName: 'a', timestamp: '2026-06-02T01:01:00.000Z', content: 'first reply' },
    { authorName: 'a', timestamp: '2026-06-02T01:02:00.000Z', content: 'second reply' },
    { authorName: 'starter', timestamp: '2026-06-02T01:00:00.000Z', content: 'thread starter', threadStarter: true },
  ]);

  assert.deepEqual(context.split('\n').map((line) => line.split(': ')[1]), [
    'thread starter',
    'first reply',
    'second reply',
  ]);
});

test('buildThreadContext keeps only recent thread messages', () => {
  const context = buildThreadContext([
    { authorName: 'a', timestamp: '1', content: 'old' },
    { authorName: 'b', timestamp: '2', content: 'middle' },
    { authorName: 'c', timestamp: '3', content: 'new' },
  ], { maxMessages: 2 });

  assert.equal(context, '[2] b: middle\n[3] c: new');
});

test('buildThreadContext excludes bridge progress messages from prompts', () => {
  const context = buildThreadContext([
    {
      authorId: 'bridge-agent',
      authorName: 'Codex bridge',
      source: 'bridge-agent',
      purpose: 'worker-progress',
      timestamp: '1',
      content: 'running command: git status',
    },
    {
      authorId: 'bridge-agent',
      authorName: 'Codex bridge',
      source: 'bridge-agent',
      purpose: 'job-progress',
      timestamp: '2',
      content: 'claude Opus 5 (xhigh) working for 1 minute.',
    },
    {
      authorName: 'requester',
      timestamp: '3',
      content: '다음 작업 해줘',
    },
    {
      authorName: 'requester',
      purpose: 'worker-progress',
      timestamp: '4',
      content: 'worker-progress라는 단어 설명해줘',
    },
  ]);

  assert.equal(
    context,
    '[3] requester: 다음 작업 해줘\n[4] requester: worker-progress라는 단어 설명해줘',
  );
});

test('buildThreadContext respects maxChars while keeping the newest message', () => {
  const context = buildThreadContext([
    { authorName: 'a', timestamp: '1', content: 'long long long long long' },
    { authorName: 'b', timestamp: '2', content: 'latest' },
  ], { maxChars: 14 });

  assert.equal(context, '[2] b: latest');
});

test('buildJobThreadContext retains later messages but fixes the current execution trigger', () => {
  const messages = [
    {
      id: 'before',
      authorName: 'requester',
      timestamp: '2026-07-28T09:50:00.000Z',
      content: '앞선 대화 맥락',
    },
    {
      id: 'queued-a',
      authorName: 'requester',
      timestamp: '2026-07-28T09:55:39.900Z',
      content: '/queue 데이터셋 업로드',
    },
    {
      id: 'queued-b',
      authorName: 'requester',
      timestamp: '2026-07-28T09:58:05.315Z',
      content: '/queue 코드도 커밋하고 푸시',
    },
  ];

  const context = buildJobThreadContext(messages, {
    id: 'queued-a',
    event: messages[1],
  });

  assert.match(context, /앞선 대화 맥락/);
  assert.match(context, /\/queue 데이터셋 업로드/);
  assert.match(context, /\/queue 코드도 커밋하고 푸시/);
  assert.match(context, /Current job trigger boundary:/);
  assert.match(context, /Event ID: queued-a/);
  assert.match(context, /Messages later than this trigger remain visible for continuity/);
  assert.match(context, /they belong to separate jobs/);
});
