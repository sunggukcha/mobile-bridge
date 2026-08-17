import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDailyMaintenanceTask,
  buildDailyMaintenanceMinimalResumeTask,
  createDailyMaintenanceRun,
  collectDailyMaintenanceContext,
  dailyMaintenanceReviewWindow,
  maintenancePromptBudget,
  previousDailyMaintenanceWindow,
  summarizeDailyMaintenanceContext,
} from '../lib/daily-maintenance.mjs';
import { runGit } from '../lib/git-sync.mjs';

test('previousDailyMaintenanceWindow returns the prior 03:00 KST maintenance window', () => {
  const window = previousDailyMaintenanceWindow(new Date('2026-06-03T03:00:01+09:00'));

  assert.equal(window.start.toISOString(), '2026-06-01T18:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-06-02T18:00:00.000Z');
});

test('previousDailyMaintenanceWindow anchors to the pending daily boundary before 03:00 KST', () => {
  const window = previousDailyMaintenanceWindow(new Date('2026-06-03T02:59:59+09:00'));

  assert.equal(window.start.toISOString(), '2026-05-31T18:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-06-01T18:00:00.000Z');
});

test('collectDailyMaintenanceContext reads channel and thread scoped history', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-maint-'));
  const channelRoot = path.join(stateRoot, 'c1_common');
  const threadRoot = path.join(stateRoot, 'c1', 't1');

  await writeJsonl(path.join(channelRoot, 'memory', 'events.jsonl'), [
    { timestamp: '2026-06-01T18:59:59.000Z', content: 'old channel event' },
    { timestamp: '2026-06-02T01:00:00.000Z', content: 'legacy channel event' },
    { timestamp: '2026-06-02T17:30:00.000Z', content: 'late channel event' },
  ]);
  await writeJsonl(path.join(threadRoot, 'memory', 'events.jsonl'), [
    { timestamp: '2026-06-02T02:00:00.000Z', content: 'thread event' },
  ]);
  await writeJsonl(path.join(threadRoot, 'jobs', 'jobs.jsonl'), [
    { createdAt: '2026-06-02T03:00:00.000Z', status: 'done' },
    { createdAt: '2026-06-02T17:45:00.000Z', status: 'late-done' },
  ]);

  const logPath = path.join(stateRoot, 'logs', 'bridge.log');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, 'ok\n');
  const logTime = new Date('2026-06-02T04:00:00.000Z');
  await fs.utimes(logPath, logTime, logTime);
  await writeJsonl(path.join(stateRoot, '_system', 'events.jsonl'), [
    { timestamp: '2026-06-02T05:00:00.000Z', type: 'ready' },
  ]);

  const context = await collectDailyMaintenanceContext({
    stateRoot,
    now: new Date('2026-06-03T03:00:01+09:00'),
    maxItems: 10,
  });

  assert.deepEqual(context.conversationEvents.map((event) => [event.scope, event.channelId, event.threadId, event.content]), [
    ['channel', 'c1', 'channel', 'old channel event'],
    ['channel', 'c1', 'channel', 'legacy channel event'],
    ['thread', 'c1', 't1', 'thread event'],
    ['channel', 'c1', 'channel', 'late channel event'],
  ]);
  assert.deepEqual(context.jobEvents.map((event) => [event.scope, event.channelId, event.threadId, event.status]), [
    ['thread', 'c1', 't1', 'done'],
    ['thread', 'c1', 't1', 'late-done'],
  ]);
  assert.equal(context.systemLogs.length, 2);
  assert.equal(context.systemLogs[0].type, 'ready');
  assert.equal(context.window.source, 'state-history-fallback');
});

test('collectDailyMaintenanceContext checks git status against the configured branch', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-maint-'));
  const fixture = await createBranchFixture();

  const context = await collectDailyMaintenanceContext({
    stateRoot,
    repoPath: fixture.local,
    gitRemote: 'origin',
    gitBranch: 'feature',
    now: new Date('2026-06-03T03:00:01+09:00'),
  });

  assert.equal(context.gitStatus.branch, 'feature');
  assert.equal(context.gitStatus.remote, 'origin');
  assert.equal(context.gitStatus.synced, true);
  assert.equal(context.gitStatus.remoteVerified, true);
  assert.equal(context.gitStatus.remoteHead, await gitTrim(fixture.remoteWork, ['rev-parse', 'feature']));
});

test('dailyMaintenanceReviewWindow starts after the previous maintenance event when state exists', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-maint-'));
  const threadRoot = path.join(stateRoot, 'c1', 'm1');

  await writeJsonl(path.join(threadRoot, 'memory', 'events.jsonl'), [
    {
      id: 'daily_maintenance_1',
      timestamp: '2026-06-02T19:00:01.000Z',
      authorName: 'system-maintenance',
      content: 'Daily bridge maintenance.',
    },
  ]);

  const window = await dailyMaintenanceReviewWindow({
    stateRoot,
    now: new Date('2026-06-03T19:00:02.000Z'),
  });

  assert.equal(window.start.toISOString(), '2026-06-02T19:00:01.000Z');
  assert.equal(window.end.toISOString(), '2026-06-03T19:00:02.000Z');
  assert.equal(window.startInclusive, false);
  assert.equal(window.source, 'previous-maintenance');
});

test('dailyMaintenanceReviewWindow falls back to the earliest state activity when no maintenance marker exists', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-maint-'));
  const threadRoot = path.join(stateRoot, 'c1', 't1');

  await writeJsonl(path.join(threadRoot, 'memory', 'events.jsonl'), [
    { timestamp: '2026-06-02T18:30:00.000Z', content: 'message' },
  ]);
  await writeJsonl(path.join(threadRoot, 'jobs', 'jobs.jsonl'), [
    { createdAt: '2026-06-02T18:10:00.000Z', status: 'started' },
  ]);

  const window = await dailyMaintenanceReviewWindow({
    stateRoot,
    now: new Date('2026-06-02T19:00:02.000Z'),
  });

  assert.equal(window.start.toISOString(), '2026-06-02T18:10:00.000Z');
  assert.equal(window.end.toISOString(), '2026-06-02T19:00:02.000Z');
  assert.equal(window.startInclusive, true);
  assert.equal(window.source, 'state-history-fallback');
});

test('collectDailyMaintenanceContext excludes the previous maintenance marker and includes later events', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-maint-'));
  const threadRoot = path.join(stateRoot, 'c1', 'm1');

  await writeJsonl(path.join(threadRoot, 'memory', 'events.jsonl'), [
    {
      id: 'daily_maintenance_1',
      timestamp: '2026-06-02T19:00:01.000Z',
      authorName: 'system-maintenance',
      content: 'Daily bridge maintenance.',
    },
    { timestamp: '2026-06-02T19:00:01.000Z', content: 'same instant should be excluded' },
    { timestamp: '2026-06-02T19:03:08.000Z', content: 'after maintenance' },
  ]);
  await writeJsonl(path.join(threadRoot, 'jobs', 'jobs.jsonl'), [
    { createdAt: '2026-06-02T19:04:56.000Z', status: 'done' },
  ]);

  const context = await collectDailyMaintenanceContext({
    stateRoot,
    now: new Date('2026-06-03T19:00:00.000Z'),
    maxItems: 10,
  });

  assert.deepEqual(context.conversationEvents.map((event) => event.content), ['after maintenance']);
  assert.deepEqual(context.jobEvents.map((event) => event.status), ['done']);
  assert.equal(context.window.source, 'previous-maintenance');
  assert.equal(context.window.startInclusive, false);
});

test('collectDailyMaintenanceContext sorts job events by their available timestamps', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-maint-'));
  const threadRoot = path.join(stateRoot, 'c1', 'm1');

  await writeJsonl(path.join(threadRoot, 'memory', 'events.jsonl'), [
    {
      id: 'daily_maintenance_1',
      timestamp: '2026-06-02T19:00:01.000Z',
      authorName: 'system-maintenance',
      content: 'Daily bridge maintenance.',
    },
  ]);
  await writeJsonl(path.join(threadRoot, 'jobs', 'jobs.jsonl'), [
    { id: 'created', createdAt: '2026-06-02T19:01:00.000Z', status: 'started' },
    { id: 'updated', updatedAt: '2026-06-02T19:02:00.000Z', status: 'progress-notified' },
    { id: 'finished', finishedAt: '2026-06-02T19:03:00.000Z', status: 'done' },
  ]);

  const context = await collectDailyMaintenanceContext({
    stateRoot,
    now: new Date('2026-06-02T20:00:00.000Z'),
    maxItems: 10,
  });

  assert.deepEqual(context.jobEvents.map((event) => event.id), ['created', 'updated', 'finished']);
});

test('summarizeDailyMaintenanceContext digests failures, job outcomes, and user load', () => {
  const summary = summarizeDailyMaintenanceContext({
    window: { end: '2026-06-11T02:00:00.000Z' },
    systemLogs: [
      { type: 'thread-create-failed' },
      { type: 'thread-create-failed' },
      { type: 'ready' },
    ],
    jobEvents: [
      { id: 'job-1', channelId: 'c1', threadId: 't1', status: 'queued', createdAt: '2026-06-11T00:00:00.000Z' },
      { id: 'job-1', channelId: 'c1', threadId: 't1', status: 'started' },
      { id: 'job-1', channelId: 'c1', threadId: 't1', status: 'done', finishedAt: '2026-06-11T00:10:00.000Z' },
      { id: 'job-2', channelId: 'c1', threadId: 't2', status: 'queued', createdAt: '2026-06-11T01:00:00.000Z' },
      { id: 'job-2', channelId: 'c1', threadId: 't2', status: 'started' },
    ],
    conversationEvents: [
      { channelId: 'c1', threadId: 't1', content: '해줘', authorName: '테스트 사용자' },
      { channelId: 'c1', threadId: 't1', content: '응답', source: 'bridge-agent' },
    ],
  });

  assert.deepEqual(summary.attentionEvents, [{ type: 'thread-create-failed', count: 2 }]);
  assert.equal(summary.jobs.total, 2);
  assert.deepEqual(summary.jobs.stalled, [
    {
      id: 'job-2',
      channelId: 'c1',
      threadId: 't2',
      status: 'started',
      lastSeenAt: '2026-06-11T01:00:00.000Z',
      staleMinutes: 60,
    },
  ]);
  assert.equal(summary.jobs.doneCount, 1);
  assert.equal(summary.jobs.doneDurationCount, 1);
  assert.equal(summary.jobs.medianDoneMinutes, 10);
  assert.equal(summary.userMessages.total, 1);
});

test('summarizeDailyMaintenanceContext counts done jobs outside the duration sample', () => {
  const summary = summarizeDailyMaintenanceContext({
    jobEvents: [
      // A job may begin just before the exclusive maintenance window, leaving
      // no retained createdAt even though its terminal event belongs here.
      { id: 'boundary-job', channelId: 'c1', threadId: 't1', status: 'done', finishedAt: '2026-06-11T00:10:00.000Z' },
      { id: 'timed-job', channelId: 'c1', threadId: 't2', status: 'queued', createdAt: '2026-06-11T00:00:00.000Z' },
      { id: 'timed-job', channelId: 'c1', threadId: 't2', status: 'done', finishedAt: '2026-06-11T00:05:00.000Z' },
    ],
  });

  assert.equal(summary.jobs.byStatus.done, 2);
  assert.equal(summary.jobs.doneCount, 2);
  assert.equal(summary.jobs.doneDurationCount, 1);
  assert.equal(summary.jobs.medianDoneMinutes, 5);
});

test('summarizeDailyMaintenanceContext nets out thread-create failures that recovered via standalone fallback', () => {
  const summary = summarizeDailyMaintenanceContext({
    systemLogs: [
      // m1: failed then recovered via standalone fallback -> not attention noise.
      { type: 'thread-create-failed', messageId: 'm1' },
      { type: 'thread-create-fallback-standalone', messageId: 'm1' },
      // m2: failed and the fallback also failed -> genuine loss, still attention.
      { type: 'thread-create-failed', messageId: 'm2' },
      { type: 'thread-create-fallback-failed', messageId: 'm2' },
    ],
  });

  // m1 is recovered (count 2 - 1 = 1 remaining for the genuine m2 loss), and the
  // m2 fallback failure surfaces on its own as a real unthreadable loss.
  assert.deepEqual(summary.attentionEvents, [
    { type: 'thread-create-failed', count: 1 },
    { type: 'thread-create-fallback-failed', count: 1 },
  ]);
  // Raw counts stay intact for full visibility.
  assert.equal(
    summary.systemEventCounts.find((e) => e.type === 'thread-create-failed').count,
    2,
  );
});

test('summarizeDailyMaintenanceContext drops thread-create-failed entirely when all recovered', () => {
  const summary = summarizeDailyMaintenanceContext({
    systemLogs: [
      { type: 'thread-create-failed', messageId: 'm1' },
      { type: 'thread-create-fallback-standalone', messageId: 'm1' },
    ],
  });

  assert.deepEqual(summary.attentionEvents, []);
});

test('summarizeDailyMaintenanceContext does not flag successful outbound dedupe as attention', () => {
  const summary = summarizeDailyMaintenanceContext({
    systemLogs: [
      { type: 'job-outbound-duplicate-skipped' },
      { type: 'discord-message-dropped-after-send-failure' },
    ],
  });

  assert.deepEqual(summary.attentionEvents, [
    { type: 'discord-message-dropped-after-send-failure', count: 1 },
  ]);
  assert.equal(summary.systemEventCounts.find((entry) => entry.type === 'job-outbound-duplicate-skipped').count, 1);
});

test('summarizeDailyMaintenanceContext detects failures in neutral event fields and close codes', () => {
  const summary = summarizeDailyMaintenanceContext({
    systemLogs: [
      { type: 'worker-finished', status: 'failed' },
      { type: 'socket-state', error: 'ECONNRESET' },
      { type: 'connection-state', code: 1006 },
      { type: 'delivery-state', delivered: false, queued: false },
      { type: 'normal-close', code: 1000 },
    ],
  });

  assert.deepEqual(summary.attentionEvents, [
    { type: 'connection-state', count: 1 },
    { type: 'delivery-state', count: 1 },
    { type: 'socket-state', count: 1 },
    { type: 'worker-finished', count: 1 },
  ]);
});

test('summarizeDailyMaintenanceContext detects numeric failure counters and raw log errors', () => {
  const summary = summarizeDailyMaintenanceContext({
    systemLogs: [
      { type: 'todo-alerts-processed', sent: 2, failed: 1 },
      { type: 'worker-fallback-used', attempts: [{ status: 'failed' }, { status: 'succeeded' }] },
      { file: 'logs/bridge.log', tail: 'socket ended with ECONNRESET' },
      { type: 'message-duplicate-suppressed' },
    ],
  });

  assert.deepEqual(summary.attentionEvents, [
    { type: 'log-snippet', count: 1 },
    { type: 'todo-alerts-processed', count: 1 },
    { type: 'worker-fallback-used', count: 1 },
  ]);
});

test('summarizeDailyMaintenanceContext keeps terminal status when a late progress-update follows done', () => {
  const summary = summarizeDailyMaintenanceContext({
    jobEvents: [
      { id: 'job-1', channelId: 'c1', threadId: 't1', status: 'queued', createdAt: '2026-06-14T16:18:28.000Z' },
      { id: 'job-1', channelId: 'c1', threadId: 't1', status: 'started' },
      { id: 'job-1', channelId: 'c1', threadId: 't1', status: 'progress-update' },
      { id: 'job-1', channelId: 'c1', threadId: 't1', status: 'done', finishedAt: '2026-06-14T16:24:02.021Z' },
      // Trailing 【응답완료】 progress-update logged after the job finished.
      { id: 'job-1', channelId: 'c1', threadId: 't1', status: 'progress-update' },
    ],
  });

  assert.deepEqual(summary.jobs.stalled, []);
  assert.equal(summary.jobs.byStatus.done, 1);
  assert.equal(summary.jobs.byStatus['progress-update'], undefined);
  assert.equal(summary.jobs.doneCount, 1);
});

test('summarizeDailyMaintenanceContext does not report a restart-interrupted job whose continuation finished', () => {
  const summary = summarizeDailyMaintenanceContext({
    jobEvents: [
      // Original job interrupted by a runtime restart: last status is non-terminal.
      { id: 'job-7', channelId: 'c1', threadId: 't1', status: 'queued', createdAt: '2026-06-18T01:00:00.000Z' },
      { id: 'job-7', channelId: 'c1', threadId: 't1', status: 'started' },
      { id: 'job-7', channelId: 'c1', threadId: 't1', status: 'needs-runtime-restart' },
      // Work recovered under a continuation id that shares the root and reaches done.
      { id: 'job-7_continue_20260618100000', channelId: 'c1', threadId: 't1', status: 'started' },
      { id: 'job-7_continue_20260618100000', channelId: 'c1', threadId: 't1', status: 'done', finishedAt: '2026-06-18T01:05:00.000Z' },
    ],
  });

  // The original id must not show as a phantom unfinished job.
  assert.deepEqual(summary.jobs.stalled, []);
});

test('summarizeDailyMaintenanceContext still reports a genuinely stalled job with no finished continuation', () => {
  const summary = summarizeDailyMaintenanceContext({
    window: { end: '2026-06-18T02:00:00.000Z' },
    jobEvents: [
      {
        id: 'job-8',
        channelId: 'c1',
        threadId: 't1',
        status: 'started',
        createdAt: '2026-06-18T01:00:00.000Z',
      },
      { id: 'job-8', channelId: 'c1', threadId: 't1', status: 'needs-runtime-restart' },
    ],
  });

  assert.equal(summary.jobs.stalled.length, 1);
  assert.equal(summary.jobs.stalled[0].id, 'job-8');
});

test('summarizeDailyMaintenanceContext excludes waiting-for-user continuations from stalled jobs', () => {
  const summary = summarizeDailyMaintenanceContext({
    window: { end: '2026-07-20T13:00:00.000Z' },
    jobEvents: [
      {
        id: 'job-ask',
        channelId: 'c1',
        threadId: 't1',
        status: 'waiting_for_user',
        createdAt: '2026-07-20T11:00:00.000Z',
      },
      {
        id: 'job-ask_continue_20260720112000',
        channelId: 'c1',
        threadId: 't1',
        status: 'started',
        createdAt: '2026-07-20T11:20:00.000Z',
      },
      { id: 'job-ask_continue_20260720112000', channelId: 'c1', threadId: 't1', status: 'waiting_for_user' },
    ],
  });

  assert.deepEqual(summary.jobs.stalled, []);
});

test('buildDailyMaintenanceTask includes the digest and required output sections', () => {
  const task = buildDailyMaintenanceTask({
    window: {
      start: '2026-06-01T18:00:00.000Z',
      end: '2026-06-02T18:00:00.000Z',
      timeZone: 'Asia/Seoul',
      source: 'state-history-fallback',
    },
    conversationEvents: [],
    jobEvents: [
      { id: 'job-9', channelId: 'c1', threadId: 't9', status: 'started' },
    ],
    systemLogs: [{ type: 'job-error' }],
    gitStatus: { synced: true },
  });

  assert.match(task, /Final report/);
  assert.match(task, /"stalled"/);
  assert.match(task, /job-error/);
  assert.match(task, /npm test/);
  assert.match(task, /bridge_daily_maintenance_result/);
  assert.match(task, /actually implemented and verified/);
  assert.doesNotMatch(task, /다음 follow-up/);
  assert.match(task, /gateway\/event ingestion/);
});

test('buildDailyMaintenanceTask asks for channel and thread review', () => {
  const task = buildDailyMaintenanceTask({
    window: {
      start: '2026-06-01T18:00:00.000Z',
      end: '2026-06-02T18:00:00.000Z',
      timeZone: 'Asia/Seoul',
      source: 'state-history-fallback',
    },
    conversationEvents: [],
    jobEvents: [],
    systemLogs: [],
    gitStatus: { synced: true },
  });

  assert.match(task, /by channel\/thread/);
  assert.match(task, /confirmed failures/);
  assert.match(task, /earliest available bridge state/);
  assert.match(task, /without reset --hard/);
});

test('createDailyMaintenanceRun stores raw context while sharded prompt stays compact', async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-maint-artifacts-'));
  const longContent = 'raw user message '.repeat(2_000);
  const context = {
    window: {
      start: '2026-06-01T18:00:00.000Z',
      end: '2026-06-02T18:00:00.000Z',
      timeZone: 'Asia/Seoul',
      source: 'state-history-fallback',
    },
    conversationEvents: [{ id: 'm1', timestamp: '2026-06-02T01:00:00.000Z', content: longContent }],
    jobEvents: [{ id: 'j1', status: 'started', createdAt: '2026-06-02T02:00:00.000Z' }],
    systemLogs: [{ type: 'job-error', timestamp: '2026-06-02T03:00:00.000Z', error: 'context_length_exceeded' }],
    gitStatus: { synced: true },
  };
  context.summary = summarizeDailyMaintenanceContext(context);

  const run = await createDailyMaintenanceRun({
    artifactRoot,
    context,
    now: new Date('2026-06-12T03:00:00+09:00'),
    inputBudgetChars: 50_000,
  });
  const task = buildDailyMaintenanceTask(context, { manifest: run.manifest, inlineItems: 1 });

  assert.match(await fs.readFile(run.rawContextPath, 'utf8'), /raw user message/);
  assert.match(task, /Mode: sharded-manifest/);
  assert.match(task, /raw-context\.json/);
  assert.match(task, /fresh general-channel final message/);
  assert.equal(task.includes(longContent), false);
  assert.ok(task.length < 20_000);
  assert.equal(run.manifest.tasks.length > 1, true);
});

test('buildDailyMaintenanceMinimalResumeTask is small and points at artifacts', () => {
  const task = buildDailyMaintenanceMinimalResumeTask({
    manifestPath: '/tmp/manifest.json',
    rawContextPath: '/tmp/raw-context.json',
    summaryPath: '/tmp/summary.json',
    reason: 'input-limit',
    failedWorker: 'claude-fable',
    errorDetail: 'context_length_exceeded '.repeat(500),
    promptChars: 130_000,
    maxPromptChars: 120_000,
  });

  assert.match(task, /Mode: minimal-resume/);
  assert.match(task, /\/tmp\/manifest\.json/);
  assert.match(task, /claude-fable/);
  assert.ok(task.length < 8_000);
});

test('maintenancePromptBudget detects oversized prompts', () => {
  assert.deepEqual(
    maintenancePromptBudget('12345', { maxPromptChars: 4 }),
    { chars: 5, maxPromptChars: 4, ratio: 1.25, overBudget: true },
  );
});

async function writeJsonl(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

async function createBranchFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-maint-git-'));
  const remoteWork = path.join(root, 'remote-work');
  const bare = path.join(root, 'remote.git');
  const local = path.join(root, 'local');

  await fs.mkdir(remoteWork);
  await runGit(remoteWork, ['init']);
  await runGit(remoteWork, ['checkout', '-b', 'main']);
  await configureUser(remoteWork);
  await commitFile(remoteWork, 'bridge.txt', 'main\n', 'main');
  await runGit(root, ['clone', '--bare', remoteWork, bare]);
  await runGit(remoteWork, ['remote', 'add', 'origin', bare]);
  await runGit(remoteWork, ['checkout', '-b', 'feature']);
  await commitFile(remoteWork, 'feature.txt', 'feature\n', 'feature');
  await runGit(remoteWork, ['push', 'origin', 'main']);
  await runGit(remoteWork, ['push', 'origin', 'feature']);
  await runGit(root, ['clone', bare, local]);
  await runGit(local, ['checkout', 'feature']);
  await configureUser(local);

  return { remoteWork, local };
}

async function configureUser(cwd) {
  await runGit(cwd, ['config', 'user.email', 'bridge-test@example.invalid']);
  await runGit(cwd, ['config', 'user.name', 'Bridge Test']);
}

async function commitFile(cwd, fileName, content, message) {
  await fs.writeFile(path.join(cwd, fileName), content);
  await runGit(cwd, ['add', fileName]);
  await runGit(cwd, ['commit', '-m', message]);
}

async function gitTrim(cwd, args) {
  return (await runGit(cwd, args)).stdout.trim();
}
