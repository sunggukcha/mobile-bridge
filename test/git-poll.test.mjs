import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyGitPollEdit,
  buildGitPollContinuationContent,
  gitPollIsInThread,
  gitPollMatchesCancelThread,
  gitPollTimeoutWindowMs,
  normalizeGitPollRequest,
  resolveGitPollRepoPath,
  shortSha,
} from '../lib/git-poll.mjs';
import { runGit } from '../lib/git-sync.mjs';

test('normalizeGitPollRequest applies defaults and clamps tiny intervals', () => {
  const result = normalizeGitPollRequest({ intervalMs: 1, timeoutMs: 2, task: '' });

  assert.equal(result.intervalMs, 10_000);
  assert.equal(result.startAfterMs, 0);
  assert.equal(result.timeoutMs, 10_000);
  assert.match(result.task, /Remote git updates were detected/);
});

test('normalizeGitPollRequest accepts delayed starts', () => {
  const result = normalizeGitPollRequest({
    intervalMs: 60_000,
    startAfterMs: 2 * 60 * 60_000,
    timeoutMs: 6 * 60 * 60_000,
    task: 'continue later',
  });

  assert.equal(result.intervalMs, 60_000);
  assert.equal(result.startAfterMs, 2 * 60 * 60_000);
  assert.equal(result.timeoutMs, 6 * 60 * 60_000);
  assert.equal(result.task, 'continue later');
});

test('applyGitPollEdit preserves the timeout window when delaying start only', () => {
  const now = new Date('2026-06-30T00:00:00.000Z');
  const active = {
    intervalMs: 60_000,
    startAt: '2026-06-30T01:00:00.000Z',
    timeoutAt: '2026-06-30T07:00:00.000Z',
    task: 'continue after pull',
  };

  const updated = applyGitPollEdit(active, { startAfterMs: 6 * 60 * 60_000 }, { now });

  assert.equal(updated.startAt, '2026-06-30T06:00:00.000Z');
  assert.equal(updated.timeoutAt, '2026-06-30T12:00:00.000Z');
  assert.equal(updated.intervalMs, 60_000);
  assert.equal(updated.task, 'continue after pull');
});

test('applyGitPollEdit updates interval and task without moving timeout', () => {
  const active = {
    intervalMs: 60_000,
    startAt: '2026-06-30T00:00:00.000Z',
    timeoutAt: '2026-06-30T06:00:00.000Z',
    task: 'old task',
  };

  const updated = applyGitPollEdit(active, {
    intervalMs: 2 * 60_000,
    task: 'new task',
  }, { now: new Date('2026-06-30T01:00:00.000Z') });

  assert.equal(updated.intervalMs, 2 * 60_000);
  assert.equal(updated.timeoutAt, active.timeoutAt);
  assert.equal(updated.task, 'new task');
  assert.equal(gitPollTimeoutWindowMs(active), 6 * 60 * 60_000);
});

test('git poll thread matching does not make the source thread an edit or cancel alias', () => {
  const poll = {
    channelId: 'channel-1',
    threadId: 'poll-thread-1',
    sourceChannelId: 'channel-1',
    sourceThreadId: 'source-thread-1',
  };

  assert.equal(gitPollIsInThread(poll, 'channel-1', 'poll-thread-1'), true);
  assert.equal(gitPollIsInThread(poll, 'channel-1', 'source-thread-1'), false);
  assert.equal(gitPollMatchesCancelThread(poll, 'channel-1', 'poll-thread-1'), true);
  assert.equal(gitPollMatchesCancelThread(poll, 'channel-1', 'source-thread-1'), false);
});

test('resolveGitPollRepoPath selects a direct repo or the only child repo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-git-poll-'));
  const direct = path.join(root, 'direct');
  const parent = path.join(root, 'parent');
  const child = path.join(parent, 'repo-a');
  await fs.mkdir(direct);
  await fs.mkdir(child, { recursive: true });
  await runGit(direct, ['init']);
  await runGit(child, ['init']);

  assert.equal(
    await resolveGitPollRepoPath({ basePath: direct, repositoriesRoot: root }),
    direct,
  );
  assert.equal(
    await resolveGitPollRepoPath({ basePath: parent, repositoriesRoot: root }),
    child,
  );
});

test('resolveGitPollRepoPath requires path when repository root is ambiguous', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-git-poll-'));
  await fs.mkdir(path.join(root, 'repo-a'));
  await fs.mkdir(path.join(root, 'repo-b'));
  await runGit(path.join(root, 'repo-a'), ['init']);
  await runGit(path.join(root, 'repo-b'), ['init']);

  await assert.rejects(
    () => resolveGitPollRepoPath({ basePath: root, repositoriesRoot: root }),
    /multiple git repositories/,
  );
  assert.equal(
    await resolveGitPollRepoPath({ basePath: root, repositoriesRoot: root, requestedPath: 'repo-b' }),
    path.join(root, 'repo-b'),
  );
});

test('buildGitPollContinuationContent records pull context and task', () => {
  const content = buildGitPollContinuationContent({
    repoPath: '/tmp/repo',
    remote: 'origin',
    branch: 'main',
    baselineRemoteHead: '1234567890abcdef',
    task: 'run tests',
  }, {
    action: 'fast-forward-merge',
    remoteHead: 'fedcba0987654321',
  });

  assert.match(content, /Git polling detected a remote update/);
  assert.match(content, /Previous remote head: 1234567890ab/);
  assert.match(content, /Current remote head: fedcba098765/);
  assert.match(content, /run tests/);
  assert.equal(shortSha('abcdef1234567890'), 'abcdef123456');
});
