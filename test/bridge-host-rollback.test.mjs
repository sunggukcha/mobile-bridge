import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRepoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('failed v3 health gate restores a live v2 supervisor and service', {
  timeout: 30_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-rollback-'));
  const repoRoot = path.join(root, 'repo');
  const fakeBin = path.join(root, 'bin');
  const stateRoot = path.join(root, 'state');
  const doctorArgsPath = path.join(root, 'doctor-args.json');
  let initialSupervisor = null;
  let launcher = null;

  try {
    await fs.mkdir(path.join(repoRoot, 'v3'), { recursive: true });
    await fs.mkdir(fakeBin, { recursive: true });
    await Promise.all([
      copyExecutable(
        path.join(sourceRepoRoot, 'start-bridge-host.sh'),
        path.join(repoRoot, 'start-bridge-host.sh'),
      ),
      writeModule(
        path.join(repoRoot, 'bridge-service.mjs'),
        "setInterval(() => {}, 1000);\n",
      ),
      writeModule(
        path.join(repoRoot, 'bridge-supervisor.mjs'),
        fakeV2SupervisorSource(),
      ),
      writeModule(
        path.join(repoRoot, 'v3', 'doctor.mjs'),
        [
          "import fs from 'node:fs/promises';",
          "await fs.writeFile(process.env.DOCTOR_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
          '',
        ].join('\n'),
      ),
      writeModule(
        path.join(repoRoot, 'v3', 'health.mjs'),
        'process.exitCode = 1;\n',
      ),
      writeModule(
        path.join(repoRoot, 'v3', 'watchdog.mjs'),
        'setInterval(() => {}, 1000);\n',
      ),
      writeExecutable(
        path.join(fakeBin, 'pgrep'),
        filteredPgrepSource(),
      ),
    ]);

    initialSupervisor = spawn(
      process.execPath,
      [path.join(repoRoot, 'bridge-supervisor.mjs')],
      {
        cwd: repoRoot,
        detached: true,
        stdio: 'ignore',
      },
    );
    await waitFor(async () =>
      (await repoProcesses(repoRoot, 'bridge-service.mjs')).length > 0
    );

    launcher = spawn('bash', [path.join(repoRoot, 'start-bridge-host.sh')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        TEST_REPO_ROOT: repoRoot,
        BRIDGE_NODE_BIN: process.execPath,
        BRIDGE_RUNTIME_VERSION: 'v3',
        BRIDGE_RESTART_SCOPE: 'runtime',
        BRIDGE_STATE_ROOT: stateRoot,
        BRIDGE_STOP_GRACE_SECONDS: '2',
        V3_HEALTH_GATE_TIMEOUT_MS: '100',
        V3_PLATFORM_MODE: 'live',
        DOCTOR_ARGS_FILE: doctorArgsPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await childResult(launcher, { timeoutMs: 20_000 });
    launcher = null;

    assert.equal(result.code, 4, result.stderr);
    assert.match(
      result.stderr,
      /v2 was automatically restored and its service process is running/,
    );
    const doctorArgs = JSON.parse(await fs.readFile(doctorArgsPath, 'utf8'));
    assert.ok(doctorArgs.includes('--require-idle'));
    assert.ok(doctorArgs.includes('--probe-platforms'));

    const restored = await waitFor(async () => {
      const supervisors = await repoProcesses(
        repoRoot,
        'bridge-supervisor.mjs',
      );
      const services = await repoProcesses(repoRoot, 'bridge-service.mjs');
      return (
        supervisors.some((pid) => pid !== initialSupervisor.pid)
        && services.length > 0
      )
        ? { supervisors, services }
        : null;
    });
    assert.ok(restored.supervisors.length > 0);
    assert.ok(restored.services.length > 0);
    assert.equal(
      (await repoProcesses(repoRoot, 'v3/watchdog.mjs')).length,
      0,
    );
  } finally {
    launcher?.kill('SIGKILL');
    await stopRepoProcesses(repoRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function fakeV2SupervisorSource() {
  return [
    "import { spawn } from 'node:child_process';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const root = path.dirname(fileURLToPath(import.meta.url));",
    "const service = spawn(process.execPath, [path.join(root, 'bridge-service.mjs')], { stdio: 'ignore' });",
    'let stopping = false;',
    "for (const signal of ['SIGINT', 'SIGTERM']) {",
    '  process.once(signal, () => {',
    '    if (stopping) return;',
    '    stopping = true;',
    '    service.kill(signal);',
    '    process.exit(0);',
    '  });',
    '}',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
}

function filteredPgrepSource() {
  return [
    '#!/usr/bin/env bash',
    'set -u',
    'real_pgrep=/usr/bin/pgrep',
    'if [ "${1:-}" = "-P" ]; then',
    '  exec "$real_pgrep" "$@"',
    'fi',
    '"$real_pgrep" "$@" 2>/dev/null | while read -r pid; do',
    '  [ "$pid" != "$$" ] || continue',
    '  cmd="$(tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null || true)"',
    '  case "$cmd" in',
    '    *"$TEST_REPO_ROOT"*) printf "%s\\n" "$pid" ;;',
    '  esac',
    'done',
    '',
  ].join('\n');
}

async function copyExecutable(source, destination) {
  await fs.copyFile(source, destination);
  await fs.chmod(destination, 0o755);
}

async function writeModule(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode: 0o600 });
}

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o700 });
  await fs.chmod(filePath, 0o700);
}

async function childResult(child, { timeoutMs }) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let timer;
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`host launcher did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return { ...result, stdout, stderr };
}

async function repoProcesses(repoRoot, needle = '') {
  const entries = await fs.readdir('/proc', { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let command = '';
    try {
      command = (await fs.readFile(
        path.join('/proc', entry.name, 'cmdline'),
      )).toString().replaceAll('\0', ' ');
    } catch {
      continue;
    }
    if (
      command.includes(repoRoot)
      && (!needle || command.includes(needle))
    ) {
      matches.push(Number(entry.name));
    }
  }
  return matches;
}

async function stopRepoProcesses(repoRoot) {
  const pids = await repoProcesses(repoRoot);
  for (const pid of pids) signal(pid, 'SIGTERM');
  await delay(250);
  for (const pid of await repoProcesses(repoRoot)) signal(pid, 'SIGKILL');
}

function signal(pid, name) {
  try {
    process.kill(Number(pid), name);
  } catch {
    // The isolated test process may have exited between scan and signal.
  }
}

async function waitFor(probe, {
  timeoutMs = 8_000,
  intervalMs = 50,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
