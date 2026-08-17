import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('host launcher selects v2 or v3 without hard-coding the checkout path', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'start-bridge-host.sh'), 'utf8');

  assert.match(source, /BASH_SOURCE\[0\]/);
  assert.match(source, /pwd -P/);
  assert.match(source, /BRIDGE_RUNTIME_VERSION/);
  assert.match(source, /runtime_version="\$\{runtime_version:-v2\}"/);
  assert.match(source, /"\$repo\/v3\/watchdog\.mjs"/);
  assert.match(source, /V3_PLATFORM_MODE="\$platform_mode"/);
  assert.doesNotMatch(
    source,
    /^repo="\/mnt\/c\/Users\/Example\/Desktop\/codex\/mobile-codex-bridge"$/m,
  );
});

test('v3 promotion preflights, gates readiness, and restores v2 on failure', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'start-bridge-host.sh'), 'utf8');

  const doctor = source.indexOf('"$repo/v3/doctor.mjs"');
  const stopV2 = source.indexOf('kill -TERM $v2_service_pids');
  const launchV3 = source.indexOf('launch_v3_runtime');
  const healthGate = source.indexOf('"$repo/v3/health.mjs"');
  const restoreV2 = source.indexOf('launch_v2_runtime', healthGate);
  assert.ok(doctor >= 0 && doctor < stopV2, 'doctor must run before v2 is stopped');
  assert.ok(launchV3 >= 0 && launchV3 < healthGate);
  assert.ok(healthGate < restoreV2);
  assert.match(source, /doctor_args\+=\(--probe-platforms\)/);
  assert.match(source, /--wait-ms "\$health_gate_ms" --require-watchdog/);
  assert.match(source, /Automatic v2 rollback is blocked because a detached v3 Worker became active/);
  assert.match(source, /v2 was automatically restored and its service process is running/);
});

test('normal v3 runtime replacement preserves detached Workers', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'start-bridge-host.sh'), 'utf8');

  assert.match(source, /BRIDGE_RESTART_SCOPE/);
  assert.match(
    source,
    /if \[ "\$runtime_version" = "v2" \] \|\| \[ "\$restart_scope" = "full" \]; then/,
  );
  assert.match(source, /kill_pid_groups TERM \$v3_worker_pids/);
  assert.match(source, /kill_pid_groups KILL \$v2_descendant_pids \$v3_worker_descendant_pids/);

  const fullStop = source.indexOf('if [ "$restart_scope" = "full" ] && [ -n "$v3_worker_pids" ]');
  const workerTerm = source.indexOf('kill_pid_groups TERM $v3_worker_pids', fullStop);
  assert.notEqual(fullStop, -1);
  assert.notEqual(workerTerm, -1);
  assert.ok(fullStop < workerTerm);
});

test('host launcher refuses unsafe first cutover and rollback with active Workers', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'start-bridge-host.sh'), 'utf8');

  assert.match(source, /Refusing v2 -> v3 cutover while legacy Workers are active/);
  assert.match(source, /Refusing v3 -> v2 rollback while detached v3 Workers are active/);
  assert.match(source, /drain them or use BRIDGE_RESTART_SCOPE=full/);
  assert.match(source, /v2_descendant_pids="\$\(collect_descendants \$v2_service_pids\)"/);
  assert.match(source, /legacy_v2_descendant_pids=/);
  assert.match(source, /active_pids_excluding/);
  assert.match(source, /promotion_control_pids/);
  assert.match(source, /v3-promotion-launcher\.mjs/);
});

test('Windows host launcher does not use a login shell that can replace cwd', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'start-bridge-host.ps1'), 'utf8');

  assert.match(source, /--cd/);
  assert.match(source, /\$QuotedRepo/);
  assert.match(source, /"bash", "start-bridge-host\.sh"/);
  assert.doesNotMatch(source, /"-lc"/);
});

test('host launcher scopes supervisor discovery to this checkout', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'start-bridge-host.sh'), 'utf8');
  const start = source.indexOf('find_v2_supervisor_pids()');
  const end = source.indexOf('\nv2_service_pids=', start);
  const helper = source.slice(start, end);

  assert.match(helper, /find_repo_role_pids 'bridge-supervisor\.mjs'/);
  assert.match(helper, /pgrep -f -- "\$role"/);
  assert.match(helper, /readlink -f "\/proc\/\$pid\/cwd"/);
  assert.match(helper, /\[ "\$cwd" = "\$repo" \]/);
  assert.match(helper, /"\$role"\|"\.\/\$role"\|"\$repo\/\$role"/);
});
