import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { channelStateDir, todoStateFiles } from '../lib/config.mjs';
import { JsonState } from '../lib/state.mjs';
import { formatTodoAlertMessage, processDueTodoAlerts } from '../lib/todo-alerts.mjs';

test('processDueTodoAlerts sends due one-shot alerts and archives them', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.items, [{ id: 'today', title: '오늘 할 일', items: ['문서정리'] }]);
  await writeJsonl(files.alerts, [
    {
      id: 'due-alert',
      todo_id: 'today',
      title: '오늘 할 일: 문서정리',
      notify_at: '2026-06-03T09:00:00+09:00',
      notify_label: '2026-06-03 09:00 KST',
    },
    {
      id: 'future-alert',
      title: '나중 알림',
      notify_at: '2026-06-03T21:00:00+09:00',
    },
  ]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-06-03T03:30:00.000Z'),
  });

  assert.equal(result.sent, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(sent.map((entry) => entry.channelId), ['c1']);
  assert.match(sent[0].content, /오늘 할 일: 문서정리/);

  const remaining = await readJsonl(files.alerts);
  const completed = await readJsonl(files.alertsCompleted);
  assert.deepEqual(remaining.map((alert) => alert.id), ['future-alert']);
  assert.equal(completed[0].id, 'due-alert');
  assert.equal(completed[0].sent_at, '2026-06-03T03:30:00.000Z');
});

test('processDueTodoAlerts reschedules daily todo digests', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.items, [{ id: 'todo-1', title: '프로젝트 문서 정리', items: ['README'] }]);
  await writeJsonl(files.alerts, [{
    id: 'todo-digest-daily-0900-kst',
    type: 'todo_digest',
    title: '전체 TODO 요약',
    notify_at: '2026-06-03T09:00:00+09:00',
    notify_label: '2026-06-03 09:00 KST',
    recurrence: 'daily',
    todo_scope: 'personal',
  }]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-06-03T03:30:00.000Z'),
  });

  assert.equal(result.sent, 1);
  assert.equal(result.rescheduled, 1);
  assert.match(sent[0].content, /활성 TODO 1건/);

  const remaining = await readJsonl(files.alerts);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].notify_at, '2026-06-04T09:00:00+09:00');
  assert.equal(remaining[0].notify_label, '2026-06-04 09:00 KST');
  assert.equal(remaining[0].last_sent_at, '2026-06-03T03:30:00.000Z');
});

test('processDueTodoAlerts skips empty todo digests without posting but still reschedules', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  // Only a personal todo exists; the company-scoped digest has nothing to report.
  await writeJsonl(files.items, [{ id: 'todo-1', title: '개인 할 일', items: ['샘플 항목'] }]);
  await writeJsonl(files.alerts, [{
    id: 'company-todo-digest-daily-1000-kst',
    type: 'todo_digest',
    title: '회사 TODO 요약',
    notify_at: '2026-06-03T10:00:00+09:00',
    notify_label: '2026-06-03 10:00 KST',
    recurrence: 'workdays',
    todo_scope: 'company',
    last_sent_at: '2026-05-29T01:00:00.000Z',
  }]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-06-03T03:30:00.000Z'),
  });

  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.rescheduled, 1);
  assert.equal(sent.length, 0);

  const remaining = await readJsonl(files.alerts);
  assert.equal(remaining.length, 1);
  // 2026-06-03 is a Wednesday, so the next workday digest is Thursday.
  assert.equal(remaining[0].notify_at, '2026-06-04T10:00:00+09:00');
  assert.equal(remaining[0].notify_label, '2026-06-04 10:00 KST');
  assert.equal(remaining[0].last_skipped_at, '2026-06-03T03:30:00.000Z');
  // Nothing was posted, so the previous real send time must be preserved.
  assert.equal(remaining[0].last_sent_at, '2026-05-29T01:00:00.000Z');

  const completed = await readJsonl(files.alertsCompleted);
  assert.equal(completed.length, 0);
});

test('todo digest messages wrap todo URLs so Discord does not autolink them', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.items, [{
    id: 'todo-1',
    title: '공개 행사 확인하기',
    items: ['https://example.test/events/launch'],
  }]);
  await writeJsonl(files.alerts, [{
    id: 'todo-digest-daily-0900-kst',
    type: 'todo_digest',
    title: '전체 TODO 요약',
    notify_at: '2026-06-03T09:00:00+09:00',
    notify_label: '2026-06-03 09:00 KST',
    recurrence: 'daily',
    todo_scope: 'personal',
  }]);

  const sent = [];
  await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-06-03T03:30:00.000Z'),
  });

  assert.match(sent[0].content, /`https:\/\/example\.test\/events\/launch`/);
});

test('one-shot todo alert messages wrap todo URLs so Discord does not autolink them', () => {
  const content = formatTodoAlertMessage(
    {
      id: 'event-alert',
      todo_id: 'todo-1',
      title: '행사 페이지 확인하기',
      notify_at: '2026-08-23T09:00:00+09:00',
    },
    {
      items: [{
        id: 'todo-1',
        title: '공개 행사 확인하기',
        items: ['https://example.test/events/launch'],
      }],
    },
  );

  assert.match(content, /`https:\/\/example\.test\/events\/launch`/);
});

test('processDueTodoAlerts sends daily quote content for the KST calendar date', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.alerts, [{
    id: 'daily-quote-1000-kst',
    type: 'daily_quote',
    title: '일일 명언',
    notify_at: '2028-02-29T10:00:00+09:00',
    notify_label: '2028-02-29 10:00 KST',
    recurrence: 'daily',
    discord_channel_id: 'quote-thread',
    created_from_thread_id: 'quote-thread',
    quotes: {
      '02-28': { speaker: 'Wrong Day', quote: 'This should not be sent.' },
      '02-29': {
        speaker: 'Marcus Aurelius',
        quote: 'The universe is change; our life is what our thoughts make it.',
        speaker_ko: '마르쿠스 아우렐리우스',
        quote_ko: '우주는 변화이며, 우리의 삶은 우리의 생각이 만드는 것이다.',
        interpretation_ko: '세상은 계속 바뀌고, 삶의 모습은 우리가 어떤 생각을 품느냐에 크게 달려 있다는 뜻이다.',
      },
    },
  }]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2028-02-29T01:00:00.000Z'),
  });

  assert.equal(result.sent, 1);
  assert.equal(result.rescheduled, 1);
  assert.equal(sent[0].channelId, 'c1');
  assert.equal(sent[0].content, [
    '원문:',
    'Marcus Aurelius: The universe is change; our life is what our thoughts make it.',
    '',
    '한국어 번역:',
    '마르쿠스 아우렐리우스: 우주는 변화이며, 우리의 삶은 우리의 생각이 만드는 것이다.',
    '',
    '해석',
    '세상은 계속 바뀌고, 삶의 모습은 우리가 어떤 생각을 품느냐에 크게 달려 있다는 뜻이다.',
  ].join('\n'));

  const remaining = await readJsonl(files.alerts);
  assert.equal(remaining[0].discord_channel_id, 'c1');
  assert.equal(remaining[0].parent_channel_id, 'c1');
  assert.equal(remaining[0].notify_at, '2028-03-01T10:00:00+09:00');
});

test('processDueTodoAlerts sends duplicate daily quote alerts only once', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  const alert = {
    id: 'daily-quote-1000-kst',
    type: 'daily_quote',
    title: '일일 명언',
    notify_at: '2028-02-29T10:00:00+09:00',
    notify_label: '2028-02-29 10:00 KST',
    recurrence: 'daily',
    discord_channel_id: 'quote-thread',
    created_from_thread_id: 'quote-thread',
    quotes: {
      '02-29': {
        speaker: 'Marcus Aurelius',
        quote: 'The universe is change.',
        speaker_ko: '마르쿠스 아우렐리우스',
        quote_ko: '우주는 변화다.',
      },
    },
  };
  await writeJsonl(files.alerts, [alert, { ...alert }, { ...alert }]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2028-02-29T01:00:00.000Z'),
  });

  assert.equal(result.checked, 3);
  assert.equal(result.sent, 1);
  assert.equal(result.rescheduled, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, 'c1');

  const remaining = await readJsonl(files.alerts);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'daily-quote-1000-kst');
  assert.equal(remaining[0].notify_at, '2028-03-01T10:00:00+09:00');
});

test('processDueTodoAlerts sends concurrently processed daily quote alerts only once', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.alerts, [{
    id: 'daily-quote-1000-kst',
    type: 'daily_quote',
    title: '일일 명언',
    notify_at: '2028-02-29T10:00:00+09:00',
    notify_label: '2028-02-29 10:00 KST',
    recurrence: 'daily',
    quotes: {
      '02-29': {
        speaker: 'Marcus Aurelius',
        quote: 'The universe is change.',
        speaker_ko: '마르쿠스 아우렐리우스',
        quote_ko: '우주는 변화다.',
      },
    },
  }]);

  const sent = [];
  const api = {
    async postMessage(channelId, content) {
      await sleep(25);
      sent.push({ channelId, content });
      return [{ id: `message-${sent.length}` }];
    },
  };
  const args = {
    config,
    api,
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2028-02-29T01:00:00.000Z'),
  };
  const [first, second] = await Promise.all([
    processDueTodoAlerts(args),
    processDueTodoAlerts(args),
  ]);

  assert.equal(first.sent + second.sent, 1);
  assert.equal(first.rescheduled + second.rescheduled, 1);
  assert.equal(sent.length, 1);

  const remaining = await readJsonl(files.alerts);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].notify_at, '2028-03-01T10:00:00+09:00');
});

test('processDueTodoAlerts normalizes future daily quote target to the parent channel', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  const alert = {
    id: 'future-daily-quote',
    type: 'daily_quote',
    title: '일일 명언',
    notify_at: '2028-03-01T10:00:00+09:00',
    recurrence: 'daily',
    discord_channel_id: 'quote-thread',
    created_from_thread_id: 'quote-thread',
    quotes: {},
  };
  await writeJsonl(files.alerts, [alert, { ...alert }, { ...alert }]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2028-02-29T01:00:00.000Z'),
  });

  assert.equal(result.sent, 0);
  assert.equal(sent.length, 0);
  const remaining = await readJsonl(files.alerts);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].discord_channel_id, 'c1');
  assert.equal(remaining[0].parent_channel_id, 'c1');
  assert.equal(remaining[0].created_from_thread_id, 'quote-thread');
});

test('processDueTodoAlerts queues failed Discord sends and does not duplicate later', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.alerts, [{
    id: 'due-alert',
    title: '실패해도 outbox',
    notify_at: '2026-06-03T09:00:00+09:00',
  }]);

  const systemState = new JsonState(path.join(config.stateRoot, '_system'));
  const result = await processDueTodoAlerts({
    config,
    api: {
      async postMessage() {
        throw new Error('network down');
      },
    },
    systemState,
    now: new Date('2026-06-03T03:30:00.000Z'),
  });

  assert.equal(result.queued, 1);
  assert.equal(result.completed, 1);
  assert.equal((await readJsonl(files.alerts)).length, 0);
  const outbox = await systemState.readJson('discord-outbox.json', []);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].purpose, 'todo-alert');
});

// Reception refuses `{ path }` attachments, so an alert that sends a path never
// reaches Discord: it fails, retries until the outbox gives up, and the user sees
// nothing while the alert is already archived as sent.
test('processDueTodoAlerts uploads channel-artifact attachments as bytes, never as host paths', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  const artifacts = path.join(config.stateRoot, 'c1_common', 'artifacts');
  await fs.mkdir(path.join(artifacts, 'maps'), { recursive: true });
  await fs.writeFile(path.join(artifacts, 'maps', 'day.png'), 'not-really-a-png');
  await writeJsonl(files.alerts, [{
    id: 'map-alert',
    type: 'message',
    title: '오늘 일정',
    content: '오늘 동선',
    notify_at: '2026-08-08T08:00:00-04:00',
    attachments: ['artifacts/maps/day.png'],
  }]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-08-08T12:00:00.000Z'),
  });

  assert.equal(result.sent, 1);
  assert.equal(sent[0].options.files.length, 1);
  const [attached] = sent[0].options.files;
  assert.equal(attached.path, undefined);
  assert.equal(attached.filename, 'day.png');
  assert.equal(attached.contentType, 'image/png');
  assert.equal(attached.size, 'not-really-a-png'.length);
  assert.equal(
    Buffer.from(attached.dataBase64, 'base64').toString('utf8'),
    'not-really-a-png',
  );
});

test('processDueTodoAlerts drops an oversized attachment but still posts the alert text', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  const artifacts = path.join(config.stateRoot, 'c1_common', 'artifacts');
  await fs.mkdir(path.join(artifacts, 'maps'), { recursive: true });
  await fs.writeFile(
    path.join(artifacts, 'maps', 'huge.png'),
    Buffer.alloc(8 * 1024 * 1024 + 1, 1),
  );
  await writeJsonl(files.alerts, [{
    id: 'map-alert',
    type: 'message',
    content: '오늘 동선',
    notify_at: '2026-08-08T08:00:00-04:00',
    attachments: ['artifacts/maps/huge.png'],
  }]);

  const sent = [];
  const skipped = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-08-08T12:00:00.000Z'),
    logSystem: async (event, payload) => {
      if (event === 'todo-alert-attachment-skipped') skipped.push(payload);
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(sent[0].options.files, undefined);
  assert.deepEqual(skipped[0].skipped.map((entry) => entry.reason), ['file-too-large']);
});

test('processDueTodoAlerts still posts an alert whose attachment is missing or escapes the artifacts root', async () => {
  const config = await testConfig(['c1']);
  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.alerts, [{
    id: 'map-alert',
    type: 'message',
    content: '오늘 동선',
    notify_at: '2026-08-08T08:00:00-04:00',
    attachments: ['artifacts/maps/gone.png', '../../../etc/hosts'],
  }]);

  const sent = [];
  const skipped = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-08-08T12:00:00.000Z'),
    logSystem: async (event, payload) => {
      if (event === 'todo-alert-attachment-skipped') skipped.push(payload);
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(sent[0].content, '오늘 동선');
  assert.deepEqual(sent[0].options, {});
  assert.deepEqual(
    skipped[0].skipped.map((entry) => entry.reason),
    ['missing', 'outside-artifacts-dir'],
  );
});

async function testConfig(channelIds) {
  return {
    stateRoot: await fs.mkdtemp(path.join(os.tmpdir(), 'todo-alerts-')),
    discord: { channelIds },
  };
}

function fakeApi(sent) {
  return {
    async postMessage(channelId, content, options = {}) {
      sent.push({ channelId, content, options });
      return [{ id: `message-${sent.length}` }];
    },
  };
}

async function writeJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '');
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// An alert body rendered from an external source must be rebuilt at send time,
// or an edit made after the alert was created goes out as stale text.
test('processDueTodoAlerts rebuilds alert content from its refresh hook before sending', async () => {
  const config = await testConfig(['c1']);
  await fakeChannelPython(config, 'c1');
  await writeRefreshScript(config, 'c1', `
import json, sys
payload = json.load(sys.stdin)
date = payload["alert"]["notify_at"][:10]
print(json.dumps({
    "content": "최신 일정 " + date,
    "attachments": ["artifacts/fresh.txt"],
}, ensure_ascii=False))
`);
  await writeArtifact(config, 'c1', 'fresh.txt', 'fresh');

  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.alerts, [{
    id: 'sheet-alert',
    type: 'message',
    title: '오늘 일정',
    content: '옛날에 만들어진 낡은 본문',
    notify_at: '2026-08-10T06:00:00-04:00',
    attachments: ['artifacts/stale.txt'],
    refresh: { script: 'artifacts/refresh.py', timeout_ms: 30000 },
  }]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-08-10T10:00:00.000Z'),
  });

  assert.equal(result.sent, 1);
  assert.equal(result.refreshed, 1);
  assert.equal(sent[0].content, '최신 일정 2026-08-10');
  assert.deepEqual(sent[0].options.files.map((file) => file.filename), ['fresh.txt']);

  // The archived record keeps what actually went out, not the stale draft.
  const completed = await readJsonl(files.alertsCompleted);
  assert.equal(completed[0].content, '최신 일정 2026-08-10');
  assert.equal(completed[0].content_refreshed_at, '2026-08-10T10:00:00.000Z');
});

// The refresh is a best-effort improvement, never a delivery gate.
test('processDueTodoAlerts still sends stored content when the refresh hook fails', async () => {
  const config = await testConfig(['c1']);
  await fakeChannelPython(config, 'c1');
  await writeRefreshScript(config, 'c1', `
import sys
sys.stderr.write("sheet unreachable\\n")
sys.exit(1)
`);

  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.alerts, [{
    id: 'sheet-alert',
    type: 'message',
    title: '오늘 일정',
    content: '저장된 본문',
    notify_at: '2026-08-10T06:00:00-04:00',
    refresh: { script: 'artifacts/refresh.py' },
  }]);

  const sent = [];
  const result = await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-08-10T10:00:00.000Z'),
  });

  assert.equal(result.sent, 1);
  assert.equal(result.refreshed, 0);
  assert.equal(sent[0].content, '저장된 본문');
});

// A state file must not be able to point the hook at a script outside the
// channel it belongs to.
test('processDueTodoAlerts refuses a refresh script outside the channel state dir', async () => {
  const config = await testConfig(['c1']);
  await fakeChannelPython(config, 'c1');
  const outside = path.join(config.stateRoot, 'escape.py');
  await fs.writeFile(outside, 'print(\'{"content": "탈출"}\')\n');

  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.alerts, [{
    id: 'sheet-alert',
    type: 'message',
    content: '저장된 본문',
    notify_at: '2026-08-10T06:00:00-04:00',
    refresh: { script: '../escape.py' },
  }]);

  const sent = [];
  await processDueTodoAlerts({
    config,
    api: fakeApi(sent),
    systemState: new JsonState(path.join(config.stateRoot, '_system')),
    now: new Date('2026-08-10T10:00:00.000Z'),
  });

  assert.equal(sent[0].content, '저장된 본문');
});

async function fakeChannelPython(config, channelId) {
  config.python = { channelVenvEnabled: true, channelVenvDir: '.venv' };
  const binDir = path.join(channelStateDir(config, channelId), '.venv', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(await resolveTestPython(), path.join(binDir, 'python'));
}

// The refresh hook runs the channel venv interpreter, so these tests need a real
// python3 on the host rather than a stub.
async function resolveTestPython() {
  if (process.env.BRIDGE_TEST_PYTHON) return process.env.BRIDGE_TEST_PYTHON;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['python3', 'python']) {
      const candidate = path.join(dir, name);
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile()) return candidate;
    }
  }
  return '';
}

async function writeRefreshScript(config, channelId, source) {
  const file = path.join(channelStateDir(config, channelId), 'artifacts', 'refresh.py');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
}

async function writeArtifact(config, channelId, name, body) {
  const file = path.join(channelStateDir(config, channelId), 'artifacts', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}
