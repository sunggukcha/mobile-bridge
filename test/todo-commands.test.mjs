import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isControlOnlyCommandRequest, parseTodoCommand } from '../lib/bridge-commands.mjs';
import { applyTodoCommand, formatTodoCommandResult, matchTodoTarget } from '../lib/todo-commands.mjs';

test('parseTodoCommand recognizes add, complete, and remove forms', () => {
  assert.deepEqual(parseTodoCommand('/할일추가 문서 적극적으로 정리하기'), {
    action: 'add',
    title: '문서 적극적으로 정리하기',
  });
  assert.deepEqual(parseTodoCommand('/할일 완료 2'), { action: 'complete', target: '2' });
  assert.deepEqual(parseTodoCommand('/todo삭제 문서정리'), { action: 'remove', target: '문서정리' });
  assert.deepEqual(parseTodoCommand('/todoadd add tests'), { action: 'add', title: 'add tests' });
  assert.equal(parseTodoCommand('/할일'), null);
  assert.equal(parseTodoCommand('할일추가 문서정리'), null);
  assert.equal(parseTodoCommand('오늘 할일 추가해줘'), null);
});

test('todo fast commands are control-only requests', () => {
  assert.equal(isControlOnlyCommandRequest('/할일추가 문서정리'), true);
  assert.equal(isControlOnlyCommandRequest('/할일완료 1'), true);
  assert.equal(isControlOnlyCommandRequest('일반 작업 요청'), false);
});

test('applyTodoCommand add appends an active entry', async () => {
  const config = await testConfig();

  const result = await applyTodoCommand(config, 'channel-1', { action: 'add', title: '문서정리' }, {
    now: new Date('2026-06-11T07:00:00.000Z'),
    id: 'msg-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.entry.title, '문서정리');
  assert.equal(result.entry.status, 'active');
  const items = await readJsonl(path.join(config.stateRoot, 'channel-1_common', 'todo.jsonl'));
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'todo-msg-1');
});

test('applyTodoCommand complete moves the matched entry to the completed file', async () => {
  const config = await testConfig();
  await applyTodoCommand(config, 'channel-1', { action: 'add', title: '문서정리' }, { id: 'a' });
  await applyTodoCommand(config, 'channel-1', { action: 'add', title: '테스트 추가' }, { id: 'b' });

  const result = await applyTodoCommand(config, 'channel-1', { action: 'complete', target: '테스트' }, {
    now: new Date('2026-06-11T08:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.entry.status, 'completed');
  assert.equal(result.entry.completed_at, '2026-06-11T08:00:00.000Z');
  const root = path.join(config.stateRoot, 'channel-1_common');
  const items = await readJsonl(path.join(root, 'todo.jsonl'));
  assert.deepEqual(items.map((item) => item.title), ['문서정리']);
  const completed = await readJsonl(path.join(root, 'todo-completed.jsonl'));
  assert.deepEqual(completed.map((item) => item.title), ['테스트 추가']);
});

test('applyTodoCommand complete by displayed number targets the nth active item', async () => {
  const config = await testConfig();
  await applyTodoCommand(config, 'channel-1', { action: 'add', title: 'first' }, { id: 'a' });
  await applyTodoCommand(config, 'channel-1', { action: 'add', title: 'second' }, { id: 'b' });

  const result = await applyTodoCommand(config, 'channel-1', { action: 'complete', target: '2' });

  assert.equal(result.ok, true);
  assert.equal(result.entry.title, 'second');
});

test('applyTodoCommand remove keeps an audit record outside the completed list', async () => {
  const config = await testConfig();
  await applyTodoCommand(config, 'channel-1', { action: 'add', title: '주간 알림' }, { id: 'a' });

  const result = await applyTodoCommand(config, 'channel-1', { action: 'remove', target: '주간' });

  assert.equal(result.ok, true);
  assert.equal(result.entry.status, 'removed');
  const root = path.join(config.stateRoot, 'channel-1_common');
  assert.deepEqual(await readJsonl(path.join(root, 'todo.jsonl')), []);
  assert.deepEqual(await readJsonl(path.join(root, 'todo-completed.jsonl')), []);
  const removed = await readJsonl(path.join(root, 'todo-removed.jsonl'));
  assert.equal(removed.length, 1);
});

test('applyTodoCommand reports ambiguous and missing targets without changing state', async () => {
  const config = await testConfig();
  await applyTodoCommand(config, 'channel-1', { action: 'add', title: '배포 staging' }, { id: 'a' });
  await applyTodoCommand(config, 'channel-1', { action: 'add', title: '배포 production' }, { id: 'b' });

  const ambiguous = await applyTodoCommand(config, 'channel-1', { action: 'complete', target: '배포' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.equal(ambiguous.candidates.length, 2);

  const missing = await applyTodoCommand(config, 'channel-1', { action: 'remove', target: '없는항목' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-found');

  const items = await readJsonl(path.join(config.stateRoot, 'channel-1_common', 'todo.jsonl'));
  assert.equal(items.length, 2);
});

test('matchTodoTarget prefers exact title match over substring matches', () => {
  const items = [
    { id: 'todo-1', title: '검토' },
    { id: 'todo-2', title: '검토 확인' },
  ];

  assert.deepEqual(matchTodoTarget(items, '검토'), [items[0]]);
  assert.deepEqual(matchTodoTarget(items, 'todo-2'), [items[1]]);
  assert.deepEqual(matchTodoTarget(items, '7'), []);
});

test('formatTodoCommandResult lists remaining active todos with display numbers', () => {
  const text = formatTodoCommandResult(
    { ok: true, action: 'complete', entry: { title: '테스트 추가' } },
    { items: [{ title: '문서정리' }] },
  );

  assert.equal(text, [
    '할일 완료 처리됨: 테스트 추가',
    '',
    '활성 TODO: 1',
    '1. 문서정리',
  ].join('\n'));
});

async function testConfig() {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-commands-'));
  return { stateRoot };
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
