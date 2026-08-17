#!/usr/bin/env node
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  dotEnvAuthoritativeChildEnv,
  loadConfig,
  loadDotEnv,
  readDotEnvFile,
} from './lib/config.mjs';
import { DiscordApi } from './lib/discord-api.mjs';
import { queueDiscordOutbox } from './lib/discord-outbox.mjs';
import { formatErrorDetail } from './lib/error-detail.mjs';
import { JsonState } from './lib/state.mjs';
import { acquirePidLock, releasePidLock, releasePidLockSync } from './lib/supervisor-lock.mjs';

const DEFAULT_IGNORE_BEFORE = new Date().toISOString();
const RESTART_EXIT_CODE = 75;
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const supervisorNoticesPath = path.join(repoRoot, 'lib', 'supervisor-notices.mjs');

// The supervisor process is long-lived (it only restarts on host reboot), so a
// static import would pin the notice formatter to whatever code was on disk at
// launch. Re-importing per notice, cache-busted by mtime, lets notice-format
// changes deploy on the next service restart without cycling the supervisor.
async function loadSupervisorNotices() {
  const url = new URL('./lib/supervisor-notices.mjs', import.meta.url);
  try {
    const stat = await fs.stat(supervisorNoticesPath);
    url.searchParams.set('v', String(Math.trunc(stat.mtimeMs)));
  } catch {
    // Stat can fail transiently on WSL/9p; fall back to the module's current mtime-less URL.
  }
  return import(url.href);
}

loadDotEnv(path.join(repoRoot, '.env'));
const config = loadConfig();
const systemState = new JsonState(path.join(config.stateRoot, '_system'));
const api = new DiscordApi(config.discord);
const ignoreBefore = process.env.BRIDGE_IGNORE_BEFORE || DEFAULT_IGNORE_BEFORE;
const nodeBinDir = path.dirname(process.execPath);
const supervisorLockFile = path.join(config.stateRoot, '_system', 'supervisor.lock');

await systemState.init();
if (isLikelyCodexSandbox()) {
  await systemState.appendJsonl('supervisor-events.jsonl', {
    timestamp: new Date().toISOString(),
    type: 'supervisor-sandbox-refused',
    pid: process.pid,
    initCommand: readInitCommandLine(),
  });
  process.exit(0);
}
const supervisorLock = await acquirePidLock(supervisorLockFile);
if (!supervisorLock.acquired) {
  await systemState.appendJsonl('supervisor-events.jsonl', {
    timestamp: new Date().toISOString(),
    type: 'supervisor-duplicate-exit',
    owner: supervisorLock.owner || null,
  });
  process.exit(0);
}
await systemState.writeJson('supervisor.json', {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  ignoreBefore,
});

let stopping = false;
let currentChild = null;
let consecutiveFailures = 0;

while (!stopping) {
  const result = await runService();
  currentChild = null;
  await systemState.appendJsonl('supervisor-events.jsonl', {
    timestamp: new Date().toISOString(),
    type: 'service-exit',
    ...result,
  });

  if (stopping) break;

  consecutiveFailures = result.code === RESTART_EXIT_CODE ? 0 : consecutiveFailures + 1;
  await notifyServiceExit(result, { consecutiveFailures });

  await delay(result.code === RESTART_EXIT_CODE ? 1500 : Math.min(30_000, 3000 * consecutiveFailures));
}

async function runService() {
  return new Promise((resolve) => {
    const dotenvEnv = readDotEnvFile(path.join(repoRoot, '.env'));
    const childEnv = {
      ...dotEnvAuthoritativeChildEnv(dotenvEnv, process.env),
      BRIDGE_IGNORE_BEFORE: ignoreBefore,
      BRIDGE_RUNTIME_ROLE: 'v2-service',
    };
    childEnv.PATH = [nodeBinDir, childEnv.PATH].filter(Boolean).join(path.delimiter);
    const child = spawn(process.execPath, [path.join(repoRoot, 'bridge-service.mjs')], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    currentChild = child;

    systemState.writeJson('service-child.json', {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      ignoreBefore,
    }).catch(() => {});

    // Spawn failures (ENOENT, EPERM…) must feed the restart/backoff loop like a
    // failed exit — rejecting here crashed the supervisor as an unhandled rejection.
    child.on('error', (error) => resolve({ code: null, signal: null, spawnError: formatErrorDetail(error) }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

async function notifyServiceExit(result, options) {
  if (!config.discord.generalChannelId || !config.discord.token) return;
  const pendingRestart = result.code === RESTART_EXIT_CODE
    ? await systemState.readJson('pending-restart.json', null).catch(() => null)
    : null;
  const { formatServiceExitNotice } = await loadSupervisorNotices();
  await postSupervisorNotice(formatServiceExitNotice(result, { ...options, pendingRestart }), 'service-exit');
  if (result.code === RESTART_EXIT_CODE && pendingRestart) {
    await consumePendingRestart(pendingRestart);
  }
}

async function consumePendingRestart(pendingRestart) {
  try {
    await fs.rm(systemState.file('pending-restart.json'), { force: true });
    await systemState.appendJsonl('supervisor-events.jsonl', {
      timestamp: new Date().toISOString(),
      type: 'pending-restart-consumed',
      source: pendingRestart.source || null,
      workerLabel: pendingRestart.workerLabel || null,
      workerEffort: pendingRestart.workerEffort || null,
    });
  } catch (error) {
    await systemState.appendJsonl('supervisor-events.jsonl', {
      timestamp: new Date().toISOString(),
      type: 'pending-restart-consume-failed',
      error: formatErrorDetail(error),
    }).catch(() => {});
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopping = true;
    if (currentChild && !currentChild.killed) currentChild.kill(signal);
    await notifySupervisorStop(signal);
    await releasePidLock(supervisorLockFile).catch(() => {});
    await systemState.appendJsonl('supervisor-events.jsonl', {
      timestamp: new Date().toISOString(),
      type: 'supervisor-stop',
      signal,
    }).catch(() => {});
    process.exit(0);
  });
}

process.on('exit', () => {
  // 'exit' runs synchronous work only; the async release would never complete
  // here and the lock file would survive the process.
  try { releasePidLockSync(supervisorLockFile); } catch { /* best effort */ }
});

async function notifySupervisorStop(signal) {
  if (!config.discord.generalChannelId || !config.discord.token) return;
  const { formatSupervisorStopNotice } = await loadSupervisorNotices();
  await postSupervisorNotice(formatSupervisorStopNotice(signal), 'supervisor-stop');
}

async function postSupervisorNotice(content, purpose) {
  try {
    await api.postMessage(config.discord.generalChannelId, content);
  } catch (error) {
    const entry = await queueDiscordOutbox(systemState, {
      channelId: config.discord.generalChannelId,
      content,
      purpose,
      lastError: formatErrorDetail(error),
    });
    await systemState.appendJsonl('supervisor-events.jsonl', {
      timestamp: new Date().toISOString(),
      type: 'supervisor-notice-outbox-queued',
      outboxId: entry.id,
      purpose,
      error: formatErrorDetail(error),
    });
  }
}

function isLikelyCodexSandbox() {
  const initCommand = readInitCommandLine();
  return /\b(bwrap|codex-linux-sandbox)\b/.test(initCommand);
}

function readInitCommandLine() {
  try {
    return fsSync.readFileSync('/proc/1/cmdline', 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}
