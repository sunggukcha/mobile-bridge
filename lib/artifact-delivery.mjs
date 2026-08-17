import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_DISCORD_DELIVERY_FILES = 10;
export const MAX_DISCORD_DELIVERY_BYTES = 8 * 1024 * 1024;

// Jobs copy whole working trees into their artifact folder — a cloned repo, a
// virtualenv, an installed package tree. None of those are ever deliverable
// output, and walking them is what makes this scan unbounded: one channel's
// artifacts folder accumulated a .venv and two .git repos, after which every job
// in that channel stalled here for more than five minutes before it could even
// reach the Worker (`find -type f` over that tree does not finish in 20s).
export const SKIPPED_ARTIFACT_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.cache',
]);
// Artifact contents are whatever a job wrote, so the exclusions above cannot be
// exhaustive. These caps make the scan bounded regardless of what is in there:
// a truncated snapshot loses at most some delivery detection, while an unbounded
// one used to hang the job forever.
export const MAX_ARTIFACT_SCAN_FILES = 20_000;
export const ARTIFACT_SCAN_TIME_BUDGET_MS = 15_000;
// Escape hatch for an artifact folder that is legitimately enormous — a dataset
// or training output nobody will ever hand back over chat. Dropping this file in
// such a folder removes it from the walk without moving the data. It is detected
// from the parent's own listing, so it costs no extra filesystem calls.
export const ARTIFACT_IGNORE_MARKER = '.bridge-artifact-ignore';

export async function captureArtifactDeliverySnapshot(artifactRoot, {
  maxFiles = MAX_ARTIFACT_SCAN_FILES,
  timeBudgetMs = ARTIFACT_SCAN_TIME_BUDGET_MS,
  now = () => Date.now(),
} = {}) {
  const rawRoot = String(artifactRoot || '').trim();
  if (!rawRoot) return new Map();
  return scanArtifactFiles(path.resolve(rawRoot), { maxFiles, timeBudgetMs, now });
}

export function serializeArtifactDeliverySnapshot(snapshot) {
  if (!(snapshot instanceof Map)) return null;
  return [...snapshot.entries()].map(([relativePath, entry]) => ([
    normalizeRelativePath(relativePath),
    {
      size: Number(entry?.size || 0),
      mtimeMs: Number(entry?.mtimeMs || 0),
      ctimeMs: Number(entry?.ctimeMs || 0),
    },
  ]));
}

export function deserializeArtifactDeliverySnapshot(value) {
  if (value instanceof Map) return value;
  if (!Array.isArray(value)) return null;
  const snapshot = new Map();
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const relativePath = normalizeRelativePath(item[0]);
    if (!relativePath || relativePath === '.') continue;
    snapshot.set(relativePath, {
      size: Number(item[1]?.size || 0),
      mtimeMs: Number(item[1]?.mtimeMs || 0),
      ctimeMs: Number(item[1]?.ctimeMs || 0),
    });
  }
  return snapshot;
}

export async function deliveryArtifactsForFinalMessage({
  artifactRoot,
  finalText = '',
  beforeSnapshot = null,
  maxFiles = MAX_DISCORD_DELIVERY_FILES,
  maxTotalBytes = MAX_DISCORD_DELIVERY_BYTES,
  maxFileBytes = MAX_DISCORD_DELIVERY_BYTES,
} = {}) {
  const rawRoot = String(artifactRoot || '').trim();
  const root = rawRoot ? path.resolve(rawRoot) : '';
  const selected = referencedArtifactPaths(finalText, root);
  const files = [];
  const skipped = [];
  const filenames = new Set();
  let totalBytes = 0;

  if (!root) {
    return {
      files,
      skipped: selected.map((relativePath) => ({ relativePath, reason: 'invalid-artifact-root' })),
      unreferenced: [],
    };
  }

  for (const relativePath of selected) {
    if (files.length >= maxFiles) {
      skipped.push({ relativePath, reason: 'too-many-files' });
      continue;
    }

    const resolved = await resolveArtifactFile(root, relativePath);
    if (!resolved.ok) {
      if (resolved.reason !== 'directory') {
        skipped.push({ relativePath, reason: resolved.reason });
      }
      continue;
    }

    let data;
    try {
      data = await fs.readFile(resolved.path);
    } catch {
      skipped.push({ relativePath, reason: 'unreadable' });
      continue;
    }
    const size = data.length;
    if (size === 0) {
      skipped.push({ relativePath, reason: 'empty' });
      continue;
    }
    if (size > maxFileBytes) {
      skipped.push({ relativePath, reason: 'file-too-large', size });
      continue;
    }
    if (totalBytes + size > maxTotalBytes) {
      skipped.push({ relativePath, reason: 'total-too-large', size });
      continue;
    }

    const filename = path.basename(resolved.path);
    if (filenames.has(filename)) {
      skipped.push({ relativePath, reason: 'duplicate-filename' });
      continue;
    }
    filenames.add(filename);
    totalBytes += size;
    files.push({
      filename,
      relativePath: `artifacts/${normalizeRelativePath(relativePath)}`,
      size,
      sha256: sha256(data),
      dataBase64: data.toString('base64'),
    });
  }

  const unreferenced = beforeSnapshot instanceof Map
    ? await unreferencedArtifactChanges(root, beforeSnapshot, new Set(selected))
    : [];
  return { files, skipped, unreferenced };
}

export function artifactDeliveryFingerprint(files = []) {
  const manifest = (Array.isArray(files) ? files : [])
    .map((file) => ({
      relativePath: String(file?.relativePath || ''),
      filename: String(file?.filename || file?.name || ''),
      size: Number(file?.size || 0),
      sha256: String(file?.sha256 || ''),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (manifest.length === 0) return '';
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function compactArtifactDeliveryFiles(files = []) {
  return (Array.isArray(files) ? files : []).map((file) => ({
    filename: String(file?.filename || file?.name || ''),
    relativePath: String(file?.relativePath || ''),
    size: Number(file?.size || 0),
    sha256: String(file?.sha256 || ''),
  }));
}

export function appendArtifactDeliveryWarning(content, { skipped = [], unreferenced = [] } = {}) {
  const details = skipped.map((entry) => {
    const file = `artifacts/${entry.relativePath}`;
    if (entry.reason === 'missing') return `${file} (파일 없음)`;
    if (entry.reason === 'empty') return `${file} (빈 파일)`;
    if (entry.reason === 'file-too-large') return `${file} (파일 용량 초과)`;
    if (entry.reason === 'total-too-large') return `${file} (전체 용량 초과)`;
    if (entry.reason === 'too-many-files') return `${file} (첨부 개수 초과)`;
    if (entry.reason === 'duplicate-filename') return `${file} (중복 파일명)`;
    return `${file} (${entry.reason})`;
  });
  if (unreferenced.length > 0) {
    details.push(`작업 중 생성·변경된 artifacts 파일 ${unreferenced.length}개 (최종 응답에서 첨부 대상으로 명시되지 않음)`);
  }
  return [
    String(content || '').trimEnd(),
    `⚠️ 첨부 업로드 제외: ${details.join(', ')}. 위 파일은 전송 완료로 간주하지 않습니다.`,
  ].filter(Boolean).join('\n\n');
}

export function artifactDeliveryNonce({
  jobId = '',
  destinationChannelId = '',
  purpose = '',
  content = '',
  files = [],
} = {}) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const digest = createHash('sha256')
    .update(String(jobId || ''))
    .update('\0')
    .update(String(destinationChannelId || ''))
    .update('\0')
    .update(String(purpose || ''))
    .update('\0')
    .update(String(content || ''))
    .update('\0')
    .update(artifactDeliveryFingerprint(files))
    .digest('hex');
  return `ad${digest.slice(0, 23)}`;
}

function referencedArtifactPaths(text, artifactRoot) {
  const candidates = [];
  const source = String(text || '');

  for (const match of source.matchAll(/`([^`\r\n]+)`/g)) candidates.push(match[1]);
  for (const match of source.matchAll(/!?\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^\r\n)]+))\)/g)) {
    candidates.push(match[1] || match[2]);
  }
  const unformattedSource = maskReferenceMarkup(source);
  for (const match of unformattedSource.matchAll(/(?:^|[\s'"[(])(artifacts\/[^\s`'":)\]]+)/g)) {
    candidates.push(match[1]);
  }
  if (artifactRoot) {
    const absolutePattern = new RegExp(`(${escapeRegExp(artifactRoot)}[/\\\\][^\\s\u0000]+)`, 'g');
    for (const match of unformattedSource.matchAll(absolutePattern)) candidates.push(match[1]);
  }

  const relativePaths = [];
  for (const candidate of candidates) {
    const relativePath = referencedRelativePath(candidate, artifactRoot);
    if (!relativePath || !looksLikeArtifactReference(relativePath)) continue;
    relativePaths.push(relativePath);
  }
  return [...new Set(relativePaths)];
}

function referencedRelativePath(value, artifactRoot) {
  const raw = stripReferencePunctuation(value);
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('artifacts/')) {
    return normalizeRelativePath(normalized.slice('artifacts/'.length));
  }
  if (!path.isAbsolute(raw) || !artifactRoot) return '';
  const relative = path.relative(artifactRoot, path.resolve(raw));
  return normalizeRelativePath(relative);
}

function stripReferencePunctuation(value) {
  return String(value || '')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/[.,;:!?。，；：！？]+$/gu, '')
    .replace(/(\.[A-Za-z0-9]{1,10})(?:으로|에서|을|를|이|가|은|는|에|로|와|과)$/u, '$1');
}

function looksLikeArtifactReference(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized === '.') return false;
  if (/:\$[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) return false;
  // Korean postpositions can immediately follow "artifacts/" in prose.
  if (/^[가-힣]+$/u.test(normalized) && !normalized.includes('/') && !normalized.includes('.')) return false;
  return true;
}

async function resolveArtifactFile(root, relativePath) {
  if (!root || root === path.parse(root).root) return { ok: false, reason: 'invalid-artifact-root' };
  const normalized = normalizeRelativePath(relativePath);
  const candidate = path.resolve(root, normalized);
  if (!isPathInside(root, candidate) || candidate === root) {
    return { ok: false, reason: 'outside-artifacts-dir' };
  }

  let lstat;
  try {
    lstat = await fs.lstat(candidate);
  } catch (error) {
    return { ok: false, reason: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (lstat.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (lstat.isDirectory()) return { ok: false, reason: 'directory' };
  if (!lstat.isFile()) return { ok: false, reason: 'not-a-file' };

  let realRoot;
  let realFile;
  try {
    [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!isPathInside(realRoot, realFile) || realFile === realRoot) {
    return { ok: false, reason: 'outside-artifacts-dir' };
  }
  return { ok: true, path: realFile };
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^artifacts\//, '').replace(/^\/+/, '');
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskReferenceMarkup(source) {
  return String(source || '')
    .replace(/`[^`\r\n]+`/g, (match) => ' '.repeat(match.length))
    .replace(/!?\[[^\]\r\n]*\]\((?:<[^>\r\n]+>|[^\r\n)]+)\)/g, (match) => ' '.repeat(match.length));
}

async function unreferencedArtifactChanges(root, beforeSnapshot, selected) {
  const afterSnapshot = await scanArtifactFiles(root);
  const unreferenced = [];
  for (const [relativePath, current] of afterSnapshot.entries()) {
    if (selected.has(relativePath)) continue;
    const before = beforeSnapshot.get(relativePath);
    if (!before || artifactSnapshotEntryChanged(before, current)) unreferenced.push(relativePath);
  }
  return unreferenced.sort();
}

async function scanArtifactFiles(root, {
  maxFiles = MAX_ARTIFACT_SCAN_FILES,
  timeBudgetMs = ARTIFACT_SCAN_TIME_BUDGET_MS,
  now = () => Date.now(),
} = {}) {
  const snapshot = new Map();
  const context = {
    snapshot,
    maxFiles: Number(maxFiles) > 0 ? Number(maxFiles) : Number.POSITIVE_INFINITY,
    deadlineMs: Number(timeBudgetMs) > 0 ? now() + Number(timeBudgetMs) : Number.POSITIVE_INFINITY,
    now,
    truncated: false,
  };
  await scanArtifactDirectory(root, '', context);
  // Carried on the Map so a caller can report the loss without changing the
  // snapshot's shape, which is serialized and compared elsewhere.
  if (context.truncated) snapshot.truncated = true;
  return snapshot;
}

async function scanArtifactDirectory(root, relativeDir, context) {
  if (scanExhausted(context)) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  // Never opt the artifact root itself out: that would silently disable delivery
  // for the whole channel.
  if (
    relativeDir
    && entries.some((entry) => entry.name === ARTIFACT_IGNORE_MARKER && !entry.isDirectory())
  ) {
    return;
  }

  // readdir order is filesystem-defined. Sorting makes a truncated scan cover a
  // deterministic prefix, so the before-job and after-job snapshots stop at the
  // same place instead of disagreeing and reporting untouched files as new.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (scanExhausted(context)) return;
    if (entry.isSymbolicLink()) continue;
    const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (SKIPPED_ARTIFACT_DIRECTORIES.has(entry.name)) continue;
      await scanArtifactDirectory(root, relativePath, context);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(path.join(root, relativePath));
      context.snapshot.set(relativePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function scanExhausted(context) {
  if (context.snapshot.size >= context.maxFiles) {
    context.truncated = true;
    return true;
  }
  if (context.now() >= context.deadlineMs) {
    context.truncated = true;
    return true;
  }
  return false;
}

function artifactSnapshotEntryChanged(before, current) {
  return Number(before?.size) !== Number(current?.size)
    || Number(before?.mtimeMs) !== Number(current?.mtimeMs)
    || Number(before?.ctimeMs) !== Number(current?.ctimeMs);
}
