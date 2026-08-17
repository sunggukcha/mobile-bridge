import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  formatChannelPreferencesForPrompt,
  readChannelPreferences,
} from '../lib/channel-memory.mjs';

test('readChannelPreferences loads active channel preferences', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-channel-memory-'));
  const config = { stateRoot: temp };
  const memoryDir = path.join(temp, 'channel-1_common', 'memory');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'preferences.jsonl'), [
    JSON.stringify({ id: 'pref-001', subject: 'news', instruction: '논문 섹션 포함' }),
    JSON.stringify({ id: 'pref-002', status: 'deleted', subject: 'old', instruction: '무시' }),
    '',
  ].join('\n'));

  const preferences = await readChannelPreferences(config, 'channel-1');

  assert.deepEqual(preferences.map((entry) => entry.id), ['pref-001']);
});

test('formatChannelPreferencesForPrompt gives workers durable channel preferences', () => {
  const prompt = formatChannelPreferencesForPrompt([
    { id: 'pref-001', subject: 'news', instruction: '논문 섹션 포함' },
  ]);

  assert.match(prompt, /Channel memory preferences:/);
  assert.match(prompt, /durable user preferences/);
  assert.match(prompt, /\[pref-001\] news: 논문 섹션 포함/);
  assert.equal(formatChannelPreferencesForPrompt([]), 'No channel memory preferences.');
});
