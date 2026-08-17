import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeReservationsFromEntries,
  dueReservationsFromEntries,
  formatReserveCommandUsage,
  formatReserveTimeLabel,
  parseReserveCommand,
  parseReserveTime,
} from '../lib/reserve-command.mjs';

test('parseReserveCommand parses quoted order, KST time, and model fallback sequence', () => {
  assert.deepEqual(
    parseReserveCommand('/reserve --time 2607062130 --model 0 2 --order "서버 스크립트 유지보수 이어서 해"'),
    {
      action: 'schedule',
      timeText: '2607062130',
      modelNumbers: ['0', '2'],
      order: '서버 스크립트 유지보수 이어서 해',
      verboseProgress: false,
      errors: [],
    },
  );
});

test('parseReserveCommand accepts -- separator for order text', () => {
  assert.deepEqual(
    parseReserveCommand('/예약 --time=202607062130 --model=0 -- 남은 유지보수 계속'),
    {
      action: 'schedule',
      timeText: '202607062130',
      modelNumbers: ['0'],
      order: '남은 유지보수 계속',
      verboseProgress: false,
      errors: [],
    },
  );
});

test('parseReserveCommand makes verbose progress explicit opt-in', () => {
  assert.equal(
    parseReserveCommand('/reserve --time 2607062130 --model 0 --verbose --order "continue"').verboseProgress,
    true,
  );
  assert.equal(
    parseReserveCommand('/reserve --time 2607062130 --model 0 --verbose=false --order "continue"').verboseProgress,
    false,
  );
});

test('parseReserveCommand reports missing required fields', () => {
  const parsed = parseReserveCommand('/reserve --model 0');

  assert.equal(parsed.action, 'schedule');
  assert.deepEqual(parsed.modelNumbers, ['0']);
  assert.equal(parsed.verboseProgress, false);
  assert.match(parsed.errors.join('\n'), /--time is required/);
  assert.match(parsed.errors.join('\n'), /--order is required/);
});

test('parseReserveTime parses YYMMDDHHmm and YYYYMMDDHHmm as KST', () => {
  const now = new Date('2026-07-06T00:00:00.000Z');

  assert.deepEqual(parseReserveTime('2607062130', { now }), {
    ok: true,
    scheduledAt: '2026-07-06T12:30:00.000Z',
    label: '2026-07-06 21:30 KST',
  });
  assert.deepEqual(parseReserveTime('202607062130', { now }), {
    ok: true,
    scheduledAt: '2026-07-06T12:30:00.000Z',
    label: '2026-07-06 21:30 KST',
  });
});

test('parseReserveTime rejects ambiguous or past times', () => {
  const now = new Date('2026-07-06T12:31:00.000Z');

  assert.equal(parseReserveTime('2130', { now }).ok, false);
  assert.equal(parseReserveTime('2607062130', { now }).ok, false);
});

test('reservation entry helpers keep latest active entries and find due work', () => {
  const entries = [
    { id: 'a', status: 'active', scheduledAt: '2026-07-06T12:30:00.000Z' },
    { id: 'b', status: 'active', scheduledAt: '2026-07-06T12:40:00.000Z' },
    { id: 'a', status: 'cancelled', scheduledAt: '2026-07-06T12:30:00.000Z' },
    { id: 'c', status: 'active', scheduledAt: '2026-07-06T12:20:00.000Z' },
  ];
  const now = new Date('2026-07-06T12:31:00.000Z');

  assert.deepEqual(activeReservationsFromEntries(entries, { now }).map((entry) => entry.id), ['c', 'b']);
  assert.deepEqual(dueReservationsFromEntries(entries, { now }).map((entry) => entry.id), ['c']);
});

test('formatReserveTimeLabel and usage text are stable', () => {
  assert.equal(formatReserveTimeLabel('2026-07-06T12:30:00.000Z'), '2026-07-06 21:30 KST');
  assert.match(formatReserveCommandUsage(), /\/reserve --time 2607062130 --model 0 --order/);
});
