import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatJobCompletionSummary,
  formatJobDuration,
  shouldPostStandaloneCompletionMarker,
} from '../lib/job-completion.mjs';

test('formatJobCompletionSummary reports elapsed time from the first worker start', () => {
  const text = formatJobCompletionSummary('【응답완료】', {
    workerTranscripts: [
      { startedAt: '2026-07-20T08:00:00.000Z' },
      { startedAt: '2026-07-20T08:01:00.000Z' },
    ],
  }, { finishedAt: '2026-07-20T09:02:03.000Z' });

  assert.equal(text, '【작업시간: 1시간 2분 3초 응답완료】');
});

test('formatJobCompletionSummary puts elapsed time beside the worker', () => {
  const text = formatJobCompletionSummary('【(codex: gpt-5.6-terra (xhigh)) 응답완료】', {
    workerTranscripts: [{ startedAt: '2026-07-20T08:00:00.000Z' }],
  }, { finishedAt: '2026-07-20T08:01:00.000Z' });

  assert.equal(text, '【(codex: gpt-5.6-terra (xhigh) · 작업시간: 1분) 응답완료】');
});

test('formatJobCompletionSummary carries worker time across interrupted continuations', () => {
  const text = formatJobCompletionSummary('【(codex: gpt-5.6-sol (max)) 응답완료】', {
    workerTranscripts: [{ startedAt: '2026-07-20T08:00:00.000Z' }],
  }, {
    finishedAt: '2026-07-20T08:01:15.000Z',
    previousDurationMs: 2 * 60_000 + 30_000,
  });

  assert.equal(text, '【(codex: gpt-5.6-sol (max) · 작업시간: 3분 45초) 응답완료】');
});

test('formatJobDuration formats short and minute-scale durations', () => {
  assert.equal(formatJobDuration(999), '1초 미만');
  assert.equal(formatJobDuration(125_000), '2분 5초');
});

test('inline completion falls back to a standalone marker when progress dedupes the final body', () => {
  const progressDuplicate = {
    delivered: true,
    skipped: true,
    duplicate: true,
    duplicatePurpose: 'worker-progress',
    messageIds: ['message-1'],
  };

  assert.equal(shouldPostStandaloneCompletionMarker('inline', progressDuplicate), true);
  assert.equal(shouldPostStandaloneCompletionMarker('inline', { delivered: true }), false);
  assert.equal(shouldPostStandaloneCompletionMarker('separate', { delivered: true }), true);
  assert.equal(shouldPostStandaloneCompletionMarker('off', progressDuplicate), false);
});
