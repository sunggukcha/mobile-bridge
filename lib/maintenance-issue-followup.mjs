// Daily maintenance opens one worker thread per open GitHub bug issue and posts
// its outcome to the general channel. An issue whose blocker is structural (for
// example a verified fix that lives only in an already-dirty worktree, so the
// bridge can never commit it) reproduces the very same unresolved report every
// single night. This ledger remembers the previous outcome per issue so the
// bridge can retry with a backoff instead of daily, and stay quiet while the
// blocker is unchanged.

export const MAINTENANCE_ISSUE_FOLLOWUP_FILE = 'maintenance-issue-followups.json';
export const MAINTENANCE_ISSUE_FOLLOWUP_VERSION = 1;

// Consecutive unresolved attempts with the same blocker: retry the next night,
// then after 2, 4, and at most 7 days. A weekly retry still self-heals once the
// blocker disappears without spending a worker run every night.
export const DEFAULT_RETRY_BACKOFF_DAYS = [1, 2, 4, 7];

const DAY_MS = 24 * 60 * 60 * 1000;
// Maintenance fires on a fixed daily schedule, so a whole-day delay computed
// from the previous finish time can land just after that schedule and skip an
// extra day. Retry slightly early instead.
const ATTEMPT_SLACK_MS = 6 * 60 * 60 * 1000;
const MAX_TRACKED_ISSUES = 500;

export function issueFollowupKey(repository, issueNumber) {
  const repo = String(repository || '').trim();
  const number = normalizeIssueNumber(issueNumber);
  if (!number) return '';
  return repo ? `${repo}#${number}` : `#${number}`;
}

export function normalizeFollowupState(raw) {
  const issues = {};
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.issues : null;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source)) {
      const record = normalizeRecord(value);
      if (key && record) issues[key] = record;
    }
  }
  return { version: MAINTENANCE_ISSUE_FOLLOWUP_VERSION, issues };
}

// Decides whether tonight's maintenance should open a worker thread for `issue`.
// Anything that changed on the issue itself counts as new evidence and beats the
// backoff, so a human comment always gets a fresh attempt.
export function planIssueMaintenanceRun({
  state,
  repository = '',
  issue = {},
  now = Date.now(),
} = {}) {
  const key = issueFollowupKey(repository, issue?.number);
  const normalized = normalizeFollowupState(state);
  const record = key ? normalized.issues[key] || null : null;
  if (!key || !record) return { run: true, reason: 'first-attempt', key, record: null, nextAttemptAt: '' };

  const issueUpdatedAt = normalizeText(issue?.updatedAt);
  if (issueUpdatedAt && record.issueUpdatedAt && issueUpdatedAt !== record.issueUpdatedAt) {
    return { run: true, reason: 'issue-updated', key, record, nextAttemptAt: record.nextAttemptAt };
  }

  const nextAttemptMs = Date.parse(record.nextAttemptAt || '');
  if (!Number.isFinite(nextAttemptMs) || nextAttemptMs <= toMs(now)) {
    return { run: true, reason: 'backoff-elapsed', key, record, nextAttemptAt: record.nextAttemptAt };
  }

  return {
    run: false,
    reason: 'backoff-active',
    key,
    record,
    nextAttemptAt: record.nextAttemptAt,
    blockerCode: record.blockerCode,
    unresolvedStreak: record.unresolvedStreak,
  };
}

// Records how an issue maintenance job ended and answers the only question the
// delivery path needs: is this outcome worth another general-channel message?
export function recordIssueMaintenanceOutcome({
  state,
  repository = '',
  issueNumber,
  issueUpdatedAt = '',
  resolved = false,
  blockerCode = '',
  now = Date.now(),
  backoffDays = DEFAULT_RETRY_BACKOFF_DAYS,
} = {}) {
  const normalized = normalizeFollowupState(state);
  const key = issueFollowupKey(repository, issueNumber);
  const nowMs = toMs(now);
  const nowIso = new Date(nowMs).toISOString();
  if (!key) {
    return { state: normalized, key: '', report: true, reason: 'unknown-issue', record: null };
  }

  const previous = normalized.issues[key] || null;
  if (resolved) {
    delete normalized.issues[key];
    return { state: normalized, key, report: true, reason: 'resolved', record: null };
  }

  const code = normalizeBlockerCode(blockerCode);
  const updatedAt = normalizeText(issueUpdatedAt);
  const sameBlocker = Boolean(previous) && previous.blockerCode === code;
  const issueChanged = Boolean(previous)
    && Boolean(updatedAt)
    && Boolean(previous.issueUpdatedAt)
    && previous.issueUpdatedAt !== updatedAt;
  const report = !previous || !sameBlocker || issueChanged;
  const unresolvedStreak = sameBlocker ? previous.unresolvedStreak + 1 : 1;
  const delayMs = retryDelayMs(unresolvedStreak, backoffDays);

  normalized.issues[key] = {
    repository: String(repository || '').trim(),
    issueNumber: normalizeIssueNumber(issueNumber),
    blockerCode: code,
    unresolvedStreak,
    firstUnresolvedAt: sameBlocker && previous.firstUnresolvedAt ? previous.firstUnresolvedAt : nowIso,
    lastAttemptAt: nowIso,
    lastReportedAt: report ? nowIso : (previous?.lastReportedAt || ''),
    issueUpdatedAt: updatedAt || previous?.issueUpdatedAt || '',
    nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
  };

  return {
    state: normalized,
    key,
    report,
    reason: report
      ? (!previous ? 'first-unresolved' : issueChanged ? 'issue-updated' : 'blocker-changed')
      : 'repeat-blocker',
    record: normalized.issues[key],
    unresolvedStreak,
  };
}

// The maintenance start message is the one place a deferred issue stays visible
// every night, so a backoff never turns into silent forgetting.
export function formatMaintenanceIssueScheduleLine({
  issueCount = 0,
  scheduledCount = 0,
  deferred = [],
  snapshotFailed = false,
} = {}) {
  if (snapshotFailed) {
    return '별도 버그 이슈 작업: GitHub 조회 실패를 장애로 기록하고 전체 점검에서 원인을 확인';
  }
  const list = (Array.isArray(deferred) ? deferred : []).filter((entry) => normalizeIssueNumber(entry?.number));
  if (list.length === 0) {
    return `별도 버그 이슈 작업: 미해결 ${issueCount}건을 각각 독립 스레드에서 처리`;
  }
  const shown = list.slice(0, 5).map((entry) => `#${normalizeIssueNumber(entry.number)}`).join(', ');
  const rest = list.length > 5 ? ` 외 ${list.length - 5}건` : '';
  return `별도 버그 이슈 작업: 미해결 ${issueCount}건 중 ${scheduledCount}건 처리, ${list.length}건 재시도 대기(${shown}${rest} · 동일 blocker 반복)`;
}

// Keeps the ledger from growing without bound: an issue that is no longer open
// has nothing left to follow up on. Callers must pass the open-issue keys only
// when the GitHub snapshot actually succeeded, otherwise a transient `gh`
// failure would erase every backoff.
export function pruneFollowupState(state, { openIssueKeys = null, maxEntries = MAX_TRACKED_ISSUES } = {}) {
  const normalized = normalizeFollowupState(state);
  if (Array.isArray(openIssueKeys)) {
    const open = new Set(openIssueKeys.filter(Boolean));
    for (const key of Object.keys(normalized.issues)) {
      if (!open.has(key)) delete normalized.issues[key];
    }
  }
  const keys = Object.keys(normalized.issues);
  if (keys.length > maxEntries) {
    keys
      .sort((left, right) => attemptMs(normalized.issues[right]) - attemptMs(normalized.issues[left]))
      .slice(maxEntries)
      .forEach((key) => {
        delete normalized.issues[key];
      });
  }
  return normalized;
}

function retryDelayMs(streak, backoffDays) {
  const days = Array.isArray(backoffDays) && backoffDays.length > 0
    ? backoffDays
    : DEFAULT_RETRY_BACKOFF_DAYS;
  const index = Math.min(Math.max(1, streak), days.length) - 1;
  const value = Number(days[index]);
  const safeDays = Number.isFinite(value) && value > 0 ? value : 1;
  return Math.max(0, safeDays * DAY_MS - ATTEMPT_SLACK_MS);
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const issueNumber = normalizeIssueNumber(value.issueNumber);
  if (!issueNumber) return null;
  const streak = Number.parseInt(value.unresolvedStreak, 10);
  return {
    repository: normalizeText(value.repository),
    issueNumber,
    blockerCode: normalizeBlockerCode(value.blockerCode),
    unresolvedStreak: Number.isInteger(streak) && streak > 0 ? streak : 1,
    firstUnresolvedAt: normalizeText(value.firstUnresolvedAt),
    lastAttemptAt: normalizeText(value.lastAttemptAt),
    lastReportedAt: normalizeText(value.lastReportedAt),
    issueUpdatedAt: normalizeText(value.issueUpdatedAt),
    nextAttemptAt: normalizeText(value.nextAttemptAt),
  };
}

function attemptMs(record) {
  const parsed = Date.parse(record?.lastAttemptAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeBlockerCode(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9:-]+/g, '-').replace(/^-+|-+$/g, '');
  return text.slice(0, 80) || 'unknown';
}

function normalizeIssueNumber(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function normalizeText(value) {
  return String(value ?? '').trim().slice(0, 200);
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}
