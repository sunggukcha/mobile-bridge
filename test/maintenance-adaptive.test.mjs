import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAINTENANCE_MODES,
  WEEKLY_WINDOW_MS,
  adaptiveMaintenanceDecision,
  adaptiveSkipNotice,
  describeAdaptiveDecision,
  maintenanceQuotaWorkerId,
  normalizeMaintenanceMode,
  weeklyQuotaWindow,
} from '../lib/maintenance-adaptive.mjs';
import { loadConfig } from '../lib/config.mjs';

const NOW = Date.parse('2026-08-05T18:00:00.000Z');
const DAY_MS = 86_400_000;

function weeklyWindow({ remainingPercent, daysUntilReset = 5, windowDurationMins = 10_080 }) {
  return {
    key: 'weekly',
    label: '주간',
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAtMs: NOW + daysUntilReset * DAY_MS,
    windowDurationMins,
  };
}

test('mode falls back to the older boolean switch when unset', () => {
  assert.equal(normalizeMaintenanceMode(undefined, { enabledFallback: true }), 'on');
  assert.equal(normalizeMaintenanceMode(undefined, { enabledFallback: false }), 'off');
  assert.equal(normalizeMaintenanceMode('', { enabledFallback: false }), 'off');
  // An explicit mode always wins over the legacy boolean.
  assert.equal(normalizeMaintenanceMode('adaptive', { enabledFallback: false }), 'adaptive');
  assert.equal(normalizeMaintenanceMode('OFF', { enabledFallback: true }), 'off');
  assert.equal(normalizeMaintenanceMode(' Adaptive ', { enabledFallback: true }), 'adaptive');
  // Garbage must not silently become a real mode.
  assert.equal(normalizeMaintenanceMode('sometimes', { enabledFallback: true }), 'on');
  assert.deepEqual(MAINTENANCE_MODES, ['on', 'off', 'adaptive']);
});

test('config exposes the mode and still schedules for adaptive', () => {
  const off = loadConfig({ DAILY_MAINTENANCE_MODE: 'off' });
  assert.equal(off.maintenance.mode, 'off');
  assert.equal(off.maintenance.enabled, false);

  const adaptive = loadConfig({ DAILY_MAINTENANCE_MODE: 'adaptive' });
  assert.equal(adaptive.maintenance.mode, 'adaptive');
  // Scheduling must still arm; the gate decides per run.
  assert.equal(adaptive.maintenance.enabled, true);

  const legacyOff = loadConfig({ DAILY_MAINTENANCE_ENABLED: 'false' });
  assert.equal(legacyOff.maintenance.mode, 'off');
  assert.equal(legacyOff.maintenance.enabled, false);

  const explicitBeatsLegacy = loadConfig({
    DAILY_MAINTENANCE_ENABLED: 'false',
    DAILY_MAINTENANCE_MODE: 'adaptive',
  });
  assert.equal(explicitBeatsLegacy.maintenance.mode, 'adaptive');
  assert.equal(explicitBeatsLegacy.maintenance.enabled, true);
});

test('the quota checked belongs to the worker the maintenance chain starts with', () => {
  assert.equal(maintenanceQuotaWorkerId(['codex-sol']), 'codex');
  assert.equal(maintenanceQuotaWorkerId(['codex-terra', 'claude-opus']), 'codex');
  assert.equal(maintenanceQuotaWorkerId(['claude-fable', 'codex-sol']), 'claude');
  assert.equal(maintenanceQuotaWorkerId([]), 'codex');
  assert.equal(maintenanceQuotaWorkerId(undefined), 'codex');
  assert.equal(maintenanceQuotaWorkerId(['', 'claude-opus']), 'claude');
});

test('the weekly window is picked out of a live usage summary', () => {
  const summary = {
    workers: [
      { id: 'claude', windows: [{ key: 'weekly', remainingPercent: 10 }] },
      {
        id: 'codex',
        windows: [
          { key: '5h', remainingPercent: 90 },
          { key: 'weekly', remainingPercent: 42 },
        ],
      },
    ],
  };
  assert.equal(weeklyQuotaWindow(summary, 'codex').remainingPercent, 42);
  assert.equal(weeklyQuotaWindow(summary, 'claude').remainingPercent, 10);
  assert.equal(weeklyQuotaWindow(summary, 'gemini'), null);
  assert.equal(weeklyQuotaWindow(null, 'codex'), null);
  // A worker with no weekly bucket (5h only) is not usable for the pace check.
  assert.equal(
    weeklyQuotaWindow({ workers: [{ id: 'codex', windows: [{ key: '5h', remainingPercent: 80 }] }] }, 'codex'),
    null,
  );
});

test('the weekly window is chosen by real duration, not by its positional key', () => {
  // Observed live on a Codex `prolite` account: one single 10080-minute bucket
  // reported under the `5h` key. Keying off the name found nothing.
  const singleBucket = {
    workers: [{
      id: 'codex',
      windows: [{ key: '5h', remainingPercent: 25, windowDurationMins: 10_080, resetsAtMs: NOW + 2 * DAY_MS }],
    }],
  };
  const picked = weeklyQuotaWindow(singleBucket, 'codex');
  assert.equal(picked?.remainingPercent, 25);
  assert.equal(picked?.windowDurationMins, 10_080);

  // With both buckets present the longer one wins regardless of order.
  const bothBuckets = {
    workers: [{
      id: 'codex',
      windows: [
        { key: 'weekly', remainingPercent: 40, windowDurationMins: 10_080 },
        { key: '5h', remainingPercent: 90, windowDurationMins: 300 },
      ],
    }],
  };
  assert.equal(weeklyQuotaWindow(bothBuckets, 'codex').remainingPercent, 40);

  // A genuine 5-hour-only account has no weekly budget to pace against.
  const shortOnly = {
    workers: [{ id: 'codex', windows: [{ key: '5h', remainingPercent: 90, windowDurationMins: 300 }] }],
  };
  assert.equal(weeklyQuotaWindow(shortOnly, 'codex'), null);
});

test('maintenance runs while the budget is ahead of the reset clock', () => {
  // 5 days to reset => threshold 5/7 ≈ 71.4%.
  const decision = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 80, daysUntilReset: 5 }),
    nowMs: NOW,
    workerId: 'codex',
  });
  assert.equal(decision.run, true);
  assert.equal(decision.reason, 'quota-pace');
  assert.equal(Math.round(decision.remainingTimeFraction * 1000) / 1000, 0.714);
  assert.equal(decision.remainingQuotaFraction, 0.8);
});

test('maintenance is deferred while the budget is behind the reset clock', () => {
  const decision = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 60, daysUntilReset: 5 }),
    nowMs: NOW,
    workerId: 'codex',
  });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, 'quota-pace');
});

test('exactly on pace runs, so a freshly reset window is not skipped', () => {
  // Equality has to count as "not overspending": at 100% budget with the whole
  // window ahead both fractions are 1.0, and a strict comparison would skip the
  // first night after every reset.
  const decision = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 500 / 7, daysUntilReset: 5 }),
    nowMs: NOW,
  });
  assert.equal(decision.run, true);

  // One percent under pace still defers.
  const under = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 500 / 7 - 1, daysUntilReset: 5 }),
    nowMs: NOW,
  });
  assert.equal(under.run, false);
});

test('the threshold relaxes as the reset approaches', () => {
  const window = (days) => weeklyWindow({ remainingPercent: 30, daysUntilReset: days });
  // 30% budget left is behind pace with 5 days to go, ahead of it with 1.
  assert.equal(adaptiveMaintenanceDecision({ window: window(5), nowMs: NOW }).run, false);
  assert.equal(adaptiveMaintenanceDecision({ window: window(2), nowMs: NOW }).run, true);
  assert.equal(adaptiveMaintenanceDecision({ window: window(1), nowMs: NOW }).run, true);
});

test('an exhausted budget never runs, even moments before reset', () => {
  // Both fractions reach 0 at the end of a window and would compare as "on
  // pace", so exhaustion needs its own guard.
  const decision = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 0, daysUntilReset: 0 }),
    nowMs: NOW,
    workerId: 'codex',
  });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, 'quota-exhausted');
  assert.match(describeAdaptiveDecision(decision), /소진/);

  // Also exhausted well before the reset.
  assert.equal(
    adaptiveMaintenanceDecision({
      window: weeklyWindow({ remainingPercent: 0, daysUntilReset: 4 }),
      nowMs: NOW,
    }).run,
    false,
  );
});

test('a full budget runs even at the start of a fresh window', () => {
  const decision = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 100, daysUntilReset: 7 }),
    nowMs: NOW,
  });
  assert.equal(decision.run, true);
});

test('a reset already in the past is treated as no time pressure', () => {
  const decision = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 5, daysUntilReset: -3 }),
    nowMs: NOW,
  });
  assert.equal(decision.remainingTimeFraction, 0);
  assert.equal(decision.run, true);
});

test('unreadable quota fails closed rather than spending the budget blind', () => {
  const decision = adaptiveMaintenanceDecision({ window: null, workerId: 'codex' });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, 'quota-unavailable');
  assert.equal(decision.remainingQuotaFraction, null);
  // The caller keys the general-channel notice off this reason, so the wording
  // must stay recognizable.
  assert.match(describeAdaptiveDecision(decision), /읽을 수 없어/);
  assert.match(describeAdaptiveDecision(decision), /건너뜀/);
});

test('a worker missing from the summary also fails closed', () => {
  const summary = { workers: [{ id: 'claude', windows: [{ key: 'weekly', remainingPercent: 90 }] }] };
  const decision = adaptiveMaintenanceDecision({
    window: weeklyQuotaWindow(summary, 'codex'),
    workerId: 'codex',
  });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, 'quota-unavailable');
});

test('a known budget with an unknown reset also skips, since the rule cannot be applied', () => {
  const base = weeklyWindow({ remainingPercent: 40 });
  for (const resetsAtMs of [null, undefined, Number.NaN, 'not-a-date']) {
    const decision = adaptiveMaintenanceDecision({
      window: { ...base, resetsAtMs },
      nowMs: NOW,
      workerId: 'codex',
    });
    assert.equal(decision.reason, 'reset-unknown', `resetsAtMs=${String(resetsAtMs)}`);
    assert.equal(decision.run, false);
    // Budget stays reported even though the pace could not be computed.
    assert.equal(decision.remainingQuotaFraction, 0.4);
  }
});

test('the real window length is honoured instead of assuming seven days', () => {
  // A 14-day window with 5 days left is only 5/14 elapsed-remaining, so a 40%
  // budget is ahead of pace even though it would be behind on a weekly window.
  const decision = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 40, daysUntilReset: 5, windowDurationMins: 20_160 }),
    nowMs: NOW,
  });
  assert.equal(decision.run, true);
  assert.equal(decision.windowMs, 14 * DAY_MS);

  const weekly = adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 40, daysUntilReset: 5, windowDurationMins: null }),
    nowMs: NOW,
  });
  assert.equal(weekly.windowMs, WEEKLY_WINDOW_MS);
  assert.equal(weekly.run, false);
});

test('only an unmeasured skip produces a general-channel notice', () => {
  const notice = (decision) => adaptiveSkipNotice(decision);

  // Incomplete quota reading: the operator has to know the probe is degraded.
  const unavailable = notice(adaptiveMaintenanceDecision({ window: null, workerId: 'codex' }));
  assert.match(unavailable, /^새벽유지보수 미실행: codex 주간 쿼터를 읽을 수 없어 실행하지 않았습니다\.$/);

  const resetUnknown = notice(adaptiveMaintenanceDecision({
    window: { ...weeklyWindow({ remainingPercent: 40 }), resetsAtMs: null },
    nowMs: NOW,
    workerId: 'codex',
  }));
  assert.match(resetUnknown, /리셋 시각을 읽을 수 없어 실행하지 않았습니다\.$/);

  // A measured skip is the feature working; it must stay out of the channel.
  assert.equal(
    notice(adaptiveMaintenanceDecision({
      window: weeklyWindow({ remainingPercent: 60, daysUntilReset: 5 }),
      nowMs: NOW,
      workerId: 'codex',
    })),
    null,
  );
  assert.equal(
    notice(adaptiveMaintenanceDecision({
      window: weeklyWindow({ remainingPercent: 0, daysUntilReset: 3 }),
      nowMs: NOW,
      workerId: 'codex',
    })),
    null,
  );
  // A run never notifies.
  assert.equal(
    notice(adaptiveMaintenanceDecision({
      window: weeklyWindow({ remainingPercent: 90, daysUntilReset: 5 }),
      nowMs: NOW,
      workerId: 'codex',
    })),
    null,
  );
  assert.equal(notice(null), null);
});

test('the decision summary states both fractions and the verdict', () => {
  const skipped = describeAdaptiveDecision(adaptiveMaintenanceDecision({
    window: weeklyWindow({ remainingPercent: 60, daysUntilReset: 5 }),
    nowMs: NOW,
    workerId: 'codex',
  }));
  assert.match(skipped, /codex/);
  assert.match(skipped, /60%/);
  assert.match(skipped, /71\.4%/);
  assert.match(skipped, /5\.0일/);
  assert.match(skipped, /건너뜀/);

  const unavailable = describeAdaptiveDecision(
    adaptiveMaintenanceDecision({ window: null, workerId: 'codex' }),
  );
  assert.match(unavailable, /읽을 수 없어/);
  assert.match(unavailable, /건너뜀/);
});
