import fs from 'node:fs/promises';
import path from 'node:path';
import { maskSecrets, secretPatternVersion } from './secret-mask.mjs';
import { withFileLock } from './file-lock.mjs';

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const TRANSCRIPT_TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.log', '.md', '.txt']);
const LEDGER_FILE_NAME = 'state-secret-redaction.json';
// A file written in the same instant the sweep starts must not be recorded as
// covered, so the watermark is backdated by more than any such overlap.
const WATERMARK_GRACE_MS = 1_000;

// Defense in depth for credentials persisted before a token shape was added to
// secret-mask.mjs. Normal writes are already redacted; the sweep only rewrites a
// file when a newly recognized secret is actually present.
//
// The sweep is incremental, and deliberately so: a full pass reads every
// persisted state file, which on /mnt/c with ~14k transcript files took ~90 s of
// pure I/O. Two facts bound the work instead of repeating that every restart:
//   - a rescan can only find something the live masking missed when the pattern
//     set itself changed, so the pattern fingerprint gates full passes;
//   - between two passes only files written after the previous pass can hold an
//     unmasked secret, so a per-file mtime watermark skips the rest, and a
//     thread whose append-only logs never moved is skipped without its
//     transcripts being walked at all.
// Both live in the ledger at `_system/state-secret-redaction.json`. Watermarks
// are per thread, not global: a skipped thread keeps the older one, so a file
// that a skip passed over is still in scope the next time that thread is read.
export async function sweepPersistedStateSecrets(stateRoot, {
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  patternVersion = secretPatternVersion(),
  startedAtMs = Date.now(),
} = {}) {
  const ledger = await readLedger(stateRoot);
  const fullSweep = String(ledger?.patternVersion || '') !== String(patternVersion);
  // Watermark is the sweep *start*, so a file written while the sweep runs is
  // reconsidered by the next one instead of being skipped as already handled.
  const recordedWatermarkMs = Math.max(0, startedAtMs - WATERMARK_GRACE_MS);
  const sweptThroughMs = fullSweep ? 0 : Number(ledger?.sweptThroughMs) || 0;
  const result = {
    mode: fullSweep ? 'full' : 'incremental',
    patternVersion,
    sweptThroughMs,
    scannedFiles: 0,
    skippedFiles: 0,
    skippedThreads: 0,
    changed: [],
    durationMs: 0,
  };

  const { targets, threadWatermarks } = await persistedStateSecretTargets(stateRoot, {
    maxFileBytes,
    sweptThroughMs,
    recordedWatermarkMs,
    threadLedger: fullSweep ? {} : (ledger?.threads || {}),
    result,
  });
  for (const file of targets) {
    result.scannedFiles += 1;
    const content = await fs.readFile(file, 'utf8').catch(() => null);
    if (content === null) continue;
    if (maskSecrets(content) === content) continue;
    if (await rewriteMaskedFile(file)) result.changed.push(file);
  }

  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  await writeLedger(stateRoot, {
    patternVersion,
    sweptThroughMs: recordedWatermarkMs,
    threads: threadWatermarks,
    mode: result.mode,
    completedAt: new Date().toISOString(),
    scannedFiles: result.scannedFiles,
    skippedFiles: result.skippedFiles,
    skippedThreads: result.skippedThreads,
    changedFiles: result.changed.length,
    durationMs: result.durationMs,
  });
  return result;
}

// Compatibility wrapper for callers that only care about what was rewritten.
export async function redactPersistedStateSecrets(stateRoot, options = {}) {
  const { changed } = await sweepPersistedStateSecrets(stateRoot, options);
  return changed;
}

// The sweep now runs alongside live logging instead of before the gateways come
// up, so the read the rewrite is based on must be taken under the same lock the
// appenders use — otherwise a line appended between read and rename is lost. The
// cheap unlocked pre-check above keeps this path off the common case.
async function rewriteMaskedFile(file) {
  try {
    return await withFileLock(file, async () => {
      const current = await fs.readFile(file, 'utf8').catch(() => null);
      if (current === null) return false;
      const masked = maskSecrets(current);
      if (masked === current) return false;
      const temporary = `${file}.${process.pid}.${Date.now()}.redact.tmp`;
      await fs.writeFile(temporary, masked);
      await fs.rename(temporary, file);
      return true;
    });
  } catch {
    return false;
  }
}

async function persistedStateSecretTargets(stateRoot, {
  maxFileBytes,
  sweptThroughMs,
  recordedWatermarkMs,
  threadLedger,
  result,
}) {
  const targets = [];
  // Rebuilt from the threads seen this sweep, so entries for deleted threads do
  // not accumulate in the ledger.
  const threadWatermarks = {};
  const consider = async (file, watermarkMs, knownStat) => {
    const stat = knownStat === undefined ? await statSafe(file) : knownStat;
    if (!stat?.isFile()) return;
    if (stat.size > maxFileBytes || stat.mtimeMs <= watermarkMs) {
      result.skippedFiles += 1;
      return;
    }
    targets.push(file);
  };

  for (const entry of await readdirSafe(stateRoot)) {
    if (!entry.isDirectory()) continue;
    const top = path.join(stateRoot, entry.name);
    if (entry.name === '_system') {
      for (const file of await readdirSafe(top)) {
        if (!file.isFile() || file.name === LEDGER_FILE_NAME) continue;
        if (TRANSCRIPT_TEXT_EXTENSIONS.has(path.extname(file.name))) {
          await consider(path.join(top, file.name), sweptThroughMs);
        }
      }
      continue;
    }
    if (entry.name.endsWith('_common')) {
      await consider(path.join(top, 'pending-thread', 'jobs.jsonl'), sweptThroughMs);
      continue;
    }
    if (!/^\d+$/.test(entry.name)) continue;
    for (const thread of await readdirSafe(top)) {
      if (!thread.isDirectory() || thread.name === 'threads') continue;
      const threadRoot = path.join(top, thread.name);
      const threadKey = path.relative(stateRoot, threadRoot);
      const watermarkMs = Number(threadLedger?.[threadKey]) || 0;
      const eventsFile = path.join(threadRoot, 'memory', 'events.jsonl');
      const eventsStat = await statSafe(eventsFile);
      // Every transcript write belongs to a job that also appends a status line
      // to jobs.jsonl, so when neither append-only log moved since this thread
      // was last read, it cannot hold a file written since then.
      const jobsStat = await statSafe(path.join(threadRoot, 'jobs', 'jobs.jsonl'));
      const activityMs = Math.max(eventsStat?.mtimeMs || 0, jobsStat?.mtimeMs || 0);
      if (watermarkMs > 0 && activityMs > 0 && activityMs <= watermarkMs) {
        // Keep the older watermark: the files this skip passed over stay in
        // scope for whichever sweep next reads this thread.
        threadWatermarks[threadKey] = watermarkMs;
        result.skippedThreads += 1;
        continue;
      }
      threadWatermarks[threadKey] = recordedWatermarkMs;
      await consider(eventsFile, watermarkMs, eventsStat);
      for (const file of await transcriptTextFiles(path.join(threadRoot, 'jobs', 'transcripts'))) {
        await consider(file, watermarkMs);
      }
    }
  }
  return { targets: [...new Set(targets)], threadWatermarks };
}

async function transcriptTextFiles(root) {
  const files = [];
  for (const entry of await readdirSafe(root)) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      // `<file>.lock` is a live advisory lock held by a writer, not state.
      if (entry.name.endsWith('.lock')) continue;
      files.push(...await transcriptTextFiles(child));
    } else if (entry.isFile() && TRANSCRIPT_TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(child);
    }
  }
  return files;
}

async function readLedger(stateRoot) {
  try {
    return JSON.parse(await fs.readFile(ledgerPath(stateRoot), 'utf8'));
  } catch {
    return null;
  }
}

async function writeLedger(stateRoot, ledger) {
  const file = ledgerPath(stateRoot);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
    await fs.rename(temporary, file);
  } catch {
    // A missing ledger only costs one extra full sweep; never fail startup.
  }
}

function ledgerPath(stateRoot) {
  return path.join(stateRoot, '_system', LEDGER_FILE_NAME);
}

function statSafe(file) {
  return fs.stat(file).catch(() => null);
}

async function readdirSafe(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}
