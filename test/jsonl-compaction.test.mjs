import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compactBridgeStateFiles, compactJsonlFile, rotateArchiveFile } from '../lib/jsonl-compaction.mjs';

test('compactJsonlFile leaves small files untouched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-compaction-'));
  const file = path.join(dir, 'events.jsonl');
  await writeLines(file, 10);

  const result = await compactJsonlFile(file, { maxBytes: 1_000_000, keepLines: 5 });

  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'below-max-bytes');
  assert.equal((await readLines(file)).length, 10);
});

test('compactJsonlFile archives old lines and keeps the newest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-compaction-'));
  const file = path.join(dir, 'events.jsonl');
  await writeLines(file, 30);

  const result = await compactJsonlFile(file, { maxBytes: 100, keepLines: 10 });

  assert.equal(result.compacted, true);
  assert.equal(result.archivedLines, 20);
  assert.equal(result.keptLines, 10);
  const kept = await readLines(file);
  assert.equal(kept.length, 10);
  assert.equal(JSON.parse(kept[0]).index, 20);
  assert.equal(JSON.parse(kept[9]).index, 29);
  const archived = await readLines(`${file}.archive`);
  assert.equal(archived.length, 20);
  assert.equal(JSON.parse(archived[0]).index, 0);
  assert.equal(JSON.parse(archived[19]).index, 19);
});

test('compactJsonlFile appends to an existing archive across runs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-compaction-'));
  const file = path.join(dir, 'events.jsonl');
  await writeLines(file, 20);
  await compactJsonlFile(file, { maxBytes: 100, keepLines: 10 });

  // Live file grows again past the threshold.
  await fs.appendFile(file, `${Array.from({ length: 10 }, (_, index) => JSON.stringify({ index: 100 + index })).join('\n')}\n`);
  const second = await compactJsonlFile(file, { maxBytes: 100, keepLines: 10 });

  assert.equal(second.compacted, true);
  const archived = await readLines(`${file}.archive`);
  assert.equal(archived.length, 20);
  assert.equal((await readLines(file)).length, 10);
});

test('compactJsonlFile is a no-op when the file no longer exceeds keepLines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-compaction-'));
  const file = path.join(dir, 'events.jsonl');
  await writeLines(file, 8);

  const result = await compactJsonlFile(file, { maxBytes: 10, keepLines: 10 });

  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'below-keep-lines');
});

test('compactJsonlFile reports missing files without throwing', async () => {
  const result = await compactJsonlFile(path.join(os.tmpdir(), 'jsonl-compaction-missing', 'nope.jsonl'));
  assert.deepEqual(result.compacted, false);
  assert.equal(result.reason, 'missing');
});

test('compactBridgeStateFiles compacts log files but never todo state', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-compaction-state-'));
  const systemEvents = path.join(stateRoot, '_system', 'events.jsonl');
  const threadEvents = path.join(stateRoot, '100', '200', 'memory', 'events.jsonl');
  const threadJobs = path.join(stateRoot, '100', '200', 'jobs', 'jobs.jsonl');
  const pendingJobs = path.join(stateRoot, '100_common', 'pending-thread', 'jobs.jsonl');
  const todoFile = path.join(stateRoot, '100_common', 'todo.jsonl');
  for (const file of [systemEvents, threadEvents, threadJobs, pendingJobs, todoFile]) {
    await writeLines(file, 30);
  }

  const results = await compactBridgeStateFiles(stateRoot, { maxBytes: 100, keepLines: 10 });

  assert.deepEqual(
    results.map((result) => result.file).sort(),
    [systemEvents, threadEvents, threadJobs, pendingJobs].sort(),
  );
  assert.equal((await readLines(todoFile)).length, 30);
  assert.equal((await readLines(threadEvents)).length, 10);
});

test('rotateArchiveFile keeps one archive generation instead of growing forever', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-compaction-'));
  const file = path.join(dir, 'events.jsonl');
  await writeLines(file, 10);
  await writeLines(`${file}.archive`, 30);

  const first = await rotateArchiveFile(file, { maxArchiveBytes: 100 });

  assert.equal(first.rotated, true);
  assert.equal((await readLines(`${file}.archive`)).length, 0);
  assert.equal((await readLines(`${file}.archive.1`)).length, 30);
  assert.equal((await readLines(file)).length, 10, 'the live file must not be touched');

  // A second rotation replaces the previous generation rather than adding one.
  await writeLines(`${file}.archive`, 40);
  const second = await rotateArchiveFile(file, { maxArchiveBytes: 100 });

  assert.equal(second.rotated, true);
  assert.equal((await readLines(`${file}.archive.1`)).length, 40);
  assert.equal((await readLines(`${file}.archive.2`)).length, 0);
});

test('rotateArchiveFile leaves an archive under the limit alone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-compaction-'));
  const file = path.join(dir, 'events.jsonl');
  await writeLines(`${file}.archive`, 5);

  const result = await rotateArchiveFile(file, { maxArchiveBytes: 1_000_000 });

  assert.equal(result.rotated, false);
  assert.equal((await readLines(`${file}.archive`)).length, 5);
  assert.equal((await readLines(`${file}.archive.1`)).length, 0);
});

test('compactBridgeStateFiles rotates oversized archives it produced earlier', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-compaction-state-'));
  const systemEvents = path.join(stateRoot, '_system', 'events.jsonl');
  await writeLines(systemEvents, 30);
  await writeLines(`${systemEvents}.archive`, 60);

  const results = await compactBridgeStateFiles(stateRoot, {
    maxBytes: 100,
    keepLines: 10,
    maxArchiveBytes: 200,
  });

  assert.deepEqual(
    results.map((result) => `${result.file}:${result.compacted ? 'compacted' : 'rotated'}`),
    [`${systemEvents}:compacted`, `${systemEvents}.archive:rotated`],
  );
  assert.equal((await readLines(`${systemEvents}.archive.1`)).length, 80, 'compacted lines are archived, then rotated');
});

async function writeLines(file, count) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({ index, padding: 'x'.repeat(40) }));
  await fs.writeFile(file, `${lines.join('\n')}\n`);
}

async function readLines(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
