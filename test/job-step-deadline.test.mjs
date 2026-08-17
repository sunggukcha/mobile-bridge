import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ABORT_GRACE_MS,
  withJobStepDeadline,
} from '../lib/job-step-deadline.mjs';

function createJob(id = 'job-1') {
  return {
    id,
    channelId: 'channel-1',
    threadId: 'thread-1',
    abortController: new AbortController(),
  };
}

const never = () => new Promise(() => {});

test('a step that settles normally is returned untouched', async () => {
  const job = createJob();
  const value = await withJobStepDeadline(job, 'prepare', async () => 'done', {
    hardTimeoutMs: 60_000,
  });
  assert.equal(value, 'done');
});

test('a step that rejects normally keeps its own error', async () => {
  const job = createJob();
  await assert.rejects(
    withJobStepDeadline(job, 'prepare', async () => {
      throw new Error('boom');
    }, { hardTimeoutMs: 60_000 }),
    /boom/,
  );
});

test('a step stuck past its hard timeout fails with the phase name', async () => {
  const job = createJob();
  const forced = [];
  await assert.rejects(
    withJobStepDeadline(job, 'checkpoint-start', never, {
      hardTimeoutMs: 20,
      onForcedSettlement: (entry) => forced.push(entry),
    }),
    (error) => {
      assert.equal(error.jobStepTimedOut, true);
      assert.equal(error.jobPhase, 'checkpoint-start');
      assert.equal(error.forcedSettlement, true);
      assert.match(error.message, /checkpoint-start/);
      return true;
    },
  );
  assert.equal(forced.length, 1);
  assert.equal(forced[0].reason, 'step-timeout');
  assert.equal(forced[0].phase, 'checkpoint-start');
});

test('an aborted step that never unwinds is forced to settle, carrying the abort reason', async () => {
  const job = createJob();
  const forced = [];
  const pending = withJobStepDeadline(job, 'worker-dispatch', never, {
    abortGraceMs: 20,
    onForcedSettlement: (entry) => forced.push(entry),
  });
  job.abortController.abort('superseded-by:9999');

  await assert.rejects(pending, (error) => {
    assert.equal(error.aborted, true);
    // Routing downstream depends on this reason surviving the forced path.
    assert.equal(error.abortReason, 'superseded-by:9999');
    assert.equal(error.jobPhase, 'worker-dispatch');
    assert.equal(error.forcedSettlement, true);
    return true;
  });
  assert.equal(forced.length, 1);
  assert.equal(forced[0].reason, 'abort-grace-expired');
});

test('an abort that arrived before the step started still forces settlement', async () => {
  const job = createJob();
  job.abortController.abort('cancelled-by:4242');
  await assert.rejects(
    withJobStepDeadline(job, 'thread-context', never, { abortGraceMs: 20 }),
    (error) => {
      assert.equal(error.aborted, true);
      assert.equal(error.abortReason, 'cancelled-by:4242');
      return true;
    },
  );
});

test('a step that unwinds cooperatively within the grace window keeps its own error', async () => {
  const job = createJob();
  const forced = [];
  const pending = withJobStepDeadline(job, 'worker-dispatch', () => new Promise((_resolve, reject) => {
    job.abortController.signal.addEventListener('abort', () => {
      const error = new Error('worker aborted cleanly');
      error.aborted = true;
      error.abortReason = job.abortController.signal.reason;
      reject(error);
    }, { once: true });
  }), {
    abortGraceMs: 5_000,
    onForcedSettlement: (entry) => forced.push(entry),
  });
  job.abortController.abort('superseded-by:1');

  await assert.rejects(pending, /worker aborted cleanly/);
  assert.equal(forced.length, 0, 'a cooperative unwind must not be reported as forced');
});

test('a long-running step with no hard timeout is never cut off while un-aborted', async () => {
  const job = createJob();
  let release = null;
  const pending = withJobStepDeadline(job, 'worker-dispatch', () => new Promise((resolve) => {
    release = resolve;
  }), { abortGraceMs: 20 });

  await new Promise((resolve) => { setTimeout(resolve, 60); });
  release('finished after a long run');
  assert.equal(await pending, 'finished after a long run');
});

test('an abandoned step rejecting later does not raise an unhandled rejection', async () => {
  const job = createJob();
  let rejectLate = null;
  const pending = withJobStepDeadline(job, 'prepare', () => new Promise((_resolve, reject) => {
    rejectLate = reject;
  }), { hardTimeoutMs: 20 });

  await assert.rejects(pending, /exceeded 20ms/);
  rejectLate(new Error('late failure nobody is waiting for'));
  // If the abandoned promise were unhandled, this turn of the loop would trip
  // the runner's unhandled-rejection guard.
  await new Promise((resolve) => { setTimeout(resolve, 20); });
});

test('timers are cleared once the step settles', async () => {
  const job = createJob();
  const armed = [];
  const cleared = [];
  await withJobStepDeadline(job, 'prepare', async () => 'ok', {
    hardTimeoutMs: 60_000,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms };
      armed.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => cleared.push(handle),
  });
  assert.equal(armed.length, 1);
  assert.deepEqual(cleared, armed);
});

test('the default abort grace is exported for callers that need it', () => {
  assert.equal(typeof DEFAULT_ABORT_GRACE_MS, 'number');
  assert.ok(DEFAULT_ABORT_GRACE_MS > 0);
});
