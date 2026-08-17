import path from 'node:path';
import { channelStateDir, threadStateDir } from './config.mjs';

export function jobAllowedRoots(config, job = {}) {
  const repoPath = jobRepoPath(config, job);
  const roots = repoPath ? [repoPath] : [];
  // `/yolo` is an explicit operator grant, so workers can directly modify the
  // bridge source as an additional root while keeping the channel workspace as
  // their working directory.
  if (jobHasBridgeRepoAccess(job) && config.bridgeRepoRoot) roots.push(config.bridgeRepoRoot);
  if (jobNeedsFullStateAccess(job) && config.bridgeRepoRoot) roots.push(config.bridgeRepoRoot);
  if (repoPath && shouldIncludeConfiguredRoots(config, job, repoPath)) {
    roots.push(...(config.allowedRoots || []));
  }
  if (jobNeedsFullStateAccess(job)) {
    roots.push(config.stateRoot);
  } else {
    if (job.channelId) roots.push(channelStateDir(config, job.channelId));
    if (job.channelId && job.threadId) roots.push(threadStateDir(config, job.channelId, job.threadId));
  }
  return uniqueResolvedRoots(roots);
}

export function jobWorkingDirectory(config, job = {}) {
  const repoPath = jobRepoPath(config, job);
  if (repoPath) return repoPath;
  if (job.channelId) return channelStateDir(config, job.channelId);
  return path.join(config.stateRoot, '_system');
}

export function jobRepoPath(config, job = {}) {
  if (!jobNeedsRepoAccess(job)) return null;
  return path.resolve(job.repoPath || jobDefaultRepoPath(config, job));
}

export function jobArtifactRoot(config, job = {}) {
  const root = job.channelId
    ? channelStateDir(config, job.channelId)
    : path.join(config.stateRoot, '_system');
  return path.join(root, 'artifacts');
}

export function jobCanModifyBridgeSource(config, job = {}) {
  if (!config.bridgeRepoRoot) return false;
  const bridgeRoot = path.resolve(config.bridgeRepoRoot);
  return jobAllowedRoots(config, job).some((allowedRoot) =>
    containsPath(allowedRoot, bridgeRoot));
}

export function jobNeedsRepoAccess(job = {}) {
  if (job.maintenance) return true;
  if (typeof job.repoAccess === 'boolean') return job.repoAccess;
  return contentNeedsRepoAccess(job.event?.content || job.content || '');
}

export function jobNeedsFullStateAccess(job = {}) {
  if (typeof job.stateAccess === 'boolean') return job.stateAccess;
  return contentNeedsFullStateAccess(job.event?.content || job.content || '');
}

export function contentNeedsRepoAccess(content) {
  const text = String(content || '');
  if (!text.trim()) return false;

  return hasAccessDirective(text);
}

export function contentNeedsFullStateAccess(content) {
  const text = String(content || '').toLowerCase();
  if (!text.trim()) return false;

  return /(^|\s)\/god(?=$|\s|[.,!?;:])/i.test(text);
}

function uniqueResolvedRoots(roots) {
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

function hasAccessDirective(text) {
  return /(^|\s)\/(?:yolo|god|repo)(?=$|\s|[.,!?;:])/i.test(text);
}

function jobHasBridgeRepoAccess(job = {}) {
  if (!jobNeedsRepoAccess(job)) return false;
  if (job.bridgeRepoAccess === true) return true;
  return /(^|\s)\/yolo(?=$|\s|[.,!?;:])/i.test(String(job.event?.content || job.content || ''));
}

function jobDefaultRepoPath(config, job = {}) {
  if (job.maintenance) return config.bridgeRepoRoot || config.codex.cwd;
  if (job.channelId) return path.join(channelStateDir(config, job.channelId), 'workspace');
  return path.join(config.stateRoot, '_workspace');
}

function shouldIncludeConfiguredRoots(config, job = {}, repoPath) {
  if (job.maintenance) return true;
  if (job.includeConfiguredRoots) return true;
  if (!job.repoPath) return false;
  if (containsPath(config.stateRoot, repoPath)) return false;
  return path.resolve(job.repoPath) !== path.resolve(jobDefaultRepoPath(config, job));
}

function containsPath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
