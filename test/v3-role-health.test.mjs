import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoleHealthReporter } from '../v3/lib/role-health.mjs';

test('RoleHealthReporter keeps running when its fallback state file cannot be written', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-role-health-'));
  const systemPath = path.join(stateRoot, '_system');
  await fs.writeFile(systemPath, 'blocks the health directory');
  const errors = [];
  const reporter = new RoleHealthReporter({
    role: 'reception',
    stateRoot,
    intervalMs: 60_000,
    fallbackStopDrainTimeoutMs: 500,
    getStatus: () => ({ ready: true, phase: 'ready' }),
    onError: (error) => errors.push(error),
  });

  try {
    await reporter.start();
    assert.notEqual(reporter.timer, null);
    await waitFor(() => errors.length === 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].code, /^(EEXIST|ENOTDIR)$/);
  } finally {
    await reporter.stop();
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('RoleHealthReporter keeps sending primary heartbeats while a fallback write is blocked', async () => {
  const snapshots = [];
  const writes = [];
  let releaseFirstWrite;
  const firstWriteBlocked = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  let stopped = false;
  const reporter = new RoleHealthReporter({
    role: 'reception',
    stateRoot: os.tmpdir(),
    intervalMs: 60_000,
    fallbackStopDrainTimeoutMs: 500,
    getStatus: () => ({ ready: true, phase: 'ready' }),
    sendHeartbeat: (snapshot) => snapshots.push(snapshot),
    writeFallback: async (_filePath, snapshot) => {
      writes.push(snapshot);
      if (writes.length === 1) await firstWriteBlocked;
    },
  });

  try {
    await reporter.start();
    await waitFor(() => writes.length === 1);
    await reporter.requestPublish();
    let stopResolved = false;
    const stopPromise = reporter.stop({ signal: 'SIGTERM' })
      .then(() => { stopResolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(stopResolved, false, 'stop did not drain the pending fallback write');
    releaseFirstWrite();
    await stopPromise;
    stopped = true;

    assert.equal(
      snapshots.length,
      3,
      'a pending fallback write suppressed a newer IPC heartbeat',
    );
    assert.equal(writes.length, 2, 'fallback writes were not coalesced and drained');
    assert.equal(snapshots.at(-1).ready, false);
    assert.equal(
      writes.at(-1).ready,
      false,
      'the latest stopped snapshot was not retained for the fallback file',
    );
  } finally {
    releaseFirstWrite();
    if (!stopped) await reporter.stop();
  }
});

test('RoleHealthReporter throttles periodic fallback writes without throttling IPC', async () => {
  let nowMs = Date.parse('2026-08-12T00:00:00.000Z');
  const heartbeats = [];
  const writes = [];
  const reporter = new RoleHealthReporter({
    role: 'workbench',
    stateRoot: os.tmpdir(),
    intervalMs: 250,
    fallbackIntervalMs: 1_000,
    now: () => nowMs,
    getStatus: () => ({ ready: true, phase: 'ready' }),
    sendHeartbeat: (snapshot) => heartbeats.push(snapshot),
    writeFallback: async (_filePath, snapshot) => writes.push(snapshot),
  });

  try {
    await reporter.publish(null, { forceFallback: true });
    await waitFor(() => writes.length === 1);
    await reporter.publish();
    await reporter.publish();
    assert.equal(heartbeats.length, 3);
    assert.equal(writes.length, 1);

    nowMs += 1_001;
    await reporter.publish();
    await waitFor(() => writes.length === 2);
    assert.equal(heartbeats.length, 4);
  } finally {
    await reporter.stop();
  }
});

async function waitFor(probe, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
