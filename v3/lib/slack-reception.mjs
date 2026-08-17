import { SlackApi } from '../../lib/slack-api.mjs';
import {
  compactSlackFiles,
  isSlackUserMessageEvent,
  slackCommandToBridgeCommand,
  slackMessageReservationId,
  slackThreadStateId,
  slackTimestampToIso,
} from '../../lib/slack-message.mjs';
import { SlackSocketModeClient } from '../../lib/slack-socket-mode.mjs';

export class SlackReceptionAdapter {
  constructor({
    config,
    ignoreBefore,
    onInbound,
    onLog = null,
    rawEvents = false,
  } = {}) {
    if (!config?.appToken || !config?.botToken || !config?.channelId) {
      throw new Error('Slack reception requires appToken, botToken, and channelId');
    }
    if (typeof onInbound !== 'function') throw new Error('Slack reception requires onInbound');
    this.config = config;
    this.ignoreBefore = ignoreBefore instanceof Date ? ignoreBefore : new Date(ignoreBefore);
    this.onInbound = onInbound;
    this.onLog = onLog;
    this.rawEvents = Boolean(rawEvents);
    this.api = new SlackApi(config);
    this.client = null;
    this.runPromise = null;
    this.botUserId = '';
    this.teamId = config.teamId || '';
    this.userCache = new Map();
    this.running = false;
    this.authReady = false;
  }

  async start() {
    this.running = true;
    this.authReady = false;
    const auth = await this.api.authTest();
    this.botUserId = String(auth.user_id || '');
    this.teamId = String(auth.team_id || this.teamId || '');
    if (this.config.teamId && this.teamId !== String(this.config.teamId)) {
      throw new Error(`Slack workspace mismatch: expected ${this.config.teamId}, received ${this.teamId}`);
    }
    this.client = new SlackSocketModeClient({
      api: this.api,
      onEnvelope: (envelope) => this.handleEnvelope(envelope),
      reconnectDelayMs: this.config.reconnectIntervalMs,
      log: (type, payload) => this.log(type, payload),
    });
    this.runPromise = this.client.run();
    this.authReady = true;
    await this.log('slack-ready', {
      botUserId: this.botUserId,
      teamId: this.teamId,
    });
  }

  async stop() {
    this.running = false;
    this.authReady = false;
    this.client?.stop();
    if (this.runPromise) await this.runPromise.catch(() => {});
    this.client = null;
    this.runPromise = null;
  }

  deliver(message) {
    const channelId = String(message.destination?.channelId || '');
    const threadTs = String(message.destination?.threadTs || '');
    if (!channelId || !threadTs) {
      throw new Error('Slack outbound destination.channelId and threadTs are required');
    }
    if (channelId !== String(this.config.channelId)) {
      throw new Error(`refusing Slack delivery to unconfigured channel ${channelId}`);
    }
    return this.api.postMessage(channelId, message.content, { threadTs });
  }

  invoke(method, args = []) {
    const allowed = new Set([
      'authTest',
      'postMessage',
      'addReaction',
      'userInfo',
      'channelInfo',
      'listMessages',
      'listReplies',
    ]);
    const name = String(method || '');
    if (!allowed.has(name)) {
      throw new Error(`unsupported Slack reception operation: ${name}`);
    }
    return this.api[name](...(Array.isArray(args) ? args : []));
  }

  async handleEnvelope(envelope = {}) {
    if (envelope.type !== 'events_api') return;
    const payload = envelope.payload || {};
    const event = payload.event || {};
    if (!isSlackUserMessageEvent(event)) return;
    if (String(event.channel || '') !== String(this.config.channelId)) return;
    if (String(event.user || '') === this.botUserId) return;
    if (
      !this.config.allowAllUsers
      && !this.config.allowedUserIds?.has(String(event.user || ''))
    ) return;
    const teamId = String(payload.team_id || envelope.team_id || this.teamId || '');
    if (!teamId || (this.teamId && teamId !== this.teamId)) return;
    const timestamp = slackTimestampToIso(event.ts);
    if (!timestamp || Date.parse(timestamp) < this.ignoreBefore.getTime()) return;

    const rootTs = String(event.thread_ts || event.ts);
    const logicalThreadId = slackThreadStateId({
      teamId,
      channelId: event.channel,
      threadTs: rootTs,
    });
    const messageId = slackMessageReservationId(event)
      || `slack-${String(payload.event_id || envelope.envelope_id || Date.now())}`;
    if (this.rawEvents) {
      await this.onInbound({
        jobId: messageId,
        kind: 'platform.event',
        platform: 'slack',
        event,
        teamId,
        eventId: String(payload.event_id || envelope.envelope_id || ''),
        messageId: `inbound:slack:${messageId}`,
      });
      return;
    }
    const acknowledgement = await this.api
      .addReaction(event.channel, event.ts, this.config.acknowledgementReaction)
      .then(() => ({ ok: true, at: new Date().toISOString() }))
      .catch((error) => ({
        ok: error?.slackError === 'already_reacted',
        error: error?.slackError === 'already_reacted' ? '' : error.message,
      }));
    const normalized = {
      id: messageId,
      timestamp,
      authorId: String(event.user),
      authorName: await this.userName(event.user),
      channelId: String(this.config.logicalChannelId),
      threadId: logicalThreadId,
      content: slackCommandToBridgeCommand(event.text || ''),
      platform: 'slack',
      source: 'slack',
      sourceChannelId: String(event.channel),
      sourceThreadId: rootTs,
      sourceMessageId: String(event.ts),
      sourceEventId: String(payload.event_id || envelope.envelope_id || ''),
      acknowledged: acknowledgement.ok,
      acknowledgedAt: acknowledgement.at || null,
      acknowledgementError: acknowledgement.error || null,
      attachments: compactSlackFiles(event.files),
      embeds: [],
    };
    await this.onInbound({
      jobId: normalized.id,
      event: normalized,
      reply: {
        platform: 'slack',
        destination: {
          channelId: String(event.channel),
          threadTs: rootTs,
        },
      },
      messageId: `inbound:slack:${normalized.id}`,
    });
  }

  async userName(userId) {
    const id = String(userId || '');
    if (this.userCache.has(id)) return this.userCache.get(id);
    let name = id;
    try {
      const result = await this.api.userInfo(id);
      name = result.user?.profile?.display_name
        || result.user?.profile?.real_name
        || result.user?.real_name
        || result.user?.name
        || id;
    } catch (error) {
      await this.log('slack-user-info-failed', {
        userId: id,
        error: error.message,
      });
    }
    if (this.userCache.size > 1_000) this.userCache.clear();
    this.userCache.set(id, name);
    return name;
  }

  status() {
    const socket = this.client?.status?.() || {};
    return {
      running: this.running,
      authReady: this.authReady,
      ready: Boolean(this.authReady && socket.ready),
      botUserId: this.botUserId,
      teamId: this.teamId,
      socket,
    };
  }

  async log(type, payload = {}) {
    await this.onLog?.(type, payload);
  }
}
