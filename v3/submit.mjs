#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  modelOptionBySelector,
  modelSelectionFromOption,
  threadModelOptions,
} from '../lib/thread-models.mjs';
import { DurableBus } from './lib/durable-bus.mjs';
import { loadV3RuntimeConfig } from './lib/runtime-config.mjs';
import { WakeClient } from './lib/ws-link.mjs';

const args = parseArgs(process.argv.slice(2));
const content = String(args.content || args._.join(' ')).trim();
if (!content) {
  console.error('usage: node v3/submit.mjs --content "task" [--channel id] [--thread id]');
  process.exit(2);
}

const runtimeConfig = loadV3RuntimeConfig();
const platform = args.platform === 'slack' ? 'slack' : 'discord';
const channelId = String(
  args.channel
  || (platform === 'slack'
    ? runtimeConfig.bridgeConfig.slack.logicalChannelId
    : runtimeConfig.bridgeConfig.discord.generalChannelId)
  || 'v3-local',
);
const threadId = String(args.thread || `v3-local-${Date.now()}`);
const sourceChannelId = String(
  args['source-channel']
  || (platform === 'slack' ? runtimeConfig.bridgeConfig.slack.channelId : channelId)
  || channelId,
);
const sourceThreadId = String(args['source-thread'] || threadId);
const jobId = String(args.job || `v3-${randomUUID()}`);
const selectedModel = args.model
  ? (
      modelOptionBySelector(runtimeConfig.bridgeConfig, args.model)
      || threadModelOptions(runtimeConfig.bridgeConfig).find(
        (option) => option.worker === String(args.model).toLowerCase(),
      )
    )
  : null;
if (args.model && !selectedModel) {
  console.error(`unknown v3 canary model selector: ${args.model}`);
  process.exit(2);
}
const options = {
  ...(selectedModel
    ? {
        threadModelOverride: modelSelectionFromOption(selectedModel, {
          messageId: jobId,
        }),
      }
    : {}),
  ...(args.mock
    ? {
        workerMode: 'mock',
        mockPlan: {
          updates: ['local mock worker is running'],
          output: 'local mock worker completed',
        },
      }
    : {}),
};
const bus = new DurableBus(runtimeConfig.dbPath);
const message = bus.publish({
  messageId: `inbound:${platform}:${jobId}`,
  sender: 'reception',
  recipient: 'workbench',
  jobId,
  kind: 'job.requested',
  payload: {
    event: {
      id: jobId,
      timestamp: new Date().toISOString(),
      authorId: String(args.author || 'local-user'),
      authorName: String(args.name || 'local-user'),
      channelId,
      threadId,
      content,
      platform,
      source: platform,
      sourceChannelId,
      sourceThreadId,
      sourceMessageId: jobId,
      attachments: [],
      embeds: [],
    },
    reply: platform === 'slack'
      ? {
          platform,
          destination: {
            channelId: sourceChannelId,
            threadTs: sourceThreadId,
          },
        }
      : {
          platform,
          destination: { channelId: threadId },
        },
    options,
  },
});

const client = new WakeClient({
  url: runtimeConfig.receptionUrl,
  token: runtimeConfig.internalToken,
  role: 'ingress',
  instanceId: `submit-${process.pid}-${Date.now()}`,
  reconnectMinMs: 100,
  reconnectMaxMs: 200,
});
client.start();
await Promise.race([
  new Promise((resolve) => client.once('connected', resolve)),
  new Promise((resolve) => setTimeout(resolve, 500)),
]);
const websocketSent = client.wake({
  recipient: 'workbench',
  rowId: message.rowId,
  messageId: message.messageId,
});
client.stop();
bus.close();

process.stdout.write(`${JSON.stringify({
  jobId,
  rowId: message.rowId,
  inserted: message.inserted,
  websocketSent,
})}\n`);

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || '');
    if (!value.startsWith('--')) {
      parsed._.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = values[index + 1];
    if (next && !String(next).startsWith('--')) {
      parsed[name] = next;
      index += 1;
    } else {
      parsed[name] = true;
    }
  }
  return parsed;
}
