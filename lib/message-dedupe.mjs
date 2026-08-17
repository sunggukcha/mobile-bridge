import fs from 'node:fs/promises';
import path from 'node:path';

const LOCK_DIR = 'message-locks';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_STAT_CONCURRENCY = 32;
const MAX_TRACKED_LOCK_DIRECTORIES = 1_000;
const nextCleanupAtByDirectory = new Map();

export async function reserveDiscordMessage(state, message, now = new Date()) {
  const key = discordMessageReservationKey(message);
  if (!key) return true;

  await cleanupLocksIfDue(state, now).catch(() => {});
  const lockFile = state.file(path.join(LOCK_DIR, `${key}.json`));
  try {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    const handle = await fs.open(lockFile, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify({
        channelId: String(message?.channel_id || ''),
        messageId: String(message?.id || ''),
        authorId: String(message?.author?.id || ''),
        createdAt: now.toISOString(),
      })}\n`);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

// Read-only check used by startup catch-up to skip already-processed
// messages without creating locks or emitting duplicate-suppressed logs.
export async function isDiscordMessageReserved(state, message) {
  const key = discordMessageReservationKey(message);
  if (!key) return false;
  try {
    await fs.access(state.file(path.join(LOCK_DIR, `${key}.json`)));
    return true;
  } catch {
    return false;
  }
}

// v3 already has a fenced, durable inbox. Its lock therefore records
// processing vs. completion instead of treating "lock file exists" as proof
// that the handler finished. A new Workbench generation may reclaim a
// processing lock for the same still-unacknowledged bus row.
export async function beginDurableMessageProcessing(
  state,
  message,
  {
    ownerId,
    now = new Date(),
  } = {},
) {
  const key = discordMessageReservationKey(message);
  if (!key) return { accepted: true, key: null };
  await cleanupLocksIfDue(state, now).catch(() => {});
  const lockFile = state.file(path.join(LOCK_DIR, `${key}.json`));
  const existing = await readLock(lockFile);
  if (existing && existing.status !== 'processing') {
    return { accepted: false, completed: true, key };
  }
  await writeLockAtomic(lockFile, {
    channelId: String(message?.channel_id || ''),
    messageId: String(message?.id || ''),
    authorId: String(message?.author?.id || ''),
    status: 'processing',
    ownerId: String(ownerId || ''),
    startedAt: now.toISOString(),
    priorOwnerId: existing?.ownerId || null,
  });
  return {
    accepted: true,
    reclaimed: Boolean(existing),
    key,
  };
}

export async function completeDurableMessageProcessing(
  state,
  message,
  {
    ownerId,
    now = new Date(),
  } = {},
) {
  const key = discordMessageReservationKey(message);
  if (!key) return false;
  const lockFile = state.file(path.join(LOCK_DIR, `${key}.json`));
  const existing = await readLock(lockFile);
  await writeLockAtomic(lockFile, {
    channelId: String(message?.channel_id || existing?.channelId || ''),
    messageId: String(message?.id || existing?.messageId || ''),
    authorId: String(message?.author?.id || existing?.authorId || ''),
    status: 'done',
    ownerId: String(ownerId || existing?.ownerId || ''),
    startedAt: existing?.startedAt || null,
    completedAt: now.toISOString(),
  });
  return true;
}

export function discordMessageReservationKey(message) {
  const channelId = message?.channel_id;
  const messageId = message?.id;
  if (!channelId || !messageId) return null;
  return safeKey(`discord:${channelId}:${messageId}`);
}

async function cleanupLocks(state, now) {
  const dir = state.file(LOCK_DIR);
  const cutoff = now.getTime() - DEFAULT_TTL_MS;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  // An old installation can have many thousands of reservations. Bound the
  // metadata fan-out so one cleanup cannot exhaust file descriptors or create
  // a huge Promise array on the message ingestion path.
  for (let offset = 0; offset < entries.length; offset += CLEANUP_STAT_CONCURRENCY) {
    await Promise.all(entries
      .slice(offset, offset + CLEANUP_STAT_CONCURRENCY)
      .map(async (entry) => {
        if (!entry.isFile()) return;
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.unlink(filePath).catch(() => {});
      }));
  }
}

async function cleanupLocksIfDue(state, now) {
  const directory = path.resolve(state.file(LOCK_DIR));
  const nowMs = now.getTime();
  const nextCleanupAt = nextCleanupAtByDirectory.get(directory) || 0;
  if (nowMs < nextCleanupAt) return;

  rememberNextCleanup(directory, nowMs + CLEANUP_INTERVAL_MS);
  try {
    await cleanupLocks(state, now);
  } catch (error) {
    // A failed scan should be retried by the next message, not suppressed for
    // the entire interval.
    nextCleanupAtByDirectory.delete(directory);
    throw error;
  }
}

function rememberNextCleanup(directory, nextCleanupAt) {
  if (
    nextCleanupAtByDirectory.size >= MAX_TRACKED_LOCK_DIRECTORIES
    && !nextCleanupAtByDirectory.has(directory)
  ) {
    nextCleanupAtByDirectory.delete(nextCleanupAtByDirectory.keys().next().value);
  }
  nextCleanupAtByDirectory.set(directory, nextCleanupAt);
}

function safeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

async function readLock(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // Legacy/partial lock files remain conservative: they represent a
    // completed reservation and must not be silently reclaimed.
    return { status: 'done' };
  }
}

async function writeLockAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}
