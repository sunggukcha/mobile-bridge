import fs from 'node:fs/promises';
import path from 'node:path';

// Shared cross-process advisory lock for JSONL state files that are rewritten
// in place (read → filter → atomic rename). Every writer that either appends
// to or rewrites such a file must hold this lock, otherwise a rewrite can
// silently drop lines appended by another process in the read→rename window
// (job status lines, TODOs, alerts).
//
// Implementation: `mkdir` of `<file>.lock` is atomic on every platform the
// bridge runs on (incl. /mnt/c under WSL2). Stale locks are reclaimed when the
// recorded owner pid is dead, and — because pids get reused after a crash — a
// lock older than `hardStaleMs` is reclaimed even when its pid looks alive, so
// a stale lock can never freeze a channel forever.

const DEFAULT_RETRY_MS = 50;
const DEFAULT_HARD_STALE_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;

export async function withFileLock(targetFile, fn, {
  retryMs = DEFAULT_RETRY_MS,
  hardStaleMs = DEFAULT_HARD_STALE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  isProcessAlive = defaultIsProcessAlive,
} = {}) {
  const lockDir = `${targetFile}.lock`;
  const deadline = Date.now() + Math.max(retryMs, timeoutMs);
  while (true) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.mkdir(path.dirname(lockDir), { recursive: true });
        continue;
      }
      if (error.code !== 'EEXIST') throw error;
      if (await removeStaleLock(lockDir, { hardStaleMs, isProcessAlive })) continue;
      if (Date.now() >= deadline) {
        throw new Error(`file lock timeout after ${timeoutMs}ms: ${lockDir}`);
      }
      await sleep(retryMs);
      continue;
    }

    try {
      await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      }));
      return await fn();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }
}

async function removeStaleLock(lockDir, { hardStaleMs, isProcessAlive }) {
  let stat;
  try {
    stat = await fs.stat(lockDir);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  const owner = await readLockOwner(lockDir);
  // A missing/corrupt owner.json right after mkdir is the holder still writing
  // it; only the age-based reclaim below may collect such a lock.
  const ownerDead = Boolean(owner?.pid) && !isProcessAlive(Number(owner.pid));
  if (ageMs < hardStaleMs && !ownerDead) return false;

  // Re-check that the lock we inspected is still the same one before removing
  // it, so a competitor that already reclaimed-and-recreated it is not robbed.
  try {
    const recheck = await fs.stat(lockDir);
    if (recheck.mtimeMs !== stat.mtimeMs) return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  await fs.rm(lockDir, { recursive: true, force: true });
  return true;
}

async function readLockOwner(lockDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function defaultIsProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
