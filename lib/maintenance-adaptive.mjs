// Dawn maintenance is the single largest scheduled consumer of the pinned
// maintenance worker's weekly quota. Running it unconditionally can spend the
// week's budget early and leave interactive work throttled for days.
//
// `adaptive` mode compares two fractions at run time:
//
//   remaining quota  : remainingPercent / 100        (how much budget is left)
//   remaining window : msUntilReset / windowDuration (how much of the week is left)
//
// Maintenance runs only while the budget is ahead of the clock. With five days
// left before a weekly reset, that means more than 5/7 of the quota must still
// be available; at 4/7 the run is deferred to the next night, by which point the
// threshold has dropped to 4/7 and a recovered budget passes again.

export const MAINTENANCE_MODES = Object.freeze(['on', 'off', 'adaptive']);
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const WEEKLY_WINDOW_KEY = 'weekly';

export function normalizeMaintenanceMode(mode, { enabledFallback = true } = {}) {
  const text = String(mode ?? '').trim().toLowerCase();
  if (MAINTENANCE_MODES.includes(text)) return text;
  // No explicit mode: preserve whatever the older boolean switch expressed.
  return enabledFallback ? 'on' : 'off';
}

// The quota that matters is the one belonging to the worker the maintenance
// chain actually starts with — checking a family that never runs maintenance
// would gate the run on an unrelated budget.
export function maintenanceQuotaWorkerId(maintenanceChain = [], { fallback = 'codex' } = {}) {
  for (const entry of Array.isArray(maintenanceChain) ? maintenanceChain : []) {
    const text = String(entry || '').trim().toLowerCase();
    if (!text) continue;
    if (text.startsWith('codex')) return 'codex';
    if (text.startsWith('claude')) return 'claude';
    if (text.startsWith('antigravity')) return 'antigravity';
    if (text.startsWith('gemini')) return 'gemini';
  }
  return fallback;
}

// Selected by the window's real duration, not by its key. A window's key comes
// from its position in the provider payload (`primary` → 5h, `secondary` →
// weekly), which does not always describe its length: a live Codex `prolite`
// account exposes a SINGLE 10080-minute (7 day) bucket under the `5h` key, so
// keying off the name found no weekly budget at all and the gate degraded to
// "quota unavailable" on every run.
export function weeklyQuotaWindow(usageSummary, workerId, {
  minDurationMins = 24 * 60,
} = {}) {
  const worker = (usageSummary?.workers || []).find((entry) => entry?.id === workerId);
  if (!worker) return null;
  const windows = (worker.windows || [])
    .filter((entry) => Number.isFinite(Number(entry?.remainingPercent)));
  if (windows.length === 0) return null;

  const longEnough = windows
    .filter((entry) => Number(entry.windowDurationMins) >= minDurationMins)
    .sort((a, b) => Number(b.windowDurationMins) - Number(a.windowDurationMins));
  if (longEnough.length > 0) return longEnough[0];

  // No durations reported: fall back to the positional name.
  return windows.find((entry) => entry.key === WEEKLY_WINDOW_KEY) || null;
}

export function adaptiveMaintenanceDecision({
  window,
  nowMs = Date.now(),
  workerId = null,
} = {}) {
  if (!window) {
    // Quota could not be read (probe failure, worker not logged in, no weekly
    // bucket). Fail closed: the point of adaptive mode is to protect the weekly
    // budget, and spending it blind defeats that. The skip is announced in the
    // general channel so an unreadable probe cannot go unnoticed.
    return {
      run: false,
      reason: 'quota-unavailable',
      workerId,
      remainingQuotaFraction: null,
      remainingTimeFraction: null,
      resetsAtMs: null,
    };
  }

  const windowMs = Number(window.windowDurationMins) > 0
    ? Number(window.windowDurationMins) * 60_000
    : WEEKLY_WINDOW_MS;
  const remainingQuotaFraction = clampFraction(Number(window.remainingPercent) / 100);
  // `Number(null)` is 0, which would read as "resets right now" and wrongly
  // remove all time pressure. A missing reset must stay missing.
  const resetsAtMs = window.resetsAtMs == null ? Number.NaN : Number(window.resetsAtMs);

  if (remainingQuotaFraction <= 0) {
    // Checked before the pace comparison: at the very end of a window both
    // fractions reach 0 and would compare as "on pace", but a worker with no
    // budget left cannot do the work at all.
    return {
      run: false,
      reason: 'quota-exhausted',
      workerId,
      remainingQuotaFraction: 0,
      remainingTimeFraction: null,
      resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
      windowMs,
    };
  }

  if (!Number.isFinite(resetsAtMs)) {
    // Budget is known but the reset instant is not, so the pace threshold cannot
    // be computed at all. Skip rather than guess: a deferred night is recovered
    // by the next run, which picks up everything at once.
    return {
      run: false,
      reason: 'reset-unknown',
      workerId,
      remainingQuotaFraction,
      remainingTimeFraction: null,
      resetsAtMs: null,
      windowMs,
    };
  }

  const msUntilReset = Math.min(Math.max(resetsAtMs - nowMs, 0), windowMs);
  const remainingTimeFraction = clampFraction(msUntilReset / windowMs);
  return {
    // Read as "not overspending": used quota must not exceed the elapsed share of
    // the window. The comparison has to include equality, because a freshly reset
    // window is exactly on pace (100% budget, 100% of the window left) and a
    // strict `>` would skip the first night of every week. Mid-window equality is
    // unreachable in practice — remainingPercent arrives as an integer.
    run: remainingQuotaFraction >= remainingTimeFraction,
    reason: 'quota-pace',
    workerId,
    remainingQuotaFraction,
    remainingTimeFraction,
    resetsAtMs,
    msUntilReset,
    windowMs,
  };
}

// The general-channel notice, for the skips a human has to know about: the pace
// rule could not be applied because the quota reading was incomplete. A skip on
// a well-measured budget is the feature working and stays in the log only.
const UNMEASURED_SKIP_NOTICES = new Map([
  ['quota-unavailable', '주간 쿼터를 읽을 수 없어'],
  ['reset-unknown', '주간 쿼터 리셋 시각을 읽을 수 없어'],
]);

export function adaptiveSkipNotice(decision) {
  if (!decision || decision.run) return null;
  const cause = UNMEASURED_SKIP_NOTICES.get(decision.reason);
  if (!cause) return null;
  const worker = decision.workerId || 'worker';
  return `새벽유지보수 미실행: ${worker} ${cause} 실행하지 않았습니다.`;
}

export function describeAdaptiveDecision(decision) {
  if (!decision) return '';
  const verdict = decision.run ? '실행' : '건너뜀';
  const worker = decision.workerId ? `${decision.workerId} ` : '';
  if (decision.reason === 'quota-unavailable') {
    return `${worker}주간 쿼터를 읽을 수 없어 ${verdict}`;
  }
  const quota = formatPercent(decision.remainingQuotaFraction);
  if (decision.reason === 'quota-exhausted') {
    return `${worker}주간 쿼터 소진 → ${verdict}`;
  }
  if (decision.reason === 'reset-unknown') {
    return `${worker}주간 쿼터 ${quota} 남음, 리셋 시각 미확인 → ${verdict}`;
  }
  const time = formatPercent(decision.remainingTimeFraction);
  const days = Number.isFinite(decision.msUntilReset)
    ? (decision.msUntilReset / 86_400_000).toFixed(1)
    : '?';
  return `${worker}주간 쿼터 ${quota} 남음 vs 리셋까지 ${time} (${days}일) → ${verdict}`;
}

function clampFraction(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function formatPercent(fraction) {
  if (!Number.isFinite(fraction)) return '?%';
  return `${Math.round(fraction * 1000) / 10}%`;
}
