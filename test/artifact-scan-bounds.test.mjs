import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARTIFACT_IGNORE_MARKER,
  SKIPPED_ARTIFACT_DIRECTORIES,
  captureArtifactDeliverySnapshot,
} from '../lib/artifact-delivery.mjs';

async function artifactRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-artifact-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFile(root, relativePath, body = 'x') {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
}

test('dependency, VCS and cache directories are never walked', async (t) => {
  const root = await artifactRoot(t);
  await writeFile(root, 'report.md', '# report');
  await writeFile(root, 'run/output.csv', 'a,b');
  for (const skipped of SKIPPED_ARTIFACT_DIRECTORIES) {
    await writeFile(root, path.join('run', skipped, 'buried.txt'), 'noise');
  }

  const snapshot = await captureArtifactDeliverySnapshot(root);
  assert.deepEqual([...snapshot.keys()].sort(), ['report.md', 'run/output.csv']);
  assert.equal(Boolean(snapshot.truncated), false);
});

test('a nested .git checkout inside an artifact folder is skipped', async (t) => {
  const root = await artifactRoot(t);
  await writeFile(root, 'release/notes.md', 'notes');
  await writeFile(root, 'release/repo/.git/objects/ab/cdef', 'blob');
  await writeFile(root, 'release/repo/src/index.mjs', 'code');

  const snapshot = await captureArtifactDeliverySnapshot(root);
  assert.deepEqual(
    [...snapshot.keys()].sort(),
    ['release/notes.md', 'release/repo/src/index.mjs'],
  );
});

test('the file cap bounds the scan and reports truncation', async (t) => {
  const root = await artifactRoot(t);
  for (let index = 0; index < 12; index += 1) {
    await writeFile(root, `file-${String(index).padStart(3, '0')}.txt`, 'body');
  }

  const snapshot = await captureArtifactDeliverySnapshot(root, { maxFiles: 5 });
  assert.equal(snapshot.size, 5);
  assert.equal(snapshot.truncated, true);
});

test('a truncated scan covers the same deterministic prefix every time', async (t) => {
  const root = await artifactRoot(t);
  for (let index = 0; index < 20; index += 1) {
    await writeFile(root, `dir-${String(index).padStart(2, '0')}/item.txt`, 'body');
  }

  // Before/after snapshots that truncated at different points would report
  // untouched files as newly created.
  const first = await captureArtifactDeliverySnapshot(root, { maxFiles: 6 });
  const second = await captureArtifactDeliverySnapshot(root, { maxFiles: 6 });
  assert.deepEqual([...first.keys()], [...second.keys()]);
  assert.deepEqual([...first.keys()].sort(), [...first.keys()]);
});

test('the time budget stops a scan that would otherwise run unbounded', async (t) => {
  const root = await artifactRoot(t);
  for (let index = 0; index < 8; index += 1) {
    await writeFile(root, `file-${index}.txt`, 'body');
  }

  // A clock that jumps past the budget on its first check.
  let calls = 0;
  const snapshot = await captureArtifactDeliverySnapshot(root, {
    timeBudgetMs: 1_000,
    now: () => {
      calls += 1;
      return calls > 2 ? 10_000 : 0;
    },
  });
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.size < 8, 'the budget must cut the scan short');
});

test('an ignore marker removes a folder from the walk without hiding its siblings', async (t) => {
  const root = await artifactRoot(t);
  await writeFile(root, 'summary.md', 'summary');
  await writeFile(root, 'dataset/' + ARTIFACT_IGNORE_MARKER, '');
  await writeFile(root, 'dataset/shard-0001.bin', 'data');
  await writeFile(root, 'dataset/deep/shard-0002.bin', 'data');
  await writeFile(root, 'results/metrics.json', '{}');

  const snapshot = await captureArtifactDeliverySnapshot(root);
  assert.deepEqual([...snapshot.keys()].sort(), ['results/metrics.json', 'summary.md']);
});

test('an ignore marker at the artifact root is refused so delivery cannot be disabled wholesale', async (t) => {
  const root = await artifactRoot(t);
  await writeFile(root, ARTIFACT_IGNORE_MARKER, '');
  await writeFile(root, 'report.md', 'report');

  const snapshot = await captureArtifactDeliverySnapshot(root);
  assert.ok(snapshot.has('report.md'), 'the root marker must not silence the channel');
});

test('a missing artifact root is still an empty, untruncated snapshot', async (t) => {
  const root = await artifactRoot(t);
  const snapshot = await captureArtifactDeliverySnapshot(path.join(root, 'absent'));
  assert.equal(snapshot.size, 0);
  assert.equal(Boolean(snapshot.truncated), false);
});
