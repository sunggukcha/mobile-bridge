export const PENDING_RESTART_STATE = 'pending-restart.json';
export const DEFERRED_RESTART_STATE = 'deferred-restart.json';

// Owns the service-restart state machine (request → defer-until-idle → perform),
// extracted from bridge-service.mjs so the re-entrance guard, the deferred
// window, and its crash persistence are behaviorally testable without a live
// Discord gateway. All side effects arrive through hooks.
export function createRestartCoordinator({
  runningJobs,          // () => Iterable<{id, channelId, threadId}>
  isShuttingDown = () => false, // graceful stop initiated outside the coordinator
  formatNotice,         // (request) => string
  postNotice,           // async (request, content) => {delivered, queued, messageIds, outboxId}
  logEvent,             // async (type, payload)
  writeState,           // async (name, value)
  readState,            // async (name) => value | null
  removeState,          // async (name)
  freezeSchedulers = () => {},  // stop git polls + reserved-command timers for the deferred window
  prepareShutdown = () => {},   // synchronous: mark service shutting down, stop heartbeat/timers
  terminateChildren = async () => null,
  exit,                 // (code) => never
  restartExitCode,
}) {
  let deferred = null;
  let inProgress = false;

  function runningJobsBlockingRestart(allowRunningJobIds = []) {
    const allowed = new Set((allowRunningJobIds || []).map((id) => String(id)));
    return [...runningJobs()]
      .filter((job) => !allowed.has(String(job.id)))
      .map((job) => ({
        id: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
      }));
  }

  async function request({
    reason,
    improvement,
    channelId,
    threadId,
    messageId = null,
    source = 'manual',
    allowRunningJobIds = [],
    interruptRunningJobs = false,
    workerLabel = null,
    workerEffort = null,
    runtimeChangedPaths = [],
  }) {
    assertRestartExplanation({ reason, improvement });
    if (inProgress || isShuttingDown()) {
      await logEvent('restart-request-ignored-restart-in-progress', {
        channelId,
        threadId,
        sourceThreadId: threadId,
        reason,
        improvement,
        source,
      });
      return { deferred: false, alreadyRestarting: true };
    }
    if (deferred) {
      await logEvent('restart-request-ignored-deferred-pending', {
        channelId,
        threadId,
        sourceThreadId: threadId,
        reason,
        improvement,
        source,
        pendingSource: deferred.source,
      });
      return { deferred: true, alreadyPending: true };
    }

    const blockers = runningJobsBlockingRestart(allowRunningJobIds);
    if (blockers.length > 0 && !interruptRunningJobs) {
      return deferUntilIdle({
        reason,
        improvement,
        channelId,
        threadId,
        messageId,
        source,
        allowRunningJobIds,
        interruptRunningJobs,
        workerLabel,
        workerEffort,
        runtimeChangedPaths,
      }, blockers);
    }

    await perform({
      reason,
      improvement,
      channelId,
      threadId,
      messageId,
      source,
      interruptRunningJobs,
      interruptedJobs: blockers,
      workerLabel,
      workerEffort,
      runtimeChangedPaths,
    });
    return blockers.length > 0 ? { deferred: false, interruptedJobs: blockers } : { deferred: false };
  }

  async function deferUntilIdle(restartRequest, blockers) {
    deferred = {
      ...restartRequest,
      deferredAt: new Date().toISOString(),
      allowRunningJobIds: Array.isArray(restartRequest.allowRunningJobIds)
        ? restartRequest.allowRunningJobIds
        : [],
    };
    // Survive a crash during the deferred window: the request (and the fact that
    // git polls/reserved commands were frozen) would otherwise exist only in memory.
    await writeState(DEFERRED_RESTART_STATE, {
      ...deferred,
      blockers,
      frozen: { gitPolls: true, reservedCommands: true },
    });
    freezeSchedulers();
    const delivery = await postNotice(restartRequest, formatNotice({
      ...restartRequest,
      deferred: true,
      blockers,
    }));
    await logEvent('restart-deferred-until-idle', {
      channelId: restartRequest.channelId,
      threadId: restartRequest.threadId,
      sourceThreadId: restartRequest.threadId,
      reason: restartRequest.reason,
      improvement: restartRequest.improvement,
      source: restartRequest.source,
      blockers,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return { deferred: true, blockers };
  }

  async function runIfIdle() {
    if (!deferred) return;
    const blockers = runningJobsBlockingRestart(deferred.allowRunningJobIds);
    if (blockers.length > 0) return;
    const restartRequest = deferred;
    deferred = null;
    await removeState(DEFERRED_RESTART_STATE);
    await perform(restartRequest);
  }

  // A deferred restart only exists in deferred-restart.json when the process died
  // mid-window. The death itself already applied what the restart was waiting for
  // (supervisor relaunch loads current runtime), so record it as fulfilled rather
  // than restarting again.
  async function completeAbandoned() {
    const abandoned = await readState(DEFERRED_RESTART_STATE);
    if (!abandoned) return;
    await removeState(DEFERRED_RESTART_STATE);
    await logEvent('deferred-restart-fulfilled-by-startup', abandoned);
  }

  async function perform({
    reason,
    improvement,
    channelId,
    threadId,
    messageId = null,
    source = 'manual',
    interruptRunningJobs = false,
    interruptedJobs = [],
    workerLabel = null,
    workerEffort = null,
    runtimeChangedPaths = [],
  }) {
    assertRestartExplanation({ reason, improvement });
    // Re-entrance guard: the awaits below (Discord post, state writes) yield the
    // event loop, so a second restart trigger could otherwise run this concurrently —
    // duplicate notices, pending-restart.json overwrite, and racing process.exit.
    if (inProgress) {
      await logEvent('restart-request-ignored-restart-in-progress', {
        channelId, threadId, sourceThreadId: threadId, reason, improvement, source,
      });
      return;
    }
    inProgress = true;
    prepareShutdown();
    const delivery = await postNotice({ channelId, threadId }, formatNotice({
      reason,
      improvement,
      channelId,
      threadId,
      source,
      workerLabel,
      workerEffort,
      runtimeChangedPaths: Array.isArray(runtimeChangedPaths)
        ? runtimeChangedPaths
        : [],
    }));
    await writeState(PENDING_RESTART_STATE, {
      requestedAt: new Date().toISOString(),
      reason,
      improvement,
      channelId,
      threadId,
      sourceThreadId: threadId,
      messageId,
      restartMessageId: delivery.messageIds?.[0] || null,
      restartOutboxId: delivery.outboxId || null,
      source,
      interruptRunningJobs: Boolean(interruptRunningJobs),
      interruptedJobs: Array.isArray(interruptedJobs) ? interruptedJobs : [],
      workerLabel,
      workerEffort,
      runtimeChangedPaths: Array.isArray(runtimeChangedPaths)
        ? runtimeChangedPaths
        : [],
    });
    await logEvent('restart-requested', {
      channelId,
      threadId,
      sourceThreadId: threadId,
      reason,
      improvement,
      source,
      workerLabel,
      workerEffort,
      interruptRunningJobs: Boolean(interruptRunningJobs),
      interruptedJobs: Array.isArray(interruptedJobs) ? interruptedJobs : [],
    });
    const childProcesses = await terminateChildren();
    await logEvent('restart-child-processes-terminated', { childProcesses });
    exit(restartExitCode);
  }

  return {
    request,
    runIfIdle,
    completeAbandoned,
    get deferred() { return deferred; },
    get inProgress() { return inProgress; },
  };
}

export function assertRestartExplanation({ reason, improvement }) {
  if (!String(reason || '').trim()) throw new Error('restart reason is required');
  if (!String(improvement || '').trim()) throw new Error('restart improvement is required');
}
