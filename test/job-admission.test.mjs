import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isActionableJobEvent,
  shouldPostSupersededNotice,
} from '../lib/job-admission.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('isActionableJobEvent rejects body-empty events with no request context', () => {
  for (const event of [
    {},
    { content: '' },
    { content: ' \n\t ', attachments: [], embeds: [] },
    {
      content: '',
      attachments: [],
      embeds: [],
      forwardedMessages: [],
      message_snapshots: [],
      referencedMessage: null,
      referenced_message: {},
    },
  ]) {
    assert.equal(isActionableJobEvent(event), false);
  }
});

test('isActionableJobEvent preserves every supported request-bearing context', () => {
  for (const event of [
    { content: '/status' },
    { content: '', attachments: [{ id: 'a1' }] },
    { content: '', embeds: [{ description: 'preview' }] },
    { content: '', forwardedMessages: [{ content: 'forwarded task' }] },
    { content: '', message_snapshots: [{ message: { content: 'forwarded task' } }] },
    { content: '', referencedMessage: { id: 'original-message' } },
    { content: '', referenced_message: { message_id: 'original-message' } },
    { content: '', message_reference: { message_id: 'original-message' } },
    { content: '', resumeContext: { jobId: 'job-1' } },
    { content: '', pendingAskAnswer: { jobId: 'job-1' } },
    { content: '', recoveredFromJobId: 'job-1' },
    { content: '', continuationJobId: 'job-1_continue_1' },
  ]) {
    assert.equal(isActionableJobEvent(event), true, JSON.stringify(event));
  }
});

test('shouldPostSupersededNotice suppresses an unstarted invisible job', () => {
  assert.equal(shouldPostSupersededNotice({
    jobId: 'job-1',
    jobRecords: [
      { id: 'job-1', status: 'queued' },
      { id: 'job-1', status: 'started' },
      { id: 'job-1', status: 'superseding' },
    ],
    outboundEvents: [],
  }), false);
});

test('shouldPostSupersededNotice preserves worker-started and visible jobs', () => {
  const cases = [
    { workerStarted: true },
    { visibleDelivery: true },
    { jobRecords: [{ id: 'job-1', status: 'worker-started', delivered: false }] },
    { jobRecords: [{ id: 'job-1', status: 'progress-update', delivered: true }] },
    { jobRecords: [{ id: 'job-1', status: 'progress-update', messageIds: ['m1'] }] },
    { outboundEvents: [{ id: 'discord-message-1', jobId: 'job-1', delivered: true }] },
    { outboundEvents: [{ id: 'discord-message-2', jobId: 'job-1_continue_20260809000000', messageIds: ['m1'] }] },
  ];
  for (const evidence of cases) {
    assert.equal(shouldPostSupersededNotice({
      jobId: 'job-1_continue_20260809120000',
      jobRecords: [],
      outboundEvents: [],
      ...evidence,
    }), true, JSON.stringify(evidence));
  }
  assert.equal(shouldPostSupersededNotice({
    jobId: 'job-1',
    jobRecords: [{ id: 'job-2', status: 'worker-started', delivered: true }],
    outboundEvents: [{ jobId: 'job-2', delivered: true }],
  }), false);
});

test('bridge admission and supersede guards run before the unsafe operations', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');

  const handleStart = source.indexOf('async function handleMessage(');
  const handleEnd = source.indexOf('\n// Gateway payloads can arrive', handleStart);
  const handleSource = source.slice(handleStart, handleEnd);
  assert.ok(handleSource.indexOf('message = await hydrateForwardedMessage(message);') >= 0);
  assert.ok(
    handleSource.indexOf('if (!isActionableJobEvent(message))')
      < handleSource.indexOf('const acknowledgement = await acknowledgeMessage'),
  );

  const dispatchStart = source.indexOf('async function recordAndDispatchEvent(');
  const dispatchEnd = source.indexOf('\nasync function scheduleThreadCreationRetry(', dispatchStart);
  const dispatchSource = source.slice(dispatchStart, dispatchEnd);
  assert.ok(
    dispatchSource.indexOf('if (!isActionableJobEvent(event))')
      < dispatchSource.indexOf('observeSourceEventHighWatermark'),
  );
  assert.ok(
    dispatchSource.indexOf('if (!isActionableJobEvent(event))')
      < dispatchSource.indexOf("appendJsonl('memory/events.jsonl'"),
  );
  assert.ok(
    dispatchSource.indexOf('if (!isActionableJobEvent(event))')
      < dispatchSource.indexOf('enqueueCodexJob(event'),
  );

  const enqueueStart = source.indexOf('function enqueueCodexJob(');
  const enqueueEnd = source.indexOf('\nfunction appendQueuedJobState(', enqueueStart);
  const enqueueSource = source.slice(enqueueStart, enqueueEnd);
  assert.ok(
    enqueueSource.indexOf('if (!isActionableJobEvent({')
      < enqueueSource.indexOf('appendQueuedJobState(job)'),
  );
  assert.ok(
    enqueueSource.indexOf('if (!isActionableJobEvent({')
      < enqueueSource.indexOf('scheduler.enqueue(job)'),
  );

  const supersedeStart = source.indexOf('async function markJobSuperseded(');
  const supersedeEnd = source.indexOf('\nfunction isSupersededJobError(', supersedeStart);
  const supersedeSource = source.slice(supersedeStart, supersedeEnd);
  assert.match(supersedeSource, /if \(await supersededJobNeedsStopNotice\(job\)\)/);
  assert.match(supersedeSource, /job-superseded-notice-suppressed/);
  assert.match(supersedeSource, /state\.readJsonl\('jobs\/jobs\.jsonl'/);
  assert.match(supersedeSource, /state\.readJsonl\('memory\/events\.jsonl'/);
});
