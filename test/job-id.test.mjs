import assert from 'node:assert/strict';
import test from 'node:test';
import { continuationJobId, formatKstCompactTimestamp, rootJobId } from '../lib/job-id.mjs';

test('formatKstCompactTimestamp formats YYYYMMDDHHmmss in KST', () => {
  assert.equal(
    formatKstCompactTimestamp(new Date('2026-06-03T15:14:33.816Z')),
    '20260604001433',
  );
});

test('continuationJobId uses the root job id, compact KST timestamp, ms, and sequence', () => {
  const id = continuationJobId('1000000000000000006', new Date('2026-06-03T15:14:33.816Z'));
  assert.match(id, /^1000000000000000006_continue_20260604001433816\d{3}$/);
});

test('continuationJobId never collides for the same root job and instant', () => {
  const date = new Date('2026-06-03T15:14:33.816Z');
  const a = continuationJobId('1000000000000000006', date);
  const b = continuationJobId('1000000000000000006', date);
  assert.notEqual(a, b);
  assert.equal(rootJobId(a), '1000000000000000006');
});

test('rootJobId returns the source message id for continuation jobs', () => {
  assert.equal(rootJobId('1000000000000000006_continue_20260604001433'), '1000000000000000006');
  assert.equal(rootJobId('1000000000000000006'), '1000000000000000006');
});
