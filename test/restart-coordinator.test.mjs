import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFERRED_RESTART_STATE,
  PENDING_RESTART_STATE,
  assertRestartExplanation,
  createRestartCoordinator,
} from '../lib/restart-coordinator.mjs';

function makeHarness({ jobs = [], shuttingDown = false, postNoticeGate = null } = {}) {
  const state = new Map();
  const events = [];
  const notices = [];
  const exits = [];
  let frozen = 0;
  let shutdownPrepared = 0;
  let childrenTerminated = 0;

  const coordinator = createRestartCoordinator({
    runningJobs: () => jobs,
    isShuttingDown: () => shuttingDown,
    formatNotice: (request) => `notice:${request.reason}${request.deferred ? ':deferred' : ''}`,
    postNotice: async (request, content) => {
      if (postNoticeGate) await postNoticeGate;
      notices.push({ request, content });
      return { delivered: true, queued: false, messageIds: ['m1'], outboxId: null };
    },
    logEvent: async (type, payload) => { events.push({ type, payload }); },
    writeState: async (name, value) => { state.set(name, value); },
    readState: async (name) => (state.has(name) ? state.get(name) : null),
    removeState: async (name) => { state.delete(name); },
    freezeSchedulers: () => { frozen += 1; },
    prepareShutdown: () => { shutdownPrepared += 1; },
    terminateChildren: async () => { childrenTerminated += 1; return { count: 0 }; },
    exit: (code) => { exits.push(code); },
    restartExitCode: 75,
  });

  return {
    coordinator,
    state,
    events,
    notices,
    exits,
    counters: {
      get frozen() { return frozen; },
      get shutdownPrepared() { return shutdownPrepared; },
      get childrenTerminated() { return childrenTerminated; },
    },
    jobs,
  };
}

const REQUEST = {
  reason: 'runtime source changed',
  improvement: 'load the new code',
  channelId: 'chan',
  threadId: 'thread',
  source: 'runtime-sources',
};

test('idle request performs the restart: notice, pending state, child cleanup, exit', async () => {
  const h = makeHarness();

  const result = await h.coordinator.request(REQUEST);

  assert.deepEqual(result, { deferred: false });
  assert.equal(h.counters.shutdownPrepared, 1);
  assert.equal(h.counters.childrenTerminated, 1);
  assert.deepEqual(h.exits, [75]);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.notices[0].request, {
    channelId: 'chan',
    threadId: 'thread',
  });
  assert.equal(h.notices[0].content, 'notice:runtime source changed');
  const pending = h.state.get(PENDING_RESTART_STATE);
  assert.equal(pending.reason, 'runtime source changed');
  assert.equal(pending.restartMessageId, 'm1');
  assert.deepEqual(
    h.events.map((event) => event.type),
    ['restart-requested', 'restart-child-processes-terminated'],
  );
});

test('request threads the worker label + effort into notice and pending state', async () => {
  const noticeRequests = [];
  const state = new Map();
  const coordinator = createRestartCoordinator({
    runningJobs: () => [],
    formatNotice: (request) => { noticeRequests.push(request); return 'notice'; },
    postNotice: async () => ({ delivered: true, queued: false, messageIds: ['m1'], outboxId: null }),
    logEvent: async () => {},
    writeState: async (name, value) => { state.set(name, value); },
    readState: async (name) => (state.has(name) ? state.get(name) : null),
    removeState: async (name) => { state.delete(name); },
    terminateChildren: async () => null,
    exit: () => {},
    restartExitCode: 75,
  });

  await coordinator.request({
    ...REQUEST,
    workerLabel: 'codex: gpt-5.6-terra',
    workerEffort: 'xhigh',
  });

  assert.equal(noticeRequests[0].workerLabel, 'codex: gpt-5.6-terra');
  assert.equal(noticeRequests[0].workerEffort, 'xhigh');
  const pending = state.get(PENDING_RESTART_STATE);
  assert.equal(pending.workerLabel, 'codex: gpt-5.6-terra');
  assert.equal(pending.workerEffort, 'xhigh');
});

test('runtime source paths survive into pending restart state for role handoff', async () => {
  const h = makeHarness();
  const runtimeChangedPaths = [
    'bridge-service.mjs',
    'v3/lib/reception-service.mjs',
  ];

  await h.coordinator.request({
    ...REQUEST,
    runtimeChangedPaths,
  });

  assert.deepEqual(
    h.state.get(PENDING_RESTART_STATE).runtimeChangedPaths,
    runtimeChangedPaths,
  );
});

test('deferred request carries the worker label + effort into the persisted window', async () => {
  const h = makeHarness({ jobs: [{ id: 'job-1', channelId: 'c', threadId: 't' }] });

  await h.coordinator.request({
    ...REQUEST,
    workerLabel: 'claude: claude-fable-5',
    workerEffort: 'low',
  });

  const persisted = h.state.get(DEFERRED_RESTART_STATE);
  assert.equal(persisted.workerLabel, 'claude: claude-fable-5');
  assert.equal(persisted.workerEffort, 'low');
});

test('request defers while jobs are running and persists the deferred window', async () => {
  const h = makeHarness({ jobs: [{ id: 'job-1', channelId: 'c', threadId: 't' }] });

  const result = await h.coordinator.request(REQUEST);

  assert.equal(result.deferred, true);
  assert.deepEqual(result.blockers, [{ id: 'job-1', channelId: 'c', threadId: 't' }]);
  assert.equal(h.exits.length, 0);
  assert.equal(h.counters.frozen, 1);
  assert.equal(h.coordinator.deferred.reason, 'runtime source changed');
  // Crash persistence: the deferred request must be on disk, not memory-only.
  const persisted = h.state.get(DEFERRED_RESTART_STATE);
  assert.equal(persisted.reason, 'runtime source changed');
  assert.deepEqual(persisted.blockers, [{ id: 'job-1', channelId: 'c', threadId: 't' }]);
  assert.deepEqual(persisted.frozen, { gitPolls: true, reservedCommands: true });
  assert.equal(h.notices[0].content, 'notice:runtime source changed:deferred');

  // A second request during the deferred window is ignored, not double-posted.
  const second = await h.coordinator.request({ ...REQUEST, reason: 'another change' });
  assert.deepEqual(second, { deferred: true, alreadyPending: true });
  assert.equal(h.notices.length, 1);
  assert.equal(h.events.at(-1).type, 'restart-request-ignored-deferred-pending');
});

test('allowRunningJobIds lets the requesting job bypass the blocker check', async () => {
  const h = makeHarness({ jobs: [{ id: 'job-1', channelId: 'c', threadId: 't' }] });

  const result = await h.coordinator.request({ ...REQUEST, allowRunningJobIds: ['job-1'] });

  assert.deepEqual(result, { deferred: false });
  assert.deepEqual(h.exits, [75]);
});

test('interruptRunningJobs restarts immediately and records interrupted jobs for recovery', async () => {
  const runningJob = { id: 'job-1', channelId: 'c', threadId: 't' };
  const h = makeHarness({ jobs: [runningJob] });

  const result = await h.coordinator.request({ ...REQUEST, interruptRunningJobs: true });

  assert.deepEqual(result, { deferred: false, interruptedJobs: [runningJob] });
  assert.deepEqual(h.exits, [75]);
  assert.equal(h.state.has(DEFERRED_RESTART_STATE), false);
  const pending = h.state.get(PENDING_RESTART_STATE);
  assert.equal(pending.interruptRunningJobs, true);
  assert.deepEqual(pending.interruptedJobs, [runningJob]);
  assert.equal(h.events.at(-2).type, 'restart-requested');
  assert.deepEqual(h.events.at(-2).payload.interruptedJobs, [runningJob]);
});

test('runIfIdle waits for blockers to drain, then restarts and clears the persisted window', async () => {
  const jobs = [{ id: 'job-1', channelId: 'c', threadId: 't' }];
  const h = makeHarness({ jobs });
  await h.coordinator.request(REQUEST);

  await h.coordinator.runIfIdle();
  assert.equal(h.exits.length, 0, 'still blocked');

  jobs.length = 0;
  await h.coordinator.runIfIdle();
  assert.deepEqual(h.exits, [75]);
  assert.equal(h.state.has(DEFERRED_RESTART_STATE), false);
  assert.equal(h.coordinator.deferred, null);
  const pending = h.state.get(PENDING_RESTART_STATE);
  assert.equal(pending.reason, 'runtime source changed');
});

test('concurrent restart triggers collapse into a single restart (re-entrance guard)', async () => {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const h = makeHarness({ postNoticeGate: gate });

  // First request reaches the slow Discord post and yields the event loop.
  const first = h.coordinator.request(REQUEST);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.coordinator.inProgress, true);

  // Second trigger lands mid-restart: ignored instead of racing to process.exit.
  const second = await h.coordinator.request({ ...REQUEST, reason: 'duplicate trigger' });
  assert.deepEqual(second, { deferred: false, alreadyRestarting: true });
  assert.equal(h.events.at(-1).type, 'restart-request-ignored-restart-in-progress');

  releaseGate();
  await first;
  assert.deepEqual(h.exits, [75], 'exactly one restart performed');
  assert.equal(h.notices.length, 1, 'exactly one restart notice posted');
  assert.equal(h.state.get(PENDING_RESTART_STATE).reason, 'runtime source changed');
});

test('requests during graceful shutdown are ignored', async () => {
  const h = makeHarness({ shuttingDown: true });

  const result = await h.coordinator.request(REQUEST);

  assert.deepEqual(result, { deferred: false, alreadyRestarting: true });
  assert.equal(h.exits.length, 0);
  assert.equal(h.notices.length, 0);
});

test('completeAbandoned clears a deferred window left behind by a crash', async () => {
  const h = makeHarness();
  h.state.set(DEFERRED_RESTART_STATE, { reason: 'crashed mid-window' });

  await h.coordinator.completeAbandoned();

  assert.equal(h.state.has(DEFERRED_RESTART_STATE), false);
  assert.deepEqual(h.events, [{
    type: 'deferred-restart-fulfilled-by-startup',
    payload: { reason: 'crashed mid-window' },
  }]);
  assert.equal(h.exits.length, 0, 'startup already runs the new runtime; no second restart');

  // Idempotent when nothing was abandoned.
  await h.coordinator.completeAbandoned();
  assert.equal(h.events.length, 1);
});

test('assertRestartExplanation rejects empty reason or improvement', () => {
  assert.throws(() => assertRestartExplanation({ reason: '', improvement: 'x' }), /reason/);
  assert.throws(() => assertRestartExplanation({ reason: 'x', improvement: ' ' }), /improvement/);
  assert.doesNotThrow(() => assertRestartExplanation({ reason: 'x', improvement: 'y' }));

  const h = makeHarness();
  assert.rejects(h.coordinator.request({ ...REQUEST, reason: '' }), /reason/);
});
