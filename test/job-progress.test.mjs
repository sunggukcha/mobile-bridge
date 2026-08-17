import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProgressUpdateForwarder,
  createProgressUpdateBuffer,
  createTerminalResponseProgressGate,
  formatJobStopMessage,
  formatProgressMessage,
  jobStatusAfterOutboundDelivery,
  jobProgressIntervalMs,
  jobProgressMinSilenceMs,
  startJobProgressTimer,
} from '../lib/job-progress.mjs';

test('formatProgressMessage falls back to the job id when no worker display is known', () => {
  assert.equal(
    formatProgressMessage({ id: 'job_123' }, 1_000, 61_000),
    'job_123 working for 1 minute.',
  );
  assert.equal(
    formatProgressMessage({ id: 'job_123' }, 1_000, 181_000),
    'job_123 working for 3 minutes.',
  );
  assert.equal(
    formatProgressMessage({ id: 'job_123' }, 1_000, 181_000, 'worker update:\n[codex/response_text] checking files'),
    'job_123 working for 3 minutes.',
  );
});

test('formatProgressMessage leads with the worker display when provided', () => {
  assert.equal(
    formatProgressMessage({ id: 'job_123' }, 1_000, 61_000, { workerDisplay: 'codex gpt-5.6-terra (xhigh)' }),
    'codex gpt-5.6-terra (xhigh) working for 1 minute.',
  );
  assert.equal(
    formatProgressMessage({ id: 'job_123' }, 1_000, 121_000, { workerLabel: 'claude Opus 5 (xhigh)' }),
    'claude Opus 5 (xhigh) working for 2 minutes.',
  );
});

test('formatJobStopMessage provides explicit running-job closure notices', () => {
  assert.equal(formatJobStopMessage('superseded'), '이전 작업을 새 요청으로 교체했습니다.');
  assert.equal(formatJobStopMessage('cancelled'), '실행 중이던 작업을 취소했습니다.');
  assert.equal(formatJobStopMessage('done'), '');
});

test('queued stop notices preserve the terminal job status after delivery', () => {
  assert.equal(jobStatusAfterOutboundDelivery('job-superseded'), 'superseded');
  assert.equal(jobStatusAfterOutboundDelivery('job-cancelled'), 'cancelled');
  assert.equal(jobStatusAfterOutboundDelivery('job-final'), 'done');
});

test('jobProgressIntervalMs defaults to one minute and can be disabled', () => {
  assert.equal(jobProgressIntervalMs({}), 60_000);
  assert.equal(jobProgressIntervalMs({ jobProgressIntervalMs: 15_000 }), 15_000);
  assert.equal(jobProgressIntervalMs({ jobProgressIntervalMs: 0 }), null);
  assert.equal(jobProgressMinSilenceMs({}), 60_000);
  assert.equal(jobProgressMinSilenceMs({ jobProgressMinSilenceMs: 30_000 }), 60_000);
  assert.equal(jobProgressMinSilenceMs({ jobProgressMinSilenceMs: 120_000 }), 120_000);
});

test('startJobProgressTimer notifies only while the job is running', async () => {
  const intervals = [];
  const cleared = [];
  const notifications = [];
  let currentTime = 0;
  let running = true;
  const timer = startJobProgressTimer({
    job: { id: 'job_abc' },
    config: { jobProgressIntervalMs: 60_000 },
    isRunning: () => running,
    notify: async (job, status, summary) => notifications.push({ job, status, summary }),
    now: () => currentTime,
    setIntervalFn: (fn, intervalMs) => {
      intervals.push({ fn, intervalMs });
      return { id: 'timer-1' };
    },
    clearIntervalFn: (handle) => cleared.push(handle),
  });

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].intervalMs, 60_000);

  currentTime = 60_000;
  intervals[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(notifications.map((entry) => [entry.status, entry.summary]), [
    ['progress', 'job_abc working for 1 minute.'],
  ]);

  running = false;
  currentTime = 120_000;
  intervals[0].fn();
  await Promise.resolve();
  assert.equal(notifications.length, 1);

  timer.stop();
  assert.deepEqual(cleared, [{ id: 'timer-1' }]);
});

test('startJobProgressTimer forwards current worker details to progress messages', async () => {
  const intervals = [];
  const notifications = [];
  let currentTime = 0;
  const timer = startJobProgressTimer({
    job: { id: 'job_worker' },
    config: { jobProgressIntervalMs: 60_000 },
    isRunning: () => true,
    notify: async (_job, _status, summary) => notifications.push(summary),
    details: () => ({ workerDisplay: 'claude Opus 5 (xhigh)' }),
    now: () => currentTime,
    setIntervalFn: (fn, intervalMs) => {
      intervals.push({ fn, intervalMs });
      return { id: 'timer-worker' };
    },
    clearIntervalFn: () => {},
  });

  currentTime = 60_000;
  intervals[0].fn();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(notifications, [
    'claude Opus 5 (xhigh) working for 1 minute.',
  ]);
  timer.stop();
});

test('startJobProgressTimer carries elapsed worker time across a continuation', async () => {
  const intervals = [];
  const notifications = [];
  let currentTime = 100_000;
  const timer = startJobProgressTimer({
    job: { id: 'job_continuation', previousWorkerDurationMs: 2 * 60_000 },
    config: { jobProgressIntervalMs: 60_000 },
    isRunning: () => true,
    notify: async (_job, _status, summary) => notifications.push(summary),
    now: () => currentTime,
    setIntervalFn: (fn) => {
      intervals.push(fn);
      return { id: 'timer-continuation' };
    },
    clearIntervalFn: () => {},
  });

  currentTime += 60_000;
  intervals[0]();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(notifications, ['job_continuation working for 3 minutes.']);
  timer.stop();
});

test('startJobProgressTimer skips progress when the same job sent a recent message', async () => {
  const intervals = [];
  const notifications = [];
  let currentTime = 0;
  const timer = startJobProgressTimer({
    job: { id: 'job_recent' },
    config: { jobProgressIntervalMs: 60_000 },
    isRunning: () => true,
    notify: async (_job, _status, summary) => notifications.push(summary),
    now: () => currentTime,
    setIntervalFn: (fn, intervalMs) => {
      intervals.push({ fn, intervalMs });
      return { id: 'timer-2' };
    },
    clearIntervalFn: () => {},
  });

  currentTime = 30_000;
  timer.markMessageSent();
  currentTime = 60_000;
  intervals[0].fn();
  await Promise.resolve();
  assert.equal(notifications.length, 0);

  currentTime = 90_000;
  intervals[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(notifications, ['job_recent working for 1 minute.']);
  timer.stop();
});

test('startJobProgressTimer keeps a one minute silence floor with shorter intervals', async () => {
  const intervals = [];
  const notifications = [];
  let currentTime = 0;
  const timer = startJobProgressTimer({
    job: { id: 'job_short_interval' },
    config: { jobProgressIntervalMs: 10_000 },
    isRunning: () => true,
    notify: async (_job, _status, summary) => notifications.push(summary),
    now: () => currentTime,
    setIntervalFn: (fn, intervalMs) => {
      intervals.push({ fn, intervalMs });
      return { id: 'timer-short' };
    },
    clearIntervalFn: () => {},
  });

  assert.equal(intervals[0].intervalMs, 10_000);

  currentTime = 10_000;
  intervals[0].fn();
  await Promise.resolve();
  assert.equal(notifications.length, 0);

  currentTime = 60_000;
  intervals[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(notifications, ['job_short_interval working for 1 minute.']);

  currentTime = 70_000;
  intervals[0].fn();
  await Promise.resolve();
  assert.equal(notifications.length, 1);

  timer.stop();
});

test('startJobProgressTimer notifies on every tick that lands on the silence boundary', async () => {
  const intervals = [];
  const timeouts = [];
  const notifications = [];
  let currentTime = 0;
  const timer = startJobProgressTimer({
    job: { id: 'job_boundary' },
    config: { jobProgressIntervalMs: 60_000, jobProgressMinSilenceMs: 60_000 },
    isRunning: () => true,
    notify: async (_job, _status, summary) => notifications.push(summary),
    now: () => currentTime,
    setIntervalFn: (fn) => {
      intervals.push(fn);
      return { id: 'timer-boundary' };
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (fn, delayMs) => {
      const handle = { fn, delayMs, cleared: false };
      timeouts.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      handle.cleared = true;
    },
  });

  // The worker-start ack lands shortly after the timer is armed.
  currentTime = 400;
  timer.markMessageSent();

  for (const [tickAt, dueAt] of [[60_000, 60_400], [120_000, 120_400], [180_000, 180_400]]) {
    currentTime = tickAt;
    intervals[0]();
    await Promise.resolve();
    assert.equal(notifications.length, Math.floor(tickAt / 60_000) - 1);
    const boundary = timeouts.findLast((handle) => !handle.cleared);
    assert.equal(boundary.delayMs, 400);

    currentTime = dueAt;
    boundary.fn();
    await Promise.resolve();
    await Promise.resolve();
  }

  assert.deepEqual(notifications, [
    'job_boundary working for 1 minute.',
    'job_boundary working for 2 minutes.',
    'job_boundary working for 3 minutes.',
  ]);
  timer.stop();
});

test('startJobProgressTimer tolerates an interval tick firing a hair early', async () => {
  const intervals = [];
  const timeouts = [];
  const notifications = [];
  let currentTime = 0;
  const timer = startJobProgressTimer({
    job: { id: 'job_jitter' },
    config: { jobProgressIntervalMs: 60_000 },
    isRunning: () => true,
    notify: async (_job, _status, summary) => notifications.push(summary),
    now: () => currentTime,
    setIntervalFn: (fn) => {
      intervals.push(fn);
      return { id: 'timer-jitter' };
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (fn, delayMs) => {
      const handle = { fn, delayMs, cleared: false };
      timeouts.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      handle.cleared = true;
    },
  });

  for (const [tickAt, dueAt] of [[59_999, 60_000], [119_998, 120_000], [179_997, 180_000]]) {
    currentTime = tickAt;
    intervals[0]();
    await Promise.resolve();
    const boundary = timeouts.findLast((handle) => !handle.cleared);
    assert.equal(boundary.delayMs, dueAt - tickAt);
    currentTime = dueAt;
    boundary.fn();
    await Promise.resolve();
    await Promise.resolve();
  }

  assert.equal(notifications.length, 3);
  timer.stop();
});

test('startJobProgressTimer still suppresses progress well inside the silence window', async () => {
  const intervals = [];
  const timeouts = [];
  const notifications = [];
  let currentTime = 0;
  const timer = startJobProgressTimer({
    job: { id: 'job_slack_bound' },
    config: { jobProgressIntervalMs: 60_000 },
    isRunning: () => true,
    notify: async (_job, _status, summary) => notifications.push(summary),
    now: () => currentTime,
    setIntervalFn: (fn) => {
      intervals.push(fn);
      return { id: 'timer-slack' };
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (fn, delayMs) => {
      const handle = { fn, delayMs, cleared: false };
      timeouts.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      handle.cleared = true;
    },
  });

  currentTime = 2_000;
  timer.markMessageSent();
  currentTime = 60_000;
  intervals[0]();
  await Promise.resolve();
  assert.equal(notifications.length, 0);
  const boundary = timeouts.findLast((handle) => !handle.cleared);
  assert.equal(boundary.delayMs, 2_000);

  currentTime = 62_000;
  boundary.fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(notifications.length, 1);
  timer.stop();
});

test('createProgressUpdateBuffer formats and drains worker updates', () => {
  const buffer = createProgressUpdateBuffer({ maxItems: 3 });
  assert.equal(buffer.hasUpdates(), false);
  assert.equal(buffer.add({ worker: 'codex', type: 'response_text', text: 'reading files' }), true);
  assert.equal(buffer.add({ worker: 'codex', type: 'reasoning', text: 'found likely path' }), true);
  assert.equal(buffer.add({ worker: 'claude', type: 'response_text', text: 'checking fallback text' }), true);
  assert.equal(buffer.hasUpdates(), true);
  assert.equal(
    buffer.drain(),
    'reading files\nfound likely path\nchecking fallback text',
  );
  assert.equal(buffer.hasUpdates(), false);
});

test('createProgressUpdateBuffer preserves intermediate output line breaks', () => {
  const buffer = createProgressUpdateBuffer({ maxItems: 2 });
  buffer.add({
    worker: 'codex',
    type: 'response_text',
    text: '검사 결과:\n- lib/job-progress.mjs\n- bridge-service.mjs',
  });

  assert.equal(
    buffer.drain(),
    '검사 결과:\n- lib/job-progress.mjs\n- bridge-service.mjs',
  );
});

test('createProgressUpdateBuffer appends delta updates for the same worker and type', () => {
  const buffer = createProgressUpdateBuffer({ maxItems: 4 });
  buffer.add({ worker: 'codex', type: 'response_text', text: 'read', append: true });
  buffer.add({ worker: 'codex', type: 'response_text', text: 'ing files', append: true });
  buffer.add({ worker: 'codex', type: 'reasoning', text: 'checked path', append: true });

  assert.equal(
    buffer.drain(),
    'reading files\nchecked path',
  );
});

test('createProgressUpdateBuffer drops empty HTML comment progress lines', () => {
  const buffer = createProgressUpdateBuffer({ maxItems: 4 });
  buffer.add({ worker: 'codex', type: 'reasoning', text: 'Preparing supportive Korean reply' });
  buffer.add({ worker: 'codex', type: 'reasoning', text: '<!-- -->' });
  buffer.add({ worker: 'codex', type: 'reasoning', text: 'Confirming concise final response' });

  assert.equal(
    buffer.drain(),
    'Preparing supportive Korean reply\nConfirming concise final response',
  );
});

test('createProgressUpdateBuffer does not truncate long worker updates', () => {
  const buffer = createProgressUpdateBuffer({ maxItems: 2 });
  const text = 'long-progress-'.repeat(20);
  buffer.add({ worker: 'codex', type: 'response_text', text });

  const drained = buffer.drain();
  assert.equal(drained.includes('[truncated]'), false);
  assert.equal(drained.endsWith(text), true);
});

test('createProgressUpdateBuffer accepts fallback worker response updates', () => {
  const buffer = createProgressUpdateBuffer();

  assert.equal(buffer.add({ worker: 'claude', type: 'response_text', text: 'checking claude' }), true);
  assert.equal(buffer.add({ worker: 'gemini', type: 'response_text', text: 'checking gemini' }), true);
  assert.equal(buffer.add({ worker: 'unknown', type: 'response_text', text: 'hidden' }), false);

  assert.equal(buffer.drain(), 'checking claude\nchecking gemini');
});

test('createProgressUpdateBuffer accepts concrete model worker names', () => {
  const buffer = createProgressUpdateBuffer();

  assert.equal(buffer.add({ worker: 'codex-gpt-5.6-terra', type: 'response_text', text: 'checking repo' }), true);
  assert.equal(buffer.add({ worker: 'codex-gpt-5.6-terra', type: 'tool_call', text: 'running command: git status' }), true);
  assert.equal(buffer.add({ worker: 'codex-spark-gpt-5.3-codex-spark', type: 'reasoning', text: 'narrowed path' }), true);
  assert.equal(buffer.add({ worker: 'antigravity-claude-opus-4.6-thinking', type: 'response_text', text: 'checking HF repo' }), true);

  assert.equal(
    buffer.drain(),
    'checking repo\nnarrowed path\nchecking HF repo',
  );

  const verboseBuffer = createProgressUpdateBuffer({ verbose: true });
  verboseBuffer.add({ worker: 'codex-gpt-5.6-terra', type: 'response_text', text: 'checking repo' });
  verboseBuffer.add({ worker: 'codex-gpt-5.6-terra', type: 'tool_call', text: 'running command: git status' });
  verboseBuffer.add({ worker: 'codex-spark-gpt-5.3-codex-spark', type: 'reasoning', text: 'narrowed path' });
  verboseBuffer.add({ worker: 'antigravity', type: 'response_text', text: 'checking HF repo' });

  assert.equal(
    verboseBuffer.drain(),
    'checking repo\nrunning command: git status\nnarrowed path\nchecking HF repo',
  );
});

test('terminal response progress is held by identity and discarded when the job completes', () => {
  const buffer = createProgressUpdateBuffer();
  const gate = createTerminalResponseProgressGate({
    forward: (update) => buffer.add(update),
  });

  gate.add({ worker: 'claude', type: 'response_text', text: 'checking files' });
  gate.add({ worker: 'claude', type: 'reasoning', text: 'found the affected path' });
  gate.add({
    worker: 'claude',
    type: 'response_text',
    text: [
      'final answer',
      '<bridge_restart_service>{"reason":"runtime changed","improvement":"loads the fix"}</bridge_restart_service>',
    ].join('\n'),
  });

  assert.equal(gate.hasPendingResponse(), true);
  gate.complete();
  assert.equal(gate.hasPendingResponse(), false);
  assert.equal(buffer.drain(), 'checking files\nfound the affected path');
});

test('worker progress strips every internal bridge control block before delivery', () => {
  const buffer = createProgressUpdateBuffer();
  buffer.add({
    worker: 'claude',
    type: 'response_text',
    text: [
      'visible update',
      '<bridge_restart_service>{"reason":"restart","improvement":"fixed"}</bridge_restart_service>',
      '<bridge_wait_for_user>{"question":"confirm?"}</bridge_wait_for_user>',
      '<bridge_maintenance_issue_result>{"resolved":true,"summary":"fixed"}</bridge_maintenance_issue_result>',
      '<bridge_daily_maintenance_result>{"improvements":["fixed"]}</bridge_daily_maintenance_result>',
      'continuing',
    ].join('\n'),
  });

  assert.equal(buffer.drain(), 'visible update\ncontinuing');
});

test('createProgressUpdateForwarder sends buffered updates after a short delay', async () => {
  const timers = [];
  const cleared = [];
  const sent = [];
  let sentCount = 0;
  const forwarder = createProgressUpdateForwarder({
    delayMs: 2_000,
    send: async (message) => sent.push(message),
    onSent: () => {
      sentCount += 1;
    },
    setTimeoutFn: (fn, delayMs) => {
      timers.push({ fn, delayMs });
      return { id: `timer-${timers.length}` };
    },
    clearTimeoutFn: (handle) => cleared.push(handle),
  });

  assert.equal(forwarder.add({ worker: 'codex', type: 'response_text', text: 'reading' }), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 2_000);

  await timers[0].fn();
  assert.deepEqual(sent, ['reading']);
  assert.equal(sentCount, 1);

  forwarder.add({ worker: 'codex', type: 'response_text', text: 'done' });
  await forwarder.flush();
  assert.equal(sent.at(-1), 'done');
  assert.equal(cleared.at(-1).id, 'timer-2');
});

test('createProgressUpdateBuffer strips raw labels, test output, and truncated markers', () => {
  const buffer = createProgressUpdateBuffer();
  buffer.add({ worker: 'codex', type: 'response_text', text: '[codex/response_text] checking\n[truncated]\nready' });
  assert.equal(buffer.add({ worker: 'codex', type: 'tool_output', text: '[codex/tool_output]\n$ pwd' }), true);
  buffer.add({
    worker: 'codex',
    type: 'response_text',
    text: [
      'workerupdate [codex/response_text] Outbound 정리 함수도 독립 테스트를 붙여',
      '# Subtest: runAgentJob does not fall back for non-runtime worker failures',
      'ok 5 - runAgentJob does not fall back for non-runtime worker failures',
      '  ---',
      '  duration_ms: 34.79',
      "  type: 'test'",
      '  ...',
      '[truncated]',
      '다음 작업',
    ].join('\n'),
  });

  assert.equal(
    buffer.drain(),
    'checking\nready\nOutbound 정리 함수도 독립 테스트를 붙여\n다음 작업',
  );
});

test('createProgressUpdateBuffer hides command progress unless verbose is enabled', () => {
  const defaultBuffer = createProgressUpdateBuffer();
  defaultBuffer.add({
    worker: 'codex',
    type: 'tool_call',
    text: 'running command: /bin/bash -lc pwd',
  });
  defaultBuffer.add({
    worker: 'codex',
    type: 'tool_output',
    text: 'command completed: /bin/bash -lc pwd\n/tmp/project',
  });

  assert.equal(defaultBuffer.drain(), '');

  const verboseBuffer = createProgressUpdateBuffer({ verbose: true });
  verboseBuffer.add({
    worker: 'codex',
    type: 'tool_call',
    text: 'running command: /bin/bash -lc pwd',
  });
  verboseBuffer.add({
    worker: 'codex',
    type: 'tool_output',
    text: 'command completed: /bin/bash -lc pwd\n/tmp/project',
  });

  assert.equal(
    verboseBuffer.drain(),
    'running command: /bin/bash -lc pwd\ncommand completed: /bin/bash -lc pwd\n/tmp/project',
  );
});

test('createProgressUpdateBuffer drops Claude tool detail and synthetic activity text', () => {
  const buffer = createProgressUpdateBuffer();
  buffer.add({
    worker: 'claude-opus-primary',
    type: 'tool_call',
    text: 'running command: print-sensitive-command-arguments',
  });
  buffer.add({
    worker: 'claude-opus-primary',
    type: 'tool_output',
    text: 'tool output: sensitive-result',
  });
  // Liveness for a tool-only turn comes from the interval progress message
  // ("claude Opus 5 (xhigh) working for N minutes."), not from a synthetic
  // activity line, so an activity update must not become a Discord message.
  assert.equal(buffer.add({
    worker: 'claude-opus-primary',
    type: 'activity',
    text: 'Claude가 작업 중입니다.',
  }), false);

  assert.equal(buffer.drain(), '');
});

test('createProgressUpdateBuffer rejects any synthetic liveness update type', () => {
  // Every delivered progress message calls progressTimer.markMessageSent(), which
  // resets the silence window and pushes the "<worker> working for N minutes."
  // notice out. So a *new* frequent update type — under any name — silently
  // replaces that notice for the user. Adding one to PROGRESS_UPDATE_TYPES must
  // be a deliberate decision that breaks this test first, not an incidental edit.
  for (const type of ['activity', 'heartbeat', 'liveness', 'keepalive', 'status', 'thinking', 'progress']) {
    const buffer = createProgressUpdateBuffer();
    assert.equal(
      buffer.add({ worker: 'claude-opus-primary', type, text: 'Claude가 작업 중입니다.' }),
      false,
      `progress update type "${type}" must not be forwarded as a Discord message`,
    );
    assert.equal(buffer.drain(), '');
  }
});
