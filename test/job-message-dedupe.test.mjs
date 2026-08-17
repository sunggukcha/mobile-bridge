import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createJobMessageDedupe,
  isTerminalJobOutboundPurpose,
  jobMessageDedupeKey,
  shouldReconcileSuppressedJobFinalToMemory,
  shouldSuppressDuplicateJobOutbound,
  stripTrailingJobCompletionMarkers,
} from '../lib/job-message-dedupe.mjs';

test('only final responses and completion markers terminate recovery', () => {
  assert.equal(isTerminalJobOutboundPurpose('job-final'), true);
  assert.equal(isTerminalJobOutboundPurpose('job-completion-marker'), true);
  assert.equal(isTerminalJobOutboundPurpose('maintenance-git-summary'), false);
  assert.equal(isTerminalJobOutboundPurpose('worker-progress'), false);
});

test('createJobMessageDedupe finds recent duplicates for the same job destination', () => {
  let currentTime = 1_000;
  const dedupe = createJobMessageDedupe({ ttlMs: 10_000, now: () => currentTime });
  const job = { id: 'job-1' };

  dedupe.remember(job, 'checking files', {
    purpose: 'worker-progress',
    destinationChannelId: 'thread-1',
  });

  assert.equal(
    dedupe.duplicateFor(job, ' checking   files ', { destinationChannelId: 'thread-1' })?.purpose,
    'worker-progress',
  );
  assert.equal(dedupe.duplicateFor({ id: 'job-2' }, 'checking files', { destinationChannelId: 'thread-1' }), null);
  assert.equal(dedupe.duplicateFor(job, 'checking files', { destinationChannelId: 'thread-2' }), null);

  currentTime += 10_001;
  assert.equal(dedupe.duplicateFor(job, 'checking files', { destinationChannelId: 'thread-1' }), null);
});

test('createJobMessageDedupe compares inline completion marker messages by body too', () => {
  const dedupe = createJobMessageDedupe();
  const job = { id: 'job-1' };

  dedupe.remember(job, '작업 완료\n\n【(claude: Opus 5) 응답완료】', {
    purpose: 'job-final',
    destinationChannelId: 'thread-1',
  });

  assert.equal(
    dedupe.duplicateFor(job, '작업 완료', { destinationChannelId: 'thread-1' })?.purpose,
    'job-final',
  );
});

test('createJobMessageDedupe strips the effort-bearing completion marker', () => {
  const dedupe = createJobMessageDedupe();
  const job = { id: 'job-1' };

  dedupe.remember(job, '작업 완료\n\n【응답완료: codex gpt-5.6-terra (xhigh)】', {
    purpose: 'job-final',
    destinationChannelId: 'thread-1',
  });

  assert.equal(
    dedupe.duplicateFor(job, '작업 완료', { destinationChannelId: 'thread-1' })?.purpose,
    'job-final',
  );
});

test('createJobMessageDedupe strips the worker marker with effort suffix', () => {
  const dedupe = createJobMessageDedupe();
  const job = { id: 'job-1' };

  dedupe.remember(job, '작업 완료\n\n【(codex: gpt-5.6-terra (xhigh)) 응답완료】', {
    purpose: 'job-final',
    destinationChannelId: 'thread-1',
  });

  assert.equal(
    dedupe.duplicateFor(job, '작업 완료', { destinationChannelId: 'thread-1' })?.purpose,
    'job-final',
  );
});

test('stripTrailingJobCompletionMarkers removes stale terminal markers only', () => {
  assert.equal(
    stripTrailingJobCompletionMarkers([
      '작업 완료',
      '',
      '【(claude: Fable 5) 응답완료】',
      '',
      '【(claude: Fable 5 (xhigh)) 응답완료】',
    ].join('\n')),
    '작업 완료',
  );
  assert.equal(
    stripTrailingJobCompletionMarkers('작업 완료\n\n【응답완료: codex gpt-5.6-terra (xhigh)】'),
    '작업 완료',
  );
  assert.equal(
    stripTrailingJobCompletionMarkers('작업 완료 【(claude: Fable 5) 응답완료】'),
    '작업 완료',
  );
  assert.equal(
    stripTrailingJobCompletionMarkers('문장 중간 【(claude: Fable 5) 응답완료】 유지'),
    '문장 중간 【(claude: Fable 5) 응답완료】 유지',
  );
  assert.equal(
    stripTrailingJobCompletionMarkers('작업 완료\n\n【(codex: gpt-5.6-terra (xhigh) · 작업시간: 1분) 응답완료】'),
    '작업 완료',
  );
});

test('createJobMessageDedupe treats continuation ids as the same root job', () => {
  const dedupe = createJobMessageDedupe();

  dedupe.remember({ id: 'job-1' }, '최종 답변\n\n【(claude: Opus 5) 응답완료】', {
    purpose: 'job-final',
    destinationChannelId: 'thread-1',
    delivery: { delivered: true, messageIds: ['message-1'] },
  });

  const duplicate = dedupe.duplicateFor(
    { id: 'job-1_continue_20260630153000' },
    '최종 답변',
    { destinationChannelId: 'thread-1' },
  );

  assert.equal(duplicate?.purpose, 'job-final');
  assert.equal(duplicate?.delivered, true);
  assert.deepEqual(duplicate?.messageIds, ['message-1']);
});

test('jobMessageDedupeKey is stable across continuation ids', () => {
  const legacyShape = jobMessageDedupeKey(
    { id: 'job-1' },
    'thread-1',
    '완료\n\n【응답완료】',
    { purpose: 'job-final' },
  );
  assert.equal(
    legacyShape,
    jobMessageDedupeKey({ id: 'job-1_continue_20260630153000' }, 'thread-1', '완료', { purpose: 'job-final' }),
  );
  assert.equal(legacyShape, ['job-1', 'thread-1', 'job-final', '완료'].join('\0'));
});

test('attachment-bearing finals do not dedupe against text-only progress', () => {
  const dedupe = createJobMessageDedupe();
  const job = { id: 'job-1' };

  dedupe.remember(job, '이미지를 보냈습니다.', {
    purpose: 'worker-progress',
    destinationChannelId: 'thread-1',
  });

  assert.equal(dedupe.duplicateFor(job, '이미지를 보냈습니다.', {
    destinationChannelId: 'thread-1',
    deliveryFingerprint: 'artifact-sha256',
  }), null);
  assert.notEqual(
    jobMessageDedupeKey(job, 'thread-1', '이미지를 보냈습니다.', { purpose: 'job-final' }),
    jobMessageDedupeKey(job, 'thread-1', '이미지를 보냈습니다.', {
      purpose: 'job-final',
      deliveryFingerprint: 'artifact-sha256',
    }),
  );
});

test('a delivered worker progress body suppresses an identical final post', () => {
  assert.equal(shouldSuppressDuplicateJobOutbound('job-final', {
    purpose: 'worker-progress',
    delivered: true,
    messageIds: ['message-1'],
  }), true);
  assert.equal(shouldSuppressDuplicateJobOutbound('job-final', {
    purpose: 'worker-progress',
    delivered: false,
    queued: false,
  }), false);
  assert.equal(shouldSuppressDuplicateJobOutbound('job-completion-marker', {
    purpose: 'worker-progress',
    delivered: true,
  }), false);
});

test('a suppressed final reconciles the visible worker progress body into final memory', () => {
  const deliveredProgress = {
    purpose: 'worker-progress',
    delivered: true,
    messageIds: ['message-1'],
  };

  assert.equal(shouldReconcileSuppressedJobFinalToMemory('job-final', deliveredProgress), true);
  assert.equal(shouldReconcileSuppressedJobFinalToMemory('job-completion-marker', deliveredProgress), false);
  assert.equal(shouldReconcileSuppressedJobFinalToMemory('job-final', {
    purpose: 'job-final',
    delivered: true,
  }), false);
});
