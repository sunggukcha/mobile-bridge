const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DAILY_MAINTENANCE_HOUR_KST = 3;

export function nextDailyMaintenanceAtKst(now = new Date(), hour = DEFAULT_DAILY_MAINTENANCE_HOUR_KST) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  let targetShiftedMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hour,
    0,
    0,
    0,
  );
  if (targetShiftedMs <= shifted.getTime()) targetShiftedMs += DAY_MS;
  return new Date(targetShiftedMs - KST_OFFSET_MS);
}

export function nextDailyRunAtKst(now = new Date(), hour = 4) {
  return nextDailyMaintenanceAtKst(now, hour);
}

export function nextWeekdayDailyRunAtKst(now = new Date(), hour = 4) {
  let runAt = nextDailyRunAtKst(now, hour);
  while (!isKstWeekday(runAt)) {
    runAt = new Date(runAt.getTime() + DAY_MS);
  }
  return runAt;
}

export function delayUntil(date, now = new Date()) {
  return Math.max(0, date.getTime() - now.getTime());
}

function isKstWeekday(date) {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  const day = shifted.getUTCDay();
  return day >= 1 && day <= 5;
}
