import { splitRichContent } from './rich-content.mjs';
import {
  loadDiscordAttachment,
  sha256,
  verifyDiscordAttachments,
} from './discord-attachment-upload.mjs';
import {
  boundedRichDeliveryId,
  boundedRichMessageIds,
  boundedRichPartCount,
} from './rich-delivery-progress.mjs';

const DISCORD_MESSAGE_LIMIT = 1800;
const MAX_MESSAGE_ATTACHMENTS = 10;
const MAX_RATE_LIMIT_RETRIES = 8;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const MAX_ERROR_BODY_LENGTH = 1_000;

export class DiscordApi {
  constructor({
    token,
    apiBaseUrl = 'https://discord.com/api/v10',
    allowAttachmentFilePaths = true,
  }) {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.allowAttachmentFilePaths = Boolean(allowAttachmentFilePaths);
  }

  async getChannel(channelId) {
    return this.request('GET', `/channels/${channelId}`);
  }

  async getMessage(channelId, messageId) {
    return this.request('GET', `/channels/${channelId}/messages/${messageId}`);
  }

  async listMessages(channelId, { limit = 50, after = null } = {}) {
    const params = new URLSearchParams({
      limit: String(Math.min(Math.max(Number(limit) || 50, 1), 100)),
    });
    if (after) params.set('after', String(after));
    return this.request('GET', `/channels/${channelId}/messages?${params.toString()}`);
  }

  async postMessage(channelId, content, options = {}) {
    const explicitAttachments = await loadExplicitAttachments(options.files, {
      allowFilePaths: this.allowAttachmentFilePaths,
    });
    const nextMessageOptions = createDiscordMessageOptionsSequencer(options);
    const reconciledAttachmentMessage = await this.reconcileAttachmentMessage(
      channelId,
      explicitAttachments,
      options.reconcileAttachmentMessageId,
    );
    // Consume the nonce slot used by the already-created attachment message so
    // resumed rich/long-message parts retain their original deterministic IDs.
    if (reconciledAttachmentMessage) nextMessageOptions();
    const parts = await splitRichContent(content, {
      styleId: options.styleId,
      includeStylePreview: options.includeStylePreview === true,
    });
    if (parts.some((part) => part.type === 'image')) {
      const startAt = Math.min(
        boundedRichPartCount(options.startPartIndex),
        parts.length,
      );
      const richDelivery = {
        channelId: boundedRichDeliveryId(options.richContinuationChannelId) || String(channelId),
        startPartChunkIndex: parts[startAt]?.type === 'text'
          ? boundedRichPartCount(options.startPartChunkIndex)
          : 0,
      };
      const sent = [];
      let explicitAttachmentMessage = reconciledAttachmentMessage;
      if (explicitAttachments.length > 0) {
        explicitAttachmentMessage ||= await this.postVerifiedAttachments(
          channelId,
          explicitAttachments,
          '',
          nextMessageOptions(),
        );
        sent.push(explicitAttachmentMessage);
      }
      // Rich-part retries skip already visible parts. Advance the deterministic
      // nonce sequence by the number of messages those parts consumed so the
      // first unsent part keeps the same nonce it had on the direct attempt.
      const priorPartMessageCount = boundedRichPartCount(options.startPartMessageCount);
      for (let index = 0; index < priorPartMessageCount; index += 1) nextMessageOptions();

      const completedMessageIds = [];
      let completedMessageCount = 0;
      let completedParts = 0;
      try {
        for (const part of parts.slice(startAt)) {
          const partMessages = [];
          if (part.type === 'image') {
            partMessages.push(await this.postAttachments(
              richDelivery.channelId,
              [part.attachment],
              nextMessageOptions(),
            ));
          } else if (part.content.trim()) {
            partMessages.push(...await this.postPlainMessage(
              richDelivery.channelId,
              part.content,
              options,
              [],
              nextMessageOptions,
              null,
              richDelivery,
            ));
          }
          sent.push(...partMessages);
          completedMessageIds.push(...partMessages.map((message) => message?.id).filter(Boolean));
          completedMessageCount += partMessages.length;
          completedParts += 1;
        }
      } catch (error) {
        const partialMessageIds = boundedRichMessageIds(error?.discordPartialPartMessageIds);
        const partialMessageCount = boundedRichPartCount(error?.discordPartialPartMessageCount);
        error.discordCompletedParts = boundedRichPartCount(completedParts);
        error.discordCompletedMessageIds = boundedRichMessageIds([
          ...completedMessageIds,
          ...partialMessageIds,
        ]);
        error.discordPartialPartMessageCount = boundedRichPartCount(
          error?.discordPartialPartMessageCount,
        );
        error.discordCompletedMessageCount = boundedRichPartCount(
          completedMessageCount + partialMessageCount,
        );
        error.discordTotalParts = boundedRichPartCount(parts.length);
        if (richDelivery.channelId !== String(channelId)) {
          error.discordContinuationChannelId = richDelivery.channelId;
        }
        if (explicitAttachmentMessage?.id) {
          error.discordPostCompleted = true;
          error.discordAttachmentVerificationPending = true;
          error.discordMessageIds = boundedRichMessageIds([
            explicitAttachmentMessage.id,
            ...(Array.isArray(error?.discordMessageIds) ? error.discordMessageIds : []),
          ]);
        }
        throw error;
      }
      return sent;
    }
    // Text-only transformations still matter. Trivial TeX is rewritten to
    // Unicode and oversized GFM tables become fenced, width-aligned text; using
    // the original `content` here silently undid both conversions (#24, #25).
    const transformedContent = parts.length > 0
      ? parts.map((part) => part.content || '').join('')
      : content;
    const longDelivery = {
      channelId: boundedRichDeliveryId(options.richContinuationChannelId) || String(channelId),
      startPartChunkIndex: boundedRichPartCount(options.startPartChunkIndex),
    };
    const priorMessageCount = boundedRichPartCount(options.startPartMessageCount);
    const alreadyConsumedMessageCount = reconciledAttachmentMessage ? 1 : 0;
    for (
      let index = alreadyConsumedMessageCount;
      index < priorMessageCount;
      index += 1
    ) nextMessageOptions();
    try {
      return await this.postPlainMessage(
        longDelivery.channelId,
        transformedContent,
        options,
        explicitAttachments,
        nextMessageOptions,
        reconciledAttachmentMessage,
        longDelivery,
      );
    } catch (error) {
      const partialMessageIds = boundedRichMessageIds(error?.discordPartialPartMessageIds);
      error.discordCompletedMessageIds = boundedRichMessageIds(partialMessageIds);
      error.discordPartialPartMessageCount = boundedRichPartCount(
        error?.discordPartialPartMessageCount,
      );
      error.discordCompletedMessageCount = error.discordPartialPartMessageCount;
      if (longDelivery.channelId !== String(channelId)) {
        error.discordContinuationChannelId = longDelivery.channelId;
      }
      throw error;
    }
  }

  async postPlainMessage(
    channelId,
    content,
    options = {},
    explicitAttachments = [],
    nextMessageOptions = createDiscordMessageOptionsSequencer(options),
    reconciledAttachmentMessage = null,
    richDelivery = null,
  ) {
    const destinationChannelId = boundedRichDeliveryId(richDelivery?.channelId) || String(channelId);
    const rendered = String(content ?? '');
    const chunks = chunkDiscordMessage(rendered);
    const sent = [];
    const startChunkIndex = Math.min(
      boundedRichPartCount(richDelivery?.startPartChunkIndex),
      chunks.length,
    );
    if (richDelivery) richDelivery.startPartChunkIndex = 0;

    try {
      if (startChunkIndex > 0) {
        for (const chunk of chunks.slice(startChunkIndex)) {
          sent.push(await this.sendMessage(
            destinationChannelId,
            chunk,
            continuationMessageOptions(nextMessageOptions()),
          ));
        }
        return sent;
      }

      if (chunks.length === 1) {
        sent.push(explicitAttachments.length > 0
          ? reconciledAttachmentMessage || await this.postVerifiedAttachments(
              destinationChannelId,
              explicitAttachments,
              chunks[0],
              nextMessageOptions(),
            )
          : await this.sendMessage(destinationChannelId, chunks[0], nextMessageOptions()));
        return sent;
      }

      const channel = await this.getChannel(destinationChannelId).catch(() => null);
      const first = explicitAttachments.length > 0
        ? reconciledAttachmentMessage || await this.postVerifiedAttachments(
            destinationChannelId,
            explicitAttachments,
            chunks[0],
            nextMessageOptions(),
          )
        : await this.sendMessage(destinationChannelId, chunks[0], nextMessageOptions());
      sent.push(first);

      let continuationChannelId = destinationChannelId;
      if (!isDiscordThreadChannel(channel) && first?.id) {
        const thread = await this.createThreadFromMessage(
          destinationChannelId,
          first.id,
          options.longMessageThreadName || content,
          options.longMessageAutoArchiveDuration || options.auto_archive_duration,
        ).catch(() => null);
        if (thread?.id) continuationChannelId = String(thread.id);
      }
      if (richDelivery) richDelivery.channelId = continuationChannelId;

      for (const chunk of chunks.slice(1)) {
        sent.push(await this.sendMessage(
          continuationChannelId,
          chunk,
          continuationMessageOptions(nextMessageOptions()),
        ));
      }
      return sent;
    } catch (error) {
      if (richDelivery) {
        error.discordPartialPartMessageCount = boundedRichPartCount(sent.length);
        error.discordPartialPartMessageIds = boundedRichMessageIds(
          sent.map((message) => message?.id).filter(Boolean),
        );
      }
      throw error;
    }
  }

  async postVerifiedAttachments(channelId, attachments, content, options = {}) {
    const message = await this.postAttachments(channelId, attachments, {
      ...options,
      ...(String(content || '').trim() ? { content } : {}),
    });
    if (options.verifyFiles === false) return message;
    try {
      const reread = await this.getMessage(channelId, message.id);
      await verifyDiscordAttachments(reread, attachments);
    } catch (error) {
      error.discordPostCompleted = true;
      error.discordAttachmentVerificationPending = true;
      error.discordMessageIds = [String(message.id || '')].filter(Boolean);
      throw error;
    }
    return message;
  }

  async reconcileAttachmentMessage(channelId, attachments, messageId) {
    const id = String(messageId || '').trim();
    if (!id) return null;
    if (!Array.isArray(attachments) || attachments.length === 0) {
      throw new Error('cannot reconcile a Discord attachment message without immutable attachment bytes');
    }
    const message = await this.getMessage(channelId, id);
    await verifyDiscordAttachments(message, attachments);
    return message;
  }

  async sendMessage(channelId, content, options = {}) {
    return this.request('POST', `/channels/${channelId}/messages`, {
      content,
      allowed_mentions: { parse: [] },
      ...discordMessageOptions(options),
    });
  }

  async postAttachments(channelId, attachments, options = {}) {
    const files = Array.isArray(attachments) ? attachments : [];
    if (files.length === 0) throw new Error('at least one Discord attachment is required');
    if (files.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new Error(`Discord allows at most ${MAX_MESSAGE_ATTACHMENTS} attachments per message`);
    }

    const form = new FormData();
    const payload = {
      allowed_mentions: { parse: [] },
      ...discordMessageOptions(options),
      attachments: files.map((file, index) => ({
        id: index,
        filename: String(file.filename || `attachment-${index + 1}`),
        ...(file.description ? { description: String(file.description) } : {}),
      })),
    };
    form.append('payload_json', JSON.stringify(payload));
    for (const [index, file] of files.entries()) {
      const filename = String(file.filename || `attachment-${index + 1}`);
      const blob = file.data instanceof Blob
        ? file.data
        : new Blob([file.data], { type: file.contentType || 'application/octet-stream' });
      form.append(`files[${index}]`, blob, filename);
    }
    return this.requestMultipart('POST', `/channels/${channelId}/messages`, form);
  }

  async createThreadFromMessage(channelId, messageId, name, autoArchiveDuration = 1440) {
    return this.request('POST', `/channels/${channelId}/messages/${messageId}/threads`, {
      name: threadName(name),
      auto_archive_duration: autoArchiveDuration,
    });
  }

  // Standalone public thread, for messages that can never host a thread
  // themselves (e.g. forwarded messages reject with Discord error 50068).
  async createThread(channelId, name, autoArchiveDuration = 1440) {
    return this.request('POST', `/channels/${channelId}/threads`, {
      name: threadName(name),
      auto_archive_duration: autoArchiveDuration,
      type: 11,
    });
  }

  async addReaction(channelId, messageId, emoji) {
    const encoded = encodeURIComponent(emoji);
    return this.request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`);
  }

  async request(method, route, body = null) {
    for (let rateLimitRetries = 0; ; rateLimitRetries += 1) {
      const response = await fetch(`${this.apiBaseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        const rateLimit = await response.json().catch(() => null);
        const delayMs = Math.min(
          Math.ceil(Number(rateLimit?.retry_after || 1) * 1000),
          MAX_RATE_LIMIT_WAIT_MS,
        );
        await delay(delayMs);
        continue;
      }

      if (!response.ok) {
        throw await discordApiError(response, method, route);
      }

      if (response.status === 204) return null;
      return response.json();
    }
  }

  async requestMultipart(method, route, form) {
    for (let rateLimitRetries = 0; ; rateLimitRetries += 1) {
      const response = await fetch(`${this.apiBaseUrl}${route}`, {
        method,
        headers: { Authorization: `Bot ${this.token}` },
        body: form,
      });

      if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        const rateLimit = await response.json().catch(() => null);
        const delayMs = Math.min(
          Math.ceil(Number(rateLimit?.retry_after || 1) * 1000),
          MAX_RATE_LIMIT_WAIT_MS,
        );
        await delay(delayMs);
        continue;
      }

      if (!response.ok) {
        throw await discordApiError(response, method, route);
      }

      return response.json();
    }
  }
}

async function discordApiError(response, method, route) {
  const text = await response.text().catch(() => '');
  const summary = discordErrorBodySummary(response, text);
  const suffix = summary ? ` ${summary}` : '';
  const error = new Error(`Discord API ${method} ${route} failed: ${response.status}${suffix}`);
  error.status = response.status;
  return error;
}

function discordErrorBodySummary(response, text) {
  const body = String(text || '').trim();
  const contentType = String(response?.headers?.get?.('content-type') || '');
  const isHtml = /text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html)\b/i.test(body);
  if (isHtml) {
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
    return compactErrorText(title || response?.statusText || 'HTML error response');
  }
  return compactErrorText(body || response?.statusText || '');
}

function compactErrorText(value) {
  const compact = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= MAX_ERROR_BODY_LENGTH) return compact;
  return `${compact.slice(0, MAX_ERROR_BODY_LENGTH - 1)}…`;
}

export function chunkDiscordMessage(content) {
  const text = String(content ?? '');
  if (!text.trim()) return ['(empty)'];
  if (text.length <= DISCORD_MESSAGE_LIMIT) return [text];

  // Discord parses every posted chunk independently. Track open code Markdown so
  // a boundary can close it in one message and reopen it in the next.
  const units = markdownUnits(text);
  const chunks = [];
  let start = 0;

  while (start < units.length) {
    const startState = units[start].before;
    const prefix = markdownReopenPrefix(startState);
    let bodyLength = prefix.length;
    let endsWithNewline = prefix.endsWith('\n');
    let fitted = null;
    let safeFitted = null;
    let newlineBreak = null;
    let whitespaceBreak = null;
    let markupBoundary = null;

    for (let index = start; index < units.length; index += 1) {
      const unit = units[index];
      const nextLength = bodyLength + unit.text.length;
      const nextEndsWithNewline = unit.text.endsWith('\n');
      const hasMore = index + 1 < units.length;
      const suffixLength = hasMore
        ? markdownCloseSuffix(unit.after, nextEndsWithNewline).length
        : 0;
      if (nextLength + suffixLength > DISCORD_MESSAGE_LIMIT) break;

      const previous = fitted;
      bodyLength = nextLength;
      endsWithNewline = nextEndsWithNewline;
      fitted = {
        end: index + 1,
        state: unit.after,
        endsWithNewline,
        renderedLength: bodyLength + suffixLength,
      };

      if (!markdownStateActive(unit.before) && markdownStateActive(unit.after) && previous) {
        markupBoundary = previous;
      } else if (markdownStateActive(unit.before) && !markdownStateActive(unit.after)) {
        markupBoundary = fitted;
      }
      if (markdownBoundaryCanWrap(units, index, fitted.state)) {
        safeFitted = fitted;
        if (unit.text.endsWith('\n')) newlineBreak = fitted;
        else if (/[ \t]$/.test(unit.text)) whitespaceBreak = fitted;
      }
    }

    if (!fitted) {
      splitOversizedMarkdownUnit(units, start, prefix);
      continue;
    }

    const maximumBreak = safeFitted || fitted;
    const selected = fitted.end === units.length
      ? fitted
      : selectMarkdownBreak(maximumBreak, {
        markupBoundary,
        newlineBreak,
        whitespaceBreak,
      });
    let chunk = prefix;
    for (let index = start; index < selected.end; index += 1) {
      chunk += units[index].text;
    }
    if (selected.end < units.length) {
      chunk += markdownCloseSuffix(selected.state, selected.endsWithNewline);
    }
    chunks.push(chunk);
    start = selected.end;
  }

  return chunks;
}

function markdownUnits(text) {
  const source = String(text || '');
  const units = [];
  let fence = null;
  let inlineTicks = 0;
  let atLineStart = true;
  let index = 0;

  // Fence lines and backtick runs stay atomic; ordinary text is split by Unicode
  // code point so a boundary cannot bisect either a delimiter or a surrogate pair.
  while (index < source.length) {
    if (atLineStart && inlineTicks === 0) {
      const lineEnd = source.indexOf('\n', index);
      const end = lineEnd === -1 ? source.length : lineEnd + 1;
      const line = source.slice(index, end);

      if (fence && isClosingFenceLine(line, fence.length)) {
        const before = markdownState(fence, inlineTicks);
        fence = null;
        const after = markdownState(fence, inlineTicks);
        units.push({ text: line, before, after });
        atLineStart = line.endsWith('\n');
        index = end;
        continue;
      }

      if (!fence) {
        const openingFence = parseOpeningFenceLine(line);
        if (openingFence) {
          const before = markdownState(fence, inlineTicks);
          fence = openingFence;
          const after = markdownState(fence, inlineTicks);
          units.push({ text: line, before, after });
          atLineStart = line.endsWith('\n');
          index = end;
          continue;
        }
      }
    }

    const before = markdownState(fence, inlineTicks);
    if (!fence && source[index] === '`') {
      let end = index + 1;
      while (source[end] === '`') end += 1;
      const run = source.slice(index, end);
      if (inlineTicks > 0 || !isEscapedBacktick(source, index)) {
        if (inlineTicks === 0) inlineTicks = run.length;
        else if (inlineTicks === run.length) inlineTicks = 0;
      }
      units.push({
        text: run,
        before,
        after: markdownState(fence, inlineTicks),
      });
      atLineStart = false;
      index = end;
      continue;
    }

    const codePoint = source.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    units.push({
      text: character,
      before,
      after: before,
    });
    atLineStart = character === '\n';
    index += character.length;
  }

  return units;
}

function parseOpeningFenceLine(line) {
  const match = String(line || '').match(/^( {0,3})(`{3,})([^`\r\n]*)(?:\r?\n)?$/);
  if (!match) return null;
  const language = match[3].trim().split(/\s+/)[0].slice(0, 64);
  return {
    length: match[2].length,
    language,
  };
}

function isClosingFenceLine(line, openingLength) {
  const match = String(line || '').match(/^ {0,3}(`+)[ \t]*(?:\r?\n)?$/);
  return Boolean(match && match[1].length >= openingLength);
}

function isEscapedBacktick(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function markdownState(fence, inlineTicks) {
  return {
    fence,
    inlineTicks,
  };
}

function markdownStateActive(state) {
  return Boolean(state?.fence || state?.inlineTicks);
}

function markdownReopenPrefix(state) {
  if (state?.fence) {
    return `${'`'.repeat(state.fence.length)}${state.fence.language || ''}\n`;
  }
  if (state?.inlineTicks) return '`'.repeat(state.inlineTicks);
  return '';
}

function markdownCloseSuffix(state, endsWithNewline) {
  if (state?.fence) {
    return `${endsWithNewline ? '' : '\n'}${'`'.repeat(state.fence.length)}`;
  }
  if (state?.inlineTicks) return '`'.repeat(state.inlineTicks);
  return '';
}

function markdownBoundaryCanWrap(units, index, state) {
  if (!state?.inlineTicks) return true;
  const previousText = units[index]?.text || '';
  const nextText = units[index + 1]?.text || '';
  // Synthetic inline delimiters must not touch a literal backtick run, or the
  // adjacent runs merge into a different Markdown delimiter.
  return !previousText.endsWith('`') && !nextText.startsWith('`');
}

function selectMarkdownBreak(maximum, {
  markupBoundary,
  newlineBreak,
  whitespaceBreak,
}) {
  if (markdownStateActive(maximum.state)
    && markupBoundary
    && markupBoundary.renderedLength >= maximum.renderedLength * 0.72) {
    return markupBoundary;
  }
  if (newlineBreak && newlineBreak.renderedLength >= maximum.renderedLength * 0.55) {
    return newlineBreak;
  }
  if (whitespaceBreak && whitespaceBreak.renderedLength >= maximum.renderedLength * 0.8) {
    return whitespaceBreak;
  }
  return maximum;
}

function splitOversizedMarkdownUnit(units, index, prefix) {
  const unit = units[index];
  let splitAt = 0;

  for (const character of unit.text) {
    const nextSplit = splitAt + character.length;
    const nextEndsWithNewline = character === '\n';
    const suffixLength = markdownCloseSuffix(unit.before, nextEndsWithNewline).length;
    if (prefix.length + nextSplit + suffixLength > DISCORD_MESSAGE_LIMIT) break;
    splitAt = nextSplit;
  }

  if (splitAt === 0) {
    throw new Error('Discord Markdown wrapper exceeds the message length limit');
  }

  const headText = unit.text.slice(0, splitAt);
  const tailText = unit.text.slice(splitAt);
  const headAfter = tailText ? unit.before : unit.after;
  const replacement = [{
    text: headText,
    before: unit.before,
    after: headAfter,
  }];
  if (tailText) {
    replacement.push({
      text: tailText,
      before: unit.before,
      after: unit.after,
    });
  }
  units.splice(index, 1, ...replacement);
}

function discordMessageOptions(options = {}) {
  const {
    deliveryNonce,
    files,
    reconcileAttachmentMessageId,
    verifyFiles,
    longMessageThreadName,
    longMessageAutoArchiveDuration,
    auto_archive_duration,
    styleId,
    includeStylePreview,
    startPartIndex,
    startPartMessageCount,
    startPartChunkIndex,
    richContinuationChannelId,
    ...discordOptions
  } = options || {};
  return discordOptions;
}

function continuationMessageOptions(options = {}) {
  const {
    deliveryNonce,
    files,
    reconcileAttachmentMessageId,
    verifyFiles,
    message_reference,
    longMessageThreadName,
    longMessageAutoArchiveDuration,
    auto_archive_duration,
    styleId,
    includeStylePreview,
    startPartIndex,
    startPartMessageCount,
    startPartChunkIndex,
    richContinuationChannelId,
    ...discordOptions
  } = options || {};
  return discordOptions;
}

async function loadExplicitAttachments(files, { allowFilePaths = true } = {}) {
  const requested = Array.isArray(files) ? files : [];
  if (requested.length === 0) return [];
  if (requested.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`Discord allows at most ${MAX_MESSAGE_ATTACHMENTS} attachments per message`);
  }

  const loaded = [];
  const filenames = new Set();
  for (const file of requested) {
    let attachment;
    if (typeof file?.dataBase64 === 'string') {
      const encoded = file.dataBase64.replace(/\s+/g, '');
      const data = Buffer.from(encoded, 'base64');
      if (!encoded || normalizeBase64(data.toString('base64')) !== normalizeBase64(encoded)) {
        throw new Error('invalid base64 Discord attachment payload');
      }
      if (data.length === 0) throw new Error('refusing to upload an empty Discord attachment');
      attachment = {
        filename: String(file?.filename || file?.name || ''),
        contentType: String(file?.contentType || 'application/octet-stream'),
        data,
        size: data.length,
        sha256: sha256(data),
      };
    } else {
      if (!allowFilePaths) {
        throw new Error('Discord attachment file paths are disabled at the Reception boundary');
      }
      attachment = await loadDiscordAttachment(file?.path || file?.filePath);
    }
    const filename = String(file?.filename || file?.name || attachment.filename);
    if (!filename || /[/\\]/.test(filename)) {
      throw new Error(`invalid Discord attachment filename: ${filename || '(empty)'}`);
    }
    if (filenames.has(filename)) {
      throw new Error(`duplicate attachment filename in one Discord message: ${filename}`);
    }
    filenames.add(filename);
    if (Number.isFinite(Number(file?.size)) && Number(file.size) !== attachment.size) {
      throw new Error(`Discord attachment changed before upload: ${filename} size mismatch`);
    }
    if (file?.sha256 && String(file.sha256) !== attachment.sha256) {
      throw new Error(`Discord attachment changed before upload: ${filename} SHA-256 mismatch`);
    }
    loaded.push({ ...attachment, filename });
  }
  return loaded;
}

function createDiscordMessageOptionsSequencer(options = {}) {
  const base = String(options?.deliveryNonce || '').trim();
  let index = 0;
  return () => {
    if (!base) return options;
    const suffix = `-${(index++).toString(36)}`;
    return {
      ...options,
      nonce: `${base.slice(0, Math.max(0, 25 - suffix.length))}${suffix}`,
      enforce_nonce: true,
    };
  };
}

function normalizeBase64(value) {
  return String(value || '').replace(/=+$/g, '');
}

function isDiscordThreadChannel(channel) {
  return [10, 11, 12].includes(Number(channel?.type));
}

function threadName(value) {
  const normalized = String(value || 'Codex 작업')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return normalized || 'Codex 작업';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
