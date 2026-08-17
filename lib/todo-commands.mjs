import fs from 'node:fs/promises';
import path from 'node:path';
import { todoStateFiles } from './config.mjs';
import { withFileLock } from './file-lock.mjs';

// Applies parsed fast-path todo commands (see parseTodoCommand in
// bridge-commands.mjs) directly to the channel todo state, bypassing the
// worker queue entirely.

let todoLock = Promise.resolve();

export async function applyTodoCommand(config, channelId, command, { now = new Date(), id = null } = {}) {
  const files = todoStateFiles(config, channelId);
  // The process-local promise chain serializes callers inside this process;
  // the shared file lock additionally serializes against other processes
  // (worker CLIs, a second bridge) so the read→rewrite below cannot drop a
  // TODO appended concurrently.
  return withTodoLock(async () =>
    withFileLock(files.items, () => applyTodoCommandUnlocked(config, channelId, command, { now, id })));
}

async function applyTodoCommandUnlocked(config, channelId, command, { now, id }) {
  const files = todoStateFiles(config, channelId);

  if (command.action === 'add') {
    const entry = {
      id: `todo-${id || now.getTime()}`,
      status: 'active',
      scope: 'personal',
      title: command.title,
      items: [],
      created_at: now.toISOString(),
      source: 'fast-command',
    };
    await appendJsonl(files.items, entry);
    return { ok: true, action: 'add', entry };
  }

  const items = await readJsonl(files.items);
  const matches = matchTodoTarget(items, command.target);
  if (matches.length === 0) {
    return { ok: false, action: command.action, reason: 'not-found', target: command.target };
  }
  if (matches.length > 1) {
    return { ok: false, action: command.action, reason: 'ambiguous', target: command.target, candidates: matches };
  }

  const [matched] = matches;
  const remaining = items.filter((item) => item !== matched);
  const completed = command.action === 'complete';
  const entry = {
    ...matched,
    status: completed ? 'completed' : 'removed',
    ...(completed
      ? { completed_at: now.toISOString() }
      : { removed_at: now.toISOString() }),
  };
  const destination = completed
    ? files.completed
    : path.join(path.dirname(files.items), 'todo-removed.jsonl');
  await appendJsonl(destination, entry);
  await writeJsonlAtomic(files.items, remaining);
  return { ok: true, action: command.action, entry };
}

export function matchTodoTarget(items, target) {
  const text = String(target || '').trim();
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    if (index >= 1 && index <= items.length) return [items[index - 1]];
    return [];
  }
  const lowered = text.toLowerCase();
  const exact = items.filter((item) =>
    String(item.title || '').toLowerCase() === lowered
    || String(item.id || '').toLowerCase() === lowered);
  if (exact.length > 0) return exact;
  return items.filter((item) => String(item.title || '').toLowerCase().includes(lowered));
}

export function formatTodoCommandResult(result, todoState) {
  const lines = [];
  if (result.ok) {
    const verb = { add: '추가됨', complete: '완료 처리됨', remove: '삭제됨' }[result.action];
    lines.push(`할일 ${verb}: ${result.entry.title}`);
  } else if (result.reason === 'ambiguous') {
    lines.push(`여러 항목이 일치합니다: ${result.target}`);
    lines.push('번호로 다시 지정해주세요:');
    for (const candidate of result.candidates) {
      lines.push(`- [${candidate.id || 'todo'}] ${candidate.title || '(untitled)'}`);
    }
  } else {
    lines.push(`해당 할일을 찾지 못했습니다: ${result.target}`);
  }
  const active = todoState?.items || [];
  lines.push('');
  lines.push(`활성 TODO: ${active.length}`);
  for (const [index, item] of active.entries()) {
    lines.push(`${index + 1}. ${item.title || '(untitled)'}`);
  }
  if (active.length === 0) lines.push('- 없음');
  return lines.join('\n');
}

async function withTodoLock(fn) {
  const previous = todoLock;
  let release;
  todoLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function appendJsonl(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`);
}

async function writeJsonlAtomic(file, values) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = values.map((value) => JSON.stringify(value)).join('\n');
  const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, body ? `${body}\n` : '');
  await fs.rename(tmpPath, file);
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
