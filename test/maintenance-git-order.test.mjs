import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('daily maintenance runs git sync before runtime restart short-circuit', async () => {
  const source = await fs.readFile('bridge-service.mjs', 'utf8');
  const gitSyncIndex = source.indexOf('maintenanceGitSummary = await runMaintenanceGitSync(job);');
  const runtimeRestartIndex = source.indexOf('runtimeChangedPaths.length > 0)');

  assert.notEqual(gitSyncIndex, -1);
  assert.notEqual(runtimeRestartIndex, -1);
  assert(gitSyncIndex < runtimeRestartIndex);
});

test('daily maintenance preserves changed paths for the v3 role handoff', async () => {
  const source = await fs.readFile('bridge-service.mjs', 'utf8');
  const start = source.indexOf('async function maybeRestartAfterMaintenanceGroup');
  const end = source.indexOf('\nasync function runMaintenanceGitSync', start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(
    source.slice(start, end),
    /requestServiceRestart\(\{[\s\S]*?source: 'daily-maintenance',[\s\S]*?runtimeChangedPaths,/,
  );
});
