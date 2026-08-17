import fs from 'node:fs/promises';
import path from 'node:path';
import { statePathPart } from './config.mjs';
import { acquirePidLock, releasePidLock } from './supervisor-lock.mjs';

const LOCK_DIR = 'thread-job-locks';
const PROCESS_STARTED_AT_MS = Date.now() - (process.uptime() * 1_000);

export function threadJobLockFile(config, job = {}) {
  return path.join(
    config.stateRoot,
    '_system',
    LOCK_DIR,
    `${statePathPart(job.channelId || 'system')}__${statePathPart(job.threadId || job.channelId || 'channel')}.lock`,
  );
}

export function acquireThreadJobLock(config, job = {}, options = {}) {
  return acquirePidLock(threadJobLockFile(config, job), {
    ...options,
    metadata: {
      channelId: String(job.channelId || ''),
      threadId: String(job.threadId || job.channelId || ''),
      jobId: String(job.id || ''),
      ...(options.metadata || {}),
    },
  });
}

export function releaseThreadJobLock(config, job = {}, options = {}) {
  return releasePidLock(threadJobLockFile(config, job), options);
}

export async function readThreadJobLockOwner(config, job = {}, {
  currentPid = process.pid,
  processStartedAtMs = PROCESS_STARTED_AT_MS,
} = {}) {
  try {
    const owner = JSON.parse(await fs.readFile(threadJobLockFile(config, job), 'utf8'));
    // Startup recovery may enqueue several interrupted roots from one thread.
    // The first enqueue can start immediately and acquire this process's lock
    // before the recovery loop reaches the remaining roots. That local lock is
    // already serialized by JobScheduler, so exposing it as an external live
    // owner makes the remaining roots wait for another service restart.
    return isThreadJobLockOwnerFromCurrentService(owner, {
      currentPid,
      processStartedAtMs,
    }) ? null : owner;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function isThreadJobLockOwnerFromCurrentService(owner, {
  currentPid = process.pid,
  processStartedAtMs = PROCESS_STARTED_AT_MS,
} = {}) {
  const ownerPid = Number(owner?.pid);
  const expectedPid = Number(currentPid);
  const ownerStartedAtMs = Date.parse(owner?.startedAt || '');
  return Number.isFinite(ownerPid)
    && ownerPid > 0
    && Number.isFinite(expectedPid)
    && ownerPid === expectedPid
    && Number.isFinite(ownerStartedAtMs)
    && ownerStartedAtMs >= Number(processStartedAtMs);
}

export function isThreadJobLockOwnerFromPreviousService(owner, serviceStartedAt) {
  const ownerStartedAt = Date.parse(owner?.startedAt || '');
  const serviceStartedAtMs = Date.parse(
    serviceStartedAt instanceof Date ? serviceStartedAt.toISOString() : serviceStartedAt || '',
  );
  return Number.isFinite(ownerStartedAt)
    && Number.isFinite(serviceStartedAtMs)
    && ownerStartedAt < serviceStartedAtMs;
}
