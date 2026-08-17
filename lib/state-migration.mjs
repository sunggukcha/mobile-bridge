import fs from 'node:fs/promises';
import path from 'node:path';

export const MIGRATION_SENTINEL = '.legacy-state-migrated';

export async function migrateStateLayout({ sourceRoot, targetRoot, archiveSource = false, once = false } = {}) {
  if (!sourceRoot || !targetRoot) throw new Error('sourceRoot and targetRoot are required');
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) {
    throw new Error('sourceRoot and targetRoot must differ');
  }

  // Migration is a one-time move. Re-running it merges legacy .jsonl records back into
  // the canonical state (mergeJsonl appends any line missing from the target), which
  // resurrects alerts/todos the user has since deleted. With `once`, a sentinel in the
  // target marks completion so later restarts skip the re-merge entirely.
  const sentinelPath = path.join(targetRoot, MIGRATION_SENTINEL);
  if (once && (await exists(sentinelPath))) {
    return { migrated: false, reason: 'already-migrated', sourceRoot, targetRoot };
  }

  const sourceExists = await exists(sourceRoot);
  if (!sourceExists) {
    if (once) await markMigrated(sentinelPath, targetRoot);
    return { migrated: false, reason: 'source-missing', sourceRoot, targetRoot };
  }

  await fs.mkdir(targetRoot, { recursive: true });
  for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
    if (isIgnoredTopLevelStateDir(entry.name)) continue;
    const sourcePath = path.join(sourceRoot, entry.name);
    if (entry.isDirectory() && isChannelDir(entry.name)) {
      await migrateChannelDir(sourcePath, targetRoot, entry.name);
      continue;
    }
    await mergeAny(sourcePath, path.join(targetRoot, entry.name));
  }

  let archivedTo = null;
  if (archiveSource) {
    archivedTo = path.join(path.dirname(targetRoot), `.bridge_state_old_${compactTimestamp(new Date())}`);
    await fs.rm(archivedTo, { recursive: true, force: true });
    await fs.rename(sourceRoot, archivedTo);
  }

  if (once) await markMigrated(sentinelPath, targetRoot);
  return { migrated: true, sourceRoot, targetRoot, archivedTo };
}

async function markMigrated(sentinelPath, targetRoot) {
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(sentinelPath, `${new Date().toISOString()}\n`);
}

async function migrateChannelDir(sourcePath, targetRoot, channelId) {
  const commonTarget = path.join(targetRoot, `${channelId}_common`);
  await fs.mkdir(commonTarget, { recursive: true });

  for (const entry of await fs.readdir(sourcePath, { withFileTypes: true })) {
    const child = path.join(sourcePath, entry.name);
    if (entry.isDirectory() && entry.name === 'threads') {
      for (const thread of await fs.readdir(child, { withFileTypes: true })) {
        if (!thread.isDirectory()) continue;
        await mergeAny(path.join(child, thread.name), path.join(targetRoot, channelId, thread.name));
      }
      continue;
    }
    await mergeAny(child, path.join(commonTarget, entry.name));
  }
}

async function mergeAny(source, target) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      await mergeAny(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await exists(target)) {
    if (source.endsWith('.jsonl') && target.endsWith('.jsonl')) {
      await mergeJsonl(source, target);
    }
    return;
  }
  await fs.copyFile(source, target);
}

async function mergeJsonl(source, target) {
  const [sourceLines, targetLines] = await Promise.all([
    readLines(source),
    readLines(target),
  ]);
  // Multiset difference, not a Set: two legitimately identical events (e.g.
  // repeated log lines) must both survive the merge, while re-running the
  // migration still adds nothing new (idempotent).
  const targetCounts = new Map();
  for (const line of targetLines) targetCounts.set(line, (targetCounts.get(line) || 0) + 1);
  const additions = sourceLines.filter((line) => {
    const remaining = targetCounts.get(line) || 0;
    if (remaining > 0) {
      targetCounts.set(line, remaining - 1);
      return false;
    }
    return true;
  });
  if (additions.length === 0) return;
  await fs.appendFile(target, `${additions.join('\n')}\n`);
}

async function readLines(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isChannelDir(name) {
  return /^\d+$/.test(name);
}

function isIgnoredTopLevelStateDir(name) {
  return ['.agents', '.codex', '.git'].includes(name);
}

function compactTimestamp(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return [
    shifted.getUTCFullYear(),
    pad2(shifted.getUTCMonth() + 1),
    pad2(shifted.getUTCDate()),
    pad2(shifted.getUTCHours()),
    pad2(shifted.getUTCMinutes()),
    pad2(shifted.getUTCSeconds()),
  ].join('');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
