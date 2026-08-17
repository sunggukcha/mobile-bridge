import assert from 'node:assert/strict';
import test from 'node:test';
import { delayUntil, nextDailyMaintenanceAtKst, nextWeekdayDailyRunAtKst } from '../lib/maintenance-schedule.mjs';

test('nextDailyMaintenanceAtKst returns today 03:00 KST before 03:00', () => {
  const next = nextDailyMaintenanceAtKst(new Date('2026-06-02T17:57:00.000Z'));

  assert.equal(next.toISOString(), '2026-06-02T18:00:00.000Z');
});

test('nextDailyMaintenanceAtKst returns tomorrow 03:00 KST after 03:00', () => {
  const next = nextDailyMaintenanceAtKst(new Date('2026-06-02T18:01:00.000Z'));

  assert.equal(next.toISOString(), '2026-06-03T18:00:00.000Z');
});

test('delayUntil never returns a negative delay', () => {
  assert.equal(delayUntil(new Date('2026-06-02T00:00:00.000Z'), new Date('2026-06-03T00:00:00.000Z')), 0);
});

test('nextWeekdayDailyRunAtKst skips Saturday and Sunday in KST', () => {
  assert.equal(
    nextWeekdayDailyRunAtKst(new Date('2026-06-19T01:00:00.000Z'), 9).toISOString(),
    '2026-06-22T00:00:00.000Z',
  );
  assert.equal(
    nextWeekdayDailyRunAtKst(new Date('2026-06-20T00:00:00.000Z'), 9).toISOString(),
    '2026-06-22T00:00:00.000Z',
  );
  assert.equal(
    nextWeekdayDailyRunAtKst(new Date('2026-06-21T00:00:00.000Z'), 9).toISOString(),
    '2026-06-22T00:00:00.000Z',
  );
  assert.equal(
    nextWeekdayDailyRunAtKst(new Date('2026-06-22T00:00:00.000Z'), 9).toISOString(),
    '2026-06-23T00:00:00.000Z',
  );
});
