import assert from 'node:assert/strict';
import test from 'node:test';
import { formatErrorDetail } from '../lib/error-detail.mjs';

test('formatErrorDetail includes nested fetch cause diagnostics', () => {
  const error = new TypeError('fetch failed', {
    cause: Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' }),
  });
  assert.equal(
    formatErrorDetail(error),
    'fetch failed cause=socket disconnected causeCode=ECONNRESET',
  );
});
