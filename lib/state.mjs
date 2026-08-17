import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from './file-lock.mjs';

// pid+ms alone can collide when two writes to the same file land in one
// millisecond (concurrent writeJson calls in this process); the counter
// disambiguates them.
let tmpFileCounter = 0;

// Windows programs can briefly hold a read handle without delete sharing.
// On a DrvFS/9p mount that makes an otherwise valid atomic rename surface as
// EACCES/EPERM. A health writer must outlive that transient handle instead of
// taking the whole bridge down. The non-linear delays also break a writer out
// of lock-step with a polling reader.
const ATOMIC_RENAME_RETRY_DELAYS_MS = Object.freeze([
  10,
  25,
  50,
  100,
  200,
  400,
  750,
  1_000,
  1_500,
]);
const TRANSIENT_ATOMIC_RENAME_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EPERM',
]);
const pendingJsonWrites = new Map();
const DEFAULT_JSONL_TAIL_CHUNK_BYTES = 64 * 1024;

export class JsonState {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
  }

  file(name) {
    return path.join(this.rootDir, name);
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async readJson(name, fallback = null) {
    try {
      return JSON.parse(await fs.readFile(this.file(name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async writeJson(name, value, options = {}) {
    await writeJsonAtomic(this.file(name), value, options);
  }

  async appendJsonl(name, value) {
    const filePath = this.file(name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Locked so a concurrent compaction rewrite (jsonl-compaction.mjs) cannot
    // drop this line in its read→rename window.
    await withFileLock(filePath, async () => {
      await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
    });
  }

  async readJsonl(name, { limit = 1000 } = {}) {
    return readJsonlTail(this.file(name), { limit });
  }
}

// State ledgers are append-only and callers almost always need only their most
// recent entries. Reading backwards keeps both I/O and peak memory proportional
// to the requested tail instead of to a ledger's lifetime size.
export async function readJsonlTail(filePath, {
  limit = 1000,
  chunkBytes = DEFAULT_JSONL_TAIL_CHUNK_BYTES,
  fsImpl = fs,
} = {}) {
  const numericLimit = Number(limit);
  const maximumEntries = numericLimit === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Number.isFinite(numericLimit) ? Math.trunc(numericLimit) : 0);
  if (maximumEntries === 0) return [];

  let handle;
  try {
    handle = await fsImpl.open(filePath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  try {
    const stat = await handle.stat();
    let position = stat.size;
    const readSize = Math.max(1, Math.trunc(Number(chunkBytes)) || DEFAULT_JSONL_TAIL_CHUNK_BYTES);
    const reversedLines = [];
    let leadingFragment = Buffer.alloc(0);

    while (position > 0 && reversedLines.length < maximumEntries) {
      const start = Math.max(0, position - readSize);
      const requestedBytes = position - start;
      const chunk = Buffer.allocUnsafe(requestedBytes);
      let bytesRead = 0;
      // FileHandle.read is allowed to return fewer bytes than requested. Fill
      // the complete backward range so a short DrvFS/9p read cannot leave a
      // hole in the middle of a JSON line.
      while (bytesRead < requestedBytes) {
        const result = await handle.read(
          chunk,
          bytesRead,
          requestedBytes - bytesRead,
          start + bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead === 0) break;
      position = start;

      const current = chunk.subarray(0, bytesRead);
      const combined = leadingFragment.length > 0
        ? Buffer.concat([current, leadingFragment])
        : current;
      let lineEnd = combined.length;

      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        appendJsonlLine(reversedLines, combined.subarray(index + 1, lineEnd));
        lineEnd = index;
        if (reversedLines.length >= maximumEntries) break;
      }

      if (reversedLines.length >= maximumEntries) break;
      leadingFragment = Buffer.from(combined.subarray(0, lineEnd));
    }

    if (position === 0 && reversedLines.length < maximumEntries) {
      appendJsonlLine(reversedLines, leadingFragment);
    }

    return reversedLines
      .slice(0, maximumEntries)
      .reverse()
      .map((line) => JSON.parse(line.toString('utf8')));
  } finally {
    await handle.close();
  }
}

function appendJsonlLine(lines, line) {
  const withoutCarriageReturn = line.at(-1) === 0x0d
    ? line.subarray(0, line.length - 1)
    : line;
  if (withoutCarriageReturn.length > 0) lines.push(withoutCarriageReturn);
}

export async function writeJsonAtomic(filePath, value, {
  fsImpl = fs,
  mode = null,
  renameRetryDelaysMs = ATOMIC_RENAME_RETRY_DELAYS_MS,
  sleepFn = sleep,
} = {}) {
  const resolvedPath = path.resolve(filePath);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const previous = pendingJsonWrites.get(resolvedPath) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      await fsImpl.mkdir(path.dirname(resolvedPath), { recursive: true });
      const tmpPath = [
        resolvedPath,
        process.pid,
        Date.now(),
        tmpFileCounter++,
        'tmp',
      ].join('.');
      let operationError = null;
      try {
        await fsImpl.writeFile(
          tmpPath,
          body,
          Number.isInteger(mode) ? { mode } : undefined,
        );
        await renameWithRetry(tmpPath, resolvedPath, {
          fsImpl,
          renameRetryDelaysMs,
          sleepFn,
        });
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        try {
          await fsImpl.unlink(tmpPath);
        } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT' && !operationError) {
            throw cleanupError;
          }
        }
      }
    });

  pendingJsonWrites.set(resolvedPath, operation);
  try {
    await operation;
  } finally {
    if (pendingJsonWrites.get(resolvedPath) === operation) {
      pendingJsonWrites.delete(resolvedPath);
    }
  }
}

async function renameWithRetry(source, destination, {
  fsImpl,
  renameRetryDelaysMs,
  sleepFn,
}) {
  const retryDelays = Array.isArray(renameRetryDelaysMs)
    ? renameRetryDelaysMs
    : ATOMIC_RENAME_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsImpl.rename(source, destination);
      return;
    } catch (error) {
      if (
        !TRANSIENT_ATOMIC_RENAME_CODES.has(error?.code)
        || attempt >= retryDelays.length
      ) {
        throw error;
      }
      await sleepFn(Math.max(0, Number(retryDelays[attempt]) || 0));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
