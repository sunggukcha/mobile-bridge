import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JsonState } from '../lib/state.mjs';
import {
  observeSourceEventHighWatermark,
  SOURCE_EVENT_HIGH_WATERMARK_FILE,
} from '../lib/source-event-high-watermark.mjs';
import {
  isCancelCommandRequest,
  isControlOnlyCommandRequest,
} from '../lib/bridge-commands.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const newerTaskEvent = {
  id: 'slack-C0000000001-1700000400-000004',
  timestamp: '2026-07-28T08:19:28.602Z',
  content: 'GitHub issue #3를 생성해라',
  source: 'slack',
  platform: 'slack',
  sourceEventId: 'Ev000000001',
  sourceMessageId: '1700000400.000004',
};

const olderDelayedEvent = {
  id: 'slack-C0000000001-1700000300-000003',
  timestamp: '2026-07-28T08:16:48.174Z',
  content: '버그를 GitHub issue로 남겨라',
  source: 'slack',
  platform: 'slack',
  sourceEventId: 'Ev000000002',
  sourceMessageId: '1700000300.000003',
};

function ignoredEvent(event = {}) {
  return event.source === 'bridge-agent'
    || (isControlOnlyCommandRequest(event.content) && !isCancelCommandRequest(event.content));
}

async function tempState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-event-high-watermark-'));
  return new JsonState(root);
}

test('a newer task makes a delayed older Slack event terminally supersede itself before worker start', async () => {
  const state = await tempState();
  await state.appendJsonl('memory/events.jsonl.archive', newerTaskEvent);
  await state.appendJsonl('memory/events.jsonl', {
    id: '1700000500.000005',
    timestamp: '2026-07-28T08:21:38.666Z',
    source: 'bridge-agent',
    content: 'Issue #3 created',
  });

  const newer = await observeSourceEventHighWatermark({
    state,
    event: olderDelayedEvent,
    isIgnoredEvent: ignoredEvent,
  });
  const lifecycle = [{ id: olderDelayedEvent.id, status: 'queued' }];
  let workerStarts = 0;
  if (newer) {
    lifecycle.push({
      id: olderDelayedEvent.id,
      status: 'superseded',
      supersededByJobId: newer.id,
    });
  } else {
    workerStarts += 1;
  }

  assert.equal(newer.id, newerTaskEvent.id);
  assert.deepEqual(lifecycle.map((entry) => entry.status), ['queued', 'superseded']);
  assert.equal(lifecycle[1].supersededByJobId, newerTaskEvent.id);
  assert.equal(workerStarts, 0);
  assert.deepEqual(
    await state.readJson(SOURCE_EVENT_HIGH_WATERMARK_FILE),
    {
      id: newerTaskEvent.id,
      timestamp: newerTaskEvent.timestamp,
      source: 'slack',
      platform: 'slack',
      sourceEventId: 'Ev000000001',
      sourceMessageId: '1700000400.000004',
    },
  );
});

test('new task events advance the durable high-water mark and duplicate delivery stays current', async () => {
  const state = await tempState();

  assert.equal(await observeSourceEventHighWatermark({
    state,
    event: newerTaskEvent,
    isIgnoredEvent: ignoredEvent,
  }), null);
  assert.equal(await observeSourceEventHighWatermark({
    state,
    event: { ...newerTaskEvent },
    isIgnoredEvent: ignoredEvent,
  }), null);

  const newest = {
    ...newerTaskEvent,
    id: 'slack-C0000000001-1700000600-000006',
    timestamp: '2026-07-28T08:23:24.685Z',
    sourceEventId: 'Ev000000003',
    sourceMessageId: '1700000600.000006',
  };
  assert.equal(await observeSourceEventHighWatermark({
    state,
    event: newest,
    isIgnoredEvent: ignoredEvent,
  }), null);
  assert.equal(
    (await state.readJson(SOURCE_EVENT_HIGH_WATERMARK_FILE)).id,
    newest.id,
  );
});

test('a queued task still advances the high-water mark against delayed older work', async () => {
  const state = await tempState();
  const queuedTask = {
    ...newerTaskEvent,
    id: 'queued-task',
    timestamp: '2026-07-28T08:30:00.000Z',
    content: '/queue Run this after the current task',
  };

  assert.equal(await observeSourceEventHighWatermark({
    state,
    event: queuedTask,
    isIgnoredEvent: ignoredEvent,
  }), null);
  const newer = await observeSourceEventHighWatermark({
    state,
    event: olderDelayedEvent,
    isIgnoredEvent: ignoredEvent,
  });

  assert.equal(newer.id, queuedTask.id);
});

test('control-only and bridge-generated events do not advance the supersede high-water mark', async () => {
  const state = await tempState();
  await observeSourceEventHighWatermark({
    state,
    event: newerTaskEvent,
    isIgnoredEvent: ignoredEvent,
  });

  for (const event of [
    {
      id: 'slack-control',
      timestamp: '2026-07-28T08:25:00.000Z',
      content: '/model sol',
      source: 'slack',
    },
    {
      id: 'bridge-final',
      timestamp: '2026-07-28T08:26:00.000Z',
      content: 'done',
      source: 'bridge-agent',
    },
  ]) {
    assert.equal(await observeSourceEventHighWatermark({
      state,
      event,
      isIgnoredEvent: ignoredEvent,
    }), null);
  }

  assert.equal(
    (await state.readJson(SOURCE_EVENT_HIGH_WATERMARK_FILE)).id,
    newerTaskEvent.id,
  );
});

test('a cancel command advances the high-water mark so delayed older work stays stopped', async () => {
  const state = await tempState();
  const cancelEvent = {
    ...newerTaskEvent,
    id: 'cancel-event',
    timestamp: '2026-07-28T08:30:00.000Z',
    content: '/cancel',
  };

  assert.equal(await observeSourceEventHighWatermark({
    state,
    event: cancelEvent,
    isIgnoredEvent: ignoredEvent,
  }), null);
  const newer = await observeSourceEventHighWatermark({
    state,
    event: olderDelayedEvent,
    isIgnoredEvent: ignoredEvent,
  });

  assert.equal(newer.id, cancelEvent.id);
});

test('bridge admission rejects the persisted high-water event before scheduler startup', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const dispatchStart = source.indexOf('async function recordAndDispatchEvent(');
  const dispatchEnd = source.indexOf('\nasync function scheduleThreadCreationRetry(', dispatchStart);
  const dispatchSource = source.slice(dispatchStart, dispatchEnd);
  const enqueueStart = source.indexOf('function enqueueCodexJob(');
  const enqueueEnd = source.indexOf('\nfunction appendQueuedJobState(', enqueueStart);
  const enqueueSource = source.slice(enqueueStart, enqueueEnd);
  const admissionStart = source.indexOf('function newestAcceptedThreadJobAfter(');
  const admissionEnd = source.indexOf('\nfunction isJobEventNewerThan(', admissionStart);
  const admissionSource = source.slice(admissionStart, admissionEnd);

  assert.match(
    dispatchSource,
    /persistedNewerThreadEvent\s*=\s*await observeSourceEventHighWatermark/,
  );
  assert.match(
    dispatchSource,
    /const queueWithoutInterrupt\s*=\s*isQueueCommandRequest\(message\.content\);[\s\S]*supersedeQueuedThreadJobs:\s*!queueWithoutInterrupt/,
  );
  assert.match(
    dispatchSource,
    /if \(isCancelCommandRequest\(message\.content\)\) \{\s*await handleCancelCommandRequest\(event\);\s*return;/,
  );
  assert.match(
    dispatchSource,
    /maybeHandleJobStartCommands\([\s\S]*persistedNewerThreadEvent/,
  );
  const jobStartStart = source.indexOf('async function maybeHandleJobStartCommands(');
  const jobStartEnd = source.indexOf('\nfunction applyJobStartAccessCommands(', jobStartStart);
  const jobStartSource = source.slice(jobStartStart, jobStartEnd);
  assert.match(
    jobStartSource,
    /const queueWithoutInterrupt\s*=\s*isQueueCommandRequest\(event\.content\);[\s\S]*supersedeQueuedThreadJobs:\s*!queueWithoutInterrupt/,
  );
  const emptyTaskStart = jobStartSource.indexOf('if (!taskContent) {');
  const jobEventStart = jobStartSource.indexOf('  const jobEvent = {', emptyTaskStart);
  const emptyTaskSource = jobStartSource.slice(emptyTaskStart, jobEventStart);
  assert.ok(emptyTaskStart >= 0 && jobEventStart > emptyTaskStart);
  assert.doesNotMatch(emptyTaskSource, /queueWithoutInterrupt|abortSupersededRunningThreadJobs/);
  assert.match(
    source,
    /async function handleCancelCommandRequest\(event\) \{[\s\S]*cancelQueuedThreadJobs\(event\)[\s\S]*cancelRunningThreadJobs\(event\)/,
  );
  assert.match(
    enqueueSource,
    /if \(options\.supersedeQueuedThreadJobs\) \{\s*const newerJob\s*=\s*newestAcceptedThreadJobAfter\(job, options\.persistedNewerThreadEvent\);[\s\S]*if \(newerJob\) \{\s*markQueuedJobSuperseded\(job, newerJob\.id\);\s*return false;\s*\}/,
  );
  assert.match(
    admissionSource,
    /queuedThreadJobs\(threadKey\)[\s\S]*running\.values\(\)[\s\S]*persistedNewerThreadEvent\?\.id/,
  );
  assert.ok(
    enqueueSource.indexOf('markQueuedJobSuperseded(job, newerJob.id)')
      < enqueueSource.indexOf('scheduler.enqueue(job)'),
  );
});
