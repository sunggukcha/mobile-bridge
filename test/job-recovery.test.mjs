import assert from 'node:assert/strict';
import test from 'node:test';
import { rootJobId } from '../lib/job-id.mjs';
import {
  compareThreadEvents,
  eventForRecoverableJob,
  interruptedJobCandidatesFromEntries,
  isPostSuccessRuntimeRestartRecovery,
  isQueueProtectedJob,
  newestRecoverySupersedingThreadEventAfter,
  newestSupersedingThreadEventAfter,
  newestThreadJobAfter,
  newestThreadEventAfter,
  shouldSupersedeLiveJob,
} from '../lib/job-recovery.mjs';

test('compareThreadEvents uses source timestamps instead of delayed arrival order', () => {
  const newerFirst = {
    id: 'slack-C0000000001-1700000200-000002',
    timestamp: '2026-07-28T07:40:29.039Z',
  };
  const olderArrivingLater = {
    id: 'slack-C0000000001-1700000100-000001',
    timestamp: '2026-07-28T07:39:31.029Z',
  };

  assert.equal(compareThreadEvents(olderArrivingLater, newerFirst) < 0, true);
  assert.equal(compareThreadEvents(newerFirst, olderArrivingLater) > 0, true);
});

test('newestThreadJobAfter rejects a delayed older Slack job instead of superseding current work', () => {
  const newerActiveJob = {
    id: 'slack-C0000000001-1700000200-000002',
    event: {
      id: 'slack-C0000000001-1700000200-000002',
      timestamp: '2026-07-28T07:40:29.039Z',
    },
  };
  const olderDelayedJob = {
    id: 'slack-C0000000001-1700000100-000001',
    event: {
      id: 'slack-C0000000001-1700000100-000001',
      timestamp: '2026-07-28T07:39:31.029Z',
    },
  };

  assert.equal(newestThreadJobAfter([newerActiveJob], olderDelayedJob)?.id, newerActiveJob.id);
  assert.equal(newestThreadJobAfter([olderDelayedJob], newerActiveJob), null);
});

test('interruptedJobCandidatesFromEntries recovers every interrupted root job in a thread', () => {
  const candidates = interruptedJobCandidatesFromEntries([
    { id: 'job-a', status: 'queued', createdAt: '2026-06-09T00:00:00.000Z' },
    { id: 'job-b', status: 'started', createdAt: '2026-06-09T00:01:00.000Z' },
    { id: 'job-c', status: 'done', createdAt: '2026-06-09T00:02:00.000Z' },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.deepEqual(candidates.map((entry) => entry.id), ['job-a', 'job-b']);
  assert.deepEqual(candidates.map((entry) => [entry.channelId, entry.threadId]), [
    ['channel-1', 'thread-1'],
    ['channel-1', 'thread-1'],
  ]);
});

test('interruptedJobCandidatesFromEntries keeps only the newest continuation per root job', () => {
  const candidates = interruptedJobCandidatesFromEntries([
    { id: 'job-a', status: 'needs-runtime-restart', updatedAt: '2026-06-09T00:00:00.000Z' },
    { id: 'job-a_continue_20260609090100', status: 'queued', createdAt: '2026-06-09T00:01:00.000Z' },
    { id: 'job-b', status: 'retry-scheduled', retryAt: '2026-06-09T00:02:00.000Z' },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.deepEqual(candidates.map((entry) => entry.id), [
    'job-a_continue_20260609090100',
    'job-b',
  ]);
});

test('interruptedJobCandidatesFromEntries backfills repo metadata for continuation recovery', () => {
  const [candidate] = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'started',
      createdAt: '2026-06-09T00:00:00.000Z',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
      stateAccess: true,
      verboseProgress: true,
      richStyleId: 'minimal-light',
    },
    {
      id: 'job-a',
      status: 'retry-scheduled',
      updatedAt: '2026-06-09T00:01:00.000Z',
      nextAttempt: 2,
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidate.id, 'job-a');
  assert.equal(candidate.repoAccess, true);
  assert.equal(candidate.repoPath, '/tmp/projects/repo-a');
  assert.equal(candidate.stateAccess, true);
  assert.equal(candidate.verboseProgress, true);
  assert.equal(candidate.richStyleId, 'minimal-light');
  assert.equal(candidate.nextAttempt, 2);
});

test('interruptedJobCandidatesFromEntries backfills repo metadata across continuation ids', () => {
  const [candidate] = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'needs-runtime-restart',
      updatedAt: '2026-06-09T00:00:00.000Z',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
      stateAccess: true,
      richStyleId: 'synthwave',
    },
    {
      id: 'job-a_continue_20260609090100',
      status: 'queued',
      createdAt: '2026-06-09T00:01:00.000Z',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidate.id, 'job-a_continue_20260609090100');
  assert.equal(candidate.repoAccess, true);
  assert.equal(candidate.repoPath, '/tmp/projects/repo-a');
  assert.equal(candidate.stateAccess, true);
  assert.equal(candidate.richStyleId, 'synthwave');
});

test('interruptedJobCandidatesFromEntries preserves GitHub issue maintenance serialization metadata', () => {
  const [candidate] = interruptedJobCandidatesFromEntries([
    {
      id: 'daily_maintenance_issue_7',
      status: 'started',
      createdAt: '2026-07-28T03:00:00.000Z',
      maintenance: true,
      maintenanceIssue: {
        number: 7,
        repository: 'owner/mobile-codex-bridge',
        url: 'https://github.com/owner/mobile-codex-bridge/issues/7',
      },
      concurrencyKey: 'maintenance:run-1',
      finalChannelId: 'channel-1',
    },
    {
      id: 'daily_maintenance_issue_7',
      status: 'checkpoint-saved',
      updatedAt: '2026-07-28T03:01:00.000Z',
      checkpointStatus: 'running',
    },
  ], { channelId: 'channel-1', threadId: 'thread-7' });

  assert.equal(candidate.maintenance, true);
  assert.equal(candidate.maintenanceIssue.number, 7);
  assert.equal(candidate.concurrencyKey, 'maintenance:run-1');
  assert.equal(candidate.finalChannelId, 'channel-1');
});

test('interruptedJobCandidatesFromEntries treats progress updates as informational', () => {
  const candidates = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'started',
      createdAt: '2026-06-09T00:00:00.000Z',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
    {
      id: 'job-a',
      status: 'progress-update',
      updatedAt: '2026-06-09T00:01:00.000Z',
      details: 'still working',
    },
    {
      id: 'job-b',
      status: 'done',
      finishedAt: '2026-06-09T00:02:00.000Z',
    },
    {
      id: 'job-b',
      status: 'progress-update',
      updatedAt: '2026-06-09T00:03:00.000Z',
      details: 'late flush',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.deepEqual(candidates.map((entry) => entry.id), ['job-a']);
  assert.equal(candidates[0].status, 'started');
  assert.equal(candidates[0].repoAccess, true);
  assert.equal(candidates[0].repoPath, '/tmp/projects/repo-a');
});

test('interruptedJobCandidatesFromEntries treats transcript saves as informational', () => {
  const candidates = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'started',
      createdAt: '2026-06-09T00:00:00.000Z',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
    {
      id: 'job-a',
      status: 'transcript-saved',
      updatedAt: '2026-06-09T00:01:00.000Z',
      transcriptRoot: 'jobs/transcripts/job-a',
      handoffPath: 'jobs/transcripts/job-a/handoff.md',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'job-a');
  assert.equal(candidates[0].status, 'started');
  assert.equal(candidates[0].handoffPath, 'jobs/transcripts/job-a/handoff.md');
});

test('interruptedJobCandidatesFromEntries treats worker starts as informational', () => {
  const candidates = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'started',
      createdAt: '2026-06-09T00:00:00.000Z',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
    {
      id: 'job-a',
      status: 'worker-started',
      updatedAt: '2026-06-09T00:01:00.000Z',
      workerPid: 12345,
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'job-a');
  assert.equal(candidates[0].status, 'started');
  assert.equal(candidates[0].workerPid, 12345);
});

test('interruptedJobCandidatesFromEntries treats detached Worker reattachment as informational', () => {
  const [candidate] = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'started',
      createdAt: '2026-07-29T00:00:00.000Z',
      attempt: 2,
    },
    {
      id: 'job-a',
      status: 'detached-worker-reattached',
      recoveredAt: '2026-07-29T00:01:00.000Z',
      detachedWorkerStatus: 'running',
      detachedWorkerPid: 1234,
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidate.status, 'started');
  assert.equal(candidate.attempt, 2);
});

test('interruptedJobCandidatesFromEntries recovers interrupted handoff with missing continuation record', () => {
  const [candidate] = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'started',
      createdAt: '2026-06-09T00:00:00.000Z',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
    {
      id: 'job-a',
      status: 'interrupted-recovered',
      recoveredAt: '2026-06-09T00:01:00.000Z',
      continuationJobId: 'job-a_continue_20260609090100',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidate.id, 'job-a');
  assert.equal(candidate.status, 'interrupted-recovered');
  assert.equal(candidate.repoAccess, true);
  assert.equal(candidate.repoPath, '/tmp/projects/repo-a');
});

test('interruptedJobCandidatesFromEntries does not revive an old root after a terminal continuation', () => {
  const candidates = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'started',
      createdAt: '2026-06-09T00:00:00.000Z',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
    {
      id: 'job-a_continue_20260609090100',
      status: 'done',
      finishedAt: '2026-06-09T00:02:00.000Z',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.deepEqual(candidates, []);
});

test('interruptedJobCandidatesFromEntries backfills metadata from interrupted handoff to continuation', () => {
  const [candidate] = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'interrupted-recovered',
      recoveredAt: '2026-06-09T00:01:00.000Z',
      continuationJobId: 'job-a_continue_20260609090100',
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
    {
      id: 'job-a_continue_20260609090100',
      status: 'queued',
      createdAt: '2026-06-09T00:02:00.000Z',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidate.id, 'job-a_continue_20260609090100');
  assert.equal(candidate.repoAccess, true);
  assert.equal(candidate.repoPath, '/tmp/projects/repo-a');
});

test('interruptedJobCandidatesFromEntries preserves runtime restart metadata after recovery handoff', () => {
  const [candidate] = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'needs-runtime-restart',
      updatedAt: '2026-06-09T00:01:00.000Z',
      runtimeChangedPaths: ['bridge-service.mjs'],
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
    {
      id: 'job-a',
      status: 'interrupted-recovered',
      recoveredAt: '2026-06-09T00:02:00.000Z',
      continuationJobId: 'job-a_continue_20260609090200',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidate.id, 'job-a');
  assert.equal(candidate.status, 'interrupted-recovered');
  assert.deepEqual(candidate.runtimeChangedPaths, ['bridge-service.mjs']);
  assert.equal(isPostSuccessRuntimeRestartRecovery(candidate), true);
});

test('interruptedJobCandidatesFromEntries revives runtime restart jobs mis-superseded by newer thread events', () => {
  const [candidate] = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'needs-runtime-restart',
      updatedAt: '2026-06-09T00:01:00.000Z',
      runtimeChangedPaths: ['bridge-service.mjs'],
      repoAccess: true,
      repoPath: '/tmp/projects/repo-a',
    },
    {
      id: 'job-a',
      status: 'superseded',
      updatedAt: '2026-06-09T00:02:00.000Z',
      finishedAt: '2026-06-09T00:02:00.000Z',
      supersededByJobId: 'status-check',
      error: 'superseded by newer thread event status-check',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.equal(candidate.id, 'job-a');
  assert.equal(candidate.status, 'superseded');
  assert.deepEqual(candidate.runtimeChangedPaths, ['bridge-service.mjs']);
  assert.equal(candidate.supersededByJobId, 'status-check');
});

test('interruptedJobCandidatesFromEntries leaves ordinary superseded jobs terminal', () => {
  const candidates = interruptedJobCandidatesFromEntries([
    {
      id: 'job-a',
      status: 'started',
      updatedAt: '2026-06-09T00:01:00.000Z',
    },
    {
      id: 'job-a',
      status: 'superseded',
      updatedAt: '2026-06-09T00:02:00.000Z',
      finishedAt: '2026-06-09T00:02:00.000Z',
      supersededByJobId: 'new-work',
      error: 'superseded by newer thread event new-work',
    },
  ], { channelId: 'channel-1', threadId: 'thread-1' });

  assert.deepEqual(candidates, []);
});

test('newestThreadEventAfter finds the latest event after the job event', () => {
  const newer = newestThreadEventAfter([
    { id: 'older', timestamp: '2026-06-09T00:00:00.000Z' },
    { id: 'base', timestamp: '2026-06-09T00:01:00.000Z' },
    { id: 'newer-a', timestamp: '2026-06-09T00:02:00.000Z' },
    { id: 'newer-b', timestamp: '2026-06-09T00:03:00.000Z' },
  ], { id: 'base', timestamp: '2026-06-09T00:01:00.000Z' });

  assert.equal(newer.id, 'newer-b');
});

test('newestThreadEventAfter falls back to Discord snowflake ordering', () => {
  const base = { id: '1000000000000000007' };
  const newer = newestThreadEventAfter([
    { id: '1000000000000000007' },
    { id: '1000000000000000008' },
  ], base);

  assert.equal(newer.id, '1000000000000000008');
});

test('newestThreadEventAfter returns null when no newer event exists', () => {
  const newer = newestThreadEventAfter([
    { id: 'older', timestamp: '2026-06-09T00:00:00.000Z' },
    { id: 'base', timestamp: '2026-06-09T00:01:00.000Z' },
  ], { id: 'base', timestamp: '2026-06-09T00:01:00.000Z' });

  assert.equal(newer, null);
});

test('newestSupersedingThreadEventAfter ignores control-only events', () => {
  const newer = newestSupersedingThreadEventAfter([
    { id: 'base', timestamp: '2026-06-09T00:01:00.000Z', content: '작업해줘' },
    { id: 'restart', timestamp: '2026-06-09T00:02:00.000Z', content: '서버 재부팅 해줘' },
    { id: 'yolo', timestamp: '2026-06-09T00:03:00.000Z', content: '/yolo' },
    { id: 'god', timestamp: '2026-06-09T00:04:00.000Z', content: '/god' },
    { id: 'work', timestamp: '2026-06-09T00:05:00.000Z', content: '이제 새 작업해줘' },
  ], { id: 'base', timestamp: '2026-06-09T00:01:00.000Z' }, {
    isControlEvent: (event) => ['서버 재부팅 해줘', '/yolo', '/god'].includes(event.content),
  });

  assert.equal(newer.id, 'work');
});

test('newestSupersedingThreadEventAfter returns null when only newer control events exist', () => {
  const newer = newestSupersedingThreadEventAfter([
    { id: 'base', timestamp: '2026-06-09T00:01:00.000Z', content: '작업해줘' },
    { id: 'restart', timestamp: '2026-06-09T00:02:00.000Z', content: '서버 재부팅 해줘' },
    { id: 'yolo', timestamp: '2026-06-09T00:03:00.000Z', content: '/yolo' },
    { id: 'god', timestamp: '2026-06-09T00:04:00.000Z', content: '/god' },
  ], { id: 'base', timestamp: '2026-06-09T00:01:00.000Z' }, {
    isControlEvent: (event) => ['서버 재부팅 해줘', '/yolo', '/god'].includes(event.content),
  });

  assert.equal(newer, null);
});

test('newestRecoverySupersedingThreadEventAfter keeps runtime restart recovery alive after newer user messages', () => {
  const baseEvent = { id: 'base', timestamp: '2026-06-09T00:01:00.000Z', content: '작업해줘' };
  const newer = newestRecoverySupersedingThreadEventAfter([
    baseEvent,
    { id: 'status-check', timestamp: '2026-06-09T00:02:00.000Z', content: 'continue 안 된 거지?' },
    { id: 'new-work', timestamp: '2026-06-09T00:03:00.000Z', content: '새 작업' },
  ], {
    id: 'job-a',
    status: 'needs-runtime-restart',
    runtimeChangedPaths: ['bridge-service.mjs'],
  }, baseEvent);

  assert.equal(newer, null);
});

test('newestRecoverySupersedingThreadEventAfter preserves earlier work across queued tasks', () => {
  const baseEvent = { id: 'base', timestamp: '2026-08-04T07:07:00.000Z', content: '현재 작업' };
  const queuedEvent = {
    id: 'queued-work',
    timestamp: '2026-08-04T07:08:00.000Z',
    content: '/queue 현재 작업 뒤에 실행',
  };
  const controlEvent = {
    id: 'status-check',
    timestamp: '2026-08-04T07:08:30.000Z',
    content: '/status',
  };
  const job = { id: 'job-a', status: 'started' };
  const options = {
    isControlEvent: (event) => event.content === '/status',
  };

  assert.equal(
    newestRecoverySupersedingThreadEventAfter(
      [baseEvent, queuedEvent, controlEvent],
      job,
      baseEvent,
      options,
    ),
    null,
  );

  const replacementEvent = {
    id: 'replacement',
    timestamp: '2026-08-04T07:09:00.000Z',
    content: '대신 이 작업을 실행',
  };
  assert.equal(
    newestRecoverySupersedingThreadEventAfter(
      [baseEvent, queuedEvent, controlEvent, replacementEvent],
      job,
      baseEvent,
      options,
    )?.id,
    replacementEvent.id,
  );
});

test('newestRecoverySupersedingThreadEventAfter still supersedes unfinished ordinary work', () => {
  const baseEvent = { id: 'base', timestamp: '2026-06-09T00:01:00.000Z', content: '작업해줘' };
  const newer = newestRecoverySupersedingThreadEventAfter([
    baseEvent,
    { id: 'new-work', timestamp: '2026-06-09T00:03:00.000Z', content: '새 작업' },
  ], {
    id: 'job-a',
    status: 'started',
  }, baseEvent);

  assert.equal(newer.id, 'new-work');
});

test('eventForRecoverableJob uses ask answer message as continuation base event', () => {
  const events = [
    { id: 'job-a', timestamp: '2026-06-30T09:59:24.000Z', content: '질문해도 돼?' },
    { id: 'answer-b', timestamp: '2026-06-30T10:10:13.000Z', content: 'staging' },
  ];
  const event = eventForRecoverableJob(events, {
    id: 'job-a_continue_20260630191013',
    pendingAskAnswer: { answerMessageId: 'answer-b' },
  });

  assert.equal(event.id, 'answer-b');
});

test('ask answer continuation is not superseded by its own answer message', () => {
  const events = [
    { id: 'job-a', timestamp: '2026-06-30T09:59:24.000Z', content: '질문해도 돼?' },
    { id: 'answer-b', timestamp: '2026-06-30T10:10:13.000Z', content: 'staging' },
  ];
  const baseEvent = eventForRecoverableJob(events, {
    id: 'job-a_continue_20260630191013',
    pendingAskAnswer: { answerMessageId: 'answer-b' },
  });
  const superseding = newestSupersedingThreadEventAfter(events, baseEvent);

  assert.equal(superseding, null);
});

test('a job enqueued with /queue stays protected from a later superseding message', () => {
  // The queued/running job carries the protection, so the scheduler can no
  // longer drop it for whatever message happens to arrive next (issue #22).
  assert.equal(isQueueProtectedJob({ event: { content: '/queue 리포트 정리해줘' } }), true);
  assert.equal(isQueueProtectedJob({ event: { content: '리포트 정리해줘\n/queue' } }), true);
  assert.equal(isQueueProtectedJob({ event: { content: '리포트 정리해줘' } }), false);
  assert.equal(isQueueProtectedJob({}), false);
  assert.equal(isQueueProtectedJob(), false);
});

test('queued live supersede replaces ordinary jobs but preserves /queue jobs', () => {
  const incomingJob = {
    id: 'new-job',
    event: { id: 'new-job', timestamp: '2026-08-09T02:00:00.000Z', content: 'new work' },
  };
  const ordinaryQueuedJob = {
    id: 'old-job',
    event: { id: 'old-job', timestamp: '2026-08-09T01:00:00.000Z', content: 'old work' },
  };
  const protectedQueuedJob = {
    ...ordinaryQueuedJob,
    event: { ...ordinaryQueuedJob.event, content: '/queue old work' },
  };

  assert.equal(shouldSupersedeLiveJob(incomingJob, ordinaryQueuedJob), true);
  assert.equal(shouldSupersedeLiveJob(incomingJob, protectedQueuedJob), false);
  assert.equal(shouldSupersedeLiveJob(ordinaryQueuedJob, incomingJob), false);
});

test('running live supersede replaces ordinary jobs but preserves /queue jobs', () => {
  const incomingEvent = {
    id: 'new-message',
    timestamp: '2026-08-09T02:00:00.000Z',
    content: 'new work',
  };
  const ordinaryRunningJob = {
    id: 'old-job',
    event: { id: 'old-message', timestamp: '2026-08-09T01:00:00.000Z', content: 'old work' },
  };
  const protectedRunningJob = {
    ...ordinaryRunningJob,
    event: { ...ordinaryRunningJob.event, content: 'old work\n/queue' },
  };

  assert.equal(shouldSupersedeLiveJob(incomingEvent, ordinaryRunningJob), true);
  assert.equal(shouldSupersedeLiveJob(incomingEvent, protectedRunningJob), false);
  assert.equal(shouldSupersedeLiveJob(ordinaryRunningJob.event, {
    id: incomingEvent.id,
    event: incomingEvent,
  }), false);
});

test('rootJobId strips continuation suffixes', () => {
  assert.equal(rootJobId('1000000000000000006_continue_20260604001433'), '1000000000000000006');
  assert.equal(rootJobId('1000000000000000006'), '1000000000000000006');
});
