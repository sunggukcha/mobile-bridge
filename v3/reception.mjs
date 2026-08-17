#!/usr/bin/env node
import path from 'node:path';
import { JsonState } from '../lib/state.mjs';
import { DurableBus } from './lib/durable-bus.mjs';
import { DiscordReceptionAdapter } from './lib/discord-reception.mjs';
import { ReceptionService } from './lib/reception-service.mjs';
import { RoleHealthReporter } from './lib/role-health.mjs';
import { loadV3RuntimeConfig } from './lib/runtime-config.mjs';
import { SlackReceptionAdapter } from './lib/slack-reception.mjs';

const runtimeConfig = loadV3RuntimeConfig();
if (runtimeConfig.platformMode === 'live') {
  const { discord, slack } = runtimeConfig.bridgeConfig;
  if (discord.enabled && (!discord.token || discord.allowedChannelIds.size === 0)) {
    throw new Error('Discord live mode requires DISCORD_BOT_TOKEN and DISCORD_ALLOWED_CHANNEL_IDS.');
  }
  if (discord.enabled && !discord.allowAllUsers && discord.allowedUserIds.size === 0) {
    throw new Error('Discord live mode requires DISCORD_ALLOWED_USER_IDS or DISCORD_ALLOW_ALL_USERS=true.');
  }
  if (slack.enabled && !slack.allowAllUsers && slack.allowedUserIds.size === 0) {
    throw new Error('Slack live mode requires SLACK_ALLOWED_USER_IDS or SLACK_ALLOW_ALL_USERS=true.');
  }
}
const bus = new DurableBus(runtimeConfig.dbPath);
const systemState = new JsonState(
  path.join(runtimeConfig.bridgeConfig.stateRoot, '_system'),
);
await systemState.init();
const adapters = {};
let reception = null;
let healthReporter = null;
const log = async (type, payload = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    ...payload,
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  await systemState
    .appendJsonl('v3-reception-events.jsonl', entry)
    .catch(() => {});
  if (
    type.endsWith('-ready')
    || type.endsWith('-not-ready')
    || type === 'reception-started'
  ) {
    healthReporter?.requestPublish();
  }
};
const accept = (message) => reception.submitInbound(message);

if (runtimeConfig.platformMode === 'live') {
  if (runtimeConfig.bridgeConfig.discord.enabled) {
    adapters.discord = new DiscordReceptionAdapter({
      config: runtimeConfig.bridgeConfig.discord,
      ignoreBefore: runtimeConfig.ignoreBefore,
      onInbound: accept,
      onLog: log,
      rawEvents: true,
    });
  }
  if (runtimeConfig.bridgeConfig.slack.enabled) {
    adapters.slack = new SlackReceptionAdapter({
      config: runtimeConfig.bridgeConfig.slack,
      ignoreBefore: runtimeConfig.ignoreBefore,
      onInbound: accept,
      onLog: log,
      rawEvents: true,
    });
  }
}

if (runtimeConfig.platformMode === 'console') {
  const consoleAdapter = {
    async deliver(message) {
      await log('console-delivery', {
        platform: message.platform,
        destination: message.destination,
        purpose: message.purpose,
        jobId: message.jobId,
        content: message.content,
      });
    },
    async invoke(method, args = []) {
      await log('console-platform-rpc', { method, args });
      if (method === 'postMessage') {
        return [{ id: `console-${Date.now()}` }];
      }
      if (method === 'createThread' || method === 'createThreadFromMessage') {
        return { id: `console-thread-${Date.now()}` };
      }
      if (method === 'getChannel') return { id: String(args[0] || ''), type: 11 };
      if (method === 'getMessage') return null;
      if (method === 'listMessages' || method === 'listReplies') return [];
      if (method === 'authTest') {
        return { user_id: 'console-bot', team_id: 'console-team' };
      }
      if (method === 'channelInfo') return { channel: { is_member: true } };
      if (method === 'userInfo') {
        return { user: { id: String(args[0] || ''), name: String(args[0] || '') } };
      }
      return null;
    },
  };
  adapters.discord = consoleAdapter;
  adapters.slack = consoleAdapter;
}

reception = new ReceptionService({
  bus,
  host: runtimeConfig.host,
  port: runtimeConfig.receptionPort,
  token: runtimeConfig.internalToken,
  adapters,
  pollIntervalMs: runtimeConfig.pollIntervalMs,
  leaseTtlMs: runtimeConfig.leaseTtlMs,
  leaseRenewMs: runtimeConfig.leaseRenewMs,
  onLog: log,
});
reception.on('listening', () => healthReporter?.requestPublish());
healthReporter = new RoleHealthReporter({
  role: 'reception',
  stateRoot: runtimeConfig.bridgeConfig.stateRoot,
  intervalMs: runtimeConfig.healthHeartbeatMs,
  getStatus: () => receptionHealthStatus(),
  onError: (error) => log('reception-health-write-error', {
    error: error.message,
  }).catch(() => {}),
});

let stopResolve;
const stopped = new Promise((resolve) => {
  stopResolve = resolve;
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    await reception.stop().catch((error) => log('reception-stop-error', {
      error: error.message,
    }));
    await healthReporter.stop().catch(() => {});
    bus.close();
    stopResolve();
  });
}

try {
  await healthReporter.start();
  await reception.start();
  await healthReporter.requestPublish();
  if (runtimeConfig.platformMode === 'disabled') {
    await log('reception-platforms-disabled', {
      hint: 'Set V3_PLATFORM_MODE=console for local testing or live for Discord/Slack.',
    });
  }
  await stopped;
} catch (error) {
  await log('reception-fatal', { error: error.message || String(error) });
  await healthReporter.stop({
    error: error.message || String(error),
  }).catch(() => {});
  bus.close();
  process.exitCode = 1;
  stopResolve();
}

function receptionHealthStatus() {
  const status = reception?.status?.() || {};
  const platforms = {};
  const required = [];
  if (runtimeConfig.platformMode === 'live') {
    if (runtimeConfig.bridgeConfig.discord.enabled) {
      required.push('discord');
      platforms.discord = adapters.discord?.status?.() || {
        running: false,
        ready: false,
      };
    }
    if (runtimeConfig.bridgeConfig.slack.enabled) {
      required.push('slack');
      platforms.slack = adapters.slack?.status?.() || {
        running: false,
        ready: false,
      };
    }
  }
  const internalReady = Boolean(status.running && status.address && status.lease);
  const platformsReady = required.every((platform) =>
    Boolean(platforms[platform]?.ready),
  );
  const ready = internalReady && platformsReady;
  return {
    ready,
    phase: !internalReady
      ? 'starting'
      : platformsReady
        ? 'ready'
        : 'waiting-for-platforms',
    instanceId: status.instanceId || null,
    address: status.address || null,
    lease: status.lease
      ? {
          role: status.lease.role,
          ownerId: status.lease.ownerId,
          epoch: status.lease.epoch,
          expiresAtMs: status.lease.expiresAtMs,
        }
      : null,
    platformMode: runtimeConfig.platformMode,
    requiredPlatforms: required,
    platforms,
    workbenchConnected: Boolean(status.workbenchConnected),
    pendingOutbound: Number(status.pendingOutbound || 0),
  };
}
