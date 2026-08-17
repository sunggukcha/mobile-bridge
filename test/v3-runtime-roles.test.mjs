import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  receptionReloadRequired,
  runtimeRolesForChanges,
} from '../v3/lib/runtime-roles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('runtime changes restart only the roles that load those modules', () => {
  assert.equal(receptionReloadRequired('bridge-service.mjs'), false);
  assert.equal(receptionReloadRequired('v3/lib/reception-service.mjs'), true);
  assert.equal(receptionReloadRequired('lib/discord-api.mjs'), true);
  assert.deepEqual(runtimeRolesForChanges([
    'bridge-service.mjs',
    'lib/job-checkpoint.mjs',
  ]), {
    workbench: true,
    reception: false,
    futureWorkers: true,
    supervisor: false,
  });
  assert.deepEqual(runtimeRolesForChanges([
    'v3/lib/reception-service.mjs',
  ]), {
    workbench: true,
    reception: true,
    futureWorkers: true,
    supervisor: false,
  });
  assert.deepEqual(runtimeRolesForChanges([
    'lib/bridge-commands.mjs',
  ]), {
    workbench: true,
    reception: true,
    futureWorkers: true,
    supervisor: false,
  });
  assert.deepEqual(runtimeRolesForChanges([
    'lib/image-font.mjs',
    'v3/lib/role-health.mjs',
  ]), {
    workbench: true,
    reception: true,
    futureWorkers: true,
    supervisor: true,
  });
  assert.deepEqual(runtimeRolesForChanges([
    'v3/lib/runtime-roles.mjs',
  ]), {
    workbench: true,
    reception: false,
    futureWorkers: true,
    supervisor: true,
  });
});

test('Reception reload mapping covers every local module loaded by its entrypoint', () => {
  const dependencies = localModuleClosure('v3/reception.mjs');
  const uncovered = dependencies.filter((filePath) =>
    !receptionReloadRequired(filePath)
  );
  assert.deepEqual(uncovered, []);
});

test('Supervisor reload mapping covers every local module loaded by its entrypoint', () => {
  const dependencies = localModuleClosure('v3/supervisor.mjs');
  const uncovered = dependencies.filter((filePath) =>
    !runtimeRolesForChanges([filePath]).supervisor
  );
  assert.deepEqual(uncovered, []);
});

function localModuleClosure(entrypoint) {
  const seen = new Set();
  const visit = (relativePath) => {
    const normalized = String(relativePath).replace(/\\/g, '/');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const source = fs.readFileSync(path.join(repoRoot, normalized), 'utf8');
    const imports = source.matchAll(
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
    );
    for (const match of imports) {
      let dependency = path.posix.normalize(path.posix.join(
        path.posix.dirname(normalized),
        match[1],
      ));
      if (!path.posix.extname(dependency)) dependency += '.mjs';
      if (fs.existsSync(path.join(repoRoot, dependency))) visit(dependency);
    }
  };
  visit(entrypoint);
  return [...seen].sort();
}

test('an .env-only change restarts the roles that resolve it', () => {
  // `.env` is read once per process start, so the Supervisor generation that
  // owns the Workbench and Workers has to be replaced for a worker-chain or
  // scheduler switch to take effect.
  assert.equal(receptionReloadRequired('.env'), true);
  assert.equal(receptionReloadRequired('.env.example'), false);
  assert.deepEqual(runtimeRolesForChanges(['.env']), {
    workbench: true,
    reception: true,
    futureWorkers: true,
    supervisor: true,
  });
});
