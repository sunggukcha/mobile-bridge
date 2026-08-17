// Deadlines for the individual steps of a running job.
//
// Aborting a job only *asks* it to unwind: the abort reaches a cooperative
// worker through its AbortSignal. A step awaiting a Worker process that already
// died has nobody left to observe the signal, so it never settles — and because
// the job stays in the `running` map, it keeps both its concurrency slot and its
// `working for N minutes.` heartbeat forever. A superseded job was observed
// still ticking 60 minutes after its abort, with no Worker process alive and no
// state writes at all.
//
// Two independent guarantees fix that class of hang:
//   - abort grace: once aborted, a step gets a fixed window to unwind, then the
//     job is forced to the terminal state its abort reason already implies.
//   - hard timeout: a step that should take milliseconds (local state I/O
//     before dispatch) cannot run past its deadline at all.
//
// Both surface the step's `phase` name, which is the only breadcrumb an
// otherwise silent stall leaves behind.

export const DEFAULT_ABORT_GRACE_MS = 30_000;

export function jobAbortSettlementError(job, phase, graceMs = DEFAULT_ABORT_GRACE_MS) {
  const error = new Error(
    `job step "${phase}" did not unwind within ${graceMs}ms of abort`,
  );
  // Carrying the original abort reason keeps the caller's error routing intact,
  // so a forced settlement reaches the same terminal state (superseded /
  // cancelled) that the cooperative path would have reached.
  error.aborted = true;
  error.abortReason = job?.abortController?.signal?.reason;
  error.jobPhase = phase;
  error.forcedSettlement = true;
  return error;
}

export function jobStepTimeoutError(job, phase, timeoutMs) {
  const error = new Error(`job step "${phase}" exceeded ${timeoutMs}ms`);
  error.jobPhase = phase;
  error.jobStepTimedOut = true;
  error.forcedSettlement = true;
  return error;
}

export async function withJobStepDeadline(job, phase, start, {
  hardTimeoutMs = 0,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  onForcedSettlement = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const execution = start();
  const signal = job?.abortController?.signal || null;
  if (!signal && hardTimeoutMs <= 0) return execution;

  let settled = false;
  const markSettled = () => { settled = true; };
  execution.then(markSettled, markSettled);

  const timers = [];
  let abortListener = null;
  const guard = new Promise((_resolve, reject) => {
    const fail = (error) => {
      // The step may have completed between the timer firing and this call;
      // never override a real outcome with a synthetic failure.
      if (settled) return;
      settled = true;
      onForcedSettlement?.({
        job,
        phase,
        error,
        reason: error.jobStepTimedOut ? 'step-timeout' : 'abort-grace-expired',
      });
      reject(error);
    };
    // Deliberately not unref'd: this timer is the guarantee that the job
    // settles, so it must keep the loop alive until it fires. It is always
    // cleared in the finally below as soon as the step settles on its own.
    const armTimer = (ms, buildError) => {
      timers.push(setTimeoutFn(() => fail(buildError()), ms));
    };
    if (hardTimeoutMs > 0) {
      armTimer(hardTimeoutMs, () => jobStepTimeoutError(job, phase, hardTimeoutMs));
    }
    if (signal) {
      const onAbort = () => armTimer(
        abortGraceMs,
        () => jobAbortSettlementError(job, phase, abortGraceMs),
      );
      if (signal.aborted) onAbort();
      else {
        abortListener = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });

  try {
    return await Promise.race([execution, guard]);
  } finally {
    for (const timer of timers) clearTimeoutFn(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
    // An abandoned step keeps running to its own conclusion; swallow that
    // outcome so it cannot surface as an unhandled rejection after the job has
    // already moved on.
    execution.catch(() => {});
  }
}
