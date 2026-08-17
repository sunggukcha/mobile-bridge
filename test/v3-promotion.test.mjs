import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  maybeScheduleV3Promotion,
  V3_PROMOTION_STATE_FILE,
} from '../lib/v3-promotion.mjs';

test('v2 service schedules one detached promotion coordinator per request id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-promotion-'));
  const repoRoot = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  const helper = path.join(repoRoot, 'scripts', 'v3-promotion-launcher.mjs');
  const spawns = [];
  try {
    await fs.mkdir(path.dirname(helper), { recursive: true });
    await fs.writeFile(helper, '// test helper\n');
    const spawnProcess = (command, args, options) => {
      spawns.push({ command, args, options });
      return { pid: 4321, unref() {} };
    };
    const options = {
      repoRoot,
      stateRoot,
      env: {
        BRIDGE_RUNTIME_ROLE: 'v2-service',
        BRIDGE_RUNTIME_VERSION: 'v3',
        V3_PLATFORM_MODE: 'live',
        V3_PROMOTION_REQUEST_ID: 'request-1',
      },
      spawnProcess,
      nodeBin: '/node',
      pidAlive: (pid) => pid === 4321,
      now: () => new Date('2026-07-31T08:00:00.000Z'),
    };

    const first = await maybeScheduleV3Promotion(options);
    const second = await maybeScheduleV3Promotion(options);

    assert.equal(first.scheduled, true);
    assert.equal(second.scheduled, false);
    assert.equal(second.reason, 'already-running');
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].options.detached, true);
    assert.equal(spawns[0].options.env.BRIDGE_RESTART_SCOPE, 'runtime');
    assert.equal(spawns[0].options.env.DATA_DIR, stateRoot);

    const state = JSON.parse(await fs.readFile(
      path.join(stateRoot, '_system', V3_PROMOTION_STATE_FILE),
      'utf8',
    ));
    assert.equal(state.requestId, 'request-1');
    assert.equal(state.status, 'scheduled');
    assert.equal(state.coordinatorPid, 4321);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promotion requires an explicit request id and never runs in Workbench', async () => {
  const withoutRequest = await maybeScheduleV3Promotion({
    repoRoot: '/tmp/unused',
    stateRoot: '/tmp/unused',
    runtimeRole: 'v2-service',
    env: { BRIDGE_RUNTIME_VERSION: 'v3' },
  });
  const workbench = await maybeScheduleV3Promotion({
    repoRoot: '/tmp/unused',
    stateRoot: '/tmp/unused',
    runtimeRole: 'v3-workbench',
    env: {
      BRIDGE_RUNTIME_VERSION: 'v3',
      V3_PROMOTION_REQUEST_ID: 'request-1',
    },
  });

  assert.equal(withoutRequest.reason, 'request-id-missing');
  assert.equal(workbench.reason, 'runtime-role-not-authorized');
});

test('a failed promotion is not retried until the request id changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-promotion-'));
  const repoRoot = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  const helper = path.join(repoRoot, 'scripts', 'v3-promotion-launcher.mjs');
  const statePath = path.join(stateRoot, '_system', V3_PROMOTION_STATE_FILE);
  let spawnCount = 0;
  try {
    await fs.mkdir(path.dirname(helper), { recursive: true });
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(helper, '// test helper\n');
    await fs.writeFile(statePath, JSON.stringify({
      requestId: 'request-1',
      status: 'failed',
      coordinatorPid: 9999,
    }));

    const result = await maybeScheduleV3Promotion({
      repoRoot,
      stateRoot,
      env: {
        BRIDGE_RUNTIME_ROLE: 'v2-service',
        BRIDGE_RUNTIME_VERSION: 'v3',
        V3_PROMOTION_REQUEST_ID: 'request-1',
      },
      spawnProcess: () => {
        spawnCount += 1;
        return { pid: 4321, unref() {} };
      },
      pidAlive: () => false,
    });

    assert.equal(result.scheduled, false);
    assert.equal(result.reason, 'already-failed');
    assert.equal(spawnCount, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
