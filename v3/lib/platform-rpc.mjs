import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WakeClient } from './ws-link.mjs';
import {
  boundedRichDeliveryId,
  boundedRichMessageIds,
  boundedRichPartCount,
} from '../../lib/rich-delivery-progress.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;

export class WorkbenchPlatformRpc extends EventEmitter {
  constructor({
    bus,
    receptionUrl,
    token,
    instanceId = `platform-rpc-${randomUUID()}`,
    pollIntervalMs = 250,
    reconnectMinMs = 200,
    reconnectMaxMs = 5_000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onLog = null,
  } = {}) {
    super();
    if (!bus || !receptionUrl || !token) {
      throw new Error('WorkbenchPlatformRpc requires bus, receptionUrl, and token');
    }
    this.bus = bus;
    this.instanceId = instanceId;
    // The Workbench lease guarantees one active generation. A stable response
    // stream lets the next generation acknowledge replies whose caller died
    // after Reception had already completed the external operation.
    this.recipient = 'workbench-rpc';
    this.pollIntervalMs = Math.max(25, Number(pollIntervalMs) || 250);
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.onLog = onLog;
    this.running = false;
    this.pollTimer = null;
    this.drainPromise = null;
    this.waiters = new Map();
    this.client = new WakeClient({
      url: receptionUrl,
      token,
      role: 'workbench',
      instanceId,
      reconnectMinMs,
      reconnectMaxMs,
      onWake: () => this.requestDrain(),
      onError: (error) => this.log('platform-rpc-link-error', {
        error: error.message,
      }),
    });
    this.client.on('connected', () => {
      this.client.wake({
        recipient: 'reception',
        responseRecipient: this.recipient,
      });
      this.requestDrain();
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.client.start();
    this.pollTimer = setInterval(() => this.requestDrain(), this.pollIntervalMs);
    this.pollTimer.unref?.();
    this.requestDrain();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.client.stop();
    const error = new Error('platform RPC stopped');
    error.code = 'V3_PLATFORM_RPC_STOPPED';
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
    if (this.drainPromise) await this.drainPromise.catch(() => {});
  }

  invoke(platform, method, args = [], {
    timeoutMs = this.timeoutMs,
    deliveryKey = '',
  } = {}) {
    if (!this.running) this.start();
    const requestId = randomUUID();
    const timeout = Math.max(1_000, Number(timeoutMs) || this.timeoutMs);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        const error = new Error(
          `platform RPC timed out after ${timeout}ms: ${platform}.${method}`,
        );
        error.code = 'V3_PLATFORM_RPC_TIMEOUT';
        reject(error);
      }, timeout);
      timer.unref?.();
      this.waiters.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    let durable;
    try {
      durable = this.bus.publish({
        messageId: `platform-request:${requestId}`,
        sender: 'workbench',
        recipient: 'reception',
        jobId: requestId,
        kind: 'platform.request',
        payload: {
          requestId,
          responseRecipient: this.recipient,
          platform: String(platform || ''),
          method: String(method || ''),
          args: Array.isArray(args) ? args : [],
          deliveryKey: String(deliveryKey || ''),
        },
      });
    } catch (error) {
      const waiter = this.waiters.get(requestId);
      this.waiters.delete(requestId);
      waiter?.reject(error);
      return response;
    }
    this.client.wake({
      recipient: 'reception',
      rowId: durable.rowId,
      messageId: durable.messageId,
    });
    this.log('platform-rpc-requested', {
      requestId,
      platform,
      method,
      rowId: durable.rowId,
    }).catch(() => {});
    return response;
  }

  requestDrain() {
    if (!this.running) return Promise.resolve();
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain()
      .catch((error) => this.log('platform-rpc-drain-error', {
        error: error.message,
      }))
      .finally(() => {
        this.drainPromise = null;
      });
    return this.drainPromise;
  }

  async drain() {
    for (;;) {
      const messages = this.bus.pending(this.recipient, { limit: 500 });
      if (messages.length === 0) return;
      for (const message of messages) {
        const requestId = String(
          message.payload?.requestId || message.jobId || '',
        );
        const waiter = this.waiters.get(requestId);
        if (message.kind !== 'platform.response') {
          this.bus.acknowledge(message.rowId, this.instanceId);
          await this.log('platform-rpc-unsupported-response', {
            rowId: message.rowId,
            kind: message.kind,
          });
          continue;
        }
        if (waiter) {
          this.waiters.delete(requestId);
          if (message.payload?.ok) {
            waiter.resolve(message.payload.result);
          } else {
            waiter.reject(platformError(message.payload?.error));
          }
        }
        this.bus.acknowledge(message.rowId, this.instanceId);
      }
    }
  }

  async log(type, payload = {}) {
    this.emit('log', type, payload);
    await this.onLog?.(type, payload);
  }
}

export class DiscordPlatformProxy {
  constructor(rpc) {
    if (!rpc) throw new Error('DiscordPlatformProxy requires RPC');
    this.rpc = rpc;
  }

  getChannel(channelId) {
    return this.rpc.invoke('discord', 'getChannel', [channelId]);
  }

  getMessage(channelId, messageId) {
    return this.rpc.invoke('discord', 'getMessage', [channelId, messageId]);
  }

  listMessages(channelId, options = {}) {
    return this.rpc.invoke('discord', 'listMessages', [channelId, options]);
  }

  postMessage(channelId, content, options = {}) {
    return this.rpc.invoke('discord', 'postMessage', [channelId, content, options]);
  }

  createThreadFromMessage(channelId, messageId, name, autoArchiveDuration) {
    return this.rpc.invoke('discord', 'createThreadFromMessage', [
      channelId,
      messageId,
      name,
      autoArchiveDuration,
    ]);
  }

  createThread(channelId, name, autoArchiveDuration) {
    return this.rpc.invoke('discord', 'createThread', [
      channelId,
      name,
      autoArchiveDuration,
    ]);
  }

  addReaction(channelId, messageId, emoji) {
    return this.rpc.invoke('discord', 'addReaction', [
      channelId,
      messageId,
      emoji,
    ]);
  }
}

export class SlackPlatformProxy {
  constructor(rpc) {
    if (!rpc) throw new Error('SlackPlatformProxy requires RPC');
    this.rpc = rpc;
  }

  authTest() {
    return this.rpc.invoke('slack', 'authTest');
  }

  postMessage(channelId, content, options = {}) {
    return this.rpc.invoke('slack', 'postMessage', [channelId, content, options]);
  }

  addReaction(channelId, timestamp, name = 'thumbsup') {
    return this.rpc.invoke('slack', 'addReaction', [
      channelId,
      timestamp,
      name,
    ]);
  }

  userInfo(userId) {
    return this.rpc.invoke('slack', 'userInfo', [userId]);
  }

  channelInfo(channelId) {
    return this.rpc.invoke('slack', 'channelInfo', [channelId]);
  }

  listMessages(channelId, options = {}) {
    return this.rpc.invoke('slack', 'listMessages', [channelId, options]);
  }

  listReplies(channelId, threadTs, options = {}) {
    return this.rpc.invoke('slack', 'listReplies', [
      channelId,
      threadTs,
      options,
    ]);
  }

  openSocketConnection() {
    throw new Error('Slack Socket Mode belongs to Reception in bridge v3');
  }
}

export function serializePlatformError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'platform request failed'),
    code: error?.code == null ? null : String(error.code),
    status: Number.isFinite(Number(error?.status))
      ? Number(error.status)
      : null,
    slackError: error?.slackError == null
      ? null
      : String(error.slackError),
    slackCompletedParts: boundedRichPartCount(error?.slackCompletedParts),
    slackCompletedMessageIds: boundedRichMessageIds(
      error?.slackCompletedMessageIds || error?.slackMessageIds,
    ),
    slackMessageIds: boundedRichMessageIds(
      error?.slackCompletedMessageIds || error?.slackMessageIds,
    ),
    slackTotalParts: Number.isFinite(Number(error?.slackTotalParts))
      ? boundedRichPartCount(error.slackTotalParts)
      : null,
    discordCompletedParts: boundedRichPartCount(error?.discordCompletedParts),
    discordCompletedMessageIds: boundedRichMessageIds(error?.discordCompletedMessageIds),
    discordCompletedMessageCount: boundedRichPartCount(
      error?.discordCompletedMessageCount
      ?? boundedRichMessageIds(error?.discordCompletedMessageIds).length,
    ),
    discordTotalParts: Number.isFinite(Number(error?.discordTotalParts))
      ? boundedRichPartCount(error.discordTotalParts)
      : null,
    discordPartialPartMessageCount: boundedRichPartCount(
      error?.discordPartialPartMessageCount,
    ),
    discordContinuationChannelId: boundedRichDeliveryId(
      error?.discordContinuationChannelId,
    ) || null,
    discordPostCompleted: Boolean(error?.discordPostCompleted),
    discordAttachmentVerificationPending: Boolean(error?.discordAttachmentVerificationPending),
    discordMessageIds: boundedRichMessageIds(error?.discordMessageIds),
  };
}

function platformError(value = {}) {
  const error = new Error(
    String(value?.message || 'platform request failed'),
  );
  error.name = String(value?.name || 'Error');
  if (value?.code != null) error.code = value.code;
  if (value?.status != null) error.status = Number(value.status);
  if (value?.slackError != null) error.slackError = value.slackError;
  error.slackCompletedParts = boundedRichPartCount(value?.slackCompletedParts);
  error.slackCompletedMessageIds = boundedRichMessageIds(
    value?.slackCompletedMessageIds || value?.slackMessageIds,
  );
  error.slackMessageIds = error.slackCompletedMessageIds;
  if (value?.slackTotalParts != null) {
    error.slackTotalParts = boundedRichPartCount(value.slackTotalParts);
  }
  error.discordCompletedParts = boundedRichPartCount(value?.discordCompletedParts);
  error.discordCompletedMessageIds = boundedRichMessageIds(value?.discordCompletedMessageIds);
  error.discordCompletedMessageCount = boundedRichPartCount(
    value?.discordCompletedMessageCount
    ?? error.discordCompletedMessageIds.length,
  );
  if (value?.discordTotalParts != null) {
    error.discordTotalParts = boundedRichPartCount(value.discordTotalParts);
  }
  error.discordPartialPartMessageCount = boundedRichPartCount(
    value?.discordPartialPartMessageCount,
  );
  const discordContinuationChannelId = boundedRichDeliveryId(
    value?.discordContinuationChannelId,
  );
  if (discordContinuationChannelId) {
    error.discordContinuationChannelId = discordContinuationChannelId;
  }
  error.discordPostCompleted = Boolean(value?.discordPostCompleted);
  error.discordAttachmentVerificationPending = Boolean(
    value?.discordAttachmentVerificationPending,
  );
  error.discordMessageIds = boundedRichMessageIds(value?.discordMessageIds);
  return error;
}
