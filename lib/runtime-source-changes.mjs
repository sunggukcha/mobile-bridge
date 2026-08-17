import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOP_LEVEL_RUNTIME_FILES = new Set([
  // `.env` is read once per process start (host launcher + v3 watchdog), so an
  // operational change such as a worker-chain or scheduler switch stays inert
  // until the service reloads.  Treat it like runtime source so a job that
  // edits it goes through the same restart path as a code change.
  '.env',
  'bridge-service.mjs',
  'bridge-supervisor.mjs',
  'v3/reception.mjs',
  'v3/watchdog.mjs',
  'v3/workbench.mjs',
  'v3/worker.mjs',
  'v3/supervisor.mjs',
  'scripts/v3-promotion-launcher.mjs',
  'start-bridge-host.sh',
  'package.json',
  'package-lock.json',
]);

export async function captureRuntimeSourceSnapshot({ cwd = process.cwd() } = {}) {
  const root = path.resolve(cwd);
  const snapshot = {};
  for (const filePath of await runtimeSourcePaths(root)) {
    snapshot[filePath] = await fileDigestOrNull(path.join(root, filePath));
  }
  return snapshot;
}

export async function changedRuntimeSourcePaths({ cwd = process.cwd(), before = {} } = {}) {
  const after = await captureRuntimeSourceSnapshot({ cwd });
  const paths = new Set([...Object.keys(before || {}), ...Object.keys(after)]);
  return [...paths]
    .filter((filePath) => before?.[filePath] !== after[filePath])
    .sort();
}

export function attributeRuntimeSourceChanges({
  changedPaths = [],
  checkpoint = null,
  repoRoot = process.cwd(),
  trustAll = false,
} = {}) {
  const root = path.resolve(repoRoot);
  const detectedPaths = [...new Set(
    (Array.isArray(changedPaths) ? changedPaths : [])
      .map(normalizeRelativePath)
      .filter((filePath) => filePath && isRuntimeSourcePath(filePath)),
  )].sort();
  if (trustAll || hasCompletedRepositoryMutationCommand(checkpoint, root)) {
    return { attributedPaths: detectedPaths, ignoredPaths: [] };
  }

  const workerPaths = runtimePathsFromWorkerEvidence(checkpoint, root);
  const attributedPaths = detectedPaths.filter((filePath) => workerPaths.has(filePath));
  const attributedSet = new Set(attributedPaths);
  return {
    attributedPaths,
    ignoredPaths: detectedPaths.filter((filePath) => !attributedSet.has(filePath)),
  };
}

export function isRuntimeSourcePath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return false;
  if (TOP_LEVEL_RUNTIME_FILES.has(normalized)) return true;
  return (
    normalized.startsWith('lib/')
    || normalized.startsWith('v3/lib/')
  ) && normalized.endsWith('.mjs');
}

async function runtimeSourcePaths(root) {
  const paths = [];
  for (const filePath of TOP_LEVEL_RUNTIME_FILES) {
    if (await isFile(path.join(root, filePath))) paths.push(filePath);
  }
  paths.push(...await runtimeLibSourcePaths(root, 'lib'));
  paths.push(...await runtimeLibSourcePaths(root, 'v3/lib'));
  return paths.sort();
}

async function runtimeLibSourcePaths(root, relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  let entries = [];
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const paths = [];
  for (const entry of entries) {
    const childRelative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...await runtimeLibSourcePaths(root, childRelative));
    } else if (entry.isFile() && isRuntimeSourcePath(childRelative)) {
      paths.push(normalizeRelativePath(childRelative));
    }
  }
  return paths;
}

async function fileDigestOrNull(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function normalizeRelativePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.includes('\0')) return null;
  if (normalized.split('/').some((part) => part === '..')) return null;
  return normalized;
}

function hasCompletedRepositoryMutationCommand(checkpoint, repoRoot) {
  return (Array.isArray(checkpoint?.commands) ? checkpoint.commands : []).some((command) =>
    command?.mutates_workspace
      && command?.status === 'completed'
      && isPathInside(repoRoot, command.cwd),
  );
}

function runtimePathsFromWorkerEvidence(checkpoint, repoRoot) {
  const paths = new Set();
  for (const file of Array.isArray(checkpoint?.changed_files) ? checkpoint.changed_files : []) {
    const sources = String(file?.source || '').split('+');
    if (!sources.includes('worker-event')) continue;
    const workspaceValue = file?.workspace_root || checkpoint?.cwd;
    if (!workspaceValue) continue;
    const workspaceRoot = path.resolve(String(workspaceValue));
    if (!isPathInside(repoRoot, workspaceRoot)) continue;
    const relativePath = normalizeRelativePath(file?.path);
    if (relativePath && isRuntimeSourcePath(relativePath)) paths.add(relativePath);
  }

  for (const file of Array.isArray(checkpoint?.observed_file_changes)
    ? checkpoint.observed_file_changes
    : []) {
    if (file?.status !== 'completed') continue;
    const filePath = String(file?.path || '').trim();
    if (!path.isAbsolute(filePath)) continue;
    const relativePath = relativePathInside(repoRoot, filePath);
    if (relativePath && isRuntimeSourcePath(relativePath)) paths.add(relativePath);
  }
  return paths;
}

function isPathInside(root, target) {
  if (!target) return false;
  const relative = path.relative(root, path.resolve(String(target)));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativePathInside(root, target) {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return normalizeRelativePath(relative);
}
