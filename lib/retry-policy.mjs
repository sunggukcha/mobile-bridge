const DEFAULT_BASE_DELAY_MS = 15_000;
const DEFAULT_MAX_DELAY_MS = 10 * 60_000;
const DEFAULT_SESSION_RESET_GRACE_MS = 5_000;
const DAY_MS = 24 * 60 * 60_000;

export function retryDelayMs(attempt, {
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
} = {}) {
  const normalizedAttempt = Math.max(1, Number.parseInt(attempt, 10) || 1);
  const exponential = baseDelayMs * 2 ** Math.min(normalizedAttempt - 1, 8);
  return Math.min(maxDelayMs, exponential);
}

// Claude reports a concrete local reset clock for session-limit failures, for
// example "resets 3:10am (Asia/Seoul)". Polling the same fixed worker every ten
// minutes before that clock only creates doomed processes and noisy retry logs.
// Preserve ordinary backoff for every other error, but sleep directly until
// the provider's next stated reset when one can be parsed safely.
export function retryDelayMsForError(error, attempt, {
  nowMs = Date.now(),
  resetGraceMs = DEFAULT_SESSION_RESET_GRACE_MS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
} = {}) {
  const backoffMs = retryDelayMs(attempt, { baseDelayMs, maxDelayMs });
  const resetAtMs = workerRetryAtMs(error, { nowMs });
  if (!Number.isFinite(resetAtMs)) return backoffMs;
  return Math.max(backoffMs, resetAtMs + Math.max(0, Number(resetGraceMs) || 0) - nowMs);
}

// Runtime workers expose retry windows in several shapes: a normalized error
// property, Retry-After-style durations, or Claude's local reset clock. Keep
// this parser shared by both job retry scheduling and the durable worker
// availability circuit so the two cannot disagree about when a probe is safe.
export function workerRetryAtMs(error, { nowMs = Date.now() } = {}) {
  const explicitRetryAtMs = finiteFutureMs(error?.workerAvailabilityRetryAtMs, nowMs)
    || finiteFutureMs(error?.retryAtMs, nowMs)
    || dateFutureMs(error?.retryAt, nowMs);
  if (Number.isFinite(explicitRetryAtMs)) return explicitRetryAtMs;

  const retryAfterMs = positiveFiniteMs(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs)) return nowMs + retryAfterMs;
  const retryAfterSeconds = positiveFiniteMs(error?.retryAfter);
  if (Number.isFinite(retryAfterSeconds)) return nowMs + retryAfterSeconds * 1_000;

  const text = normalizedJobErrorText(error);
  const durationMs = retryDurationMsFromText(text);
  if (Number.isFinite(durationMs)) return nowMs + durationMs;

  return sessionLimitResetAtMs(error, { nowMs });
}

export function shouldNotifyRetry(attempt) {
  const normalizedAttempt = Math.max(1, Number.parseInt(attempt, 10) || 1);
  return normalizedAttempt === 1 || normalizedAttempt === 3 || normalizedAttempt % 10 === 0;
}

export function isRecoverableJobStatus(status) {
  return ['queued', 'started', 'retry-scheduled', 'thread-lock-waiting', 'needs-runtime-restart'].includes(status);
}

export function isOperatorTerminatedError(error) {
  if (error?.timedOut) return false;
  if (error?.noProgressKilled) return false;
  // A worker aborted because a newer thread message superseded it is an
  // operator-initiated stop, not a runtime failure: never retry or fall back.
  if (error?.aborted) return true;
  // Bare SIGKILL is ambiguous: the kernel OOM killer also sends it. Every
  // bridge-initiated kill either sets `aborted` or happens during shutdown
  // (handled by shouldRecoverJobInterruptedByServiceShutdown), so treat an
  // unexplained SIGKILL as a runtime failure that retries instead of silently
  // abandoning the job.
  return String(error?.signal || '').toUpperCase() === 'SIGTERM';
}

export function isNonRetryableJobError(error) {
  if (error?.nonRetryable) return true;
  const text = normalizedJobErrorText(error);
  if (!text.trim()) return false;
  return text.includes('your organization has disabled claude subscription access for claude code')
    || (
      text.includes('disabled claude subscription access')
      && text.includes('use an anthropic api key instead')
    )
    || (
      text.includes('disabled claude subscription access')
      && text.includes('ask your admin to enable access')
    )
    || isGeminiUnsupportedClientError(error);
}

export function isGeminiUnsupportedClientError(error) {
  const text = normalizedJobErrorText(error);
  if (!text.trim()) return false;
  return (
    text.includes('ineligibletiererror')
    && text.includes('unsupported_client')
  ) || (
    text.includes('gemini code assist')
    && text.includes('no longer supported')
  ) || (
    text.includes('gemini code assist')
    && text.includes('unsupported_client')
  );
}

function normalizedJobErrorText(error) {
  return [
    error?.message,
    error?.stderr,
    error?.stdout,
    error?.code,
  ].filter(Boolean).join('\n').toLowerCase().replace(/\s+/g, ' ');
}

function retryDurationMsFromText(text) {
  if (!text) return null;
  const patterns = [
    /\bretry[- ]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i,
    /\b(?:retry|try again)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i,
    /\bresets?\s+in\s+(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number(match[1]);
    const multiplier = durationUnitMs(match[2]);
    const durationMs = value * multiplier;
    if (Number.isFinite(durationMs) && durationMs > 0) return durationMs;
  }
  const bareRetryAfterSeconds = Number(text.match(/\bretry-after\s*[:=]\s*(\d+(?:\.\d+)?)\b/i)?.[1]);
  if (Number.isFinite(bareRetryAfterSeconds) && bareRetryAfterSeconds > 0) {
    return bareRetryAfterSeconds * 1_000;
  }
  return null;
}

function durationUnitMs(unit) {
  const normalized = String(unit || '').toLowerCase();
  if (['millisecond', 'milliseconds', 'msec', 'msecs', 'ms'].includes(normalized)) return 1;
  if (['second', 'seconds', 'sec', 'secs', 's'].includes(normalized)) return 1_000;
  if (['minute', 'minutes', 'min', 'mins', 'm'].includes(normalized)) return 60_000;
  if (['hour', 'hours', 'hr', 'hrs', 'h'].includes(normalized)) return 60 * 60_000;
  return 0;
}

function finiteFutureMs(value, nowMs) {
  const number = Number(value);
  return Number.isFinite(number) && number > nowMs ? number : null;
}

function dateFutureMs(value, nowMs) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : null;
}

function positiveFiniteMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sessionLimitResetAtMs(error, { nowMs = Date.now() } = {}) {
  const text = normalizedJobErrorText(error);
  const match = text.match(/\b(?:session limit|hit your limit)\b.{0,200}?\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2] || '0', 10);
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  const hour = (hour12 % 12) + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  return nextZonedClockAtMs({ hour, minute, timeZone: match[4].trim(), nowMs });
}

function nextZonedClockAtMs({ hour, minute, timeZone, nowMs }) {
  const nowParts = zonedDateParts(nowMs, timeZone);
  if (!nowParts) return null;
  const localDayAsUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const localDay = new Date(localDayAsUtc + dayOffset * DAY_MS);
    const candidate = zonedLocalDateTimeAtMs({
      year: localDay.getUTCFullYear(),
      month: localDay.getUTCMonth() + 1,
      day: localDay.getUTCDate(),
      hour,
      minute,
      second: 0,
      timeZone,
    });
    if (Number.isFinite(candidate) && candidate > nowMs) return candidate;
  }
  return null;
}

function zonedLocalDateTimeAtMs({ year, month, day, hour, minute, second, timeZone }) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = targetAsUtc;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = zonedDateParts(candidate, timeZone);
    if (!observed) return null;
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    candidate = targetAsUtc - (observedAsUtc - candidate);
  }
  return candidate;
}

function zonedDateParts(epochMs, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(epochMs));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number.parseInt(values.year, 10),
      month: Number.parseInt(values.month, 10),
      day: Number.parseInt(values.day, 10),
      hour: Number.parseInt(values.hour, 10),
      minute: Number.parseInt(values.minute, 10),
      second: Number.parseInt(values.second, 10),
    };
  } catch {
    return null;
  }
}

export function shouldRecoverJobInterruptedByServiceShutdown(_error, shuttingDown) {
  // The shutdown state is authoritative. A worker can trap SIGTERM, print a
  // provider-looking error, and exit with code 1; in that case Node reports no
  // terminating signal even though the bridge restart caused the exit. Never
  // consume a fallback slot (or schedule a retry) after shutdown has begun.
  return Boolean(shuttingDown);
}

export const MAX_THREAD_CREATE_ATTEMPTS = 8;

// Discord permanently rejects thread creation for some source messages: code
// 50068 ("Invalid message type") is returned for message types that can never
// host a thread (system messages, polls, etc.). Retrying these is pure wasted
// load against the API, so the bridge must abandon instead of looping forever.
export function isNonRetryableThreadCreateError(error) {
  if (!error) return false;
  const text = `${error.message || ''} ${error.stderr || ''} ${error.body || ''}`.toLowerCase();
  if (!text.trim()) return false;
  return /"code"\s*:\s*50068\b/.test(text) || text.includes('invalid message type');
}

// Defense-in-depth ceiling so that ANY persistently failing thread creation
// eventually stops, even for error classes not matched above.
export function exceededThreadCreateAttempts(attempt, max = MAX_THREAD_CREATE_ATTEMPTS) {
  const normalizedAttempt = Math.max(1, Number.parseInt(attempt, 10) || 1);
  const normalizedMax = Math.max(1, Number.parseInt(max, 10) || MAX_THREAD_CREATE_ATTEMPTS);
  return normalizedAttempt > normalizedMax;
}
