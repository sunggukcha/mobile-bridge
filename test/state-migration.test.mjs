import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateStateLayout } from '../lib/state-migration.mjs';

test('migrateStateLayout splits legacy channel and thread state without overwriting target jsonl', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-state-migration-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');

  await writeJsonl(path.join(source, '151_common_should_ignore.jsonl'), []);
  await writeJsonl(path.join(source, '151', 'alerts.jsonl'), [
    { id: 'legacy-alert', type: 'daily_quote' },
  ]);
  await writeJsonl(path.join(source, '151', 'threads', 't1', 'jobs', 'jobs.jsonl'), [
    { id: 'legacy-job', status: 'done' },
  ]);
  await writeJsonl(path.join(target, '151_common', 'alerts.jsonl'), [
    { id: 'existing-alert', type: 'message' },
  ]);
  await writeJsonl(path.join(target, '_system', 'events.jsonl'), [
    { type: 'existing' },
  ]);
  await fs.mkdir(path.join(source, '.agents'), { recursive: true });
  await fs.writeFile(path.join(source, '.agents', 'skip.txt'), 'skip');

  const result = await migrateStateLayout({ sourceRoot: source, targetRoot: target });

  assert.equal(result.migrated, true);
  assert.deepEqual(await readJsonl(path.join(target, '151_common', 'alerts.jsonl')), [
    { id: 'existing-alert', type: 'message' },
    { id: 'legacy-alert', type: 'daily_quote' },
  ]);
  assert.deepEqual(await readJsonl(path.join(target, '151', 't1', 'jobs', 'jobs.jsonl')), [
    { id: 'legacy-job', status: 'done' },
  ]);
  assert.deepEqual(await readJsonl(path.join(target, '_system', 'events.jsonl')), [
    { type: 'existing' },
  ]);
  await assert.rejects(fs.stat(path.join(target, '.agents', 'skip.txt')), { code: 'ENOENT' });
});

test('migrateStateLayout once skips re-running and never resurrects deleted records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-state-migration-once-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');

  await writeJsonl(path.join(source, '151', 'alerts.jsonl'), [
    { id: 'legacy-alert', type: 'daily_quote' },
  ]);

  const first = await migrateStateLayout({ sourceRoot: source, targetRoot: target, once: true });
  assert.equal(first.migrated, true);
  assert.deepEqual(await readJsonl(path.join(target, '151_common', 'alerts.jsonl')), [
    { id: 'legacy-alert', type: 'daily_quote' },
  ]);

  // User deletes the alert from canonical state while the legacy line still exists.
  await fs.writeFile(path.join(target, '151_common', 'alerts.jsonl'), '');

  // A later restart must NOT re-merge the still-present legacy record back in.
  const second = await migrateStateLayout({ sourceRoot: source, targetRoot: target, once: true });
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'already-migrated');
  assert.equal(await fs.readFile(path.join(target, '151_common', 'alerts.jsonl'), 'utf8'), '');
});

test('migrateStateLayout once marks completion even when legacy source is absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-state-migration-missing-'));
  const target = path.join(root, 'target');
  const result = await migrateStateLayout({ sourceRoot: path.join(root, 'nope'), targetRoot: target, once: true });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'source-missing');
  await assert.doesNotReject(fs.stat(path.join(target, '.legacy-state-migrated')));
});

async function writeJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '');
}

async function readJsonl(file) {
  return (await fs.readFile(file, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('migrateStateLayout preserves legitimately duplicate jsonl lines while staying idempotent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-state-migration-dup-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');

  // The same event recorded twice in legacy state, one copy already migrated.
  await writeJsonl(path.join(source, '151', 'alerts.jsonl'), [
    { id: 'dup-alert', type: 'message' },
    { id: 'dup-alert', type: 'message' },
  ]);
  await writeJsonl(path.join(target, '151_common', 'alerts.jsonl'), [
    { id: 'dup-alert', type: 'message' },
  ]);

  await migrateStateLayout({ sourceRoot: source, targetRoot: target });
  assert.deepEqual(await readJsonl(path.join(target, '151_common', 'alerts.jsonl')), [
    { id: 'dup-alert', type: 'message' },
    { id: 'dup-alert', type: 'message' },
  ]);

  // Re-running the merge must not multiply the duplicates.
  await migrateStateLayout({ sourceRoot: source, targetRoot: target });
  assert.deepEqual(await readJsonl(path.join(target, '151_common', 'alerts.jsonl')), [
    { id: 'dup-alert', type: 'message' },
    { id: 'dup-alert', type: 'message' },
  ]);
});
