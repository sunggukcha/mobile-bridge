import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { defaultV3RuntimeRoot } from '../v3/lib/runtime-config.mjs';

test('defaultV3RuntimeRoot moves WSL DrvFS coordination state to native Linux storage', () => {
  const first = defaultV3RuntimeRoot({
    env: { HOME: '/home/example-user' },
    stateRoot: '/mnt/c/projects/.bridge_state',
    wsl: true,
  });
  const repeated = defaultV3RuntimeRoot({
    env: { HOME: '/home/example-user' },
    stateRoot: '/mnt/c/projects/.bridge_state',
    wsl: true,
  });
  const otherCheckout = defaultV3RuntimeRoot({
    env: { HOME: '/home/example-user' },
    stateRoot: '/mnt/c/other/.bridge_state',
    wsl: true,
  });

  assert.match(first, /^\/home\/example-user\/\.local\/state\/mobile-codex-bridge\/v3\/[a-f0-9]{16}$/);
  assert.equal(repeated, first);
  assert.notEqual(otherCheckout, first);
});

test('defaultV3RuntimeRoot keeps native and non-WSL state beside bridge state', () => {
  assert.equal(
    defaultV3RuntimeRoot({ stateRoot: '/srv/bridge-state', wsl: true }),
    path.join('/srv/bridge-state', '_v3'),
  );
  assert.equal(
    defaultV3RuntimeRoot({ stateRoot: '/mnt/c/projects/.bridge_state', wsl: false }),
    path.join('/mnt/c/projects/.bridge_state', '_v3'),
  );
});
