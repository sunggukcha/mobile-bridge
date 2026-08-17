const PROMPT_EXCLUDED_BRIDGE_PURPOSES = new Set(['job-progress', 'worker-progress']);

export function buildThreadContext(messages, {
  maxMessages = 100,
  maxChars = 40_000,
} = {}) {
  const selected = [];
  let chars = 0;
  // Events can land in the store out of chronological order (e.g. a thread
  // starter backfilled after later replies), so order by timestamp first.
  const tail = sortMessagesChronologically(messages)
    .filter(includeThreadContextMessage)
    .slice(-maxMessages)
    .reverse();

  for (const message of tail) {
    const line = formatThreadMessage(message);
    if (selected.length > 0 && chars + line.length > maxChars) break;
    selected.push(line);
    chars += line.length;
  }

  return selected.reverse().join('\n');
}

export function buildJobThreadContext(messages, job = {}, options = {}) {
  const history = buildThreadContext(messages, options);
  const trigger = job?.event || {};
  const triggerId = String(trigger.id || job?.id || '').trim() || '(unknown)';
  const triggerTimestamp = String(trigger.timestamp || trigger.createdAt || '').trim() || '(unknown)';
  const triggerMessage = formatThreadMessage(trigger);

  return [
    'Conversation history (retained for continuity, including messages that may have arrived after this job was queued):',
    history || '(empty)',
    '',
    'Current job trigger boundary:',
    `- Event ID: ${triggerId}`,
    `- Event timestamp: ${triggerTimestamp}`,
    `- Trigger message: ${triggerMessage}`,
    '',
    'Execute the triggering message using the earlier conversation as context.',
    'Messages later than this trigger remain visible for continuity, but they belong to separate jobs. Do not execute them, claim to have completed them, or treat them as replacing this job.',
  ].join('\n');
}

function includeThreadContextMessage(message) {
  const purpose = String(message?.purpose || '');
  if (PROMPT_EXCLUDED_BRIDGE_PURPOSES.has(purpose) && isBridgeAgentMessage(message)) return false;
  return true;
}

export function formatThreadMessage(message) {
  const author = formatAuthorLabel(message);
  const timestamp = message.timestamp || message.createdAt || '';
  const content = String(message.content || '').trim();
  const attachments = (message.attachments || [])
    .map((attachment) => attachment.name || attachment.filename || attachment.url)
    .filter(Boolean);
  const embeds = (message.embeds || [])
    .map(formatEmbed)
    .filter(Boolean);
  const referenced = formatReferencedMessage(message.referencedMessage || message.referenced_message);
  const forwarded = forwardedMessagesOf(message).map(formatForwardedMessage).filter(Boolean);
  const parts = [];
  if (content) parts.push(content);
  if (attachments.length > 0) parts.push(`attachments=[${attachments.join(', ')}]`);
  if (embeds.length > 0) parts.push(`embeds=[${embeds.join(' | ')}]`);
  if (forwarded.length > 0) parts.push(`forwarded=[${forwarded.join(' | ')}]`);
  if (referenced) parts.push(`referenced=[${referenced}]`);
  return [`[${timestamp}] ${author}:`, ...parts].join(' ');
}

function forwardedMessagesOf(message) {
  if (Array.isArray(message.forwardedMessages)) return message.forwardedMessages;
  if (Array.isArray(message.message_snapshots)) {
    return message.message_snapshots.map((snapshot) => snapshot?.message || snapshot).filter(Boolean);
  }
  return [];
}

function formatForwardedMessage(message) {
  const content = compactInlineText(message.content);
  const embeds = (message.embeds || []).map(formatEmbed).filter(Boolean);
  const attachments = (message.attachments || [])
    .map((attachment) => attachment.name || attachment.filename || attachment.url)
    .filter(Boolean);
  const parts = [];
  if (content) parts.push(content);
  if (embeds.length > 0) parts.push(`embeds=${embeds.join(' | ')}`);
  if (attachments.length > 0) parts.push(`attachments=${attachments.join(', ')}`);
  return parts.join(' ');
}

function sortMessagesChronologically(messages) {
  return [...messages]
    .map((message, index) => ({ message, index, timeMs: messageTimeMs(message) }))
    .sort((a, b) => {
      if (Number.isFinite(a.timeMs) && Number.isFinite(b.timeMs) && a.timeMs !== b.timeMs) {
        return a.timeMs - b.timeMs;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.message);
}

function messageTimeMs(message) {
  return Date.parse(message?.timestamp || message?.createdAt || '');
}

function formatAuthorLabel(message) {
  const name = message.authorName || message.author?.username || '';
  const id = message.authorId || message.author?.id || '';
  if (name && id && name !== id) return `${name} [${id}]`;
  return name || id || 'unknown';
}

function isBridgeAgentMessage(message) {
  return String(message?.source || '') === 'bridge-agent'
    || String(message?.authorId || message?.author?.id || '') === 'bridge-agent';
}

function formatReferencedMessage(message) {
  if (!message) return '';
  const author = formatAuthorLabel(message);
  const content = compactInlineText(message.content);
  const embeds = (message.embeds || []).map(formatEmbed).filter(Boolean);
  const attachments = (message.attachments || [])
    .map((attachment) => attachment.name || attachment.filename || attachment.url)
    .filter(Boolean);
  const parts = [];
  if (content) parts.push(content);
  if (embeds.length > 0) parts.push(`embeds=${embeds.join(' | ')}`);
  if (attachments.length > 0) parts.push(`attachments=${attachments.join(', ')}`);
  if (parts.length === 0) return '';
  return `${author}: ${parts.join(' ')}`;
}

function formatEmbed(embed) {
  const parts = [
    embed.title,
    embed.description,
    embed.url,
  ].map((value) => compactInlineText(value)).filter(Boolean);
  return parts.join(' - ');
}

function compactInlineText(value, maxChars = 1200) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}
