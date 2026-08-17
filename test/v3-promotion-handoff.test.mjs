import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRepoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('service-descendant promotion coordinator hands v2 to a healthy v3 runtime', {
  timeout: 30_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-handoff-'));
  const repoRoot = path.join(root, 'repo');
  const fakeBin = path.join(root, 'bin');
  const stateRoot = path.join(root, 'state');
  const statePath = path.join(stateRoot, '_system', 'v3-promotion.json');
  const notifications = [];
  const notificationServer = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    notifications.push({
      method: request.method,
      url: request.url,
      body: JSON.parse(body || '{}'),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'promotion-notice-1' }));
  });
  let supervisor = null;

  try {
    await listen(notificationServer);
    const notificationAddress = notificationServer.address();
    await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'v3'), { recursive: true });
    await fs.mkdir(fakeBin, { recursive: true });
    await Promise.all([
      copyExecutable(
        path.join(sourceRepoRoot, 'start-bridge-host.sh'),
        path.join(repoRoot, 'start-bridge-host.sh'),
      ),
      fs.copyFile(
        path.join(sourceRepoRoot, 'scripts', 'v3-promotion-launcher.mjs'),
        path.join(repoRoot, 'scripts', 'v3-promotion-launcher.mjs'),
      ),
      writeModule(
        path.join(repoRoot, 'bridge-service.mjs'),
        fakeV2ServiceSource(),
      ),
      writeModule(
        path.join(repoRoot, 'bridge-supervisor.mjs'),
        fakeV2SupervisorSource(),
      ),
      writeModule(path.join(repoRoot, 'v3', 'doctor.mjs'), ''),
      writeModule(path.join(repoRoot, 'v3', 'health.mjs'), ''),
      writeModule(
        path.join(repoRoot, 'v3', 'watchdog.mjs'),
        'setInterval(() => {}, 1000);\n',
      ),
      writeExecutable(
        path.join(fakeBin, 'pgrep'),
        filteredPgrepSource(),
      ),
    ]);

    supervisor = spawn(
      process.execPath,
      [path.join(repoRoot, 'bridge-supervisor.mjs')],
      {
        cwd: repoRoot,
        detached: true,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
          TEST_REPO_ROOT: repoRoot,
          BRIDGE_NODE_BIN: process.execPath,
          BRIDGE_RUNTIME_VERSION: 'v3',
          BRIDGE_RESTART_SCOPE: 'runtime',
          BRIDGE_STATE_ROOT: stateRoot,
          DATA_DIR: stateRoot,
          BRIDGE_STOP_GRACE_SECONDS: '2',
          V3_HEALTH_GATE_TIMEOUT_MS: '100',
          V3_PLATFORM_MODE: 'console',
          V3_PROMOTION_REPO_ROOT: repoRoot,
          V3_PROMOTION_REQUEST_ID: 'handoff-test',
          V3_PROMOTION_NOTIFY_DISCORD_CHANNEL_ID: 'thread-1',
          DISCORD_BOT_TOKEN: 'test-token',
          DISCORD_API_BASE_URL:
            `http://127.0.0.1:${notificationAddress.port}`,
        },
        stdio: 'ignore',
      },
    );

    const promoted = await waitFor(async () => {
      const state = await readJson(statePath).catch(() => null);
      return state?.status === 'succeeded' && state?.notification
        ? state
        : null;
    }, { timeoutMs: 20_000 });
    assert.equal(promoted.exitCode, 0);
    assert.equal(promoted.notification.status, 'delivered');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].method, 'POST');
    assert.equal(notifications[0].url, '/channels/thread-1/messages');
    assert.match(notifications[0].body.content, /v3 전환 완료/);
    assert.equal(
      (await repoProcesses(repoRoot, 'bridge-supervisor.mjs')).length,
      0,
    );
    assert.equal(
      (await repoProcesses(repoRoot, 'bridge-service.mjs')).length,
      0,
    );
    assert.ok(
      (await repoProcesses(repoRoot, 'v3/watchdog.mjs')).length > 0,
    );
  } finally {
    supervisor?.kill('SIGKILL');
    await stopRepoProcesses(repoRoot);
    await closeServer(notificationServer);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function fakeV2ServiceSource() {
  return [
    "import { spawn } from 'node:child_process';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const root = path.dirname(fileURLToPath(import.meta.url));",
    'const coordinator = spawn(',
    '  process.execPath,',
    "  [path.join(root, 'scripts', 'v3-promotion-launcher.mjs')],",
    '  { cwd: root, env: process.env, detached: true, stdio: "ignore" },',
    ');',
    'coordinator.unref();',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
}

function fakeV2SupervisorSource() {
  return [
    "import { spawn } from 'node:child_process';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const root = path.dirname(fileURLToPath(import.meta.url));",
    "const service = spawn(process.execPath, [path.join(root, 'bridge-service.mjs')], { env: process.env, stdio: 'ignore' });",
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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function repoProcesses(repoRoot, scriptName) {
  const procEntries = await fs.readdir('/proc', { withFileTypes: true });
  const matches = [];
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let command = '';
    try {
      command = (await fs.readFile(`/proc/${entry.name}/cmdline`, 'utf8'))
        .replace(/\0/g, ' ');
    } catch {
      continue;
    }
    if (command.includes(repoRoot) && command.includes(scriptName)) {
      matches.push(Number(entry.name));
    }
  }
  return matches;
}

async function stopRepoProcesses(repoRoot) {
  const pids = await repoProcesses(repoRoot, '.mjs');
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
}

async function waitFor(check, {
  timeoutMs = 5_000,
  intervalMs = 50,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}
