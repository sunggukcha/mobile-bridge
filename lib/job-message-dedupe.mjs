import { formatOutboundMessage } from './bridge-output.mjs';
import { rootJobId } from './job-id.mjs';

const DEFAULT_TTL_MS = 15_000;
export const TERMINAL_JOB_OUTBOUND_PURPOSES = Object.freeze([
  'job-final',
  'job-completion-marker',
]);
const COMPLETION_MARKER_PATTERN = String.raw`【(?:응답완료(?::\s*[^【】\n]*)?|\([^【】\n]*\)\s*응답완료|작업시간:\s*[^【】\n]*\s+응답완료)】`;
const COMPLETION_SUMMARY_PATTERN = String.raw`${COMPLETION_MARKER_PATTERN}(?:\s*\n\s*작업시간:\s*[^\n]+)?`;
const COMPLETION_MARKER_RE = new RegExp(COMPLETION_SUMMARY_PATTERN, 'gu');
const TRAILING_COMPLETION_MARKERS_RE = new RegExp(
  String.raw`(?:\s*(?:${COMPLETION_SUMMARY_PATTERN}))+\s*$`,
  'u',
);

export function createJobMessageDedupe({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const recent = new Map();

  const prune = (nowMs = now()) => {
    for (const [key, entry] of recent.entries()) {
      if (nowMs - entry.at > ttlMs) recent.delete(key);
    }
  };

  const remember = (job, content, {
    purpose = 'job-message',
    destinationChannelId = '',
    delivery = {},
    deliveryFingerprint = '',
  } = {}) => {
    const at = now();
    prune(at);
    for (const comparable of comparableJobMessageContents(content)) {
      recent.set(messageKey(job, destinationChannelId, comparable, deliveryFingerprint), {
        at,
        purpose,
        destinationChannelId,
        delivered: Boolean(delivery.delivered),
        queued: Boolean(delivery.queued),
        outboxId: delivery.outboxId || null,
        messageIds: Array.isArray(delivery.messageIds) ? delivery.messageIds.filter(Boolean) : [],
      });
    }
  };

  const duplicateFor = (job, content, { destinationChannelId = '', deliveryFingerprint = '' } = {}) => {
    const at = now();
    prune(at);
    for (const comparable of comparableJobMessageContents(content)) {
      const entry = recent.get(messageKey(job, destinationChannelId, comparable, deliveryFingerprint));
      if (entry && at - entry.at <= ttlMs) return entry;
    }
    return null;
  };

  return { duplicateFor, remember, prune };
}

export function comparableJobMessageContents(content) {
  const formatted = formatOutboundMessage(content);
  const normalized = normalizeJobMessageContent(formatted);
  const withoutMarker = normalizeJobMessageContent(stripJobCompletionMarkers(formatted));
  return [...new Set([withoutMarker || normalized, normalized].filter(Boolean))];
}

export function canonicalJobMessageContent(content) {
  return comparableJobMessageContents(content)[0] || '';
}

export function jobMessageDedupeKey(job, destinationChannelId, content, {
  purpose = '',
  deliveryFingerprint = '',
} = {}) {
  const parts = [
    rootJobId(job?.id || ''),
    String(destinationChannelId || ''),
    String(purpose || ''),
  ];
  if (deliveryFingerprint) parts.push(String(deliveryFingerprint));
  parts.push(canonicalJobMessageContent(content));
  return parts.join('\0');
}

export function stripJobCompletionMarkers(content) {
  return String(content || '')
    .replace(COMPLETION_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripTrailingJobCompletionMarkers(content) {
  return String(content || '')
    .replace(TRAILING_COMPLETION_MARKERS_RE, '')
    .trimEnd();
}

export function normalizeJobMessageContent(content) {
  return String(content || '').replace(/\s+/g, ' ').trim();
}

export function isTerminalJobOutboundPurpose(purpose) {
  return TERMINAL_JOB_OUTBOUND_PURPOSES.includes(String(purpose || ''));
}

export function shouldSuppressDuplicateJobOutbound(currentPurpose, duplicate = {}) {
  const current = String(currentPurpose || '');
  const prior = String(duplicate?.purpose || '');
  if (!isTerminalJobOutboundPurpose(current)) return true;
  if (isTerminalJobOutboundPurpose(prior)) return true;

  // Codex can expose its terminal agent_message through the progress stream
  // immediately before returning the same text as the final result. If that
  // exact body was already delivered, the final path must reconcile with the
  // visible progress message instead of posting it a second time.
  if (current !== 'job-final' || prior !== 'worker-progress') return false;
  return Boolean(
    duplicate?.delivered
    || duplicate?.queued
    || (Array.isArray(duplicate?.messageIds) && duplicate.messageIds.length > 0),
  );
}

export function shouldReconcileSuppressedJobFinalToMemory(currentPurpose, duplicate = {}) {
  return String(currentPurpose || '') === 'job-final'
    && String(duplicate?.purpose || '') === 'worker-progress'
    && shouldSuppressDuplicateJobOutbound(currentPurpose, duplicate);
}

function messageKey(job, destinationChannelId, comparable, deliveryFingerprint = '') {
  const parts = [
    rootJobId(job?.id || ''),
    String(destinationChannelId || ''),
  ];
  if (deliveryFingerprint) parts.push(String(deliveryFingerprint));
  parts.push(comparable);
  return parts.join('\0');
}
