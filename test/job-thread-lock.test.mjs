import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireThreadJobLock,
  isThreadJobLockOwnerFromCurrentService,
  isThreadJobLockOwnerFromPreviousService,
  readThreadJobLockOwner,
  releaseThreadJobLock,
  threadJobLockFile,
} from '../lib/job-thread-lock.mjs';

test('threadJobLockFile is scoped by channel and thread', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-thread-lock-'));
  const config = { stateRoot };
  const file = threadJobLockFile(config, {
    channelId: 'channel/1',
    threadId: 'thread:1',
  });

  assert.equal(
    file,
    path.join(stateRoot, '_system', 'thread-job-locks', 'channel_1__thread_1.lock'),
  );
});

test('acquireThreadJobLock blocks a second live owner and stores job metadata', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-thread-lock-'));
  const config = { stateRoot };
  const job = { id: 'job-1', channelId: 'channel-1', threadId: 'thread-1' };

  const first = await acquireThreadJobLock(config, job, {
    pid: 1234,
    isProcessAlive: () => false,
  });
  assert.equal(first.acquired, true);

  const lockContent = JSON.parse(await fs.readFile(threadJobLockFile(config, job), 'utf8'));
  assert.equal(lockContent.jobId, 'job-1');
  assert.equal(lockContent.channelId, 'channel-1');
  assert.equal(lockContent.threadId, 'thread-1');

  const second = await acquireThreadJobLock(config, { ...job, id: 'job-2' }, {
    pid: 5678,
    isProcessAlive: (pid) => pid === 1234,
  });
  assert.equal(second.acquired, false);
  assert.equal(second.owner.jobId, 'job-1');

  assert.equal(await releaseThreadJobLock(config, job, { pid: 1234 }), true);
});

test('thread job locks allow different threads to run concurrently', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-thread-lock-'));
  const config = { stateRoot };

  const first = await acquireThreadJobLock(config, { id: 'job-1', channelId: 'channel-1', threadId: 'thread-1' }, {
    pid: 1234,
    isProcessAlive: () => false,
  });
  const second = await acquireThreadJobLock(config, { id: 'job-2', channelId: 'channel-1', threadId: 'thread-2' }, {
    pid: 5678,
    isProcessAlive: () => true,
  });

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true);
});

test('startup recovery ignores a lock acquired by the current service', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-thread-lock-'));
  const config = { stateRoot };
  const job = { id: 'job-1', channelId: 'channel-1', threadId: 'thread-1' };

  const lock = await acquireThreadJobLock(config, job, {
    pid: 1234,
    startedAt: '2026-06-09T00:02:00.000Z',
    isProcessAlive: () => false,
  });
  assert.equal(lock.acquired, true);

  const owner = await readThreadJobLockOwner(config, job, {
    currentPid: 1234,
    processStartedAtMs: Date.parse('2026-06-09T00:01:00.000Z'),
  });
  assert.equal(owner, null);

  assert.equal(await releaseThreadJobLock(config, job, { pid: 1234 }), true);
});

test('startup recovery still exposes external and pid-reused locks', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-thread-lock-'));
  const config = { stateRoot };
  const job = { id: 'job-1', channelId: 'channel-1', threadId: 'thread-1' };

  await acquireThreadJobLock(config, job, {
    pid: 5678,
    startedAt: '2026-06-09T00:02:00.000Z',
    isProcessAlive: () => false,
  });
  const externalOwner = await readThreadJobLockOwner(config, job, {
    currentPid: 1234,
    processStartedAtMs: Date.parse('2026-06-09T00:01:00.000Z'),
  });
  assert.equal(externalOwner.pid, 5678);
  await releaseThreadJobLock(config, job, { pid: 5678 });

  await acquireThreadJobLock(config, job, {
    pid: 1234,
    startedAt: '2026-06-09T00:00:00.000Z',
    isProcessAlive: () => false,
  });
  const reusedPidOwner = await readThreadJobLockOwner(config, job, {
    currentPid: 1234,
    processStartedAtMs: Date.parse('2026-06-09T00:01:00.000Z'),
  });
  assert.equal(reusedPidOwner.pid, 1234);
  await releaseThreadJobLock(config, job, { pid: 1234 });
});

test('isThreadJobLockOwnerFromCurrentService requires matching pid and post-start acquisition', () => {
  const options = {
    currentPid: 1234,
    processStartedAtMs: Date.parse('2026-06-09T00:01:00.000Z'),
  };
  assert.equal(
    isThreadJobLockOwnerFromCurrentService(
      { pid: 1234, startedAt: '2026-06-09T00:02:00.000Z' },
      options,
    ),
    true,
  );
  assert.equal(
    isThreadJobLockOwnerFromCurrentService(
      { pid: 5678, startedAt: '2026-06-09T00:02:00.000Z' },
      options,
    ),
    false,
  );
  assert.equal(
    isThreadJobLockOwnerFromCurrentService(
      { pid: 1234, startedAt: '2026-06-09T00:00:00.000Z' },
      options,
    ),
    false,
  );
});

test('isThreadJobLockOwnerFromPreviousService detects restart leftovers by startedAt', () => {
  assert.equal(
    isThreadJobLockOwnerFromPreviousService(
      { pid: 1234, startedAt: '2026-06-09T00:00:00.000Z' },
      '2026-06-09T00:01:00.000Z',
    ),
    true,
  );
  assert.equal(
    isThreadJobLockOwnerFromPreviousService(
      { pid: 1234, startedAt: '2026-06-09T00:02:00.000Z' },
      '2026-06-09T00:01:00.000Z',
    ),
    false,
  );
  assert.equal(isThreadJobLockOwnerFromPreviousService({ pid: 1234 }, '2026-06-09T00:01:00.000Z'), false);
});
