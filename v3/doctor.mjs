#!/usr/bin/env node
import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { DiscordApi } from '../lib/discord-api.mjs';
import { SlackApi } from '../lib/slack-api.mjs';
import {
  DurableBus,
  V3_SCHEMA_VERSION,
} from './lib/durable-bus.mjs';
import {
  inspectV3TokenFile,
  loadV3RuntimeConfig,
} from './lib/runtime-config.mjs';

const jsonOutput = process.argv.includes('--json');
const requireIdle = process.argv.includes('--require-idle');
const probePlatforms = process.argv.includes('--probe-platforms');
const checks = [];
let runtimeConfig = null;
let bus = null;

function record(name, ok, detail, { warning = false } = {}) {
  checks.push({
    name,
    status: ok ? 'pass' : warning ? 'warning' : 'fail',
    detail,
  });
}

try {
  const [major, minor] = process.versions.node
    .split('.')
    .map((value) => Number.parseInt(value, 10));
  const supportedNode = major >= 24
    || (major === 23 && minor >= 4)
    || (major === 22 && minor >= 13);
  record(
    'node-version',
    supportedNode,
    `${process.version}; bridge v3 requires Node >=22.13 (or >=23.4)`,
  );

  runtimeConfig = loadV3RuntimeConfig();
  fs.accessSync(runtimeConfig.runtimeRoot, fsConstants.R_OK | fsConstants.W_OK);
  record('runtime-root', true, runtimeConfig.runtimeRoot);

  const wslDrvFs = isWsl()
    && /^\/mnt\/[a-z](?:\/|$)/i.test(runtimeConfig.dbPath);
  record(
    'coordination-filesystem',
    !wslDrvFs,
    wslDrvFs
      ? `${runtimeConfig.dbPath}; move V3_DB_PATH to the native Linux filesystem to avoid SQLite WAL stalls on DrvFS`
      : runtimeConfig.dbPath,
    { warning: wslDrvFs && runtimeConfig.platformMode !== 'live' },
  );

  bus = new DurableBus(runtimeConfig.dbPath);
  record(
    'coordination-schema',
    bus.schemaVersion() === V3_SCHEMA_VERSION,
    `${bus.schemaVersion()} (expected ${V3_SCHEMA_VERSION}) at ${runtimeConfig.dbPath}`,
  );

  if (runtimeConfig.tokenSource === 'environment') {
    record(
      'internal-token-source',
      runtimeConfig.internalToken.length >= 32,
      `environment (${runtimeConfig.internalToken.length} characters)`,
    );
  } else {
    const token = inspectV3TokenFile(runtimeConfig.tokenFile);
    record(
      'internal-token-permissions',
      token.secure,
      `${token.path} mode ${token.mode.toString(8).padStart(3, '0')}`
        + `${token.expectedUid == null ? '' : ` uid ${token.uid} (expected ${token.expectedUid})`}`,
    );
  }

  const loopbackHost = new Set(['127.0.0.1', '::1', 'localhost'])
    .has(runtimeConfig.host);
  record(
    'internal-bind',
    loopbackHost,
    `${runtimeConfig.host}:${runtimeConfig.receptionPort}/${runtimeConfig.workbenchPort}`,
  );

  if (runtimeConfig.platformMode === 'live') {
    const discordReady = !runtimeConfig.bridgeConfig.discord.enabled
      || (
        Boolean(runtimeConfig.bridgeConfig.discord.token)
        && runtimeConfig.bridgeConfig.discord.allowedChannelIds.size > 0
        && (
          runtimeConfig.bridgeConfig.discord.allowAllUsers
          || runtimeConfig.bridgeConfig.discord.allowedUserIds.size > 0
        )
      );
    const slackReady = !runtimeConfig.bridgeConfig.slack.enabled
      || (
        Boolean(runtimeConfig.bridgeConfig.slack.appToken)
        && Boolean(runtimeConfig.bridgeConfig.slack.botToken)
        && Boolean(runtimeConfig.bridgeConfig.slack.channelId)
        && Boolean(runtimeConfig.bridgeConfig.slack.logicalChannelId)
        && (
          runtimeConfig.bridgeConfig.slack.allowAllUsers
          || runtimeConfig.bridgeConfig.slack.allowedUserIds.size > 0
        )
      );
    const anyPlatform = runtimeConfig.bridgeConfig.discord.enabled
      || runtimeConfig.bridgeConfig.slack.enabled;
    record(
      'live-platform-config',
      anyPlatform && discordReady && slackReady,
      `discord=${runtimeConfig.bridgeConfig.discord.enabled ? 'enabled' : 'disabled'}, slack=${runtimeConfig.bridgeConfig.slack.enabled ? 'enabled' : 'disabled'}`,
    );
    if (probePlatforms && discordReady && runtimeConfig.bridgeConfig.discord.enabled) {
      const channelIds = [...runtimeConfig.bridgeConfig.discord.allowedChannelIds];
      try {
        const api = new DiscordApi(runtimeConfig.bridgeConfig.discord);
        const channel = await api.getChannel(channelIds[0]);
        record(
          'discord-rest-probe',
          String(channel?.id || '') === String(channelIds[0]),
          `bot can read configured channel ${channelIds[0]}`,
        );
      } catch (error) {
        record(
          'discord-rest-probe',
          false,
          error?.message || String(error),
        );
      }
    }
    if (probePlatforms && slackReady && runtimeConfig.bridgeConfig.slack.enabled) {
      try {
        const api = new SlackApi(runtimeConfig.bridgeConfig.slack);
        const [auth, channel, socket] = await Promise.all([
          api.authTest(),
          api.channelInfo(runtimeConfig.bridgeConfig.slack.channelId),
          api.openSocketConnection(),
        ]);
        record(
          'slack-api-probe',
          Boolean(
            auth?.user_id
            && channel?.channel?.is_member
            && /^wss:\/\//i.test(String(socket?.url || '')),
          ),
          `bot ${auth?.user_id || 'unknown'}; channel member=${Boolean(channel?.channel?.is_member)}; app socket URL issued=${Boolean(socket?.url)}`,
        );
      } catch (error) {
        record(
          'slack-api-probe',
          false,
          error?.message || String(error),
        );
      }
    }
  } else {
    record(
      'platform-mode',
      true,
      runtimeConfig.platformMode,
    );
  }

  const activeJobs = bus.activeJobs();
  const staleJobs = activeJobs.filter((job) =>
    job.workerPid && !pidAlive(job.workerPid),
  );
  record(
    'active-worker-liveness',
    staleJobs.length === 0,
    `${activeJobs.length} active, ${staleJobs.length} with a missing PID`,
    { warning: !requireIdle },
  );
  if (requireIdle) {
    record(
      'idle-cutover',
      activeJobs.length === 0,
      `${activeJobs.length} active v3 job(s)`,
    );
  }
} catch (error) {
  record('doctor-runtime', false, error?.stack || error?.message || String(error));
} finally {
  bus?.close();
}

function isWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

const failed = checks.some((entry) => entry.status === 'fail');
const report = {
  ok: !failed,
  schemaVersion: V3_SCHEMA_VERSION,
  runtime: runtimeConfig
    ? {
        repoRoot: runtimeConfig.repoRoot,
        runtimeRoot: runtimeConfig.runtimeRoot,
        dbPath: runtimeConfig.dbPath,
        tokenFile: runtimeConfig.tokenSource === 'file'
          ? runtimeConfig.tokenFile
          : null,
        tokenSource: runtimeConfig.tokenSource,
        platformMode: runtimeConfig.platformMode,
      }
    : null,
  checks,
};

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const check of checks) {
    process.stdout.write(
      `${check.status === 'pass' ? 'PASS' : check.status.toUpperCase()} ${check.name}: ${check.detail}\n`,
    );
  }
  process.stdout.write(`bridge v3 doctor: ${report.ok ? 'ready' : 'not ready'}\n`);
}
if (!report.ok) process.exitCode = 1;

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
