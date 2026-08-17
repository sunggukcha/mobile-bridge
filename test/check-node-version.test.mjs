import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedNodeVersion } from '../scripts/check-node-version.mjs';

test('isSupportedNodeVersion enforces the SQLite-capable runtime floor', () => {
  for (const version of ['20.19.0', '22.12.0', '23.3.0', 'invalid']) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
  for (const version of ['22.13.0', '22.99.0', '23.4.0', '24.0.0', '25.1.0']) {
    assert.equal(isSupportedNodeVersion(version), true, version);
  }
});
