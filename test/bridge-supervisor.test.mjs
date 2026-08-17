import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquirePidLock, releasePidLock, releasePidLockSync } from '../lib/supervisor-lock.mjs';
import { formatServiceExitNotice } from '../lib/supervisor-notices.mjs';

test('formatServiceExitNotice reports unplanned exits concisely', () => {
  const notice = formatServiceExitNotice({ code: 1, signal: null }, { consecutiveFailures: 2 });

  assert.match(notice, /서버 다운 감지/);
  assert.match(notice, /사유: 비정상 종료/);
  assert.match(notice, /연속 실패 2회/);
  assert.match(notice, /재시작: 자동 시도/);
  assert.doesNotMatch(notice, /개선:/);
});

test('formatServiceExitNotice keeps planned restart notices to a one-line title', () => {
  const notice = formatServiceExitNotice({ code: 75, signal: null }, {
    pendingRestart: {
      source: 'runtime-source-change',
      channelId: 'c1',
      threadId: 't1',
    },
  });

  assert.equal(notice, '【서비스 재시작】');
  assert.doesNotMatch(notice, /재부팅 진행/);
  assert.doesNotMatch(notice, /사유: 계획된 재시작/);
  assert.doesNotMatch(notice, /재시작: 자동 시도/);
  assert.doesNotMatch(notice, /channel=/);
  assert.doesNotMatch(notice, /thread=/);
});

test('formatServiceExitNotice carries the worker + effort into the planned restart title', () => {
  const notice = formatServiceExitNotice({ code: 75, signal: null }, {
    pendingRestart: {
      source: 'runtime-source-change',
      workerLabel: 'codex: gpt-5.6-terra',
      workerEffort: 'xhigh',
    },
  });

  assert.equal(notice, '【codex gpt-5.6-terra xhigh: 서비스 재시작】');
});

test('bridge supervisor consumes pending restart state after planned exit notice', async () => {
  const source = await fs.readFile(new URL('../bridge-supervisor.mjs', import.meta.url), 'utf8');

  assert.match(source, /consumePendingRestart\(pendingRestart\)/);
  assert.match(source, /fs\.rm\(systemState\.file\('pending-restart\.json'\), \{ force: true \}\)/);
  assert.match(source, /pending-restart-consumed/);
});

test('bridge supervisor reloads .env for each service spawn', async () => {
  const source = await fs.readFile(new URL('../bridge-supervisor.mjs', import.meta.url), 'utf8');

  assert.match(source, /readDotEnvFile\(path\.join\(repoRoot, '\.env'\)\)/);
  assert.match(source, /\.\.\.dotEnvAuthoritativeChildEnv\(dotenvEnv, process\.env\)/);
});

test('supervisor pid lock blocks a second live owner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-supervisor-lock-'));
  const lockFile = path.join(dir, 'supervisor.lock');
  const alivePids = new Set([1234]);

  const first = await acquirePidLock(lockFile, {
    pid: 1234,
    isProcessAlive: (pid) => alivePids.has(pid),
  });
  const second = await acquirePidLock(lockFile, {
    pid: 5678,
    isProcessAlive: (pid) => alivePids.has(pid),
  });

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.owner.pid, 1234);
});

test('supervisor pid lock recovers stale owner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-supervisor-lock-'));
  const lockFile = path.join(dir, 'supervisor.lock');

  await acquirePidLock(lockFile, {
    pid: 1234,
    isProcessAlive: () => false,
  });
  const recovered = await acquirePidLock(lockFile, {
    pid: 5678,
    isProcessAlive: () => false,
  });

  assert.equal(recovered.acquired, true);
  assert.equal(recovered.pid, 5678);
  assert.equal(await releasePidLock(lockFile, { pid: 5678 }), true);
});

test('releasePidLockSync releases own lock but never a foreign one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-supervisor-lock-'));
  const lockFile = path.join(dir, 'supervisor.lock');

  await acquirePidLock(lockFile, { pid: 1234, isProcessAlive: () => true });
  assert.equal(releasePidLockSync(lockFile, { pid: 5678 }), false);
  await fs.access(lockFile);

  assert.equal(releasePidLockSync(lockFile, { pid: 1234 }), true);
  await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });

  // Already-released lock is a no-op.
  assert.equal(releasePidLockSync(lockFile, { pid: 1234 }), false);
});
