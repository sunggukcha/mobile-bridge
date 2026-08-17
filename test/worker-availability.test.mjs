import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import {
  activeWorkerCooldown,
  classifyWorkerAvailabilityError,
  clearWorkerCooldown,
  recordWorkerAvailabilityFailure,
  workerAvailabilityFile,
  workerAvailabilityIdentity,
} from '../lib/worker-availability.mjs';

test('classifyWorkerAvailabilityError separates quota and capacity failures', () => {
  assert.deepEqual(
    classifyWorkerAvailabilityError(new Error("You've hit your limit · resets in 2 hours")),
    { kind: 'quota' },
  );
  assert.deepEqual(
    classifyWorkerAvailabilityError(new Error('provider overloaded: service unavailable (503)')),
    { kind: 'capacity' },
  );
  assert.equal(
    classifyWorkerAvailabilityError(new Error('worker produced no final message')),
    null,
  );
});

test('worker availability cooldown persists and stays scoped to account plus model family', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-worker-availability-'));
  const nowMs = Date.parse('2026-07-29T02:00:00.000Z');
  const env = {
    PROJECT_ROOT: temp,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    CLAUDE_SECONDARY_HOME: path.join(temp, '.bridge_state', 'claude-secondary'),
    WORKER_QUOTA_COOLDOWN_MS: '60000',
    WORKER_COOLDOWN_MAX_MS: String(4 * 60 * 60_000),
  };
  const config = loadConfig(env);
  const primaryOpus = {
    name: 'claude-opus-primary',
    worker: 'claude',
    model: 'claude-opus-5',
    claudeAccount: { id: 'primary' },
  };
  const secondaryOpus = {
    ...primaryOpus,
    name: 'claude-opus-secondary',
    claudeAccount: { id: 'secondary' },
  };
  const primaryFable = {
    ...primaryOpus,
    name: 'claude-fable-primary',
    model: 'claude-fable-5',
  };

  const recorded = await recordWorkerAvailabilityFailure(
    config,
    primaryOpus,
    new Error("You've hit your limit; retry after 2 hours"),
    { nowMs },
  );

  assert.equal(recorded.kind, 'quota');
  assert.equal(recorded.retryAt, '2026-07-29T04:00:00.000Z');
  assert.equal(recorded.key, workerAvailabilityIdentity(config, primaryOpus).key);

  // A fresh config object simulates a runtime restart: no in-memory cache is
  // involved, and the cooldown is recovered from the shared state file.
  const restartedConfig = loadConfig(env);
  assert.equal(
    (await activeWorkerCooldown(restartedConfig, primaryOpus, { nowMs: nowMs + 1_000 }))?.retryAt,
    recorded.retryAt,
  );
  assert.equal(
    await activeWorkerCooldown(restartedConfig, secondaryOpus, { nowMs: nowMs + 1_000 }),
    null,
  );
  assert.equal(
    await activeWorkerCooldown(restartedConfig, primaryFable, { nowMs: nowMs + 1_000 }),
    null,
  );

  assert.equal(
    await clearWorkerCooldown(restartedConfig, primaryOpus, { nowMs: nowMs + 2_000 }),
    true,
  );
  assert.equal(
    await activeWorkerCooldown(restartedConfig, primaryOpus, { nowMs: nowMs + 2_001 }),
    null,
  );

  await recordWorkerAvailabilityFailure(
    restartedConfig,
    primaryOpus,
    new Error('quota exhausted'),
    { nowMs: nowMs + 3_000 },
  );
  assert.equal(
    await activeWorkerCooldown(restartedConfig, primaryOpus, {
      nowMs: nowMs + 3_000 + 60_001,
    }),
    null,
  );
  const persisted = JSON.parse(await fs.readFile(workerAvailabilityFile(config), 'utf8'));
  assert.deepEqual(persisted.entries, {});
});
