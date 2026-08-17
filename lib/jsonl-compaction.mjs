import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from './file-lock.mjs';

// Append-only JSONL state files grow without bound. Compaction moves the
// oldest lines into a sibling `<name>.archive` file (kept on disk for audit;
// normal state readers match exact `.jsonl` filenames and never see it, the one
// exception being the source-event high-water bootstrap, which reads the archive
// generations too) and atomically rewrites the live file with only the newest
// lines. All bridge readers consume the tail (readJsonl limits,
// latest-status-per-id), so keeping `keepLines` recent lines preserves behavior.

const DEFAULT_MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

export async function compactJsonlFile(file, { maxBytes = 1_000_000, keepLines = 2000 } = {}) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { file, compacted: false, reason: 'missing' };
    throw error;
  }
  if (stat.size <= maxBytes) return { file, compacted: false, reason: 'below-max-bytes' };

  // Hold the shared file lock across read→archive→rename so a line appended
  // concurrently by another locked writer (JsonState.appendJsonl) cannot be
  // dropped by the rewrite.
  return withFileLock(file, async () => {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
    if (lines.length <= keepLines) return { file, compacted: false, reason: 'below-keep-lines' };

    const archived = lines.slice(0, lines.length - keepLines);
    const kept = lines.slice(-keepLines);
    await fs.appendFile(`${file}.archive`, `${archived.join('\n')}\n`);
    const tmpPath = `${file}.${process.pid}.${Date.now()}.compact.tmp`;
    await fs.writeFile(tmpPath, `${kept.join('\n')}\n`);
    await fs.rename(tmpPath, file);
    return { file, compacted: true, archivedLines: archived.length, keptLines: kept.length };
  });
}

// The `.archive` sibling is append-only and read by nobody, so compaction alone
// only moves unbounded growth one file over. Keep a single previous generation
// (`<name>.archive.1`) and let anything older go: the live file holds the recent
// window every reader actually consumes.
export async function rotateArchiveFile(file, { maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES } = {}) {
  const archive = `${file}.archive`;
  if (!(await exceedsArchiveLimit(archive, maxArchiveBytes))) {
    return { file: archive, rotated: false, reason: 'below-max-bytes' };
  }
  // Same lock as compaction's read→archive→rename, which is the only writer to
  // this archive, so the rename cannot land mid-append.
  return withFileLock(file, async () => {
    const stat = await fs.stat(archive).catch(() => null);
    if (!stat?.isFile() || stat.size <= maxArchiveBytes) {
      return { file: archive, rotated: false, reason: 'below-max-bytes' };
    }
    await fs.rm(`${archive}.1`, { force: true });
    await fs.rename(archive, `${archive}.1`);
    return { file: archive, rotated: true, rotatedBytes: stat.size };
  });
}

// Targets only the append-only log files; rewritten state files such as
// todo.jsonl / alerts.jsonl are canonical state and must never be truncated.
export async function compactBridgeStateFiles(stateRoot, options = {}) {
  const results = [];
  for (const file of await bridgeAppendOnlyJsonlFiles(stateRoot)) {
    try {
      const result = await compactJsonlFile(file, options);
      if (result.compacted) results.push(result);
    } catch (error) {
      results.push({ file, compacted: false, error: error.message || String(error) });
    }
    try {
      const rotation = await rotateArchiveFile(file, options);
      if (rotation.rotated) results.push(rotation);
    } catch (error) {
      results.push({ file: `${file}.archive`, rotated: false, error: error.message || String(error) });
    }
  }
  return results;
}

async function exceedsArchiveLimit(archive, maxArchiveBytes) {
  const stat = await fs.stat(archive).catch(() => null);
  return Boolean(stat?.isFile()) && stat.size > maxArchiveBytes;
}

async function bridgeAppendOnlyJsonlFiles(stateRoot) {
  const files = [];
  for (const entry of await readdirSafe(path.join(stateRoot, '_system'))) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path.join(stateRoot, '_system', entry.name));
    }
  }
  for (const entry of await readdirSafe(stateRoot)) {
    if (!entry.isDirectory()) continue;
    const topDir = path.join(stateRoot, entry.name);
    if (entry.name.endsWith('_common')) {
      files.push(path.join(topDir, 'pending-thread', 'jobs.jsonl'));
      continue;
    }
    if (!/^\d+$/.test(entry.name)) continue;
    for (const threadEntry of await readdirSafe(topDir)) {
      if (!threadEntry.isDirectory() || threadEntry.name === 'threads') continue;
      const threadDir = path.join(topDir, threadEntry.name);
      files.push(path.join(threadDir, 'memory', 'events.jsonl'));
      files.push(path.join(threadDir, 'jobs', 'jobs.jsonl'));
    }
  }
  return files;
}

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
