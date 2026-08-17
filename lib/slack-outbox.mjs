import fs from 'node:fs/promises';
import { formatErrorDetail } from './error-detail.mjs';
import { formatOutboundMessage } from './bridge-output.mjs';
import { readOutboxEntries, readOutboxStatus } from './outbox-state.mjs';
import {
  classifyOutboxDependencyFailures,
  clearDeliveredOutboxDependencies,
  normalizeOutboxIds,
  upsertDedupeOutboxEntry,
} from './outbox-order.mjs';
import { normalizeRichStyleId } from './rich-style-themes.mjs';
import {
  boundedRichDeliveryId,
  boundedRichMessageIds,
  boundedRichPartCount,
  mergeRichDeliveryProgress,
  richDeliveryProgressFromError,
} from './rich-delivery-progress.mjs';

const OUTBOX_FILE = 'slack-outbox.json';
const OUTBOX_STATUS_FILE = 'slack-outbox-status.json';
const BASE_RETRY_MS = 10_000;
const MAX_RETRY_MS = 300_000;
const EMPTY_STATUS_REFRESH_MS = 5 * 60_000;
const MAX_TRACKED_EMPTY_OUTBOXES = 1_000;
const emptyStatusWrittenAtByFile = new Map();
// Same cap as the Discord outbox, for the same reason: `expiresAt` is optional,
// so an entry that always fails would otherwise retry forever and re-post its
// text on every attempt.
const MAX_OUTBOX_ATTEMPTS = 12;
let outboxLock = Promise.resolve();

export async function queueSlackOutbox(state, message) {
  return withOutboxLock(async () => {
    const now = new Date().toISOString();
    const outbox = await readOutboxEntries(state, OUTBOX_FILE);
    const entry = {
      id: `slack_outbox_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      channelId: String(message.channelId || ''),
      threadTs: message.threadTs ? String(message.threadTs) : null,
      destinationId: message.destinationId ? String(message.destinationId) : null,
      content: formatOutboundMessage(message.content),
      ...((message.styleId || message.options?.styleId)
        ? { styleId: normalizeRichStyleId(message.styleId || message.options.styleId) }
        : {}),
      ...((message.includeStylePreview === true || message.options?.includeStylePreview === true)
        ? { includeStylePreview: true }
        : {}),
      purpose: message.purpose || 'message',
      job: message.job ? minimalJob(message.job) : null,
      afterOutboxIds: normalizeOutboxIds(message.afterOutboxIds),
      dedupeKey: message.dedupeKey || null,
      expiresAt: message.expiresAt || null,
      attempts: 0,
      deliveredPartCount: boundedRichPartCount(message.deliveredPartCount),
      deliveredMessageIds: boundedRichMessageIds(message.deliveredMessageIds),
      deliveredMessageCount: boundedRichPartCount(
        message.deliveredMessageCount
        ?? boundedRichMessageIds(message.deliveredMessageIds).length,
      ),
      partialPartMessageCount: boundedRichPartCount(message.partialPartMessageCount),
      continuationChannelId: boundedRichDeliveryId(message.continuationChannelId) || null,
      nextAttemptAt: now,
      lastError: message.lastError || null,
      createdAt: now,
      updatedAt: now,
    };
    const queued = upsertDedupeOutboxEntry(outbox, entry, {
      payloadFingerprint: slackDeliveryPayloadFingerprint,
    });
    const next = queued.entries;
    // Never evict an undelivered prerequisite merely because the queue grew.
    // Retry/expiry policy, rather than array position, owns message removal.
    await state.writeJson(OUTBOX_FILE, next);
    forgetEmptyStatusWrite(state);
    await writeStatus(state, {
      lastQueueAt: now,
      lastQueuedId: queued.entry.id,
      pending: next.length,
    });
    return queued.entry;
  });
}

export function slackOutboxProgressFromError(error) {
  return richDeliveryProgressFromError(error, 'slack');
}

export async function flushSlackOutbox(state, api, {
  now = new Date(),
  onDelivered = null,
  maxAttempts = MAX_OUTBOX_ATTEMPTS,
} = {}) {
  return withOutboxLock(async () => {
    const outbox = await readOutboxEntries(state, OUTBOX_FILE);
    if (outbox.length === 0) {
      if (emptyStatusWriteIsDue(state, now)) {
        try {
          await ensureEmptyOutboxFile(state);
          await writeStatus(state, {
            lastFlushAt: now.toISOString(),
            sent: 0,
            pending: 0,
            skippedExpired: 0,
            droppedExhausted: 0,
            nextAttemptAt: null,
            lastError: null,
          });
        } catch (error) {
          forgetEmptyStatusWrite(state);
          throw error;
        }
      }
      return {
        sent: 0,
        pending: 0,
        skippedExpired: 0,
        droppedExhausted: 0,
        exhausted: [],
        callbackErrors: [],
      };
    }
    const remaining = [];
    const unresolvedIds = new Set(outbox.map((entry) => entry.id).filter(Boolean));
    const callbackErrors = [];
    const exhausted = [];
    const dependencyFailed = [];
    const deliveredIds = new Set();
    const failurePlan = classifyOutboxDependencyFailures(outbox, {
      isExpired: (entry) => isExpired(entry, now),
      isExhausted: (entry) => isExhausted(entry, maxAttempts),
    });
    let sent = 0;
    let skippedExpired = 0;

    for (const entry of outbox) {
      if (failurePlan.expiredIds.has(entry.id)) {
        skippedExpired += 1;
        unresolvedIds.delete(entry.id);
        continue;
      }
      if (failurePlan.exhaustedIds.has(entry.id)) {
        exhausted.push({
          id: entry.id,
          purpose: entry.purpose || null,
          channelId: entry.channelId || null,
          attempts: Number(entry.attempts || 0),
          lastError: entry.lastError || null,
        });
        unresolvedIds.delete(entry.id);
        continue;
      }
      const failedDependencies = failurePlan.dependencyFailures.get(entry.id);
      if (failedDependencies) {
        dependencyFailed.push({
          id: entry.id,
          purpose: entry.purpose || null,
          channelId: entry.channelId || null,
          failedDependencies,
        });
        unresolvedIds.delete(entry.id);
        continue;
      }
      if (normalizeOutboxIds(entry.afterOutboxIds).some((id) => unresolvedIds.has(id)) || !isDue(entry, now)) {
        remaining.push(entry);
        continue;
      }
      let messages;
      try {
        const deliveredPartCount = boundedRichPartCount(entry.deliveredPartCount);
        messages = await api.postMessage(entry.channelId, entry.content, {
          threadTs: entry.threadTs,
          ...(entry.styleId ? { styleId: normalizeRichStyleId(entry.styleId) } : {}),
          ...(entry.includeStylePreview === true ? { includeStylePreview: true } : {}),
          ...(deliveredPartCount > 0 ? { startPartIndex: deliveredPartCount } : {}),
        });
        sent += 1;
        deliveredIds.add(entry.id);
        unresolvedIds.delete(entry.id);
      } catch (error) {
        remaining.push(scheduleRetry(entry, now, error));
        continue;
      }
      if (onDelivered) {
        try {
          await onDelivered(entry, mergeDeliveredMessages(entry, messages));
        } catch (error) {
          callbackErrors.push({ id: entry.id, purpose: entry.purpose || null, error: formatErrorDetail(error) });
        }
      }
    }

    const checkpointRemaining = remaining
      .map((entry) => clearDeliveredOutboxDependencies(entry, deliveredIds));
    await state.writeJson(OUTBOX_FILE, checkpointRemaining);
    await writeStatus(state, {
      lastFlushAt: now.toISOString(),
      sent,
      pending: checkpointRemaining.length,
      skippedExpired,
      droppedExhausted: exhausted.length,
      droppedDependencyFailed: dependencyFailed.length,
      lastExhausted: exhausted[exhausted.length - 1] || null,
      lastDependencyFailure: dependencyFailed[dependencyFailed.length - 1] || null,
      nextAttemptAt: earliestNextAttemptAt(checkpointRemaining),
      lastError: latestLastError(checkpointRemaining),
    });
    if (checkpointRemaining.length === 0) rememberEmptyStatusWrite(state, now);
    else forgetEmptyStatusWrite(state);
    return {
      sent,
      pending: checkpointRemaining.length,
      skippedExpired,
      droppedExhausted: exhausted.length,
      exhausted,
      dependencyFailed,
      callbackErrors,
    };
  });
}

function isDue(entry, now) {
  const next = Date.parse(entry.nextAttemptAt || entry.createdAt || '');
  return !Number.isFinite(next) || next <= now.getTime();
}

function isExpired(entry, now) {
  const expiresAt = Date.parse(entry.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function isExhausted(entry, maxAttempts) {
  const limit = Number(maxAttempts);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return Number(entry.attempts || 0) >= limit;
}

function scheduleRetry(entry, now, error) {
  const attempts = Number(entry.attempts || 0) + 1;
  const delayMs = Math.min(BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 4), MAX_RETRY_MS);
  const progress = mergeRichDeliveryProgress(entry, slackOutboxProgressFromError(error));
  return {
    ...entry,
    attempts,
    ...progress,
    nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
    lastError: formatErrorDetail(error),
    updatedAt: now.toISOString(),
  };
}

function mergeDeliveredMessages(entry, messages) {
  const merged = [
    ...boundedRichMessageIds(entry.deliveredMessageIds).map((id) => ({ id })),
    ...(Array.isArray(messages) ? messages : []),
  ];
  const seen = new Set();
  return merged.filter((message) => {
    const id = String(message?.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function uniqueStrings(values) {
  return boundedRichMessageIds(values);
}

async function writeStatus(state, patch) {
  const previous = await readOutboxStatus(state, OUTBOX_STATUS_FILE);
  await state.writeJson(OUTBOX_STATUS_FILE, {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

async function withOutboxLock(fn) {
  const previous = outboxLock;
  let release;
  outboxLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function minimalJob(job) {
  return {
    id: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    finalChannelId: job.finalChannelId || null,
    priority: job.priority,
    maintenance: Boolean(job.maintenance),
    search: Boolean(job.search),
  };
}

function earliestNextAttemptAt(entries) {
  return entries.map((entry) => entry.nextAttemptAt).filter(Boolean).sort()[0] || null;
}

function slackDeliveryPayloadFingerprint(entry) {
  return JSON.stringify([
    entry?.channelId || '',
    entry?.threadTs || null,
    entry?.content || '',
    entry?.styleId || null,
    Boolean(entry?.includeStylePreview),
  ]);
}

function latestLastError(entries) {
  return entries
    .filter((entry) => entry.lastError)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]?.lastError || null;
}

function emptyStatusWriteIsDue(state, now) {
  const key = state.file(OUTBOX_STATUS_FILE);
  const nowMs = now.getTime();
  const previous = emptyStatusWrittenAtByFile.get(key);
  if (
    Number.isFinite(previous)
    && nowMs >= previous
    && nowMs - previous < EMPTY_STATUS_REFRESH_MS
  ) {
    return false;
  }
  rememberEmptyStatusWrite(state, now);
  return true;
}

function rememberEmptyStatusWrite(state, now) {
  const key = state.file(OUTBOX_STATUS_FILE);
  if (
    emptyStatusWrittenAtByFile.size >= MAX_TRACKED_EMPTY_OUTBOXES
    && !emptyStatusWrittenAtByFile.has(key)
  ) {
    emptyStatusWrittenAtByFile.delete(emptyStatusWrittenAtByFile.keys().next().value);
  }
  emptyStatusWrittenAtByFile.set(key, now.getTime());
}

function forgetEmptyStatusWrite(state) {
  emptyStatusWrittenAtByFile.delete(state.file(OUTBOX_STATUS_FILE));
}

async function ensureEmptyOutboxFile(state) {
  try {
    await fs.access(state.file(OUTBOX_FILE));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await state.writeJson(OUTBOX_FILE, []);
  }
}
