#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MIGRATION_SENTINEL } from '../lib/state-migration.mjs';
import { DurableBus } from './lib/durable-bus.mjs';
import { probeV3Health } from './health.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providers = argumentValue('--providers', 'codex,claude')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter((value) => ['codex', 'claude'].includes(value));
const timeoutMs = Math.max(
  30_000,
  Number.parseInt(argumentValue('--timeout-ms', '300000'), 10) || 300_000,
);
const keepState = process.argv.includes('--keep-state');
const jsonOutput = process.argv.includes('--json');
const replaceWorkbench = process.argv.includes('--replace-workbench');
// Recovery discovery mirrors the Discord state layout, whose channel IDs are
// numeric Snowflakes. Keep the synthetic canary channel in that same shape so
// a generation handoff exercises recovery rather than an invalid path fixture.
const canaryChannelId = '1000000000000000000';
const holdSeconds = Math.max(
  3,
  Number.parseInt(argumentValue('--hold-seconds', '12'), 10) || 12,
);
if (providers.length === 0) {
  throw new Error('v3 canary requires codex and/or claude providers');
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-canary-'));
const stateRoot = path.join(root, 'state');
const workspace = path.join(root, 'workspace');
const sourceStateRoot = path.resolve(
  process.env.BRIDGE_STATE_ROOT
  || path.join(repoRoot, '..', '.bridge_state'),
);
const env = {
  ...process.env,
  PROJECT_ROOT: root,
  // loadConfig gives DATA_DIR precedence over BRIDGE_STATE_ROOT. Explicitly
  // replace both so a canary launched from the live bridge environment can
  // never acquire the production state root or its runtime locks.
  DATA_DIR: stateRoot,
  BRIDGE_STATE_ROOT: stateRoot,
  CODEX_WORKING_DIR: workspace,
  CODEX_ALLOWED_ROOTS: workspace,
  BRIDGE_CODEX_HOME: process.env.BRIDGE_CODEX_HOME
    || process.env.CODEX_HOME
    || path.join(sourceStateRoot, 'codex-home'),
  CODEX_REASONING_EFFORT: 'low',
  CLAUDE_EFFORT: 'low',
  CLAUDE_BIN: process.env.CLAUDE_BIN
    || path.join(sourceStateRoot, 'worker-tools', 'node_modules', '.bin', 'claude'),
  CLAUDE_HOME: process.env.CLAUDE_HOME
    || path.join(sourceStateRoot, 'claude-home'),
  DISCORD_ENABLED: 'false',
  SLACK_ENABLED: 'false',
  DAILY_MAINTENANCE_ENABLED: 'false',
  DAILY_REPORTS_ENABLED: 'false',
  CHANNEL_PYTHON_VENV_ENABLED: 'false',
  V3_STATE_ROOT: path.join(root, 'v3'),
  V3_DB_PATH: path.join(root, 'v3', 'coordination.sqlite'),
  V3_RUNTIME_SECRET_ROOT: path.join(root, 'secrets'),
  V3_INTERNAL_TOKEN: randomBytes(32).toString('base64url'),
  V3_RECEPTION_PORT: '0',
  V3_WORKBENCH_PORT: '0',
  // Prevent repository .env URLs from redirecting an isolated canary to the
  // live sockets. The supervisor replaces these with the actual ephemeral
  // addresses after Reception and Workbench bind.
  V3_RECEPTION_URL: 'ws://127.0.0.1:0',
  V3_WORKBENCH_URL: 'ws://127.0.0.1:0',
  V3_PLATFORM_MODE: 'console',
  V3_WORKER_MODE: 'agent',
  V3_POLL_INTERVAL_MS: '50',
  V3_HEALTH_HEARTBEAT_MS: '250',
  V3_HEALTH_STALE_MS: '3000',
  V3_ROLE_STARTUP_TIMEOUT_MS: '30000',
  V3_UNHEALTHY_GRACE_MS: '5000',
  V3_WATCHDOG_POLL_MS: '250',
  V3_LEASE_TTL_MS: '3000',
  V3_LEASE_RENEW_MS: '500',
  V3_WORKER_HEARTBEAT_MS: '500',
  BRIDGE_CATCHUP_WINDOW_MS: '0',
  NODE_NO_WARNINGS: '1',
};

// Canary state must stay isolated from the checkout's legacy `.state`.
// Mark the empty temporary root as intentionally migrated so startup measures
// v3 lifecycle/provider health instead of copying production history.
await fs.mkdir(stateRoot, { recursive: true });
await fs.writeFile(
  path.join(stateRoot, MIGRATION_SENTINEL),
  `${new Date().toISOString()}\n`,
);
await fs.mkdir(workspace, { recursive: true });
if (providers.includes('claude')) {
  await fs.access(env.CLAUDE_BIN);
}

const watchdog = spawn(
  process.execPath,
  [path.join(repoRoot, 'v3', 'watchdog.mjs')],
  {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let runtimeOutput = '';
watchdog.stdout.on('data', (chunk) => {
  runtimeOutput = appendTail(runtimeOutput, chunk);
});
watchdog.stderr.on('data', (chunk) => {
  runtimeOutput = appendTail(runtimeOutput, chunk);
});

const report = {
  ok: false,
  startedAt: new Date().toISOString(),
  stateRoot,
  providers: [],
};

try {
  const health = await waitFor(async () => {
    const current = await probeV3Health({
      env,
      repoRoot,
      requireWatchdog: true,
    });
    return current.ok ? current : null;
  }, { timeoutMs: Math.min(timeoutMs, 60_000) });
  env.V3_RECEPTION_URL = health.supervisor.activeReceptionUrl;

  for (const provider of providers) {
    const selector = argumentValue(`--${provider}-model`, provider);
    const marker = `V3_${provider.toUpperCase()}_CANARY_OK`;
    const jobId = `v3-canary-${provider}-${Date.now()}`;
    const startedAtMs = Date.now();
    const instruction = replaceWorkbench
      ? `Use the terminal once to run "sleep ${holdSeconds}". After it finishes, reply with exactly ${marker}. Do not perform any other action.`
      : `Health-check only. Do not use tools or edit files. Reply with exactly ${marker}.`;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, 'v3', 'submit.mjs'),
        '--job',
        jobId,
        '--channel',
        canaryChannelId,
        '--thread',
        `v3-canary-${provider}`,
        '--model',
        selector,
        '--content',
        instruction,
      ],
      {
        cwd: repoRoot,
        env,
        timeout: 30_000,
      },
    );
    const submitted = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    if (submitted.jobId !== jobId) {
      throw new Error(`unexpected submitted job id for ${provider}`);
    }
    const bus = new DurableBus(path.join(root, 'v3', 'coordination.sqlite'));
    let job;
    let replacement = null;
    try {
      if (replaceWorkbench) {
        const running = await waitFor(() => {
          const current = bus.getJob(jobId);
          return current?.status === 'running' && current.workerPid
            ? current
            : null;
        }, { timeoutMs: Math.min(timeoutMs, 60_000) });
        const before = await waitFor(async () => {
          const current = await probeV3Health({
            env,
            repoRoot,
            requireWatchdog: true,
          });
          return current.ok ? current : null;
        }, { timeoutMs: 30_000 });
        const workbenchPid = before.supervisor.roles.workbench.pid;
        process.kill(workbenchPid, 'SIGTERM');
        const after = await waitFor(async () => {
          const current = await probeV3Health({
            env,
            repoRoot,
            requireWatchdog: true,
          });
          return current.ok
            && current.supervisor.roles.workbench.pid !== workbenchPid
            ? current
            : null;
        }, { timeoutMs: 30_000 });
        const durable = bus.getJob(jobId);
        const sameWorkerPid = Number(durable?.workerPid) === Number(running.workerPid);
        const workerSurvivedHandoff = sameWorkerPid && pidAlive(running.workerPid);
        replacement = {
          workbenchBeforePid: workbenchPid,
          workbenchAfterPid: after.supervisor.roles.workbench.pid,
          workerPid: running.workerPid,
          sameWorkerPid,
          workerSurvivedHandoff,
        };
        if (!workerSurvivedHandoff) {
          throw new Error(
            `${provider} Worker did not survive Workbench replacement: ${JSON.stringify(replacement)}`,
          );
        }
      }
      job = await waitFor(() => {
        const current = bus.getJob(jobId);
        return ['completed', 'failed', 'cancelled', 'lost'].includes(
          current?.status,
        )
          ? current
          : null;
      }, { timeoutMs });
    } finally {
      bus.close();
    }
    const output = String(job.result?.output || '');
    let deliveryObserved = false;
    try {
      deliveryObserved = Boolean(await waitFor(
        () => runtimeOutput.includes(marker) || null,
        { timeoutMs: Math.min(timeoutMs, 30_000), intervalMs: 50 },
      ));
    } catch {
      // Keep the provider result in the report; the missing Reception marker
      // is reported separately as a delivery failure.
    }
    const providerOk = job.status === 'completed'
      && output.includes(marker)
      && deliveryObserved
      && String(job.result?.worker || '').startsWith(provider);
    report.providers.push({
      provider,
      selector,
      ok: providerOk,
      status: job.status,
      worker: job.result?.worker || null,
      durationMs: Date.now() - startedAtMs,
      markerObserved: output.includes(marker),
      deliveryObserved,
      replacement,
      error: providerOk
        ? null
        : !deliveryObserved
          ? 'final message delivery marker was not observed by Reception'
          : job.result?.error || job.lastError || 'canary output/provider mismatch',
    });
    if (!providerOk) {
      throw new Error(`${provider} canary failed: ${JSON.stringify(report.providers.at(-1))}`);
    }
  }
  report.ok = report.providers.every((entry) => entry.ok);
} catch (error) {
  report.error = error?.stack || error?.message || String(error);
  report.runtimeOutputTail = runtimeOutput;
} finally {
  report.finishedAt = new Date().toISOString();
  await stopChild(watchdog);
  if (!keepState) {
    await fs.rm(root, { recursive: true, force: true });
    report.stateRoot = null;
  }
}

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const provider of report.providers) {
    const replacement = provider.replacement;
    const selection = provider.selector !== provider.provider
      ? ` selector ${provider.selector}`
      : '';
    const handoff = replacement
      ? `; Workbench ${replacement.workbenchBeforePid}->${replacement.workbenchAfterPid}, Worker ${replacement.workerPid} preserved`
      : '';
    process.stdout.write(
      `${provider.ok ? 'PASS' : 'FAIL'} ${provider.provider}${selection}: ${provider.status}`
      + ` via ${provider.worker || 'unknown'} (${provider.durationMs}ms${handoff})\n`,
    );
  }
  process.stdout.write(`bridge v3 provider canary: ${report.ok ? 'ready' : 'failed'}\n`);
  if (report.error) process.stderr.write(`${report.error}\n`);
}
if (!report.ok) process.exitCode = 1;

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return String(process.argv[index + 1]);
}

async function waitFor(probe, {
  timeoutMs: waitTimeoutMs,
  intervalMs = 100,
} = {}) {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`condition not met within ${waitTimeoutMs}ms`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    onceExited(child).then(() => true),
    delay(15_000).then(() => false),
  ]);
  if (!exited && child.exitCode == null && !child.signalCode) {
    child.kill('SIGKILL');
    await onceExited(child);
  }
}

function onceExited(child) {
  if (child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function appendTail(current, chunk, maxCharacters = 12_000) {
  return `${current}${String(chunk)}`.slice(-maxCharacters);
}
