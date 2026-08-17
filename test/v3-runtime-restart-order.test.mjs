import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RuntimeHandoffGate } from '../v3/lib/runtime-handoff.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('runtime handoff rejects retiring Reception readiness before and after classification', () => {
  const gate = new RuntimeHandoffGate();
  const retiringReception = { pid: 101, intentionalRestart: false };
  const replacementReception = { pid: 202, intentionalRestart: false };

  gate.begin();
  assert.equal(gate.blocked, true);
  assert.equal(
    gate.observeReceptionReady(retiringReception, { ready: true }),
    false,
    'old readiness must not release the classification barrier',
  );

  gate.waitForReceptionReplacement(retiringReception);
  retiringReception.intentionalRestart = true;
  assert.equal(gate.observeReceptionReady(retiringReception, { ready: true }), false);
  assert.equal(gate.observeReceptionReady(replacementReception, { ready: false }), false);
  assert.equal(gate.blocked, true);
  assert.equal(gate.observeReceptionReady(replacementReception, { ready: true }), true);
  assert.equal(gate.blocked, false);
});

test('Supervisor wires the runtime handoff barrier before asynchronous exit work', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'v3', 'supervisor.mjs'), 'utf8');
  const startRoleStart = source.indexOf('function startRole(role)');
  const startRoleEnd = source.indexOf('\nasync function handleRoleMessage', startRoleStart);
  const exitHandlerStart = source.indexOf('async function handleRoleExit');
  const firstExitAwait = source.indexOf('\n  await log(', exitHandlerStart);
  const healthStart = source.indexOf("if (role === 'reception') {");
  const healthEnd = source.indexOf("} else if (role === 'workbench')", healthStart);
  const exitStart = source.indexOf("if (role === 'workbench' && result.code === RESTART_EXIT_CODE)");
  const exitEnd = source.indexOf('\n  const delayMs =', exitStart);
  const restartStart = source.indexOf('function restartRole(role, reason)');
  const restartEnd = source.indexOf('\nasync function monitorRoles()', restartStart);

  assert.ok(startRoleStart >= 0 && startRoleEnd > startRoleStart);
  assert.ok(exitHandlerStart >= 0 && firstExitAwait > exitHandlerStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart);
  assert.ok(exitStart >= 0 && exitEnd > exitStart);
  assert.ok(restartStart >= 0 && restartEnd > restartStart);

  assert.match(
    source.slice(startRoleStart, startRoleEnd),
    /role === 'workbench' && runtimeHandoffGate\.blocked/,
  );
  assert.match(
    source.slice(exitHandlerStart, firstExitAwait),
    /runtimeHandoffGate\.begin\(\)/,
  );

  const healthSource = source.slice(healthStart, healthEnd);
  assert.match(
    healthSource,
    /runtimeHandoffGate\.observeReceptionReady\(state, message\.snapshot\)/,
  );
  assert.match(
    healthSource,
    /message\.snapshot\.ready[\s\S]*!runtimeHandoffGate\.blocked[\s\S]*!workbench\?\.child[\s\S]*startRole\('workbench'\)/,
  );

  const exitSource = source.slice(exitStart, exitEnd);
  assert.match(
    exitSource,
    /if \(affected\.reception\) \{[\s\S]*waitForReceptionReplacement\(roles\.get\('reception'\)\)[\s\S]*restartRole\('reception', 'runtime-source-change'\);[\s\S]*return;[\s\S]*\}/,
  );

  const restartSource = source.slice(restartStart, restartEnd);
  assert.match(restartSource, /state\.health = null;/);
  assert.match(restartSource, /reconcileWorkbenchAdmission\(`restart:\$\{role\}`\);/);
});
