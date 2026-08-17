import fs from 'node:fs/promises';
import path from 'node:path';
import { getHeadSyncStatus } from './git-sync.mjs';
import { rootJobId } from './job-id.mjs';
import { DEFAULT_DAILY_MAINTENANCE_HOUR_KST } from './maintenance-schedule.mjs';
import {
  DAILY_MAINTENANCE_RESULT_MARKER_CLOSE,
  DAILY_MAINTENANCE_RESULT_MARKER_OPEN,
} from './maintenance-report.mjs';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DAILY_MAINTENANCE_INPUT_BUDGET_CHARS = 120_000;
export const DEFAULT_DAILY_MAINTENANCE_INLINE_ITEMS = 40;

const DAILY_MAINTENANCE_TASKS = [
  {
    id: 'failure-detection',
    title: 'Failure detection',
    description: 'Correlate gateway, queue, worker, delivery, restart, and state evidence to find concrete failures, including failures whose event type does not contain "error".',
  },
  {
    id: 'failure-resolution',
    title: 'Failure resolution',
    description: 'Reproduce and resolve each confirmed failure or record the precise evidence gap without speculative changes.',
  },
  {
    id: 'delivery-and-recovery',
    title: 'Delivery and recovery',
    description: 'Verify that queued output, final-message delivery, restarts, and genuinely stalled jobs recover without loss or duplication.',
  },
  {
    id: 'repo-health',
    title: 'Repository health',
    description: 'Review sync and test health, implement only evidence-backed fixes, and avoid reset --hard.',
  },
  {
    id: 'verification-and-report',
    title: 'Verification and report',
    description: 'Run appropriate verification and report only improvements actually applied in this maintenance run.',
  },
];

export function previousDailyMaintenanceWindow(now = new Date(), hourKst = DEFAULT_DAILY_MAINTENANCE_HOUR_KST) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  let endShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hourKst,
    0,
    0,
    0,
  );
  if (shifted.getTime() < endShifted) endShifted -= DAY_MS;
  const startShifted = endShifted - DAY_MS;
  return {
    start: new Date(startShifted - KST_OFFSET_MS),
    end: new Date(endShifted - KST_OFFSET_MS),
  };
}

export async function dailyMaintenanceReviewWindow({ stateRoot, now = new Date() } = {}) {
  const previousMaintenance = stateRoot
    ? await findPreviousDailyMaintenanceStart(stateRoot, now)
    : null;
  if (previousMaintenance) {
    return {
      start: previousMaintenance.timestamp,
      end: now,
      startInclusive: false,
      source: 'previous-maintenance',
      previousMaintenance,
    };
  }

  const earliestActivity = stateRoot
    ? await findEarliestStateActivity(stateRoot, now)
    : null;
  if (earliestActivity) {
    return {
      start: earliestActivity.timestamp,
      end: now,
      startInclusive: true,
      source: 'state-history-fallback',
      previousMaintenance: null,
      earliestActivity,
    };
  }

  const fallback = previousDailyMaintenanceWindow(now);
  return {
    start: fallback.start,
    end: now,
    startInclusive: true,
    source: 'scheduled-fallback',
    previousMaintenance: null,
  };
}

export async function collectDailyMaintenanceContext({
  stateRoot,
  repoPath,
  gitRemote = 'origin',
  gitBranch = 'main',
  now = new Date(),
  maxItems = 80,
} = {}) {
  const window = await dailyMaintenanceReviewWindow({ stateRoot, now });
  const [conversationEvents, jobEvents, systemLogs, gitStatus] = await Promise.all([
    collectThreadJsonlUnder(stateRoot, 'memory/events.jsonl', window, maxItems),
    collectThreadJsonlUnder(stateRoot, 'jobs/jobs.jsonl', window, maxItems),
    collectSystemEvents(stateRoot, window, maxItems),
    repoPath
      ? getHeadSyncStatus({ cwd: repoPath, remote: gitRemote, branch: gitBranch })
        .catch((error) => ({ error: error.message }))
      : null,
  ]);

  const context = {
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      timeZone: 'Asia/Seoul',
      startInclusive: window.startInclusive !== false,
      source: window.source,
      previousMaintenance: window.previousMaintenance
        ? {
            id: window.previousMaintenance.id,
            channelId: window.previousMaintenance.channelId,
            threadId: window.previousMaintenance.threadId,
            timestamp: window.previousMaintenance.timestamp.toISOString(),
          }
        : null,
    },
    conversationEvents,
    jobEvents,
    systemLogs,
    gitStatus: gitStatus ? { remote: gitRemote, branch: gitBranch, ...gitStatus } : null,
  };
  context.summary = summarizeDailyMaintenanceContext(context);
  return context;
}

export function kstDateSlug(now = new Date()) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export async function createDailyMaintenanceRun({
  artifactRoot,
  context,
  now = new Date(),
  inputBudgetChars = DEFAULT_DAILY_MAINTENANCE_INPUT_BUDGET_CHARS,
} = {}) {
  if (!artifactRoot) throw new Error('artifactRoot is required');
  if (!context || typeof context !== 'object') throw new Error('context is required');

  const runId = `daily-maintenance-${kstDateSlug(now)}-${String(now.getTime())}`;
  const runRoot = path.join(artifactRoot, 'maintenance-runs', kstDateSlug(now), runId);
  const rawContextPath = path.join(runRoot, 'raw-context.json');
  const summaryPath = path.join(runRoot, 'summary.json');
  const manifestPath = path.join(runRoot, 'manifest.json');
  const tasks = DAILY_MAINTENANCE_TASKS.map((task, index) => ({
    id: task.id,
    order: index + 1,
    title: task.title,
    description: task.description,
    status: 'todo',
    output_path: path.join(runRoot, `task-${String(index + 1).padStart(2, '0')}-${task.id}.md`),
  }));
  const manifest = {
    run_id: runId,
    status: 'created',
    mode: 'sharded',
    started_at: now.toISOString(),
    updated_at: now.toISOString(),
    window: context.window,
    input_budget: {
      max_prompt_chars: inputBudgetChars,
      raw_context_chars: JSON.stringify(context).length,
    },
    cursor: {
      last_completed_task_id: null,
      next_task_id: tasks[0]?.id || null,
    },
    failed_reason: null,
    tasks,
    artifacts: {
      run_root: runRoot,
      manifest: manifestPath,
      raw_context: rawContextPath,
      summary: summaryPath,
    },
  };

  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(rawContextPath, `${JSON.stringify(context, null, 2)}\n`);
  await fs.writeFile(summaryPath, `${JSON.stringify(context.summary || summarizeDailyMaintenanceContext(context), null, 2)}\n`);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    runId,
    runRoot,
    manifest,
    manifestPath,
    rawContextPath,
    summaryPath,
  };
}

export async function updateDailyMaintenanceManifest(manifestPath, patch = {}) {
  if (!manifestPath) return null;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const next = {
    ...manifest,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  if (patch.cursor && typeof patch.cursor === 'object') {
    next.cursor = { ...(manifest.cursor || {}), ...patch.cursor };
  }
  if (patch.input_budget && typeof patch.input_budget === 'object') {
    next.input_budget = { ...(manifest.input_budget || {}), ...patch.input_budget };
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function estimatePromptChars(prompt) {
  return String(prompt || '').length;
}

export function maintenancePromptBudget(prompt, {
  maxPromptChars = DEFAULT_DAILY_MAINTENANCE_INPUT_BUDGET_CHARS,
} = {}) {
  const chars = estimatePromptChars(prompt);
  const budget = Math.max(1, Number.parseInt(maxPromptChars, 10) || DEFAULT_DAILY_MAINTENANCE_INPUT_BUDGET_CHARS);
  return {
    chars,
    maxPromptChars: budget,
    ratio: chars / budget,
    overBudget: chars > budget,
  };
}

const TERMINAL_JOB_STATUSES = new Set(['done', 'superseded', 'cancelled', 'abandoned', 'failed']);
const ATTENTION_EVENT_TYPE_PATTERN = /fail|error|abandon|zombie|timeout|stall|interrupted|duplicate|retry|disconnect|gateway.*close|invalid.?session|heartbeat.*(?:miss|late|timeout)|outbox.*(?:queued|drop|block)|delivery.*(?:queued|drop)|rate.?limit|unauthori[sz]ed|forbidden|worker.*fallback|job-recovery-skipped/i;
const ATTENTION_EVENT_DETAIL_PATTERN = /fail|error|exception|timed?\s*out|stuck|stall|disconnect|invalid.?session|heartbeat|dropped|undeliver|unauthori[sz]ed|forbidden|rate.?limit|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i;
const BENIGN_ATTENTION_EVENT_TYPES = new Set([
  'job-outbound-duplicate-skipped',
  'message-duplicate-suppressed',
  'slack-message-duplicate-suppressed',
]);
const ATTENTION_COUNT_FIELDS = [
  'failed',
  'failures',
  'errors',
  'dropped',
  'rejected',
  'undelivered',
  'callbackErrors',
];
const DEFAULT_STALLED_JOB_MINUTES = 30;
const NON_STALLED_JOB_STATUSES = new Set(['waiting_for_user']);

// A `thread-create-failed` self-recovers when the bridge falls back to a
// standalone work thread for the same message (bridge-service.mjs
// createStandaloneWorkThread). The user still gets their message, so those
// failures should not force daily triage. Pair failures with successful
// fallbacks by messageId and report how many were recovered. Failures whose
// fallback also failed (`thread-create-fallback-failed`) are left untouched so
// genuine unthreadable losses still surface as attention events.
function countRecoveredThreadCreateFailures(systemLogs) {
  const failsByMessage = new Map();
  const fallbacksByMessage = new Map();
  for (const entry of systemLogs) {
    const messageId = entry?.messageId;
    if (!messageId) continue;
    if (entry.type === 'thread-create-failed') {
      failsByMessage.set(messageId, (failsByMessage.get(messageId) || 0) + 1);
    } else if (entry.type === 'thread-create-fallback-standalone') {
      fallbacksByMessage.set(messageId, (fallbacksByMessage.get(messageId) || 0) + 1);
    }
  }
  let recovered = 0;
  for (const [messageId, failCount] of failsByMessage) {
    recovered += Math.min(failCount, fallbacksByMessage.get(messageId) || 0);
  }
  return recovered;
}

// Pre-computed digest so the maintenance worker starts from concrete failure
// signals. Routine continuation lifecycle records are intentionally not
// reported as "unfinished"; only jobs that exceed the stale threshold surface.
export function summarizeDailyMaintenanceContext({
  window = {},
  conversationEvents = [],
  jobEvents = [],
  systemLogs = [],
  stalledJobMinutes = DEFAULT_STALLED_JOB_MINUTES,
} = {}) {
  const systemEventCounts = new Map();
  const attentionEventCounts = new Map();
  for (const entry of systemLogs) {
    const type = String(entry?.type || '').trim() || (entry?.tail ? 'log-snippet' : '');
    if (!type) continue;
    systemEventCounts.set(type, (systemEventCounts.get(type) || 0) + 1);
    if (systemEntryNeedsAttention(entry)) {
      attentionEventCounts.set(type, (attentionEventCounts.get(type) || 0) + 1);
    }
  }
  const sortedSystemCounts = [...systemEventCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  const jobsById = new Map();
  for (const [eventOrder, entry] of jobEvents.entries()) {
    if (!entry?.id) continue;
    const key = `${entry.channelId || ''}/${entry.threadId || ''}/${entry.id}`;
    const job = jobsById.get(key) || {
      id: entry.id,
      channelId: entry.channelId || '',
      threadId: entry.threadId || '',
      status: null,
      createdAt: null,
      finishedAt: null,
      lastSeenAt: null,
      retryAt: null,
      lastEventOrder: -1,
    };
    if (entry.status) {
      // A terminal status (e.g. `done`) can be followed by a late non-terminal
      // event such as the trailing 【응답완료】 progress-update that is logged
      // after the job finishes. Don't let that overwrite the terminal status,
      // or the job is falsely reported as unfinished. A later terminal status
      // (e.g. superseded) still wins.
      const jobIsTerminal = TERMINAL_JOB_STATUSES.has(job.status || '');
      const entryIsTerminal = TERMINAL_JOB_STATUSES.has(entry.status);
      if (!jobIsTerminal || entryIsTerminal) job.status = entry.status;
    }
    if (entry.createdAt && (!job.createdAt || entry.createdAt < job.createdAt)) job.createdAt = entry.createdAt;
    if (entry.finishedAt && (!job.finishedAt || entry.finishedAt > job.finishedAt)) job.finishedAt = entry.finishedAt;
    const seenAt = jobEventTimestamp(entry);
    if (seenAt && (!job.lastSeenAt || seenAt > job.lastSeenAt)) job.lastSeenAt = seenAt;
    if (entry.retryAt) job.retryAt = entry.retryAt;
    job.lastEventOrder = eventOrder;
    jobsById.set(key, job);
  }
  const jobs = [...jobsById.values()];
  const jobsByStatus = {};
  for (const job of jobs) {
    const status = job.status || 'unknown';
    jobsByStatus[status] = (jobsByStatus[status] || 0) + 1;
  }
  // A runtime-restart root and its continuation share one lifecycle. Collapse
  // by root and discard roots with a terminal member before considering stalls.
  const terminalRootKeys = new Set();
  for (const job of jobs) {
    if (TERMINAL_JOB_STATUSES.has(job.status || '')) {
      terminalRootKeys.add(`${job.channelId}/${job.threadId}/${rootJobId(job.id)}`);
    }
  }
  const activeByRoot = new Map();
  for (const job of jobs) {
    if (TERMINAL_JOB_STATUSES.has(job.status || '')) continue;
    const rootKey = `${job.channelId}/${job.threadId}/${rootJobId(job.id)}`;
    if (terminalRootKeys.has(rootKey)) continue;
    const current = activeByRoot.get(rootKey);
    if (!current || job.lastEventOrder >= current.lastEventOrder) activeByRoot.set(rootKey, job);
  }
  const referenceTimeMs = maintenanceReferenceTimeMs({ window, jobEvents, systemLogs });
  const stallThresholdMs = Math.max(1, Number(stalledJobMinutes) || DEFAULT_STALLED_JOB_MINUTES) * 60_000;
  const stalledJobs = [...activeByRoot.values()]
    .filter((job) => !NON_STALLED_JOB_STATUSES.has(job.status || ''))
    .filter((job) => !retryIsStillScheduled(job, referenceTimeMs))
    .map((job) => ({
      ...job,
      lastSeenMs: Date.parse(job.lastSeenAt || job.createdAt || ''),
    }))
    .filter((job) => Number.isFinite(job.lastSeenMs) && referenceTimeMs - job.lastSeenMs >= stallThresholdMs)
    .map(({ id, channelId, threadId, status, lastSeenAt, lastSeenMs }) => ({
      id,
      channelId,
      threadId,
      status,
      lastSeenAt,
      staleMinutes: Number(((referenceTimeMs - lastSeenMs) / 60_000).toFixed(1)),
    }));
  const doneDurationsMinutes = jobs
    .filter((job) => job.status === 'done' && job.createdAt && job.finishedAt)
    .map((job) => (Date.parse(job.finishedAt) - Date.parse(job.createdAt)) / 60_000)
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0)
    .sort((a, b) => a - b);
  const doneCount = jobs.filter((job) => job.status === 'done').length;

  const userMessagesByThread = new Map();
  let userMessageCount = 0;
  for (const event of conversationEvents) {
    if (event?.source === 'bridge-agent' || event?.threadStarter) continue;
    if (!event?.content && !(event?.attachments || []).length) continue;
    userMessageCount += 1;
    const key = `${event.channelId || ''}/${event.threadId || ''}`;
    userMessagesByThread.set(key, (userMessagesByThread.get(key) || 0) + 1);
  }

  // Net out thread-create failures that self-recovered via a standalone
  // fallback so they don't force triage every maintenance run.
  const recoveredThreadCreateFailures = countRecoveredThreadCreateFailures(systemLogs);
  const attentionEvents = [...attentionEventCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .map((entry) => (entry.type === 'thread-create-failed'
      ? { ...entry, count: entry.count - recoveredThreadCreateFailures }
      : entry))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    systemEventCounts: sortedSystemCounts,
    attentionEvents,
    jobs: {
      total: jobs.length,
      byStatus: jobsByStatus,
      stalled: stalledJobs,
      doneCount,
      doneDurationCount: doneDurationsMinutes.length,
      medianDoneMinutes: medianOf(doneDurationsMinutes),
      maxDoneMinutes: doneDurationsMinutes.length
        ? Number(doneDurationsMinutes[doneDurationsMinutes.length - 1].toFixed(1))
        : null,
    },
    userMessages: {
      total: userMessageCount,
      byThread: [...userMessagesByThread.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([thread, count]) => ({ thread, count })),
    },
  };
}

function systemEntryNeedsAttention(entry = {}) {
  const type = String(entry.type || '');
  if (BENIGN_ATTENTION_EVENT_TYPES.has(type)) return false;
  const level = String(entry.level || '').trim().toLowerCase();
  const status = String(entry.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const error = String(entry.error || '').trim();
  const numericCode = Number(entry.code ?? entry.closeCode);

  if (['error', 'fatal', 'panic'].includes(level)) return true;
  if ([
    'failed',
    'failure',
    'error',
    'fatal',
    'rejected',
    'dropped',
    'blocked',
    'stalled',
    'timed_out',
    'timeout',
    'disconnected',
    'delivery_queued',
  ].includes(status)) return true;
  // Error payloads frequently contain only provider-specific codes such as
  // ECONNRESET or EPIPE, so requiring the literal word "error" loses them.
  if (error) return true;
  if (entry.ok === false || entry.success === false) return true;
  if (entry.delivered === false && entry.queued !== true) return true;
  if (entry.synced === false && entry.action !== 'already-current') return true;
  if (ATTENTION_COUNT_FIELDS.some((field) => positiveSignalCount(entry[field]) > 0)) return true;
  if (Number.isFinite(numericCode)) {
    if (numericCode >= 400 && numericCode <= 599) return true;
    // Discord/WebSocket 1000 and 1001 are normal closure codes; other close
    // codes need review even when the surrounding event name is neutral.
    if (numericCode >= 1000 && numericCode <= 4999 && ![1000, 1001].includes(numericCode)) return true;
    if ([1000, 1001].includes(numericCode) && /(?:gateway|socket).*(?:close|disconnect)/i.test(type)) {
      return false;
    }
  }
  if (ATTENTION_EVENT_TYPE_PATTERN.test(type)) return true;
  const details = [
    entry.status,
    entry.level,
    entry.error,
    entry.message,
    entry.reason,
    entry.tail,
    entry.code,
    entry.closeCode,
  ].filter((value) => value !== null && value !== undefined).join(' ');
  return ATTENTION_EVENT_DETAIL_PATTERN.test(details);
}

function positiveSignalCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value === true) return 1;
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function maintenanceReferenceTimeMs({ window = {}, jobEvents = [], systemLogs = [] } = {}) {
  const configuredEnd = Date.parse(window.end || '');
  if (Number.isFinite(configuredEnd)) return configuredEnd;
  const observed = [...jobEvents, ...systemLogs]
    .map((entry) => Date.parse(jobEventTimestamp(entry) || ''))
    .filter(Number.isFinite);
  return observed.length ? Math.max(...observed) : Date.now();
}

function jobEventTimestamp(entry = {}) {
  for (const key of ['updatedAt', 'finishedAt', 'createdAt', 'timestamp']) {
    const parsed = Date.parse(entry?.[key] || '');
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function retryIsStillScheduled(job, referenceTimeMs) {
  if (String(job?.status || '') !== 'retry-scheduled') return false;
  const retryAtMs = Date.parse(job.retryAt || '');
  return Number.isFinite(retryAtMs) && retryAtMs > referenceTimeMs;
}

function medianOf(sortedValues) {
  if (!sortedValues.length) return null;
  const middle = Math.floor(sortedValues.length / 2);
  const median = sortedValues.length % 2 === 0
    ? (sortedValues[middle - 1] + sortedValues[middle]) / 2
    : sortedValues[middle];
  return Number(median.toFixed(1));
}

export function buildDailyMaintenanceTask(context, {
  manifest = null,
  inlineItems = DEFAULT_DAILY_MAINTENANCE_INLINE_ITEMS,
} = {}) {
  const summary = context.summary || summarizeDailyMaintenanceContext(context);
  if (manifest) return buildShardedDailyMaintenanceTask(context, { manifest, inlineItems, summary });

  return [
    'Daily bridge maintenance.',
    '',
    formatReviewWindow(context.window),
    '',
    'Required checks:',
    '- Correlate gateway/event ingestion, scheduler timing, worker exits, state lifecycle, outbox/delivery, and restart/recovery evidence. A failure can be present in status/error/message/code fields even when its event type does not contain "error".',
    '- Inspect every concrete attention event and genuinely stalled job in the digest. Trace each through the complete execution path and distinguish recovered incidents from user-visible loss.',
    '- Review conversation and job events by channel/thread only as evidence for confirmed failures. Do not create redundant "unfinished work" or "unresolved user request" report sections, and do not count ordinary continuations or waiting-for-user jobs as defects.',
    '- GitHub issues are dispatched as separate maintenance jobs with their own general-channel start thread and final message. Do not duplicate those issue tasks in this general inspection.',
    '- Prefer small, reversible, evidence-backed fixes. Do not make speculative architecture changes merely to produce activity.',
    '- Check local HEAD versus remote HEAD and reconcile safely without reset --hard.',
    '- Implement small, evidence-backed fixes directly in the bridge repo; run `npm test` before finishing.',
    '- Note: the service performs git commit/push for you after this job; spending the whole run on git bookkeeping is a failure.',
    '',
    'Final report (Korean):',
    '- Start with exactly "적용한 개선". Under it, report only improvements actually implemented and verified during this maintenance run.',
    '- Use one concise bullet per behavioral improvement. State what now works better; verification may be a short parenthetical.',
    '- Do not include source file names, line links, commit bookkeeping, artifact/manifest paths, raw logs, architecture recaps, previous-day changes, unfinished/continuation counts, unresolved-request summaries, or generic follow-up/token instructions.',
    '- If nothing was changed, give one specific reason. Do not fill space with observations or proposed work.',
    '- This final response must be a fresh general-channel message; detailed work stays in the start-message thread.',
    '',
    'Result protocol:',
    `- End with exactly one ${DAILY_MAINTENANCE_RESULT_MARKER_OPEN} JSON block.`,
    `- With changes: ${DAILY_MAINTENANCE_RESULT_MARKER_OPEN}{"improvements":["verified behavioral improvement","another verified behavioral improvement"]}${DAILY_MAINTENANCE_RESULT_MARKER_CLOSE}`,
    `- No changes: ${DAILY_MAINTENANCE_RESULT_MARKER_OPEN}{"improvements":[],"none_reason":"specific verified reason"}${DAILY_MAINTENANCE_RESULT_MARKER_CLOSE}`,
    '- The bridge formats only this structured result into the fresh general-channel final message. Keep detailed prose in progress updates and task artifacts.',
    '',
    'Digest (pre-computed from the raw data below):',
    JSON.stringify(summary, null, 2),
    '',
    'Git sync status:',
    JSON.stringify(context.gitStatus || null, null, 2),
    '',
    'Conversation events:',
    JSON.stringify(context.conversationEvents || [], null, 2),
    '',
    'Job events:',
    JSON.stringify(context.jobEvents || [], null, 2),
    '',
    'System logs:',
    JSON.stringify(context.systemLogs || [], null, 2),
  ].join('\n');
}

function buildShardedDailyMaintenanceTask(context, { manifest, inlineItems, summary }) {
  const compact = compactDailyMaintenanceContext(context, { inlineItems });
  return [
    'Daily bridge maintenance.',
    '',
    'Mode: sharded-manifest.',
    '',
    formatReviewWindow(context.window),
    '',
    'Input-limit policy:',
    '- Do not rely on raw JSON embedded in this prompt; the full raw context is stored in artifacts.',
    '- Work task-by-task in manifest cursor order. Use the manifest task output_path fields for task notes.',
    '- Read the raw context artifact only for the specific task being investigated, then write concise findings.',
    '- If more detail is needed, inspect the allowed state roots directly instead of asking the user to paste logs.',
    '- Keep Discord progress updates short and concrete.',
    '',
    'Required checks:',
    '- Correlate gateway/event ingestion, scheduler timing, worker exits, state lifecycle, outbox/delivery, and restart/recovery evidence. Inspect status/error/message/code fields even when the event type looks neutral.',
    '- Investigate every concrete attention event and genuinely stalled job in the digest; trace the complete path and separate recovered incidents from user-visible loss.',
    '- Use conversation and job records only as failure evidence. Do not create redundant unfinished-work or unresolved-request sections, and do not count ordinary continuations or waiting-for-user jobs as defects.',
    '- GitHub issues are handled by separate serialized maintenance jobs with their own Discord threads and final messages. Do not duplicate them here.',
    '- Prefer small, reversible, evidence-backed fixes. Do not make speculative architecture changes merely to produce activity.',
    '- Check local HEAD versus remote HEAD and reconcile safely without reset --hard.',
    '- Implement small, evidence-backed fixes directly in the bridge repo; run `npm test` before finishing.',
    '- Note: the service performs git commit/push for you after this job; spending the whole run on git bookkeeping is a failure.',
    '',
    'Final report (Korean):',
    '- Start with exactly "적용한 개선". Under it, report only improvements actually implemented and verified during this maintenance run.',
    '- Use one concise bullet per behavioral improvement. Verification may be a short parenthetical.',
    '- Do not include source file names, line links, commit bookkeeping, artifact/manifest paths, raw logs, architecture recaps, previous-day changes, unfinished/continuation counts, unresolved-request summaries, or generic follow-up/token instructions.',
    '- If nothing was changed, give one specific reason.',
    '- The final response must be a fresh general-channel message; detailed work stays in the start-message thread.',
    '',
    'Result protocol:',
    `- End with exactly one ${DAILY_MAINTENANCE_RESULT_MARKER_OPEN} JSON block.`,
    `- With changes: ${DAILY_MAINTENANCE_RESULT_MARKER_OPEN}{"improvements":["verified behavioral improvement","another verified behavioral improvement"]}${DAILY_MAINTENANCE_RESULT_MARKER_CLOSE}`,
    `- No changes: ${DAILY_MAINTENANCE_RESULT_MARKER_OPEN}{"improvements":[],"none_reason":"specific verified reason"}${DAILY_MAINTENANCE_RESULT_MARKER_CLOSE}`,
    '- The bridge formats only this structured result into the fresh general-channel final message. Keep detailed prose in progress updates and task artifacts.',
    '',
    'Maintenance manifest:',
    JSON.stringify(compactManifestForPrompt(manifest), null, 2),
    '',
    'Digest (pre-computed from the full raw data):',
    JSON.stringify(summary, null, 2),
    '',
    'Git sync status:',
    JSON.stringify(context.gitStatus || null, null, 2),
    '',
    'Bounded inline samples (not complete; use artifact paths above for full context):',
    JSON.stringify(compact, null, 2),
  ].join('\n');
}

export function buildDailyMaintenanceMinimalResumeTask({
  manifestPath,
  rawContextPath = '',
  summaryPath = '',
  reason = 'input-limit',
  failedWorker = null,
  errorDetail = '',
  promptChars = null,
  maxPromptChars = DEFAULT_DAILY_MAINTENANCE_INPUT_BUDGET_CHARS,
} = {}) {
  return [
    'Daily bridge maintenance.',
    '',
    'Mode: minimal-resume.',
    '',
    `Resume reason: ${reason}`,
    `Failed worker: ${failedWorker || '(unknown)'}`,
    `Previous prompt chars: ${promptChars ?? '(unknown)'}`,
    `Configured prompt budget chars: ${maxPromptChars}`,
    '',
    'Artifact paths:',
    `- manifest: ${manifestPath || '(missing)'}`,
    `- raw context: ${rawContextPath || '(missing)'}`,
    `- summary: ${summaryPath || '(missing)'}`,
    '',
    'Instructions:',
    '- Do not retry the previous large prompt.',
    '- Open the manifest first and continue from cursor.next_task_id.',
    '- Read only the raw context slices needed for the current task.',
    '- Write concise task notes to the task output_path from the manifest.',
    '- If the manifest is missing or corrupt, report that explicitly and stop safely.',
    '- Finish with the structured result block below and include only improvements actually implemented and verified in this run.',
    '- Do not include file names, paths, prior work, unfinished/unresolved summaries, or generic follow-up/token instructions.',
    '- The final response must be a fresh general-channel message; detailed work stays in the maintenance thread.',
    `- With changes: ${DAILY_MAINTENANCE_RESULT_MARKER_OPEN}{"improvements":["verified behavioral improvement"]}${DAILY_MAINTENANCE_RESULT_MARKER_CLOSE}`,
    `- No changes: ${DAILY_MAINTENANCE_RESULT_MARKER_OPEN}{"improvements":[],"none_reason":"specific verified reason"}${DAILY_MAINTENANCE_RESULT_MARKER_CLOSE}`,
    '',
    'Previous error detail:',
    truncateText(errorDetail, 4_000) || '(none)',
  ].join('\n');
}

export function compactDailyMaintenanceContext(context = {}, {
  inlineItems = DEFAULT_DAILY_MAINTENANCE_INLINE_ITEMS,
} = {}) {
  const limit = Math.max(0, Number.parseInt(inlineItems, 10) || DEFAULT_DAILY_MAINTENANCE_INLINE_ITEMS);
  return {
    conversationEvents: tailItems(context.conversationEvents || [], limit).map(compactConversationEvent),
    jobEvents: tailItems(context.jobEvents || [], limit).map(compactJobEvent),
    systemLogs: tailItems(context.systemLogs || [], limit).map(compactSystemLog),
  };
}

function compactManifestForPrompt(manifest = {}) {
  return {
    run_id: manifest.run_id || null,
    status: manifest.status || null,
    mode: manifest.mode || null,
    started_at: manifest.started_at || null,
    window: manifest.window || null,
    input_budget: manifest.input_budget || null,
    cursor: manifest.cursor || null,
    failed_reason: manifest.failed_reason || null,
    artifacts: manifest.artifacts || null,
    tasks: Array.isArray(manifest.tasks)
      ? manifest.tasks.map((task) => ({
          id: task.id,
          order: task.order,
          title: task.title,
          status: task.status,
          output_path: task.output_path,
        }))
      : [],
  };
}

function compactConversationEvent(event = {}) {
  return {
    id: event.id || null,
    timestamp: event.timestamp || event.createdAt || null,
    channelId: event.channelId || null,
    threadId: event.threadId || null,
    scope: event.scope || null,
    authorName: event.authorName || event.author?.username || null,
    source: event.source || null,
    threadStarter: Boolean(event.threadStarter),
    content: truncateText(event.content, 800),
    attachments: compactAttachments(event.attachments),
  };
}

function compactJobEvent(event = {}) {
  return {
    id: event.id || null,
    status: event.status || null,
    createdAt: event.createdAt || null,
    updatedAt: event.updatedAt || null,
    finishedAt: event.finishedAt || null,
    channelId: event.channelId || null,
    threadId: event.threadId || null,
    worker: event.worker || null,
    attempt: event.attempt || null,
    error: truncateText(event.error, 1_200),
  };
}

function compactSystemLog(entry = {}) {
  return {
    file: entry.file || null,
    type: entry.type || null,
    timestamp: entry.timestamp || entry.createdAt || null,
    level: entry.level || null,
    status: entry.status || null,
    code: entry.code ?? entry.closeCode ?? null,
    ok: typeof entry.ok === 'boolean' ? entry.ok : null,
    success: typeof entry.success === 'boolean' ? entry.success : null,
    delivered: typeof entry.delivered === 'boolean' ? entry.delivered : null,
    queued: typeof entry.queued === 'boolean' ? entry.queued : null,
    synced: typeof entry.synced === 'boolean' ? entry.synced : null,
    action: entry.action || null,
    jobId: entry.jobId || null,
    channelId: entry.channelId || null,
    threadId: entry.threadId || null,
    error: truncateText(entry.error, 1_200),
    message: truncateText(entry.message, 1_200),
    reason: truncateText(entry.reason, 1_200),
    tail: truncateText(entry.tail, 1_200),
  };
}

function compactAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, 5).map((attachment) => ({
    name: attachment.name || attachment.filename || null,
    url: attachment.url || null,
  }));
}

function tailItems(items, limit) {
  if (!Array.isArray(items) || limit <= 0) return [];
  return items.slice(-limit);
}

function truncateText(value, maxChars) {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 22))}\n[truncated ${text.length - Math.max(0, maxChars - 22)} chars]`;
}

function formatReviewWindow(window) {
  const relation = window.startInclusive === false ? 'after ' : '';
  const basis = {
    'previous-maintenance': 'since previous daily maintenance',
    'state-history-fallback': 'from earliest available bridge state because no previous daily maintenance marker was found',
    'scheduled-fallback': 'fallback from the previous scheduled maintenance boundary',
  }[window.source] || 'fallback from the previous scheduled maintenance boundary';
  return `Review window: ${relation}${window.start} to ${window.end} (${window.timeZone}; ${basis}).`;
}

async function collectThreadJsonlUnder(root, relativeFile, window, limit) {
  const items = [];
  for (const { dir, channelId, threadId, scope } of await listStateScopes(root)) {
    items.push(...await collectEntriesFromFile({
      file: path.join(dir, relativeFile),
      channelId,
      threadId,
      scope,
      window,
    }));
  }
  return items
    .sort((a, b) => String(entryTimestamp(a) || '').localeCompare(String(entryTimestamp(b) || '')))
    .slice(-limit);
}

async function findPreviousDailyMaintenanceStart(root, now) {
  const nowMs = now.getTime();
  const maintenanceEvents = [];

  for (const { dir, channelId, threadId } of await listStateScopes(root)) {
    maintenanceEvents.push(...await collectMaintenanceStarts({
      file: path.join(dir, 'memory', 'events.jsonl'),
      channelId,
      threadId,
      nowMs,
    }));
  }

  return maintenanceEvents
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0] || null;
}

async function findEarliestStateActivity(root, now) {
  const nowMs = now.getTime();
  const candidates = [];

  for (const { dir, channelId, threadId, scope } of await listStateScopes(root)) {
    candidates.push(...await collectJsonlActivityTimes({
      file: path.join(dir, 'memory', 'events.jsonl'),
      channelId,
      threadId,
      scope,
      nowMs,
    }));
    candidates.push(...await collectJsonlActivityTimes({
      file: path.join(dir, 'jobs', 'jobs.jsonl'),
      channelId,
      threadId,
      scope,
      nowMs,
    }));
  }

  const systemDir = path.join(root, '_system');
  for (const file of (await listFiles(systemDir)).filter((item) => item.endsWith('.jsonl'))) {
    candidates.push(...await collectJsonlActivityTimes({
      file,
      channelId: '_system',
      threadId: '_system',
      scope: path.relative(root, file),
      nowMs,
    }));
  }

  for (const file of await listFiles(path.join(root, 'logs'))) {
    const stat = await fs.stat(file);
    if (stat.mtime.getTime() >= nowMs) continue;
    candidates.push({
      timestamp: stat.mtime,
      channelId: '_logs',
      threadId: '_logs',
      scope: path.relative(root, file),
    });
  }

  return candidates
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0] || null;
}

async function collectJsonlActivityTimes({ file, channelId, threadId, scope, nowMs }) {
  const times = [];
  for (const entry of await readJsonl(file)) {
    const timestamp = entryTimestamp(entry);
    const time = Date.parse(timestamp || '');
    if (!Number.isFinite(time) || time >= nowMs) continue;
    times.push({
      timestamp: new Date(time),
      channelId,
      threadId,
      scope,
    });
  }
  return times;
}

async function collectMaintenanceStarts({ file, channelId, threadId, nowMs }) {
  const starts = [];
  for (const entry of await readJsonl(file)) {
    if (!isDailyMaintenanceEvent(entry)) continue;
    const time = Date.parse(entry.timestamp || entry.createdAt || '');
    if (!Number.isFinite(time) || time >= nowMs) continue;
    starts.push({
      id: entry.id || null,
      channelId,
      threadId,
      timestamp: new Date(time),
    });
  }
  return starts;
}

function isDailyMaintenanceEvent(entry) {
  return entry?.authorName === 'system-maintenance' ||
    String(entry?.id || '').startsWith('daily_maintenance_') ||
    String(entry?.content || '').startsWith('Daily bridge maintenance.');
}

async function listStateScopes(root) {
  const scopes = [];
  const roots = [root, path.join(root, 'channels')];
  for (const baseRoot of roots) {
    for (const dir of await listDirs(baseRoot)) {
      const name = path.basename(dir);
      if (isInternalStateDir(name)) continue;

      if (name.endsWith('_common')) {
        scopes.push({
          dir,
          channelId: name.slice(0, -'_common'.length),
          threadId: 'channel',
          scope: 'channel',
        });
        continue;
      }

      scopes.push({
        dir,
        channelId: name,
        threadId: 'channel',
        scope: 'channel',
      });

      for (const threadDir of await listDirs(path.join(dir, 'threads'))) {
        scopes.push({
          dir: threadDir,
          channelId: name,
          threadId: path.basename(threadDir),
          scope: 'thread',
        });
      }

      for (const threadDir of await listDirs(dir)) {
        const threadName = path.basename(threadDir);
        if (threadName === 'threads' || isInternalStateDir(threadName)) continue;
        scopes.push({
          dir: threadDir,
          channelId: name,
          threadId: threadName,
          scope: 'thread',
        });
      }
    }
  }
  return scopes;
}

function isInternalStateDir(name) {
  return [
    '_system',
    'logs',
    'worker-tools',
    'codex-home',
    'claude-home',
    'gemini-home',
    'memory',
    'jobs',
    'pending-thread',
  ].includes(name);
}

async function collectEntriesFromFile({ file, channelId, threadId, scope, window }) {
  const items = [];
  for (const entry of await readJsonl(file)) {
    const timestamp = entryTimestamp(entry);
    if (!insideWindow(timestamp, window)) continue;
    items.push({ channelId, threadId, scope, ...entry });
  }
  return items;
}

async function collectLogSnippets(root, window, limit) {
  const logsDir = path.join(root, 'logs');
  const files = await listFiles(logsDir);
  const snippets = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    if (!insideWindow(stat.mtime.toISOString(), window)) continue;
    const text = await readTail(file, 8_000);
    snippets.push({
      file: path.relative(root, file),
      mtime: stat.mtime.toISOString(),
      tail: text,
    });
  }
  return snippets.slice(-limit);
}

async function collectSystemEvents(root, window, limit) {
  const systemDir = path.join(root, '_system');
  const jsonlFiles = (await listFiles(systemDir)).filter((file) => file.endsWith('.jsonl'));
  const events = [];
  for (const file of jsonlFiles) {
    for (const entry of await readJsonl(file)) {
      const timestamp = entryTimestamp(entry);
      if (!insideWindow(timestamp, window)) continue;
      events.push({
        file: path.relative(root, file),
        ...entry,
      });
    }
  }

  const logSnippets = await collectLogSnippets(root, window, limit);
  return [
    ...events
      .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
      .slice(-limit),
    ...logSnippets,
  ].slice(-limit);
}

async function listDirs(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listFiles(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(root, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
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

async function readTail(file, bytes) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function insideWindow(timestamp, window) {
  const time = Date.parse(timestamp || '');
  if (!Number.isFinite(time)) return false;
  const start = window.start.getTime();
  const afterStart = window.startInclusive === false ? time > start : time >= start;
  return afterStart && time < window.end.getTime();
}

function entryTimestamp(entry) {
  return entry.timestamp || entry.createdAt || entry.updatedAt || entry.finishedAt;
}
