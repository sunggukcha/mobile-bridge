import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JobScheduler,
  PRIORITY,
  classifyJob,
  jobConcurrencyKey,
  jobThreadKey,
} from '../lib/scheduler.mjs';

test('classifyJob follows bridge priority rules', () => {
  assert.equal(classifyJob({ systemMaintenance: true }), PRIORITY.SYSTEM_MAINTENANCE);
  assert.equal(classifyJob({ threadId: 't1' }), PRIORITY.ACTIVE_THREAD_FOLLOW_UP);
  assert.equal(classifyJob({}), PRIORITY.NORMAL_TOP_LEVEL_JOB);
  assert.equal(classifyJob({ background: true, threadId: 't1' }), PRIORITY.BACKGROUND);
});

test('scheduler serves higher priority jobs first', () => {
  const scheduler = new JobScheduler();
  scheduler.enqueue({ id: 'normal', channelId: 'c1' });
  scheduler.enqueue({ id: 'background', channelId: 'c1', background: true });
  scheduler.enqueue({ id: 'maintenance', channelId: 'system', systemMaintenance: true });

  assert.equal(scheduler.next().id, 'maintenance');
  assert.equal(scheduler.next().id, 'normal');
  assert.equal(scheduler.next().id, 'background');
});

test('scheduler round-robins channels within the same priority', () => {
  const scheduler = new JobScheduler();
  scheduler.enqueue({ id: 'a1', channelId: 'a' });
  scheduler.enqueue({ id: 'a2', channelId: 'a' });
  scheduler.enqueue({ id: 'b1', channelId: 'b' });

  assert.equal(scheduler.next().id, 'a1');
  assert.equal(scheduler.next().id, 'b1');
  assert.equal(scheduler.next().id, 'a2');
});

test('background jobs wait when active work is already high', () => {
  const scheduler = new JobScheduler();
  scheduler.enqueue({ id: 'bg', channelId: 'c1', background: true });

  assert.equal(scheduler.next({ runningCount: 4, backgroundStartOnlyBelowRunning: 4 }), null);
  assert.equal(scheduler.next({ runningCount: 3, backgroundStartOnlyBelowRunning: 4 }).id, 'bg');
});

test('scheduler skips jobs whose thread is already running', () => {
  const scheduler = new JobScheduler();
  const runningJob = { id: 'running', channelId: 'c1', threadId: 't1' };
  scheduler.enqueue({ id: 'same-thread', channelId: 'c1', threadId: 't1' });
  scheduler.enqueue({ id: 'other-thread', channelId: 'c1', threadId: 't2' });

  const next = scheduler.next({ blockedThreadKeys: new Set([jobThreadKey(runningJob)]) });
  assert.equal(next.id, 'other-thread');

  assert.equal(
    scheduler.next({ blockedThreadKeys: new Set([jobThreadKey(runningJob)]) }),
    null,
  );
  assert.equal(scheduler.next().id, 'same-thread');
});

test('scheduler allows different threads in the same channel to run concurrently', () => {
  const scheduler = new JobScheduler();
  const running = [{ id: 'running', channelId: 'c1', threadId: 't1' }];
  scheduler.enqueue({ id: 'same-thread', channelId: 'c1', threadId: 't1' });
  scheduler.enqueue({ id: 'thread-2', channelId: 'c1', threadId: 't2' });
  scheduler.enqueue({ id: 'thread-3', channelId: 'c1', threadId: 't3' });

  const blockedThreadKeys = new Set(running.map(jobThreadKey));
  const next = scheduler.next({ runningCount: running.length, blockedThreadKeys });
  assert.equal(next.id, 'thread-2');
  running.push(next);
  blockedThreadKeys.add(jobThreadKey(next));

  const nextAgain = scheduler.next({ runningCount: running.length, blockedThreadKeys });
  assert.equal(nextAgain.id, 'thread-3');
  running.push(nextAgain);
  blockedThreadKeys.add(jobThreadKey(nextAgain));

  assert.equal(scheduler.next({ runningCount: running.length, blockedThreadKeys }), null);
});

test('scheduler serializes different maintenance threads with one explicit concurrency key', () => {
  const scheduler = new JobScheduler();
  scheduler.enqueue({
    id: 'issue-1',
    channelId: 'c1',
    threadId: 'issue-thread-1',
    concurrencyKey: 'maintenance-run-1',
  });
  scheduler.enqueue({
    id: 'issue-2',
    channelId: 'c1',
    threadId: 'issue-thread-2',
    concurrencyKey: 'maintenance-run-1',
  });
  scheduler.enqueue({
    id: 'normal',
    channelId: 'c1',
    threadId: 'normal-thread',
  });

  const first = scheduler.next();
  assert.equal(first.id, 'issue-1');
  const blocked = new Set([jobConcurrencyKey(first)]);
  assert.equal(scheduler.next({ blockedThreadKeys: blocked }).id, 'normal');
  assert.equal(scheduler.next({ blockedThreadKeys: blocked }), null);
  assert.equal(scheduler.next().id, 'issue-2');
});

test('scheduler removes queued jobs for a superseded thread only', () => {
  const scheduler = new JobScheduler();
  scheduler.enqueue({ id: 'old-thread-job', channelId: 'c1', threadId: 't1' });
  scheduler.enqueue({ id: 'other-thread-job', channelId: 'c1', threadId: 't2' });
  scheduler.enqueue({ id: 'background-old-thread-job', channelId: 'c1', threadId: 't1', background: true });

  const removed = scheduler.removeQueuedThreadJobs(jobThreadKey({ channelId: 'c1', threadId: 't1' }));

  assert.deepEqual(removed.map((job) => job.id), [
    'old-thread-job',
    'background-old-thread-job',
  ]);
  assert.equal(scheduler.size(), 1);
  assert.equal(scheduler.next().id, 'other-thread-job');
  assert.equal(scheduler.next(), null);
});

test('scheduler can inspect and selectively supersede queued thread jobs', () => {
  const scheduler = new JobScheduler();
  scheduler.enqueue({ id: 'older', channelId: 'c1', threadId: 't1', sequence: 1 });
  scheduler.enqueue({ id: 'newer', channelId: 'c1', threadId: 't1', sequence: 3 });
  scheduler.enqueue({ id: 'other-thread', channelId: 'c1', threadId: 't2', sequence: 0 });

  assert.deepEqual(
    scheduler.queuedThreadJobs(jobThreadKey({ channelId: 'c1', threadId: 't1' })).map((job) => job.id),
    ['older', 'newer'],
  );
  assert.deepEqual(scheduler.queuedJobs().map((job) => job.id), ['older', 'newer', 'other-thread']);

  const removed = scheduler.removeQueuedThreadJobs(
    jobThreadKey({ channelId: 'c1', threadId: 't1' }),
    { predicate: (job) => job.sequence < 2 },
  );

  assert.deepEqual(removed.map((job) => job.id), ['older']);
  assert.deepEqual(
    scheduler.queuedThreadJobs(jobThreadKey({ channelId: 'c1', threadId: 't1' })).map((job) => job.id),
    ['newer'],
  );
  assert.equal(scheduler.size(), 2);
});

test('jobThreadKey is scoped by channel and thread', () => {
  assert.equal(jobThreadKey({ channelId: 'c1', threadId: 't1' }), 'c1:t1');
  assert.equal(jobThreadKey({ channelId: 'c1' }), 'c1:c1');
  assert.equal(jobConcurrencyKey({ channelId: 'c1', threadId: 't1' }), 'c1:t1');
  assert.equal(
    jobConcurrencyKey({ channelId: 'c1', threadId: 't1', concurrencyKey: 'maintenance-1' }),
    'maintenance-1',
  );
});
