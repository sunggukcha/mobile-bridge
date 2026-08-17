import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDiscordAttachment } from '../lib/discord-attachment-upload.mjs';
import { DiscordApi } from '../lib/discord-api.mjs';
import { SlackApi } from '../lib/slack-api.mjs';
import { DurableBus } from '../v3/lib/durable-bus.mjs';
import { DiscordReceptionAdapter } from '../v3/lib/discord-reception.mjs';
import {
  DiscordPlatformProxy,
  SlackPlatformProxy,
  WorkbenchPlatformRpc,
} from '../v3/lib/platform-rpc.mjs';
import { ReceptionService } from '../v3/lib/reception-service.mjs';

test('Workbench platform RPC durably crosses the Reception boundary', {
  timeout: 10_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-rpc-'));
  const dbPath = path.join(root, 'coordination.sqlite');
  const receptionBus = new DurableBus(dbPath);
  const workbenchBus = new DurableBus(dbPath);
  const calls = [];
  const reception = new ReceptionService({
    bus: receptionBus,
    host: '127.0.0.1',
    port: 0,
    token: 'rpc-test-token',
    pollIntervalMs: 25,
    leaseTtlMs: 2_000,
    leaseRenewMs: 250,
    adapters: {
      discord: {
        async invoke(method, args) {
          calls.push({ method, args });
          if (method === 'postMessage') return [{ id: 'message-1' }];
          if (method === 'getChannel') {
            const error = new Error('missing channel');
            error.status = 404;
            throw error;
          }
          if (method === 'getMessage') {
            const error = new Error('verification fetch failed');
            error.discordPostCompleted = true;
            error.discordAttachmentVerificationPending = true;
            error.discordMessageIds = ['attachment-message-1'];
            error.discordCompletedParts = 1;
            error.discordCompletedMessageIds = ['rich-text-1'];
            error.discordCompletedMessageCount = 1;
            error.discordTotalParts = 2;
            error.discordPartialPartMessageCount = 1;
            error.discordContinuationChannelId = 'rich-thread-1';
            throw error;
          }
          return null;
        },
      },
      slack: {
        async invoke(method) {
          if (method !== 'postMessage') return null;
          const error = new Error('attachment failed after text');
          error.slackError = 'invalid_arguments';
          error.slackCompletedParts = 1;
          error.slackCompletedMessageIds = ['1.000001'];
          error.slackMessageIds = ['1.000001'];
          error.slackTotalParts = 3;
          throw error;
        },
      },
    },
  });
  let rpc = null;
  try {
    await reception.start();
    rpc = new WorkbenchPlatformRpc({
      bus: workbenchBus,
      receptionUrl: reception.status().address.url,
      token: 'rpc-test-token',
      pollIntervalMs: 25,
      timeoutMs: 2_000,
    });
    rpc.start();
    const discord = new DiscordPlatformProxy(rpc);
    const slack = new SlackPlatformProxy(rpc);
    assert.deepEqual(
      await discord.postMessage('thread-1', 'hello', { allowed_mentions: {} }),
      [{ id: 'message-1' }],
    );
    await assert.rejects(
      discord.getChannel('missing'),
      (error) => error.status === 404 && /missing channel/.test(error.message),
    );
    await assert.rejects(
      discord.getMessage('thread-1', 'attachment-message-1'),
      (error) => {
        assert.equal(error.discordPostCompleted, true);
        assert.equal(error.discordAttachmentVerificationPending, true);
        assert.deepEqual(error.discordMessageIds, ['attachment-message-1']);
        assert.equal(error.discordCompletedParts, 1);
        assert.deepEqual(error.discordCompletedMessageIds, ['rich-text-1']);
        assert.equal(error.discordCompletedMessageCount, 1);
        assert.equal(error.discordTotalParts, 2);
        assert.equal(error.discordPartialPartMessageCount, 1);
        assert.equal(error.discordContinuationChannelId, 'rich-thread-1');
        return true;
      },
    );
    await assert.rejects(
      slack.postMessage('C123', 'rich content', { threadTs: '1.000000' }),
      (error) => {
        assert.equal(error.slackError, 'invalid_arguments');
        assert.equal(error.slackCompletedParts, 1);
        assert.deepEqual(error.slackCompletedMessageIds, ['1.000001']);
        assert.deepEqual(error.slackMessageIds, ['1.000001']);
        assert.equal(error.slackTotalParts, 3);
        return true;
      },
    );
    assert.deepEqual(calls, [
      {
        method: 'postMessage',
        args: ['thread-1', 'hello', { allowed_mentions: {} }],
      },
      {
        method: 'getChannel',
        args: ['missing'],
      },
      {
        method: 'getMessage',
        args: ['thread-1', 'attachment-message-1'],
      },
    ]);
    assert.equal(receptionBus.pendingCount('reception'), 0);
  } finally {
    await rpc?.stop().catch(() => {});
    await reception.stop().catch(() => {});
    workbenchBus.close();
    receptionBus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Reception RPC renders Discord and Slack rich content as PNG', {
  timeout: 10_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-rich-rpc-'));
  const dbPath = path.join(root, 'coordination.sqlite');
  const receptionBus = new DurableBus(dbPath);
  const workbenchBus = new DurableBus(dbPath);
  const discordApi = new CapturingDiscordApi();
  const slackUploads = [];
  const slackApi = new SlackApi({
    botToken: 'xoxb-test',
    fetchImpl: async (url, options) => {
      if (url === 'https://slack.com/api/files.getUploadURLExternal') {
        return slackJsonResponse({
          ok: true,
          upload_url: 'https://uploads.slack.test/file',
          file_id: 'F-PNG',
        });
      }
      if (url === 'https://uploads.slack.test/file') {
        slackUploads.push(options);
        return { ok: true, status: 200 };
      }
      if (url === 'https://slack.com/api/files.completeUploadExternal') {
        return slackJsonResponse({ ok: true, files: [{ id: 'F-PNG' }] });
      }
      return slackJsonResponse({ ok: true, ts: '1.000001' });
    },
  });
  const reception = new ReceptionService({
    bus: receptionBus,
    host: '127.0.0.1',
    port: 0,
    token: 'rich-rpc-test-token',
    pollIntervalMs: 25,
    leaseTtlMs: 2_000,
    leaseRenewMs: 250,
    adapters: {
      discord: {
        invoke(method, args) {
          return discordApi[method](...args);
        },
      },
      slack: {
        invoke(method, args) {
          return slackApi[method](...args);
        },
      },
    },
  });
  let rpc = null;
  try {
    await reception.start();
    rpc = new WorkbenchPlatformRpc({
      bus: workbenchBus,
      receptionUrl: reception.status().address.url,
      token: 'rich-rpc-test-token',
      pollIntervalMs: 25,
      timeoutMs: 2_000,
    });
    rpc.start();
    const discord = new DiscordPlatformProxy(rpc);
    const slack = new SlackPlatformProxy(rpc);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="80"><rect width="180" height="80" fill="navy"/></svg>';

    await discord.postMessage('thread-1', `구조\n\n\`\`\`svg\n${svg}\n\`\`\``);
    await slack.postMessage(
      'C123',
      '표\n\n| 항목 | 상태 |\n|---|---|\n| Worker | alive |',
      { threadTs: '1.000000' },
    );

    assert.equal(discordApi.attachments.length, 1);
    assertPng(discordApi.attachments[0].attachments[0]);
    assert.match(
      discordApi.attachments[0].attachments[0].filename,
      /^codex-diagram-[a-f0-9]{12}\.png$/,
    );
    assert.equal(discordApi.sent.some((entry) => entry.content.includes('<svg')), false);
    assert.equal(slackUploads.length, 1);
    assert.equal(slackUploads[0].headers['Content-Type'], 'image/png');
    assert.equal(
      Buffer.from(slackUploads[0].body).subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
    );
    assert.equal(receptionBus.pendingCount('reception'), 0);
  } finally {
    await rpc?.stop().catch(() => {});
    await reception.stop().catch(() => {});
    workbenchBus.close();
    receptionBus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Reception RPC uploads referenced artifact bytes without exposing Discord credentials to workers', {
  timeout: 10_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-artifact-rpc-'));
  const dbPath = path.join(root, 'coordination.sqlite');
  const filePath = path.join(root, 'style_v2_a.png');
  await fs.writeFile(filePath, Buffer.from('artifact-over-rpc'));
  const selected = await loadDiscordAttachment(filePath);
  const receptionBus = new DurableBus(dbPath);
  const workbenchBus = new DurableBus(dbPath);
  const discordApi = new CapturingDiscordApi();
  t.mock.method(globalThis, 'fetch', async (url) => {
    const bytes = discordApi.remoteFiles.get(String(url));
    if (!bytes) throw new Error(`unexpected CDN request ${url}`);
    return new Response(bytes, { status: 200 });
  });
  const reception = new ReceptionService({
    bus: receptionBus,
    host: '127.0.0.1',
    port: 0,
    token: 'artifact-rpc-test-token',
    pollIntervalMs: 25,
    leaseTtlMs: 2_000,
    leaseRenewMs: 250,
    adapters: {
      discord: {
        invoke(method, args) {
          return discordApi[method](...args);
        },
      },
    },
  });
  let rpc = null;
  try {
    await reception.start();
    rpc = new WorkbenchPlatformRpc({
      bus: workbenchBus,
      receptionUrl: reception.status().address.url,
      token: 'artifact-rpc-test-token',
      pollIntervalMs: 25,
      timeoutMs: 2_000,
    });
    rpc.start();
    const discord = new DiscordPlatformProxy(rpc);

    await discord.postMessage('thread-1', '이미지를 보냈습니다.', {
      files: [{
        filename: selected.filename,
        size: selected.size,
        sha256: selected.sha256,
        dataBase64: selected.data.toString('base64'),
      }],
    });

    assert.equal(discordApi.attachments.length, 1);
    assert.equal(discordApi.attachments[0].channelId, 'thread-1');
    assert.equal(discordApi.attachments[0].options.content, '이미지를 보냈습니다.');
    assert.equal(
      discordApi.attachments[0].attachments[0].data.toString(),
      'artifact-over-rpc',
    );
    assert.equal(discordApi.messageReads, 1);
    assert.equal(receptionBus.pendingCount('reception'), 0);
  } finally {
    await rpc?.stop().catch(() => {});
    await reception.stop().catch(() => {});
    workbenchBus.close();
    receptionBus.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('production Discord Reception rejects generic RPC host-file paths', async () => {
  const adapter = new DiscordReceptionAdapter({
    config: { token: 'test-token' },
    ignoreBefore: new Date(0),
    onInbound: async () => {},
  });

  await assert.rejects(
    adapter.invoke('postMessage', ['thread-1', '전달', {
      files: [{ path: '/etc/passwd', filename: 'passwd.txt' }],
    }]),
    /file paths are disabled at the Reception boundary/,
  );
});

test('Discord Reception bounds a stuck Gateway close handshake', async () => {
  const adapter = new DiscordReceptionAdapter({
    config: { token: 'test-token' },
    ignoreBefore: new Date(0),
    onInbound: async () => {},
    stopTimeoutMs: 20,
  });
  let closeCalls = 0;
  let terminateCalls = 0;
  let resolveLoop;
  adapter.running = true;
  adapter.ready = true;
  adapter.stopController = new AbortController();
  adapter.loopPromise = new Promise((resolve) => {
    resolveLoop = resolve;
  });
  adapter.socket = {
    close() {
      closeCalls += 1;
      // Simulate a peer that never completes the close handshake.
    },
    terminate() {
      terminateCalls += 1;
      adapter.socket = null;
      resolveLoop();
    },
  };

  await adapter.stop();

  assert.equal(closeCalls, 1);
  assert.equal(terminateCalls, 1);
  assert.equal(adapter.running, false);
  assert.equal(adapter.ready, false);
  assert.equal(adapter.loopPromise, null);
});

class CapturingDiscordApi extends DiscordApi {
  constructor() {
    super({
      token: 'test-token',
      apiBaseUrl: 'https://discord.test/api',
      allowAttachmentFilePaths: false,
    });
    this.sent = [];
    this.attachments = [];
    this.messages = new Map();
    this.remoteFiles = new Map();
    this.messageReads = 0;
  }

  async postAttachments(channelId, attachments, options = {}) {
    this.attachments.push({ channelId, attachments, options });
    const id = `attachment-${this.attachments.length}`;
    const message = {
      id,
      attachments: attachments.map((attachment, index) => {
        const url = `https://cdn.test/${id}/${index}`;
        this.remoteFiles.set(url, Buffer.from(attachment.data));
        return {
          id: `${id}-${index}`,
          filename: attachment.filename,
          size: attachment.size,
          url,
        };
      }),
    };
    this.messages.set(`${channelId}:${id}`, message);
    return message;
  }

  async getMessage(channelId, messageId) {
    this.messageReads += 1;
    return this.messages.get(`${channelId}:${messageId}`) || null;
  }

  async request(method, route, body = null) {
    if (method === 'POST' && /\/channels\/[^/]+\/messages$/.test(route)) {
      this.sent.push({ content: String(body?.content || '') });
      return { id: `message-${this.sent.length}` };
    }
    throw new Error(`unexpected Discord RPC request: ${method} ${route}`);
  }
}

function assertPng(attachment) {
  assert.equal(attachment.contentType, 'image/png');
  assert.equal(
    attachment.data.subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
  );
}

function slackJsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    async json() {
      return body;
    },
  };
}
