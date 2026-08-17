import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { todoStateFiles } from '../lib/config.mjs';
import { formatActiveTodoList, formatTodoDigest, formatTodoStateForPrompt, readChannelTodoState } from '../lib/todo-state.mjs';

test('readChannelTodoState reads channel-scoped todo files', async () => {
  const config = { stateRoot: await fs.mkdtemp(path.join(os.tmpdir(), 'todo-state-')) };
  const files = todoStateFiles(config, 'c1');
  await writeJsonl(files.items, [{ id: 'todo-1', title: 'active item' }]);
  await writeJsonl(files.completed, [{ id: 'todo-2', title: 'done item', completed_at: '2026-06-02T12:00:00+09:00' }]);
  await writeJsonl(files.alerts, [{ id: 'alert-1', title: 'alert item', notify_label: '2026-06-03 09:00 KST' }]);
  await writeJsonl(files.alertsCompleted, [{ id: 'alert-2', title: 'sent alert', sent_at: '2026-06-02T09:00:00+09:00' }]);

  const state = await readChannelTodoState(config, 'c1');

  assert.equal(state.items.length, 1);
  assert.equal(state.completed.length, 1);
  assert.equal(state.alerts.length, 1);
  assert.equal(state.alertsCompleted.length, 1);
  assert.match(formatTodoStateForPrompt(state), /Channel TODO state/);
  assert.match(formatTodoDigest(state), /현재 TODO 목록/);

  const activeList = formatActiveTodoList(state);
  assert.match(activeList, /활성 TODO: 1/);
  assert.match(activeList, /active item/);
  assert.doesNotMatch(activeList, /done item/);
  assert.doesNotMatch(activeList, /alert item/);
});

async function writeJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}
