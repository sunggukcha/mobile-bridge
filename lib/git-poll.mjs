import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './git-sync.mjs';

export const DEFAULT_GIT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_GIT_POLL_TIMEOUT_MS = 6 * 60 * 60_000;
export const MIN_GIT_POLL_INTERVAL_MS = 10_000;
export const MAX_GIT_POLL_TIMEOUT_MS = 24 * 60 * 60_000;
export const MAX_GIT_POLL_START_DELAY_MS = 7 * 24 * 60 * 60_000;

const DEFAULT_CONTINUATION_TASK = [
  'Remote git updates were detected and pulled.',
  'Inspect the updates, then continue with the next useful endpoint-free task from this thread context.',
  'Leave validation steps clearly enough for another agent to verify the work.',
].join(' ');

export function normalizeGitPollRequest(command = {}) {
  const intervalMs = clampNumber(
    command.intervalMs,
    DEFAULT_GIT_POLL_INTERVAL_MS,
    MIN_GIT_POLL_INTERVAL_MS,
    MAX_GIT_POLL_TIMEOUT_MS,
  );
  const startAfterMs = clampNumber(
    command.startAfterMs,
    0,
    0,
    MAX_GIT_POLL_START_DELAY_MS,
  );
  const timeoutMs = clampNumber(
    command.timeoutMs,
    DEFAULT_GIT_POLL_TIMEOUT_MS,
    intervalMs,
    MAX_GIT_POLL_TIMEOUT_MS,
  );
  return {
    intervalMs,
    startAfterMs,
    timeoutMs,
    task: String(command.task || '').trim() || DEFAULT_CONTINUATION_TASK,
  };
}

export function applyGitPollEdit(active = {}, command = {}, { now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const previousWindowMs = gitPollTimeoutWindowMs(active, nowMs);
  const normalized = normalizeGitPollRequest({
    intervalMs: command.intervalMs ?? active.intervalMs,
    timeoutMs: command.timeoutMs ?? previousWindowMs ?? undefined,
    startAfterMs: command.startAfterMs ?? 0,
    task: command.task || active.task,
  });
  const updated = {
    ...active,
    intervalMs: command.intervalMs == null ? active.intervalMs : normalized.intervalMs,
    startAt: command.startAfterMs == null
      ? active.startAt || active.createdAt || nowDate.toISOString()
      : new Date(nowMs + normalized.startAfterMs).toISOString(),
    task: command.task ? normalized.task : active.task,
  };
  if (command.timeoutMs != null || command.startAfterMs != null) {
    const startMs = Date.parse(updated.startAt || '');
    const timeoutBase = Number.isFinite(startMs) && startMs > nowMs ? startMs : nowMs;
    const timeoutDurationMs = command.timeoutMs != null
      ? normalized.timeoutMs
      : previousWindowMs ?? normalized.timeoutMs;
    updated.timeoutAt = new Date(timeoutBase + timeoutDurationMs).toISOString();
  }
  return updated;
}

export function gitPollTimeoutWindowMs(poll = {}, nowMs = Date.now()) {
  const timeoutMs = Date.parse(poll.timeoutAt || '');
  if (!Number.isFinite(timeoutMs)) return null;
  const startMs = Date.parse(poll.startAt || poll.createdAt || '');
  const baseMs = Number.isFinite(startMs) ? startMs : nowMs;
  const windowMs = timeoutMs - baseMs;
  return Number.isFinite(windowMs) && windowMs > 0 ? windowMs : null;
}

export function gitPollIsInThread(poll = {}, channelId, threadId) {
  return String(poll.channelId || '') === String(channelId || '')
    && String(poll.threadId || '') === String(threadId || '');
}

export function gitPollMatchesCancelThread(poll = {}, channelId, threadId) {
  return gitPollIsInThread(poll, channelId, threadId);
}

export async function resolveGitPollRepoPath({
  basePath,
  repositoriesRoot,
  requestedPath = null,
} = {}) {
  const base = path.resolve(basePath || repositoriesRoot || process.cwd());
  const root = repositoriesRoot ? path.resolve(repositoriesRoot) : base;

  if (requestedPath) {
    const candidate = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(base, requestedPath);
    if (!isSameOrChild(candidate, base) && !isSameOrChild(candidate, root)) {
      throw new Error(`git poll repo path escapes allowed repository roots: ${requestedPath}`);
    }
    const topLevel = await gitTopLevel(candidate);
    if (!topLevel) throw new Error(`git poll repo path is not inside a git repo: ${candidate}`);
    return topLevel;
  }

  const direct = await gitTopLevel(base);
  if (direct) return direct;

  const children = [];
  for (const entry of await readdirSafe(base)) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(base, entry.name);
    if (await gitTopLevel(candidate)) children.push(candidate);
  }
  if (children.length === 1) return children[0];
  if (children.length === 0) throw new Error(`no git repository found under ${base}`);
  throw new Error(`multiple git repositories found under ${base}; pass path=<repo-dir>`);
}

export async function currentGitBranch(cwd) {
  const result = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = result.stdout.trim();
  return branch && branch !== 'HEAD' ? branch : 'main';
}

export function buildGitPollContinuationContent(poll = {}, sync = {}) {
  const statusAfter = sync.statusAfter || sync.remoteRefresh || {};
  const remoteHead = sync.remoteHead || sync.nextHead || statusAfter.remoteHead || '';
  const lines = [
    'Git polling detected a remote update and pulled before starting this worker.',
    `Repository: ${poll.repoPath || ''}`,
    `Remote branch: ${poll.remote || 'origin'}/${poll.branch || ''}`,
    `Previous remote head: ${shortSha(poll.baselineRemoteHead) || 'unknown'}`,
    `Current remote head: ${shortSha(remoteHead) || 'unknown'}`,
    `Pull action: ${sync.action || 'unknown'}`,
    '',
    'Continue with this task:',
    poll.task || DEFAULT_CONTINUATION_TASK,
  ];
  return lines.join('\n').trim();
}

export function formatGitPollTarget(poll = {}) {
  return `${poll.remote || 'origin'}/${poll.branch || 'unknown'} @ ${poll.repoPath || 'unknown repo'}`;
}

export function shortSha(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 12) : '';
}

function clampNumber(value, fallback, min, max) {
  const hasValue = value !== null && value !== undefined && value !== '';
  const number = Number(value);
  const selected = hasValue && Number.isFinite(number) && number >= 0 ? number : fallback;
  return Math.min(max, Math.max(min, Math.round(selected)));
}

async function gitTopLevel(cwd) {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], { reject: false });
  if (result.code !== 0) return null;
  return path.resolve(result.stdout.trim());
}

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isSameOrChild(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
