import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_THREAD_CREATE_ATTEMPTS,
  exceededThreadCreateAttempts,
  isNonRetryableJobError,
  isNonRetryableThreadCreateError,
  isOperatorTerminatedError,
  isRecoverableJobStatus,
  retryDelayMs,
  retryDelayMsForError,
  shouldNotifyRetry,
  shouldRecoverJobInterruptedByServiceShutdown,
  workerRetryAtMs,
} from '../lib/retry-policy.mjs';

test('retryDelayMs backs off and caps retry delay', () => {
  assert.equal(retryDelayMs(1, { baseDelayMs: 100, maxDelayMs: 1000 }), 100);
  assert.equal(retryDelayMs(4, { baseDelayMs: 100, maxDelayMs: 1000 }), 800);
  assert.equal(retryDelayMs(20, { baseDelayMs: 100, maxDelayMs: 1000 }), 1000);
});

test('retryDelayMsForError sleeps until a stated Claude session reset', () => {
  const nowMs = Date.parse('2026-07-20T14:25:42.000Z'); // 23:25:42 KST
  const delayMs = retryDelayMsForError(
    new Error("You've hit your session limit · resets 3:10am (Asia/Seoul) code=1"),
    1,
    { nowMs },
  );
  assert.equal(new Date(nowMs + delayMs).toISOString(), '2026-07-20T18:10:05.000Z');
});

test('retryDelayMsForError handles a same-day pm reset and falls back for unknown text', () => {
  const nowMs = Date.parse('2026-07-20T02:17:00.000Z'); // 11:17 KST
  const resetDelayMs = retryDelayMsForError(
    { stderr: "You've hit your session limit · resets 2:40pm (Asia/Seoul) code=1" },
    2,
    { nowMs },
  );
  assert.equal(new Date(nowMs + resetDelayMs).toISOString(), '2026-07-20T05:40:05.000Z');
  assert.equal(retryDelayMsForError(new Error('temporary timeout'), 2, {
    nowMs,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
  }), 200);
  assert.equal(retryDelayMsForError(new Error('session limit resets 3:10am (invalid/timezone)'), 2, {
    nowMs,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
  }), 200);
});

test('worker retry timing honors Retry-After durations and durable cooldown metadata', () => {
  const nowMs = Date.parse('2026-07-29T02:00:00.000Z');
  const retryAtMs = workerRetryAtMs(
    new Error("You've hit your limit; retry after 2 hours"),
    { nowMs },
  );
  assert.equal(new Date(retryAtMs).toISOString(), '2026-07-29T04:00:00.000Z');
  assert.equal(
    new Date(workerRetryAtMs(
      { stderr: "You've hit your limit · resets 3:10pm (Asia/Seoul)" },
      { nowMs },
    )).toISOString(),
    '2026-07-29T06:10:00.000Z',
  );
  assert.equal(
    workerRetryAtMs({ retryAfter: 90 }, { nowMs }),
    nowMs + 90_000,
  );
  assert.equal(
    new Date(nowMs + retryDelayMsForError(
      { workerAvailabilityRetryAtMs: retryAtMs },
      1,
      { nowMs },
    )).toISOString(),
    '2026-07-29T04:00:05.000Z',
  );
});

test('shouldNotifyRetry avoids spamming identical failure messages', () => {
  assert.equal(shouldNotifyRetry(1), true);
  assert.equal(shouldNotifyRetry(2), false);
  assert.equal(shouldNotifyRetry(3), true);
  assert.equal(shouldNotifyRetry(10), true);
});

test('isRecoverableJobStatus recovers pending work statuses only', () => {
  assert.equal(isRecoverableJobStatus('queued'), true);
  assert.equal(isRecoverableJobStatus('started'), true);
  assert.equal(isRecoverableJobStatus('retry-scheduled'), true);
  assert.equal(isRecoverableJobStatus('thread-lock-waiting'), true);
  assert.equal(isRecoverableJobStatus('needs-runtime-restart'), true);
  assert.equal(isRecoverableJobStatus('global-lock-waiting'), false);
  assert.equal(isRecoverableJobStatus('failed'), false);
  assert.equal(isRecoverableJobStatus('done'), false);
});

test('isOperatorTerminatedError detects operator-level worker termination only', () => {
  assert.equal(isOperatorTerminatedError({ signal: 'SIGTERM' }), true);
  // Bare SIGKILL is ambiguous (kernel OOM killer) — treated as a runtime
  // failure so the job retries instead of being silently abandoned.
  assert.equal(isOperatorTerminatedError({ signal: 'SIGKILL' }), false);
  assert.equal(isOperatorTerminatedError({ signal: 'SIGKILL', aborted: true }), true);
  assert.equal(isOperatorTerminatedError({ aborted: true }), true);
  assert.equal(isOperatorTerminatedError({ signal: 'SIGTERM', timedOut: true }), false);
  assert.equal(isOperatorTerminatedError({ signal: 'SIGTERM', noProgressKilled: true }), false);
  assert.equal(isOperatorTerminatedError({ code: 1 }), false);
  assert.equal(isOperatorTerminatedError(null), false);
});

test('shouldRecoverJobInterruptedByServiceShutdown treats shutdown as authoritative', () => {
  assert.equal(shouldRecoverJobInterruptedByServiceShutdown({ signal: 'SIGTERM' }, true), true);
  assert.equal(shouldRecoverJobInterruptedByServiceShutdown({ signal: 'SIGKILL' }, true), true);
  assert.equal(shouldRecoverJobInterruptedByServiceShutdown({ signal: 'SIGTERM' }, false), false);
  assert.equal(shouldRecoverJobInterruptedByServiceShutdown({ signal: 'SIGTERM', noProgressKilled: true }, true), true);
  // Workers can trap SIGTERM and turn a restart into an ordinary-looking exit.
  assert.equal(shouldRecoverJobInterruptedByServiceShutdown({ code: 1 }, true), true);
});

test('isNonRetryableJobError flags permanent Claude Code subscription access failures', () => {
  assert.equal(isNonRetryableJobError({
    stderr: 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
  }), true);
  assert.equal(isNonRetryableJobError({
    message: 'disabled Claude subscription access; ask your admin to enable access',
  }), true);
  assert.equal(isNonRetryableJobError({ nonRetryable: true }), true);
  assert.equal(isNonRetryableJobError(new Error('insufficient credits')), false);
  assert.equal(isNonRetryableJobError(new Error('rate limited: 429')), false);
  assert.equal(isNonRetryableJobError(null), false);
});

test('isNonRetryableJobError flags retired Gemini Code Assist free-tier clients', () => {
  assert.equal(isNonRetryableJobError({
    stderr: 'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. reasonCode=UNSUPPORTED_CLIENT tierId=free-tier',
  }), true);
  assert.equal(isNonRetryableJobError({
    message: 'Gemini Code Assist failed: UNSUPPORTED_CLIENT',
  }), true);
});

test('isNonRetryableThreadCreateError flags permanent Discord thread-create rejections', () => {
  // The exact error the bridge logged in a loop (code 50068 "Invalid message type").
  const invalidType = new Error(
    'Discord API POST /channels/1/messages/2/threads failed: 400 {"message": "Invalid message type", "code": 50068}',
  );
  invalidType.status = 400;
  assert.equal(isNonRetryableThreadCreateError(invalidType), true);
  // Code match alone is enough even without the phrase.
  assert.equal(isNonRetryableThreadCreateError({ message: 'failed: 400 {"code":50068}' }), true);
  // Transient / unrelated failures stay retryable.
  assert.equal(isNonRetryableThreadCreateError(new Error('failed: 500 internal server error')), false);
  assert.equal(isNonRetryableThreadCreateError(new Error('failed: 429 rate limited')), false);
  assert.equal(isNonRetryableThreadCreateError(new Error('fetch failed')), false);
  assert.equal(isNonRetryableThreadCreateError({}), false);
  assert.equal(isNonRetryableThreadCreateError(null), false);
});

test('exceededThreadCreateAttempts caps retries as a defense-in-depth net', () => {
  assert.equal(exceededThreadCreateAttempts(1), false);
  assert.equal(exceededThreadCreateAttempts(MAX_THREAD_CREATE_ATTEMPTS), false);
  assert.equal(exceededThreadCreateAttempts(MAX_THREAD_CREATE_ATTEMPTS + 1), true);
  assert.equal(exceededThreadCreateAttempts(3, 2), true);
  assert.equal(exceededThreadCreateAttempts('not-a-number'), false);
});
