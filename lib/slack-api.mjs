import { toSlackMrkdwn } from './message-markdown.mjs';
import { splitRichContent } from './rich-content.mjs';
import { boundedRichMessageIds, boundedRichPartCount } from './rich-delivery-progress.mjs';

const SLACK_MESSAGE_LIMIT = 35_000;
const FENCE_LINE_PATTERN = /^[ \t]*(```+|~~~+).*$/gm;
const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

export class SlackApi {
  constructor({
    botToken = '',
    appToken = '',
    apiBaseUrl = 'https://slack.com/api',
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.apiBaseUrl = String(apiBaseUrl || 'https://slack.com/api').replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  authTest() {
    return this.request('auth.test');
  }

  openSocketConnection({ signal = null } = {}) {
    return this.request('apps.connections.open', {}, {
      token: this.appToken,
      signal,
    });
  }

  async postMessage(channelId, content, {
    threadTs = null,
    startPartIndex = 0,
    styleId = undefined,
    includeStylePreview = false,
  } = {}) {
    const parts = await slackMessageParts(content, { styleId, includeStylePreview });
    const startAt = Math.min(
      Math.max(0, Math.trunc(Number(startPartIndex) || 0)),
      parts.length,
    );
    const sent = [];
    let completedParts = 0;
    try {
      for (const part of parts.slice(startAt)) {
        if (part.type === 'image') {
          sent.push(await this.postAttachment(channelId, part.attachment, { threadTs }));
        } else {
          sent.push(await this.postTextChunk(channelId, part.content, { threadTs }));
        }
        completedParts += 1;
      }
    } catch (error) {
      // An outbox retry must resume after the visible parts Slack already
      // accepted. Without this progress, a later attachment failure re-posts
      // every earlier text chunk on every retry.
      error.slackCompletedParts = boundedRichPartCount(completedParts);
      error.slackCompletedMessageIds = boundedRichMessageIds(
        sent.map((message) => message.id).filter(Boolean),
      );
      // Compatibility for persisted entries and callers predating the shared
      // rich-part handoff field.
      error.slackMessageIds = error.slackCompletedMessageIds;
      error.slackTotalParts = boundedRichPartCount(parts.length);
      throw error;
    }
    return sent;
  }

  async postText(channelId, content, { threadTs = null } = {}) {
    const sent = [];
    for (const chunk of chunkSlackMessage(toSlackMrkdwn(content))) {
      sent.push(await this.postTextChunk(channelId, chunk, { threadTs }));
    }
    return sent;
  }

  async postTextChunk(channelId, content, { threadTs = null } = {}) {
    const message = await this.request('chat.postMessage', {
      channel: String(channelId),
      text: String(content),
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
      ...(threadTs ? { thread_ts: String(threadTs) } : {}),
    });
    return {
      ...message,
      id: message.ts || message.message?.ts || '',
    };
  }

  // Slack's current external-upload flow is a three-step API: request an
  // upload URL, send the bytes to that one-time URL, then share the completed
  // file in the destination channel/thread.
  async postAttachment(channelId, attachment, { threadTs = null } = {}) {
    const filename = String(attachment?.filename || 'codex-image.png');
    const data = attachment?.data ?? Buffer.alloc(0);
    const upload = await this.request('files.getUploadURLExternal', {
      filename,
      length: Buffer.byteLength(data),
      ...(attachment?.description ? { alt_txt: String(attachment.description) } : {}),
    }, { formEncoded: true });
    const uploadUrl = String(upload?.upload_url || '');
    const fileId = String(upload?.file_id || '');
    if (!uploadUrl || !fileId) throw new Error('Slack API files.getUploadURLExternal returned no upload URL or file ID');

    const response = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': attachment?.contentType || 'application/octet-stream' },
      body: data,
    });
    if (!response?.ok) {
      throw new Error(`Slack external file upload failed: HTTP ${response?.status || 'unknown'}`);
    }

    const completed = await this.request('files.completeUploadExternal', {
      files: [{
        id: fileId,
        title: filename,
      }],
      channel_id: String(channelId),
      ...(threadTs ? { thread_ts: String(threadTs) } : {}),
    });
    return {
      ...completed,
      id: completed.files?.[0]?.id || fileId,
    };
  }

  addReaction(channelId, timestamp, name = 'thumbsup') {
    return this.request('reactions.add', {
      channel: String(channelId),
      timestamp: String(timestamp),
      name: String(name),
    });
  }

  userInfo(userId) {
    return this.request('users.info', { user: String(userId) }, { formEncoded: true });
  }

  channelInfo(channelId) {
    return this.request('conversations.info', { channel: String(channelId) }, { formEncoded: true });
  }

  async listMessages(channelId, { oldest = null, latest = null, limit = 100 } = {}) {
    const result = await this.request('conversations.history', {
      channel: String(channelId),
      limit: Math.min(Math.max(Number(limit) || 100, 1), 100),
      inclusive: true,
      ...(oldest ? { oldest: String(oldest) } : {}),
      ...(latest ? { latest: String(latest) } : {}),
    }, { formEncoded: true });
    return Array.isArray(result.messages) ? result.messages : [];
  }

  async listReplies(channelId, threadTs, { oldest = null, limit = 100 } = {}) {
    const result = await this.request('conversations.replies', {
      channel: String(channelId),
      ts: String(threadTs),
      limit: Math.min(Math.max(Number(limit) || 100, 1), 100),
      inclusive: true,
      ...(oldest ? { oldest: String(oldest) } : {}),
    }, { formEncoded: true });
    return Array.isArray(result.messages) ? result.messages : [];
  }

  async request(method, body = {}, {
    token = this.botToken,
    formEncoded = false,
    signal = null,
  } = {}) {
    if (!token) throw new Error(`Slack API ${method} requires a token`);
    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);
      const response = await this.fetchImpl(`${this.apiBaseUrl}/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': formEncoded
            ? 'application/x-www-form-urlencoded; charset=utf-8'
            : 'application/json; charset=utf-8',
        },
        body: formEncoded
          ? formEncodeSlackBody(body)
          : JSON.stringify(body || {}),
        ...(signal ? { signal } : {}),
      });

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfterSeconds = Number(response.headers?.get?.('retry-after') || 1);
        await delay(
          Math.min(Math.max(retryAfterSeconds, 1) * 1000, MAX_RATE_LIMIT_WAIT_MS),
          { signal },
        );
        continue;
      }

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        const reason = result?.error || response.statusText || `HTTP ${response.status}`;
        const error = new Error(`Slack API ${method} failed: ${reason}`);
        error.status = response.status;
        error.slackError = result?.error || null;
        throw error;
      }
      return result;
    }
  }
}

export function chunkSlackMessage(content, limit = SLACK_MESSAGE_LIMIT) {
  const text = String(content ?? '');
  if (!text.trim()) return ['(empty)'];
  if (text.length <= limit) return [text];

  // Slack parses each posted message on its own, so a split inside a fenced
  // block would leave the table or code sample it holds rendering as raw text.
  // Reserve room up front for the fence a boundary has to close and reopen.
  const margin = fenceBalanceMargin(text);
  const windowLimit = margin
    ? Math.max(limit - Math.min(margin, Math.floor(limit / 2)), 1)
    : limit;

  const chunks = [];
  let remaining = text;
  while (remaining.length > windowLimit) {
    const window = remaining.slice(0, windowLimit);
    const newline = window.lastIndexOf('\n');
    const whitespace = window.search(/\s+\S*$/);
    const splitAt = newline >= Math.floor(windowLimit * 0.5)
      ? newline + 1
      : whitespace >= Math.floor(windowLimit * 0.5)
        ? whitespace + 1
        : windowLimit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return margin ? balanceCodeFences(chunks) : chunks;
}

export async function slackMessageParts(content, options = {}) {
  const parts = [];
  for (const part of await splitRichContent(content, options)) {
    if (part.type === 'image') {
      parts.push(part);
      continue;
    }
    for (const chunk of chunkSlackMessage(toSlackMrkdwn(part.content))) {
      if (chunk.trim()) parts.push({ type: 'text', content: chunk });
    }
  }
  return parts;
}

// Room a boundary needs to close the open block and reopen it, info string
// included, so a balanced chunk still fits under the limit.
function fenceBalanceMargin(text) {
  const longest = (text.match(FENCE_LINE_PATTERN) || [])
    .reduce((widest, line) => Math.max(widest, line.trimEnd().length), 0);
  return longest ? longest * 2 + 2 : 0;
}

function balanceCodeFences(chunks) {
  const balanced = [];
  let reopen = null;

  for (const chunk of chunks) {
    const body = reopen ? `${reopen}\n${chunk}` : chunk;
    const open = openFenceAfter(body);
    balanced.push(open ? `${body}${body.endsWith('\n') ? '' : '\n'}${fenceDelimiter(open)}` : body);
    reopen = open;
  }

  return balanced;
}

function openFenceAfter(text) {
  let open = null;
  for (const line of String(text).split('\n')) {
    const fence = line.match(/^[ \t]*(```+|~~~+)(.*)$/);
    if (!fence) continue;
    if (!open) {
      open = line.trimEnd();
      continue;
    }
    const delimiter = fenceDelimiter(open);
    if (fence[1][0] === delimiter[0] && fence[1].length >= delimiter.length && !fence[2].trim()) {
      open = null;
    }
  }
  return open;
}

function fenceDelimiter(fenceLine) {
  return String(fenceLine).trim().match(/^(```+|~~~+)/)?.[1] || '```';
}

function delay(ms, { signal = null } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Slack API request aborted');
  error.name = 'AbortError';
  return error;
}

function formEncodeSlackBody(body = {}) {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(body || {})) {
    if (value === undefined || value === null) continue;
    encoded.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return encoded.toString();
}
