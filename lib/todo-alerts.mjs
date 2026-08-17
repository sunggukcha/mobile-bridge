import fs from 'node:fs/promises';
import path from 'node:path';
import { channelStateDir, todoStateFiles } from './config.mjs';
import { refreshAlertContent } from './alert-content-refresh.mjs';
import { loadDiscordAttachment } from './discord-attachment-upload.mjs';
import { queueDiscordOutbox } from './discord-outbox.mjs';
import { formatErrorDetail } from './error-detail.mjs';
import { readChannelTodoState } from './todo-state.mjs';
import { withFileLock } from './file-lock.mjs';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_LOCK_RETRY_MS = 50;
const MAX_ALERT_ATTACHMENTS = 10;
// Same ceiling job artifact delivery uses, for the same reason: the bytes travel
// through the durable bus to Reception, so an unbounded file would sit in the
// bus (and in the outbox on a retry) forever.
const MAX_ALERT_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export async function processDueTodoAlerts({
  config,
  api,
  systemState,
  now = new Date(),
  logSystem = async () => {},
} = {}) {
  if (!config?.stateRoot || !api) return emptyResult();

  const channelIds = await todoAlertChannelIds(config);
  const result = emptyResult();
  for (const channelId of channelIds) {
    const channelResult = await processChannelTodoAlerts({
      config,
      api,
      systemState,
      channelId,
      now,
      logSystem,
    });
    result.channels += channelResult.channels;
    result.checked += channelResult.checked;
    result.sent += channelResult.sent;
    result.queued += channelResult.queued;
    result.failed += channelResult.failed;
    result.rescheduled += channelResult.rescheduled;
    result.completed += channelResult.completed;
    result.skipped += channelResult.skipped;
    result.refreshed += channelResult.refreshed;
  }
  return result;
}

export async function todoAlertChannelIds(config) {
  const configured = config.discord?.channelIds || [];
  if (configured.length > 0) return uniqueStrings(configured);

  const entries = await fs.readdir(config.stateRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return uniqueStrings(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      if (/^\d+_common$/.test(entry.name)) return entry.name.replace(/_common$/, '');
      if (/^\d+$/.test(entry.name)) return entry.name;
      return '';
    })
    .filter(Boolean));
}

async function processChannelTodoAlerts({ config, api, systemState, channelId, now, logSystem }) {
  const files = todoStateFiles(config, channelId);
  return withAlertsFileLock(files.alerts, async () => processChannelTodoAlertsLocked({
    config,
    api,
    systemState,
    channelId,
    now,
    logSystem,
    files,
  }));
}

async function processChannelTodoAlertsLocked({ config, api, systemState, channelId, now, logSystem, files }) {
  const alerts = await readJsonl(files.alerts);
  if (alerts.length === 0) return emptyResult();

  const result = { ...emptyResult(), channels: 1, checked: alerts.length };
  const remaining = [];
  const completed = [];
  let changed = false;
  let todoState = null;
  const seenAlertKeys = new Set();

  for (const alert of alerts) {
    const normalizedAlert = normalizeAlertDeliveryTarget(alert, channelId);
    if (normalizedAlert !== alert) changed = true;

    const dedupeKey = alertDedupeKey(normalizedAlert, channelId);
    if (dedupeKey && seenAlertKeys.has(dedupeKey)) {
      changed = true;
      continue;
    }
    if (dedupeKey) seenAlertKeys.add(dedupeKey);

    if (normalizedAlert.sent_at || !isDue(normalizedAlert, now)) {
      remaining.push(normalizedAlert);
      continue;
    }

    todoState ||= await readChannelTodoState(config, channelId);

    // Empty TODO digests are noise: advance the schedule (or retire a one-off)
    // without posting a "미완료 TODO 없음" message. The user explicitly asked
    // not to receive digests when the TODO list is empty.
    if (isEmptyTodoDigest(normalizedAlert, todoState)) {
      rescheduleWithoutSending({ alert: normalizedAlert, now, remaining, completed, result });
      changed = true;
      continue;
    }

    // An alert whose body was rendered from an external source rebuilds itself
    // here, so the message reflects the source as it is now rather than as it
    // was when the alert was created. A failed refresh keeps the stored body.
    const { alert: liveAlert, refreshed } = await refreshAlertContent({
      config,
      channelId,
      alert: normalizedAlert,
      now,
      logSystem,
    });
    if (refreshed) {
      changed = true;
      result.refreshed += 1;
    }

    const content = formatTodoAlertMessage(liveAlert, todoState);
    const delivery = await deliverTodoAlert({
      api,
      systemState,
      channelId: deliveryChannelId(liveAlert, channelId),
      content,
      alert: liveAlert,
      files: await resolveAlertAttachments({
        config,
        channelId,
        alert: liveAlert,
        logSystem,
      }),
      logSystem,
    });

    if (!delivery.delivered && !delivery.queued) {
      remaining.push(liveAlert);
      result.failed += 1;
      continue;
    }

    if (delivery.queued) result.queued += 1;
    else result.sent += 1;

    const sentAt = now.toISOString();
    if (isRecurringAlert(liveAlert)) {
      const nextAlert = {
        ...liveAlert,
        last_sent_at: sentAt,
        notify_at: nextRecurringNotifyAt(liveAlert, now),
      };
      nextAlert.notify_label = formatKstLabel(nextAlert.notify_at);
      if (isAfterRecurrenceEnd(nextAlert, nextAlert.notify_at)) {
        completed.push({
          ...nextAlert,
          sent_at: sentAt,
          ended_at: sentAt,
          archived_at: sentAt,
        });
        result.completed += 1;
      } else {
        remaining.push(nextAlert);
        result.rescheduled += 1;
      }
    } else {
      completed.push({
        ...liveAlert,
        sent_at: sentAt,
        archived_at: sentAt,
      });
      result.completed += 1;
    }
    changed = true;
  }

  if (changed) {
    // Record completions before shrinking the live file: a crash in between
    // then yields a duplicate completed record (harmless) instead of losing
    // the delivery record entirely.
    if (completed.length > 0) await appendJsonl(files.alertsCompleted, completed);
    await writeJsonl(files.alerts, remaining);
  }

  return result;
}

// Delegates to the shared file lock (lib/file-lock.mjs), which also reclaims a
// lock whose pid was reused after a crash — the previous local implementation
// could spin on such a lock forever and freeze a channel's alerts.
async function withAlertsFileLock(alertsFile, fn) {
  return withFileLock(alertsFile, fn, { retryMs: ALERT_LOCK_RETRY_MS });
}

async function deliverTodoAlert({ api, systemState, channelId, content, alert, files = [], logSystem }) {
  const options = files.length > 0 ? { files } : {};
  try {
    await api.postMessage(channelId, content, options);
    return { delivered: true, queued: false };
  } catch (error) {
    if (!systemState) {
      await logSystem('todo-alert-delivery-failed', {
        channelId,
        alertId: alert.id || null,
        error: formatErrorDetail(error),
      });
      return { delivered: false, queued: false };
    }

    const entry = await queueDiscordOutbox(systemState, {
      channelId,
      content,
      options,
      purpose: 'todo-alert',
      dedupeKey: `todo-alert:${channelId}:${alert.id || 'alert'}:${alert.notify_at || ''}`,
      lastError: formatErrorDetail(error),
    });
    await logSystem('todo-alert-outbox-queued', {
      outboxId: entry.id,
      channelId,
      alertId: alert.id || null,
      error: formatErrorDetail(error),
    });
    return { delivered: false, queued: true };
  }
}

// An alert may carry `attachments`: channel-artifact paths uploaded with the
// message. A missing or unreadable file must never hold back the text — the
// alert is the point and attachments are optional — so bad entries are dropped
// and logged instead of throwing.
//
// The attachment is handed over as bytes, never as a host path: Reception owns
// the Discord credential and refuses `{ path }` files ("Discord attachment file
// paths are disabled at the Reception boundary") so its generic RPC can't be
// turned into an arbitrary file reader. A path here made every alert with a map
// fail delivery, retry until the outbox gave up, and never reach the user — while
// the alert itself was already archived as sent.
async function resolveAlertAttachments({ config, channelId, alert, logSystem = async () => {} }) {
  const requested = alertAttachmentPaths(alert);
  if (requested.length === 0) return [];

  const root = path.resolve(channelStateDir(config, channelId), 'artifacts');
  const files = [];
  const skipped = [];
  const filenames = new Set();
  let totalBytes = 0;
  for (const relativePath of requested.slice(0, MAX_ALERT_ATTACHMENTS)) {
    const resolved = resolveAlertAttachmentPath(root, relativePath);
    if (!resolved) {
      skipped.push({ path: relativePath, reason: 'outside-artifacts-dir' });
      continue;
    }
    const stat = await fs.stat(resolved).catch((error) => ({ error }));
    if (stat?.error) {
      skipped.push({ path: relativePath, reason: stat.error.code === 'ENOENT' ? 'missing' : 'unreadable' });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: relativePath, reason: 'not-a-file' });
      continue;
    }
    if (stat.size === 0) {
      skipped.push({ path: relativePath, reason: 'empty' });
      continue;
    }
    if (stat.size > MAX_ALERT_ATTACHMENT_BYTES) {
      skipped.push({ path: relativePath, reason: 'file-too-large', size: stat.size });
      continue;
    }
    if (totalBytes + stat.size > MAX_ALERT_ATTACHMENT_BYTES) {
      skipped.push({ path: relativePath, reason: 'total-too-large', size: stat.size });
      continue;
    }
    const attachment = await loadDiscordAttachment(resolved).catch((error) => ({ error }));
    if (attachment?.error) {
      skipped.push({ path: relativePath, reason: 'unreadable' });
      continue;
    }
    // Discord rejects a message carrying the same filename twice, and that
    // rejection would take the alert text down with it.
    if (filenames.has(attachment.filename)) {
      skipped.push({ path: relativePath, reason: 'duplicate-filename' });
      continue;
    }
    filenames.add(attachment.filename);
    totalBytes += attachment.size;
    files.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      sha256: attachment.sha256,
      dataBase64: attachment.data.toString('base64'),
    });
  }

  const dropped = skipped.length + Math.max(0, requested.length - MAX_ALERT_ATTACHMENTS);
  if (dropped > 0) {
    await logSystem('todo-alert-attachment-skipped', {
      channelId,
      alertId: alert.id || null,
      requested: requested.length,
      attached: files.length,
      skipped,
    });
  }
  return files;
}

function alertAttachmentPaths(alert) {
  const raw = Array.isArray(alert?.attachments) ? alert.attachments : [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path || entry?.filePath || ''))
    .map((value) => String(value).trim())
    .filter(Boolean);
}

// Accepts `artifacts/<name>`, a bare relative path, or an absolute path, and
// keeps every result inside the channel artifacts root.
function resolveAlertAttachmentPath(root, value) {
  const normalized = String(value).replace(/\\/g, '/');
  const candidate = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(root, normalized.replace(/^artifacts\//, '').replace(/^\/+/, ''));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return candidate;
}

export function formatTodoAlertMessage(alert, todoState) {
  if (alert.type === 'todo_digest') return formatTodoDigestMessage(alert, todoState);
  if (alert.type === 'daily_quote') return formatDailyQuoteMessage(alert);
  if (alert.type === 'message') return String(alert.content || alert.message || alert.title || '').trim();

  const label = alert.notify_label || formatKstLabel(alert.notify_at);
  const lines = [`TODO 알림${label ? ` (${label})` : ''}`];
  lines.push(`- ${formatTodoAlertText(alert.title || alert.todo_id || 'todo')}`);

  const todo = todoState?.items?.find((item) => item.id && item.id === alert.todo_id);
  for (const item of todo?.items || []) lines.push(`  - ${formatTodoAlertText(item)}`);
  return lines.join('\n');
}

function formatDailyQuoteMessage(alert) {
  const quote = quoteForAlertDate(alert);
  if (!quote) return String(alert.fallback_content || alert.title || '').trim();

  const original = quoteLine({
    speaker: firstText(quote.speaker, quote.author, quote.original_speaker, quote.speaker_original),
    text: firstText(quote.quote, quote.text, quote.original_quote, quote.quote_original),
  });
  const korean = quoteLine(koreanQuoteParts(quote));
  const interpretation = quoteInterpretation(quote);
  const sections = [];
  if (original) sections.push(['원문:', original].join('\n'));
  if (korean && korean !== original) sections.push(['한국어 번역:', korean].join('\n'));
  if (interpretation) sections.push(['해석', interpretation].join('\n'));
  if (sections.length > 0) return sections.join('\n\n');
  return String(alert.fallback_content || alert.title || '').trim();
}

function quoteInterpretation(quote) {
  const nested = quote.korean && typeof quote.korean === 'object' ? quote.korean : {};
  return firstText(
    quote.interpretation_ko,
    quote.explanation_ko,
    quote.meaning_ko,
    quote.commentary_ko,
    nested.interpretation,
    nested.explanation,
    nested.meaning,
    nested.commentary,
    quote.interpretation,
    quote.explanation,
    quote.meaning,
    quote.commentary,
  );
}

function koreanQuoteParts(quote) {
  const nested = quote.korean && typeof quote.korean === 'object' ? quote.korean : {};
  return {
    speaker: firstText(
      quote.speaker_ko,
      quote.korean_speaker,
      quote.author_ko,
      quote.korean_author,
      nested.speaker,
      nested.author,
      quote.speaker,
      quote.author,
    ),
    text: firstText(
      quote.quote_ko,
      quote.korean_quote,
      quote.text_ko,
      quote.korean_text,
      quote.translation_ko,
      quote.translation,
      nested.quote,
      nested.text,
    ),
  };
}

function quoteLine({ speaker, text } = {}) {
  const cleanSpeaker = String(speaker || '').trim();
  const cleanText = String(text || '').trim();
  if (cleanSpeaker && cleanText) return `${cleanSpeaker}: ${cleanText}`;
  return cleanText || cleanSpeaker;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function quoteForAlertDate(alert) {
  const key = String(alert.quote_key || monthDayKst(alert.notify_at) || '').trim();
  const quotes = alert.quotes && typeof alert.quotes === 'object' ? alert.quotes : {};
  return quotes[key] || quotes[key.replace('-', '')] || null;
}

function isEmptyTodoDigest(alert, todoState) {
  if (alert.type !== 'todo_digest') return false;
  return filterDigestTodos(todoState?.items || [], alert).length === 0;
}

// Advance (or retire) an alert that we deliberately did not post — used for empty
// TODO digests. Mirrors the recurrence bookkeeping of the delivery path but leaves
// last_sent_at untouched and records last_skipped_at instead, so downstream state
// stays honest about the fact that nothing was actually sent.
function rescheduleWithoutSending({ alert, now, remaining, completed, result }) {
  const skippedAt = now.toISOString();
  if (isRecurringAlert(alert)) {
    const nextAlert = {
      ...alert,
      last_skipped_at: skippedAt,
      notify_at: nextRecurringNotifyAt(alert, now),
    };
    nextAlert.notify_label = formatKstLabel(nextAlert.notify_at);
    if (isAfterRecurrenceEnd(nextAlert, nextAlert.notify_at)) {
      completed.push({ ...nextAlert, skipped_at: skippedAt, ended_at: skippedAt, archived_at: skippedAt });
      result.completed += 1;
    } else {
      remaining.push(nextAlert);
      result.rescheduled += 1;
    }
  } else {
    completed.push({ ...alert, skipped_at: skippedAt, archived_at: skippedAt });
    result.completed += 1;
  }
  result.skipped += 1;
}

function formatTodoDigestMessage(alert, todoState) {
  const todos = filterDigestTodos(todoState?.items || [], alert);
  const label = alert.notify_label || formatKstLabel(alert.notify_at);
  const title = alert.title || alert.digest_title || '전체 TODO 요약';
  const lines = [`${title}${label ? ` (${label})` : ''}`];
  if (todos.length === 0) {
    lines.push('미완료 TODO 없음');
    return lines.join('\n');
  }

  lines.push(`활성 TODO ${todos.length}건`);
  todos.forEach((todo, index) => {
    const schedule = todo.due_at ? ` (기한 ${todo.due_at})` : '';
    lines.push(`${index + 1}. ${formatTodoAlertText(todo.title || todo.id || 'todo')}${schedule}`);
    for (const item of todo.items || []) lines.push(`   - ${formatTodoAlertText(item)}`);
  });
  return lines.join('\n');
}

function formatTodoAlertText(value) {
  return suppressDiscordUrlAutolinks(String(value || ''));
}

function suppressDiscordUrlAutolinks(text) {
  return text.replace(/\bhttps?:\/\/[^\s<>()`]+/gi, (url) => `\`${url}\``);
}

function filterDigestTodos(todos, alert) {
  const scope = String(alert.todo_scope || alert.scope || 'personal').toLowerCase();
  if (scope === 'all') return todos;
  if (scope === 'company') return todos.filter(isCompanyTodo);
  return todos.filter((todo) => !isCompanyTodo(todo));
}

function isCompanyTodo(todo) {
  const scope = String(todo.scope || '').toLowerCase();
  const source = String(todo.source || '').toLowerCase();
  const id = String(todo.id || '').toLowerCase();
  return scope === 'company' || source === 'discord' || id.startsWith('company-');
}

function deliveryChannelId(alert, fallbackChannelId) {
  if (alert.type === 'daily_quote') {
    return String(alert.parent_channel_id || alert.discord_parent_channel_id || fallbackChannelId);
  }
  return String(alert.discord_channel_id || fallbackChannelId);
}

function normalizeAlertDeliveryTarget(alert, fallbackChannelId) {
  if (alert.type !== 'daily_quote') return alert;
  const target = deliveryChannelId(alert, fallbackChannelId);
  if (alert.discord_channel_id === target && alert.parent_channel_id === target) return alert;
  return {
    ...alert,
    parent_channel_id: target,
    discord_channel_id: target,
  };
}

function alertDedupeKey(alert, fallbackChannelId) {
  if (alert.id) return `id:${String(alert.id)}`;
  return [
    'anon',
    alert.type || 'alert',
    deliveryChannelId(alert, fallbackChannelId),
    alert.todo_id || '',
    alert.title || '',
    alert.notify_at || '',
    alert.content || alert.message || '',
  ].map((part) => String(part)).join('\u001f');
}

function isDue(alert, now) {
  const dueAt = Date.parse(alert.notify_at || '');
  return Number.isFinite(dueAt) && dueAt <= now.getTime();
}

function isRecurringAlert(alert) {
  return ['daily', 'workdays', 'weekdays', 'business_days'].includes(recurrenceFrequency(alert));
}

function recurrenceFrequency(alert) {
  return typeof alert.recurrence === 'string'
    ? alert.recurrence
    : String(alert.recurrence?.frequency || '').toLowerCase();
}

function nextRecurringNotifyAt(alert, now) {
  let nextMs = Date.parse(alert.notify_at || '');
  if (!Number.isFinite(nextMs)) nextMs = now.getTime();

  do {
    nextMs += DAY_MS;
  } while (nextMs <= now.getTime() || (isWorkdayRecurrence(alert) && !isKstWeekday(nextMs)));

  return formatKstOffsetIso(nextMs);
}

function isWorkdayRecurrence(alert) {
  return ['workdays', 'weekdays', 'business_days'].includes(recurrenceFrequency(alert));
}

function isKstWeekday(ms) {
  const shifted = new Date(ms + KST_OFFSET_MS);
  const day = shifted.getUTCDay();
  return day >= 1 && day <= 5;
}

function isAfterRecurrenceEnd(alert, notifyAt) {
  const endMs = recurrenceEndMs(alert);
  if (!Number.isFinite(endMs)) return false;

  const notifyMs = Date.parse(notifyAt || '');
  return Number.isFinite(notifyMs) && notifyMs > endMs;
}

function recurrenceEndMs(alert) {
  const value = alert.recurrence_until
    || alert.recurrence_until_at
    || alert.recurrence?.until
    || alert.recurrence?.until_at
    || alert.recurrence?.end_at;
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

export function formatKstLabel(value) {
  const time = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const shifted = new Date(time + KST_OFFSET_MS);
  return `${datePart(shifted)} ${timePart(shifted)} KST`;
}

function monthDayKst(value) {
  const time = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const shifted = new Date(time + KST_OFFSET_MS);
  return `${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

// KST has no DST, so the fixed +09:00 offset is safe here.
function formatKstOffsetIso(ms) {
  const shifted = new Date(ms + KST_OFFSET_MS);
  return `${datePart(shifted)}T${timePart(shifted)}:${pad2(shifted.getUTCSeconds())}+09:00`;
}

function datePart(date) {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join('-');
}

function timePart(date) {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = entries.length > 0
    ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    : '';
  const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, body);
  await fs.rename(tmpPath, file);
}

async function appendJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function uniqueStrings(values) {
  return [...new Set(values.map(String).filter(Boolean))];
}


function emptyResult() {
  return {
    channels: 0,
    checked: 0,
    sent: 0,
    queued: 0,
    failed: 0,
    rescheduled: 0,
    completed: 0,
    skipped: 0,
    refreshed: 0,
  };
}
