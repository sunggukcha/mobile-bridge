import WebSocket from 'ws';
import { DiscordApi } from '../../lib/discord-api.mjs';
import { GatewaySession, HeartbeatMonitor } from '../../lib/discord-gateway.mjs';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

export class DiscordReceptionAdapter {
  constructor({
    config,
    ignoreBefore,
    onInbound,
    onLog = null,
    reconnectMs = 5_000,
    stopTimeoutMs = 2_000,
    rawEvents = false,
  } = {}) {
    if (!config?.token) throw new Error('Discord reception requires a bot token');
    if (typeof onInbound !== 'function') throw new Error('Discord reception requires onInbound');
    this.config = config;
    this.ignoreBefore = ignoreBefore instanceof Date ? ignoreBefore : new Date(ignoreBefore);
    this.onInbound = onInbound;
    this.onLog = onLog;
    this.reconnectMs = Math.max(200, Number(reconnectMs) || 5_000);
    this.stopTimeoutMs = Math.max(20, Number(stopTimeoutMs) || 2_000);
    this.rawEvents = Boolean(rawEvents);
    this.api = new DiscordApi({
      ...config,
      // Workbench sends immutable bytes. Reception must never turn its
      // credential-owning generic RPC into an arbitrary host-file reader.
      allowAttachmentFilePaths: false,
    });
    this.session = new GatewaySession();
    this.heartbeatMonitor = new HeartbeatMonitor();
    this.threadParentCache = new Map();
    this.botUserId = '';
    this.running = false;
    this.ready = false;
    this.lastReadyAt = '';
    this.socket = null;
    this.loopPromise = null;
    this.heartbeatTimer = null;
    this.stopController = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.ready = false;
    this.stopController = new AbortController();
    this.loopPromise = this.gatewayLoop();
  }

  async stop() {
    this.running = false;
    this.ready = false;
    this.clearHeartbeat();
    this.stopController?.abort();
    const socket = this.socket;
    const loopPromise = this.loopPromise;
    let forceTimer = null;
    try {
      socket?.close(1000, 'reception stopping');
      if (socket && loopPromise) {
        // A WebSocket close handshake has no built-in deadline. Bound it well
        // below the Supervisor's role-stop timeout so Reception can release
        // its lease instead of being SIGKILLed and fencing its replacement.
        forceTimer = setTimeout(() => {
          try {
            socket.terminate();
          } catch {
            // The close event may have won the race.
          }
        }, this.stopTimeoutMs);
      }
    } catch {
      socket?.terminate();
    }
    if (loopPromise) await loopPromise.catch(() => {});
    if (forceTimer) clearTimeout(forceTimer);
    this.loopPromise = null;
    this.stopController = null;
  }

  async deliver(message) {
    const channelId = String(message.destination?.channelId || '');
    if (!channelId) throw new Error('Discord outbound destination.channelId is required');
    return this.api.postMessage(channelId, message.content);
  }

  invoke(method, args = []) {
    const allowed = new Set([
      'getChannel',
      'getMessage',
      'listMessages',
      'postMessage',
      'createThreadFromMessage',
      'createThread',
      'addReaction',
    ]);
    const name = String(method || '');
    if (!allowed.has(name)) {
      throw new Error(`unsupported Discord reception operation: ${name}`);
    }
    return this.api[name](...(Array.isArray(args) ? args : []));
  }

  async gatewayLoop() {
    let failures = 0;
    while (this.running) {
      const url = this.session.connectUrl(GATEWAY_URL);
      try {
        await this.connectOnce(url);
        failures = 0;
      } catch (error) {
        failures += 1;
        await this.log('discord-gateway-error', {
          failures,
          error: error.message || String(error),
        });
        if (failures >= 3 && this.session.canResume()) this.session.reset();
      }
      if (this.running) {
        await delay(this.reconnectMs, this.stopController?.signal);
      }
    }
  }

  connectOnce(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false });
      this.socket = socket;
      let settled = false;
      const settle = (error = null) => {
        if (settled) return;
        settled = true;
        const wasReady = this.ready;
        this.ready = false;
        this.clearHeartbeat();
        if (this.socket === socket) this.socket = null;
        if (wasReady) {
          this.log('discord-not-ready', {
            reason: error?.message || 'gateway connection closed',
          }).catch(() => {});
        }
        if (error) reject(error);
        else resolve();
      };
      socket.on('open', () => this.log('discord-gateway-open').catch(() => {}));
      socket.on('message', (data) => {
        let payload;
        try {
          payload = JSON.parse(String(data || ''));
        } catch (error) {
          this.log('discord-gateway-invalid-json', { error: error.message }).catch(() => {});
          return;
        }
        this.handleGatewayPayload(socket, payload)
          .catch((error) => this.log('discord-gateway-message-error', {
            error: error.message || String(error),
          }));
      });
      socket.on('close', () => settle());
      socket.on('error', (error) => settle(error));
    });
  }

  async handleGatewayPayload(socket, payload) {
    this.session.noteSequence(payload.s);
    if (payload.op === 1) {
      socket.send(JSON.stringify({ op: 1, d: this.session.sequence }));
      return;
    }
    if (payload.op === 11) {
      this.heartbeatMonitor.ack();
      return;
    }
    if (payload.op === 10) {
      this.clearHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (!this.heartbeatMonitor.beat()) {
          socket.close(4000, 'heartbeat acknowledgement missing');
          return;
        }
        socket.send(JSON.stringify({ op: 1, d: this.session.sequence }));
      }, Number(payload.d?.heartbeat_interval) || 45_000);
      this.heartbeatTimer.unref?.();
      socket.send(JSON.stringify(this.session.helloReply({
        token: this.config.token,
        intents: this.config.gatewayIntents,
        properties: {
          os: 'linux',
          browser: 'mobile-codex-bridge-v3',
          device: 'mobile-codex-bridge-v3',
        },
      })));
      return;
    }
    if (payload.op === 7) {
      socket.close(4000, 'Discord requested reconnect');
      return;
    }
    if (payload.op === 9) {
      const resumable = payload.d === true;
      this.session.noteInvalidSession(resumable);
      if (!resumable) await delay(1_000 + Math.floor(Math.random() * 4_000));
      socket.close(4000, 'invalid Discord session');
      return;
    }
    if (payload.op !== 0) return;
    if (payload.t === 'READY') {
      this.session.noteReady(payload.d);
      this.botUserId = String(payload.d?.user?.id || '');
      this.ready = true;
      this.lastReadyAt = new Date().toISOString();
      await this.log('discord-ready', { botUserId: this.botUserId });
      return;
    }
    if (payload.t === 'RESUMED') {
      this.ready = true;
      this.lastReadyAt = new Date().toISOString();
      await this.log('discord-ready', {
        botUserId: this.botUserId,
        resumed: true,
      });
      return;
    }
    if (payload.t === 'MESSAGE_CREATE') await this.handleMessage(payload.d);
  }

  async handleMessage(message = {}) {
    const timestamp = Date.parse(message.timestamp || '');
    if (!Number.isFinite(timestamp) || timestamp < this.ignoreBefore.getTime()) return;
    if (message.author?.bot || String(message.author?.id || '') === this.botUserId) return;
    if (
      !this.config.allowAllUsers
      && !this.config.allowedUserIds?.has(String(message.author?.id || ''))
    ) return;
    let scope;
    try {
      scope = await this.resolveScope(message);
    } catch (error) {
      if (!this.rawEvents) throw error;
      await this.log('discord-scope-check-deferred-to-workbench', {
        channelId: String(message.channel_id || ''),
        messageId: String(message.id || ''),
        error: error.message,
      });
      scope = { deferred: true };
    }
    if (!scope) return;
    if (this.rawEvents) {
      await this.onInbound({
        jobId: String(message.id),
        kind: 'platform.event',
        platform: 'discord',
        event: message,
        messageId: `inbound:discord:${String(message.id)}`,
      });
      return;
    }

    let destinationId = scope.threadId;
    if (!scope.inThread && this.config.threadMode === 'per_message') {
      const seed = String(message.content || 'Codex 작업');
      const thread = await this.api.createThreadFromMessage(
        scope.channelId,
        message.id,
        seed,
        this.config.autoArchiveDuration,
      ).catch(() => this.api.createThread(
        scope.channelId,
        seed,
        this.config.autoArchiveDuration,
      ));
      destinationId = String(thread.id);
    }
    const acknowledgement = await this.api
      .addReaction(message.channel_id, message.id, '👍')
      .then(() => ({ ok: true, at: new Date().toISOString() }))
      .catch((error) => ({ ok: false, error: error.message }));
    const event = {
      id: String(message.id),
      timestamp: message.timestamp || new Date().toISOString(),
      authorId: String(message.author?.id || ''),
      authorName: discordAuthorName(message.author),
      channelId: scope.channelId,
      threadId: destinationId,
      content: String(message.content || ''),
      platform: 'discord',
      source: 'discord',
      sourceChannelId: String(message.channel_id || ''),
      sourceThreadId: destinationId,
      sourceMessageId: String(message.id),
      acknowledged: acknowledgement.ok,
      acknowledgedAt: acknowledgement.at || null,
      acknowledgementError: acknowledgement.error || null,
      attachments: compactAttachments(message.attachments),
      embeds: compactEmbeds(message.embeds),
    };
    await this.onInbound({
      jobId: event.id,
      event,
      reply: {
        platform: 'discord',
        destination: { channelId: destinationId },
      },
      messageId: `inbound:discord:${event.id}`,
    });
  }

  async resolveScope(message) {
    const channelId = String(message.channel_id || '');
    if (this.config.allowedChannelIds.has(channelId)) {
      return { channelId, threadId: channelId, inThread: false };
    }
    if (this.threadParentCache.has(channelId)) {
      const parentId = this.threadParentCache.get(channelId);
      return parentId
        ? { channelId: parentId, threadId: channelId, inThread: true }
        : null;
    }
    const channel = await this.api.getChannel(channelId);
    const parentId = String(channel?.parent_id || '');
    const allowedParent = this.config.allowedChannelIds.has(parentId) ? parentId : '';
    if (this.threadParentCache.size > 5_000) this.threadParentCache.clear();
    this.threadParentCache.set(channelId, allowedParent);
    return allowedParent
      ? { channelId: allowedParent, threadId: channelId, inThread: true }
      : null;
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatMonitor.reset();
  }

  status() {
    return {
      running: this.running,
      ready: this.ready,
      botUserId: this.botUserId,
      lastReadyAt: this.lastReadyAt || null,
      connected: Boolean(this.socket),
    };
  }

  async log(type, payload = {}) {
    await this.onLog?.(type, payload);
  }
}

function discordAuthorName(author = {}) {
  return String(
    author.global_name
    || author.display_name
    || author.username
    || author.id
    || 'user',
  );
}

function compactAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
    id: String(attachment.id || ''),
    filename: String(attachment.filename || attachment.id || 'attachment'),
    url: String(attachment.url || attachment.proxy_url || ''),
    content_type: String(attachment.content_type || ''),
    size: Number(attachment.size || 0) || null,
  }));
}

function compactEmbeds(embeds = []) {
  return (Array.isArray(embeds) ? embeds : []).map((embed) => ({
    title: String(embed.title || ''),
    description: String(embed.description || ''),
    url: String(embed.url || ''),
    type: String(embed.type || ''),
  }));
}

function delay(ms, signal = null) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
