import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '../lib/file-lock.mjs';

async function tmpTarget() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-lock-test-'));
  return path.join(dir, 'state.jsonl');
}

test('withFileLock serializes concurrent critical sections', async () => {
  const target = await tmpTarget();
  const order = [];
  await Promise.all([
    withFileLock(target, async () => {
      order.push('a-start');
      await new Promise((resolve) => setTimeout(resolve, 120));
      order.push('a-end');
    }),
    withFileLock(target, async () => {
      order.push('b-start');
      order.push('b-end');
    }, { retryMs: 10 }),
  ]);
  const aEnd = order.indexOf('a-end');
  const bStart = order.indexOf('b-start');
  // whichever ran first must fully finish before the other starts
  assert.ok((aEnd < bStart) || (order.indexOf('b-end') < order.indexOf('a-start')));
});

test('withFileLock releases the lock after the callback throws', async () => {
  const target = await tmpTarget();
  await assert.rejects(withFileLock(target, async () => {
    throw new Error('boom');
  }), /boom/);
  // lock must be free again
  const result = await withFileLock(target, async () => 'ok');
  assert.equal(result, 'ok');
});

test('withFileLock reclaims a lock owned by a dead pid', async () => {
  const target = await tmpTarget();
  const lockDir = `${target}.lock`;
  await fs.mkdir(lockDir);
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999, created_at: new Date().toISOString() }));
  const result = await withFileLock(target, async () => 'reclaimed', {
    retryMs: 10,
    isProcessAlive: () => false,
  });
  assert.equal(result, 'reclaimed');
});

test('withFileLock reclaims an over-age lock even when its pid looks alive (pid reuse)', async () => {
  const target = await tmpTarget();
  const lockDir = `${target}.lock`;
  await fs.mkdir(lockDir);
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
  const result = await withFileLock(target, async () => 'reclaimed', {
    retryMs: 10,
    hardStaleMs: 0,
    isProcessAlive: () => true,
  });
  assert.equal(result, 'reclaimed');
});

test('withFileLock times out instead of spinning forever on a held live lock', async () => {
  const target = await tmpTarget();
  const lockDir = `${target}.lock`;
  await fs.mkdir(lockDir);
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
  await assert.rejects(
    withFileLock(target, async () => 'never', {
      retryMs: 10,
      timeoutMs: 100,
      isProcessAlive: () => true,
    }),
    /file lock timeout/,
  );
  await fs.rm(lockDir, { recursive: true, force: true });
});
