#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const requestId = String(process.env.V3_PROMOTION_REQUEST_ID || '').trim();
const configuredRepoRoot = String(
  process.env.V3_PROMOTION_REPO_ROOT || '',
).trim();
const configuredStateRoot = String(
  process.env.BRIDGE_STATE_ROOT || process.env.DATA_DIR || '',
).trim();
const repoRoot = path.resolve(
  configuredRepoRoot || process.cwd(),
);
const stateRoot = configuredStateRoot ? path.resolve(configuredStateRoot) : '';
const statePath = path.join(stateRoot, '_system', 'v3-promotion.json');
const logPath = path.join(stateRoot, 'logs', 'v3-promotion.log');

if (!requestId || !configuredRepoRoot || !stateRoot) {
  process.stderr.write(
    'V3 promotion requires a request id, repository root, and state root.\n',
  );
  process.exit(2);
}

await fs.mkdir(path.dirname(statePath), { recursive: true });
await fs.mkdir(path.dirname(logPath), { recursive: true });

// Let the parent service persist the coordinator PID before this process
// updates the same state file.
await delay(250);
const scheduled = await readJson(statePath);
if (
  scheduled?.requestId === requestId
  && Number(scheduled.coordinatorPid) > 0
  && Number(scheduled.coordinatorPid) !== process.pid
  && pidAlive(Number(scheduled.coordinatorPid))
) {
  process.exit(0);
}

const startedAt = new Date().toISOString();
await writeState({
  ...(scheduled?.requestId === requestId ? scheduled : {}),
  requestId,
  target: 'v3',
  status: 'running',
  startedAt,
  coordinatorPid: process.pid,
  repoRoot,
  stateRoot,
});
await fs.appendFile(
  logPath,
  `${startedAt} request=${requestId} starting guarded v2 -> v3 promotion\n`,
  { mode: 0o600 },
);

const logFd = fsSync.openSync(logPath, 'a', 0o600);
let result;
try {
  result = await runLauncher(logFd);
} finally {
  fsSync.closeSync(logFd);
}

const succeeded = result.code === 0;
const finalState = {
  requestId,
  target: 'v3',
  status: succeeded ? 'succeeded' : 'failed',
  startedAt,
  finishedAt: new Date().toISOString(),
  coordinatorPid: process.pid,
  launcherPid: result.pid || null,
  exitCode: result.code,
  signal: result.signal,
  error: result.error || null,
  repoRoot,
  stateRoot,
};
await writeState(finalState);
const notification = await notifyPromotionResult({
  succeeded,
  exitCode: result.code,
});
await writeState({ ...finalState, notification });
process.exitCode = succeeded ? 0 : Number.isInteger(result.code) ? result.code : 1;

function runLauncher(logFd) {
  return new Promise((resolve) => {
    const child = spawn(
      process.env.BRIDGE_BASH_BIN || 'bash',
      [path.join(repoRoot, 'start-bridge-host.sh')],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: stateRoot,
          BRIDGE_STATE_ROOT: stateRoot,
          BRIDGE_RUNTIME_VERSION: 'v3',
          BRIDGE_RESTART_SCOPE: 'runtime',
          V3_PLATFORM_MODE:
            String(process.env.V3_PLATFORM_MODE || 'live').trim() || 'live',
        },
        stdio: ['ignore', logFd, logFd],
      },
    );
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({
        pid: child.pid || null,
        code: null,
        signal: null,
        error: error.message || String(error),
      });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({
        pid: child.pid || null,
        code,
        signal,
        error: null,
      });
    });
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeState(value) {
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tempPath, statePath);
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function notifyPromotionResult({ succeeded, exitCode }) {
  const channelId = String(
    process.env.V3_PROMOTION_NOTIFY_DISCORD_CHANNEL_ID || '',
  ).trim();
  if (!channelId) return { status: 'disabled' };
  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  if (!token) {
    return { status: 'failed', error: 'Discord bot token is unavailable' };
  }
  const apiBaseUrl = String(
    process.env.DISCORD_API_BASE_URL || 'https://discord.com/api/v10',
  ).replace(/\/$/, '');
  const content = succeeded
    ? [
        '【v3 전환 완료】',
        'Watchdog · Reception · Workbench health gate를 모두 통과했습니다.',
        '현재 브리지는 v3 런타임으로 동작 중입니다.',
      ].join('\n')
    : [
        '【v3 전환 실패】',
        `사전검사 또는 health gate를 통과하지 못했습니다 (exit=${exitCode ?? 'none'}).`,
        '완료 처리하지 않았으며 v2 유지·자동복구 경로가 실행됐습니다.',
      ].join('\n');
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(
        `${apiBaseUrl}/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content,
            allowed_mentions: { parse: [] },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Discord promotion notice failed with HTTP ${response.status}`,
        );
      }
      const message = await response.json();
      return {
        status: 'delivered',
        channelId,
        messageIds: [message?.id].filter(Boolean),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 500);
    }
  }
  return {
    status: 'failed',
    channelId,
    error: lastError?.message || String(lastError),
    attempts: 3,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
