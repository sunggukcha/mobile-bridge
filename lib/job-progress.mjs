import { cleanOutboundText } from './bridge-output.mjs';

const DEFAULT_JOB_PROGRESS_INTERVAL_MS = 60_000;
const DEFAULT_MIN_MESSAGE_SILENCE_MS = 60_000;
const DEFAULT_MAX_UPDATE_ITEMS = 6;
const DEFAULT_PROGRESS_FORWARD_DELAY_MS = 1_000;
const PROGRESS_WORKERS = new Set([
  'codex',
  'codex-spark',
  'claude',
  'claude-fable',
  'claude-opus',
  'gemini',
  'antigravity',
]);
// Only worker output the user asked to see. Do NOT add a synthetic liveness type
// (`activity`, `heartbeat`, `thinking`, …): every delivered progress update calls
// `progressTimer.markMessageSent()` in bridge-service.mjs, which resets the silence
// timer, so a frequently-emitted type starves the `<worker> working for N minutes.`
// message the user actually wants. `test/job-progress.test.mjs` guards this by name
// and by shape — read the comment there before changing this set.
const PROGRESS_UPDATE_TYPES = new Set(['response_text', 'reasoning', 'tool_call', 'tool_output']);
const BRIDGE_CONTROL_BLOCK_PATTERN = /<bridge_(restart_service|wait_for_user|maintenance_issue_result|daily_maintenance_result)>[\s\S]*?<\/bridge_\1>/gi;
const TRAILING_BRIDGE_CONTROL_BLOCK_PATTERN = /<bridge_(?:restart_service|wait_for_user|maintenance_issue_result|daily_maintenance_result)(?:>[\s\S]*)?$/i;
const PROGRESS_WORKER_PREFIXES = [
  ['codex-spark', 'codex-spark'],
  ['codex', 'codex'],
  ['claude-fable', 'claude-fable'],
  ['claude-opus', 'claude-opus'],
  ['claude', 'claude'],
  ['gemini', 'gemini'],
  ['antigravity', 'antigravity'],
];

export function jobProgressIntervalMs(config = {}) {
  const configured = config.jobProgressIntervalMs ?? DEFAULT_JOB_PROGRESS_INTERVAL_MS;
  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function jobProgressMinSilenceMs(config = {}) {
  const configured = config.jobProgressMinSilenceMs ?? DEFAULT_MIN_MESSAGE_SILENCE_MS;
  const value = Number(configured);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MIN_MESSAGE_SILENCE_MS;
  return Math.max(DEFAULT_MIN_MESSAGE_SILENCE_MS, value);
}

export function formatProgressMessage(job, startedAtMs, nowMs = Date.now(), details = '') {
  const elapsedMinutes = Math.max(1, Math.floor((nowMs - startedAtMs) / 60_000));
  const subject = progressWorkerDisplay(details) || job.id;
  const unit = elapsedMinutes === 1 ? 'minute' : 'minutes';
  return `${subject} working for ${elapsedMinutes} ${unit}.`;
}

export function formatJobStopMessage(status) {
  if (status === 'superseded') return '이전 작업을 새 요청으로 교체했습니다.';
  if (status === 'cancelled') return '실행 중이던 작업을 취소했습니다.';
  return '';
}

export function jobStatusAfterOutboundDelivery(purpose) {
  if (purpose === 'job-superseded') return 'superseded';
  if (purpose === 'job-cancelled') return 'cancelled';
  return 'done';
}

export function createProgressUpdateBuffer({
  maxItems = DEFAULT_MAX_UPDATE_ITEMS,
  verbose = false,
} = {}) {
  const items = [];

  return {
    add(update) {
      const normalized = normalizeProgressUpdate(update);
      if (!normalized) return false;
      const previous = items.at(-1);
      if (normalized.append && previous?.worker === normalized.worker && previous?.type === normalized.type) {
        previous.text = `${previous.text}${normalized.text}`;
        return true;
      }
      items.push(normalized);
      while (items.length > maxItems) items.shift();
      return true;
    },
    drain() {
      if (items.length === 0) return '';
      const selected = items.splice(0, items.length);
      return formatProgressUpdates(selected, { verbose });
    },
    hasUpdates() {
      return items.length > 0;
    },
  };
}

export function createTerminalResponseProgressGate({ forward } = {}) {
  if (!forward) throw new Error('forward is required');

  // The newest response_text can become the worker's terminal answer. Hold it
  // until later worker activity proves it was intermediate; completion drops
  // the still-pending candidate by identity rather than comparing its text.
  let pendingResponse = null;
  let completed = false;

  const release = () => {
    if (completed || !pendingResponse) return false;
    const update = pendingResponse;
    pendingResponse = null;
    return forward(update) !== false;
  };

  return {
    add(update) {
      if (completed || !update) return false;
      if (String(update.type || '') !== 'response_text') {
        release();
        return forward(update) !== false;
      }

      if (
        pendingResponse
        && update.append
        && pendingResponse.type === update.type
        && pendingResponse.worker === update.worker
      ) {
        pendingResponse = {
          ...pendingResponse,
          ...update,
          append: false,
          text: `${pendingResponse.text || ''}${update.text || ''}`,
        };
        return true;
      }

      release();
      pendingResponse = { ...update, append: false };
      return true;
    },
    release,
    complete() {
      completed = true;
      pendingResponse = null;
    },
    hasPendingResponse() {
      return Boolean(pendingResponse);
    },
  };
}

export function createProgressUpdateForwarder({
  buffer = null,
  delayMs = DEFAULT_PROGRESS_FORWARD_DELAY_MS,
  verbose = false,
  send,
  onSent = null,
  onError = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!send) throw new Error('send is required');
  const progressBuffer = buffer || createProgressUpdateBuffer({ verbose });

  let timer = null;
  let inFlight = false;
  let activeFlush = null;
  let stopped = false;

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      return flush().catch((error) => {
        if (onError) onError(error);
      });
    }, Math.max(0, Number(delayMs) || 0));
    timer?.unref?.();
  };

  const flush = async () => {
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (inFlight) {
      await activeFlush;
      return progressBuffer.hasUpdates() ? flush() : false;
    }
    const details = progressBuffer.drain();
    if (!details) return false;

    inFlight = true;
    activeFlush = sendProgressDetails(details, { send, onSent, onError })
      .finally(() => {
        inFlight = false;
        activeFlush = null;
        if (!stopped && progressBuffer.hasUpdates()) schedule();
      });
    return activeFlush;
  };

  return {
    add(update) {
      const added = progressBuffer.add(update);
      if (added) schedule();
      return added;
    },
    flush,
    hasUpdates() {
      return progressBuffer.hasUpdates();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },
  };
}

export function startJobProgressTimer({
  job,
  config = {},
  isRunning,
  notify,
  details = null,
  onError = null,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const intervalMs = jobProgressIntervalMs(config);
  if (!intervalMs || !notify) return null;

  const startedAt = now() - Math.max(0, Number(job.previousWorkerDurationMs) || 0);
  const minSilenceMs = jobProgressMinSilenceMs(config);
  let lastMessageAt = now();
  let inFlight = false;
  let boundaryTimer = null;

  const clearBoundaryCheck = () => {
    if (!boundaryTimer) return;
    clearTimeoutFn(boundaryTimer);
    boundaryTimer = null;
  };

  const scheduleBoundaryCheck = (delayMs) => {
    clearBoundaryCheck();
    boundaryTimer = setTimeoutFn(() => {
      boundaryTimer = null;
      notifyIfDue().catch((error) => {
        if (onError) onError(error);
      });
    }, Math.max(1, Math.ceil(delayMs)));
    boundaryTimer?.unref?.();
  };

  const notifyIfDue = async (status = 'progress', { force = false } = {}) => {
    if (inFlight || !isRunning?.(job.id)) return;
    const sentAt = now();
    const silenceMs = sentAt - lastMessageAt;
    if (!force && silenceMs < minSilenceMs) {
      // A worker-start or progress message can land just after the fixed
      // interval was armed. Retry at the actual silence boundary instead of
      // waiting for the following interval and turning 60s into ~120s.
      scheduleBoundaryCheck(minSilenceMs - silenceMs);
      return;
    }
    clearBoundaryCheck();
    inFlight = true;
    try {
      const message = formatProgressMessage(job, startedAt, sentAt, details?.() || '');
      await notify(job, status, message);
      lastMessageAt = sentAt;
    } catch (error) {
      if (onError) onError(error);
    } finally {
      inFlight = false;
    }
  };
  const timer = setIntervalFn(() => {
    notifyIfDue().catch((error) => {
      if (onError) onError(error);
    });
  }, intervalMs);
  timer?.unref?.();

  return {
    // Any delivered job message — including a forwarded progress update — pushes the
    // silence window forward, so the periodic `working for N minutes.` notice is
    // skipped for another full interval. That coupling is why PROGRESS_UPDATE_TYPES
    // above must stay limited to real worker output.
    markMessageSent(atMs = now()) {
      clearBoundaryCheck();
      lastMessageAt = atMs;
    },
    async flush({ force = false, status = 'progress' } = {}) {
      await notifyIfDue(status, { force });
    },
    stop() {
      clearIntervalFn(timer);
      clearBoundaryCheck();
    },
  };
}

function normalizeProgressUpdate(update) {
  const append = Boolean(update?.append);
  const type = String(update?.type || 'output').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) || 'output';
  if (!PROGRESS_UPDATE_TYPES.has(type)) return null;
  const worker = normalizeProgressWorker(update?.worker);
  if (!PROGRESS_WORKERS.has(worker)) return null;
  const rawText = stripProgressLabels(String(update?.text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, ''));
  const text = append ? rawText : rawText.trim();
  if (!text.trim()) return null;
  return {
    type,
    worker,
    append,
    text,
  };
}

function progressWorkerDisplay(details) {
  if (!details || typeof details !== 'object') return '';
  return String(details.workerDisplay || details.workerLabel || '').trim();
}

function normalizeProgressWorker(value) {
  const worker = String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  if (PROGRESS_WORKERS.has(worker)) return worker;
  for (const [prefix, normalized] of PROGRESS_WORKER_PREFIXES) {
    if (worker === prefix || worker.startsWith(`${prefix}-`) || worker.startsWith(`${prefix}_`)) {
      return normalized;
    }
  }
  return worker.slice(0, 40);
}

async function sendProgressDetails(details, { send, onSent, onError }) {
  try {
    await send(details);
    if (onSent) onSent();
    return true;
  } catch (error) {
    if (onError) onError(error);
    return false;
  }
}

function formatProgressUpdates(updates, { verbose = false } = {}) {
  const lines = [];
  for (const update of updates) {
    const text = summarizeProgressUpdate(update, { verbose });
    if (text) lines.push(text);
  }
  return cleanOutboundText(stripBridgeControlBlocksFromProgress(lines.join('\n')))
    .replace(/\n{2,}/g, '\n');
}

export function stripBridgeControlBlocksFromProgress(value) {
  return String(value || '')
    .replace(BRIDGE_CONTROL_BLOCK_PATTERN, '')
    .replace(TRAILING_BRIDGE_CONTROL_BLOCK_PATTERN, '');
}

function stripProgressLabels(text) {
  return cleanOutboundText(text, { trim: false, collapseBlankLines: false });
}

function summarizeProgressUpdate(update, { verbose = false } = {}) {
  const text = stripProgressLabels(update?.text || '').trim();
  if (!text) return '';
  if (verbose) return text;
  if (update?.type === 'tool_call' || update?.type === 'tool_output') return '';
  return text;
}
