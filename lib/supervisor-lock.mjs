import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function acquirePidLock(lockFile, options = {}) {
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt || new Date().toISOString();
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const removeStale = options.removeStale !== false;

  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  // Create the lock file with its owner content in one atomic step (write a
  // private temp file, then hard-link it into place). The previous
  // open('wx') + separate write left a window where a competitor could read
  // an empty lock file, judge it ownerless/stale, and delete a live lock —
  // letting two supervisors run concurrently.
  const tmpFile = `${lockFile}.${pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpFile, `${JSON.stringify({ ...metadata, pid, startedAt }, null, 2)}\n`);
    try {
      await fs.link(tmpFile, lockFile);
    } catch (linkError) {
      // Filesystems without hard links: fall back to the non-atomic wx path.
      if (!['ENOSYS', 'EPERM', 'ENOTSUP', 'EXDEV'].includes(linkError.code)) throw linkError;
      const handle = await fs.open(lockFile, 'wx');
      await handle.writeFile(`${JSON.stringify({ ...metadata, pid, startedAt }, null, 2)}\n`);
      await handle.close();
    }
    return { acquired: true, ...metadata, pid, startedAt };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await fs.rm(tmpFile, { force: true });
  }

  const owner = await readLockOwner(lockFile);
  if (owner?.pid && isProcessAlive(Number(owner.pid))) {
    return { acquired: false, owner };
  }

  if (!removeStale) return { acquired: false, owner, stale: true };

  await fs.rm(lockFile, { force: true });
  return acquirePidLock(lockFile, { ...options, removeStale: false });
}

export async function releasePidLock(lockFile, options = {}) {
  const pid = options.pid ?? process.pid;
  const owner = await readLockOwner(lockFile);
  if (owner?.pid && Number(owner.pid) !== Number(pid)) return false;
  await fs.rm(lockFile, { force: true });
  return true;
}

// For process 'exit' handlers, where only synchronous work runs — the async
// releasePidLock never completes there and leaves the lock file behind.
export function releasePidLockSync(lockFile, options = {}) {
  const pid = options.pid ?? process.pid;
  try {
    const owner = JSON.parse(fsSync.readFileSync(lockFile, 'utf8'));
    if (owner?.pid && Number(owner.pid) !== Number(pid)) return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    // Unreadable/corrupt lock content: fall through and remove our best guess.
  }
  fsSync.rmSync(lockFile, { force: true });
  return true;
}

async function readLockOwner(lockFile) {
  try {
    return JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
