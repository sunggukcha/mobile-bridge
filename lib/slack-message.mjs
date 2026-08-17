import { BRIDGE_COMMAND_NAMES } from './bridge-commands.mjs';

const SLACK_THREAD_ID_PATTERN = /^slack-([A-Z0-9]+)-([A-Z0-9]+)-(\d+\.\d+)$/i;

// Slack consumes slash-prefixed text as a platform slash command before a
// message event can reach Socket Mode. Keep bridge controls typeable in a
// normal channel/thread by translating known bang commands anywhere outside
// Markdown code spans. This supports a task followed by startup controls while
// leaving documentation such as `` `!model` `` untouched.
export function slackCommandToBridgeCommand(content) {
  const text = String(content || '');
  const codeRanges = markdownCodeRanges(text);
  return text.replace(/(^|\s)!(?:\/?)([^\s/]+)/g, (
    matched,
    prefix,
    rawCommand,
    offset,
  ) => {
    const commandStart = offset + prefix.length;
    const command = rawCommand.toLowerCase();
    if (indexInRanges(commandStart, codeRanges)
      || !BRIDGE_COMMAND_NAMES.has(command)) {
      return matched;
    }
    return `${prefix}/${rawCommand}`;
  });
}

export function slackThreadStateId({ teamId, channelId, threadTs }) {
  const team = requiredSlackId(teamId, 'team');
  const channel = requiredSlackId(channelId, 'channel');
  const timestamp = normalizeSlackTimestamp(threadTs);
  return `slack-${team}-${channel}-${timestamp}`;
}

export function parseSlackThreadStateId(value) {
  const match = String(value || '').match(SLACK_THREAD_ID_PATTERN);
  if (!match) return null;
  return {
    teamId: match[1],
    channelId: match[2],
    threadTs: match[3],
  };
}

export function slackTimestampToIso(value) {
  const seconds = Number.parseFloat(String(value || ''));
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

export function slackMessageReservationId(event = {}) {
  const channel = String(event.channel || '').trim();
  const timestamp = normalizeSlackTimestamp(event.ts, { required: false });
  if (!channel || !timestamp) return '';
  return `slack-${channel}-${timestamp.replace('.', '-')}`;
}

export function isSlackUserMessageEvent(event = {}) {
  if (event?.type !== 'message') return false;
  if (!event.channel || !event.ts || !event.user) return false;
  if (event.bot_id || event.bot_profile) return false;
  const subtype = String(event.subtype || '');
  return !subtype || subtype === 'file_share' || subtype === 'thread_broadcast';
}

export function compactSlackFiles(files = []) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => file && typeof file === 'object')
    .map((file) => ({
      id: String(file.id || ''),
      filename: String(file.name || file.title || file.id || 'slack-file'),
      url: String(file.url_private_download || file.url_private || file.permalink || ''),
      content_type: String(file.mimetype || ''),
      size: Number(file.size || 0) || null,
    }));
}

function requiredSlackId(value, label) {
  const id = String(value || '').trim();
  if (!/^[A-Z0-9]+$/i.test(id)) throw new Error(`invalid Slack ${label} id`);
  return id;
}

function normalizeSlackTimestamp(value, { required = true } = {}) {
  const timestamp = String(value || '').trim();
  if (/^\d+\.\d+$/.test(timestamp)) return timestamp;
  if (!required) return '';
  throw new Error('invalid Slack message timestamp');
}

function markdownCodeRanges(text) {
  const ranges = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('`', cursor);
    if (start < 0) break;
    let delimiterLength = 1;
    while (text[start + delimiterLength] === '`') delimiterLength += 1;
    const delimiter = '`'.repeat(delimiterLength);
    const close = text.indexOf(delimiter, start + delimiterLength);
    if (close < 0) {
      ranges.push([start, text.length]);
      break;
    }
    const end = close + delimiterLength;
    ranges.push([start, end]);
    cursor = end;
  }
  return ranges;
}

function indexInRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}
