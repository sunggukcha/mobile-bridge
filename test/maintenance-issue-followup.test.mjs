import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  DEFAULT_RETRY_BACKOFF_DAYS,
  formatMaintenanceIssueScheduleLine,
  issueFollowupKey,
  normalizeFollowupState,
  planIssueMaintenanceRun,
  pruneFollowupState,
  recordIssueMaintenanceOutcome,
} from '../lib/maintenance-issue-followup.mjs';

const REPO = 'example-owner/mobile-codex-bridge';
const ISSUE = { number: 28, title: '수식 렌더', url: `https://github.com/${REPO}/issues/28`, updatedAt: '2026-08-10T00:00:00.000Z' };
const DAY_MS = 24 * 60 * 60 * 1000;
const NIGHT_1 = Date.parse('2026-08-13T18:05:00.000Z');

function unresolvedNight(state, at, { blockerCode = 'git-no-eligible-changes', issue = ISSUE } = {}) {
  return recordIssueMaintenanceOutcome({
    state,
    repository: REPO,
    issueNumber: issue.number,
    issueUpdatedAt: issue.updatedAt,
    resolved: false,
    blockerCode,
    now: at,
  });
}

test('the first unresolved outcome is reported and the next night still retries', () => {
  const first = unresolvedNight(normalizeFollowupState(null), NIGHT_1);
  assert.equal(first.report, true);
  assert.equal(first.reason, 'first-unresolved');
  assert.equal(first.unresolvedStreak, 1);

  const plan = planIssueMaintenanceRun({
    state: first.state,
    repository: REPO,
    issue: ISSUE,
    now: NIGHT_1 + DAY_MS,
  });
  assert.equal(plan.run, true);
  assert.equal(plan.reason, 'backoff-elapsed');
});

test('the same blocker on the next night is neither reported nor retried daily', () => {
  const first = unresolvedNight(normalizeFollowupState(null), NIGHT_1);
  const second = unresolvedNight(first.state, NIGHT_1 + DAY_MS);
  assert.equal(second.report, false);
  assert.equal(second.reason, 'repeat-blocker');
  assert.equal(second.unresolvedStreak, 2);

  const nextNight = planIssueMaintenanceRun({
    state: second.state,
    repository: REPO,
    issue: ISSUE,
    now: NIGHT_1 + 2 * DAY_MS,
  });
  assert.equal(nextNight.run, false);
  assert.equal(nextNight.reason, 'backoff-active');
  assert.equal(nextNight.blockerCode, 'git-no-eligible-changes');

  const afterBackoff = planIssueMaintenanceRun({
    state: second.state,
    repository: REPO,
    issue: ISSUE,
    now: NIGHT_1 + 3 * DAY_MS,
  });
  assert.equal(afterBackoff.run, true);
});

test('the backoff grows with the streak and stops at the configured maximum', () => {
  let state = normalizeFollowupState(null);
  let at = NIGHT_1;
  const delays = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const outcome = unresolvedNight(state, at);
    state = outcome.state;
    delays.push(Math.round((Date.parse(outcome.record.nextAttemptAt) - at) / DAY_MS));
    at += 8 * DAY_MS;
  }
  const maxDays = DEFAULT_RETRY_BACKOFF_DAYS[DEFAULT_RETRY_BACKOFF_DAYS.length - 1];
  assert.deepEqual(delays, [1, 2, 4, maxDays, maxDays, maxDays]);
});

test('a changed blocker reports again and restarts the backoff', () => {
  const first = unresolvedNight(normalizeFollowupState(null), NIGHT_1);
  const second = unresolvedNight(first.state, NIGHT_1 + DAY_MS, { blockerCode: 'worker-error' });
  assert.equal(second.report, true);
  assert.equal(second.reason, 'blocker-changed');
  assert.equal(second.unresolvedStreak, 1);
});

test('an issue updated after the last attempt beats the backoff and is reported', () => {
  const first = unresolvedNight(normalizeFollowupState(null), NIGHT_1);
  const second = unresolvedNight(first.state, NIGHT_1 + DAY_MS);
  assert.equal(second.report, false);

  const commented = { ...ISSUE, updatedAt: '2026-08-15T02:00:00.000Z' };
  const plan = planIssueMaintenanceRun({
    state: second.state,
    repository: REPO,
    issue: commented,
    now: NIGHT_1 + 2 * DAY_MS,
  });
  assert.equal(plan.run, true);
  assert.equal(plan.reason, 'issue-updated');

  const third = unresolvedNight(second.state, NIGHT_1 + 2 * DAY_MS, { issue: commented });
  assert.equal(third.report, true);
  assert.equal(third.reason, 'issue-updated');
});

test('a resolved outcome is always reported and clears the ledger entry', () => {
  const first = unresolvedNight(normalizeFollowupState(null), NIGHT_1);
  const resolved = recordIssueMaintenanceOutcome({
    state: first.state,
    repository: REPO,
    issueNumber: ISSUE.number,
    issueUpdatedAt: ISSUE.updatedAt,
    resolved: true,
    now: NIGHT_1 + DAY_MS,
  });
  assert.equal(resolved.report, true);
  assert.deepEqual(resolved.state.issues, {});
});

test('closed issues are pruned only when the open-issue snapshot is trusted', () => {
  const first = unresolvedNight(normalizeFollowupState(null), NIGHT_1);
  const key = issueFollowupKey(REPO, ISSUE.number);
  assert.ok(first.state.issues[key]);

  const keptOnSnapshotFailure = pruneFollowupState(first.state, { openIssueKeys: null });
  assert.ok(keptOnSnapshotFailure.issues[key]);

  const prunedAfterClose = pruneFollowupState(first.state, { openIssueKeys: [] });
  assert.deepEqual(prunedAfterClose.issues, {});
});

test('a corrupt or legacy ledger normalizes instead of throwing', () => {
  assert.deepEqual(normalizeFollowupState(null).issues, {});
  assert.deepEqual(normalizeFollowupState('nope').issues, {});
  assert.deepEqual(normalizeFollowupState({ issues: { bad: { issueNumber: 0 } } }).issues, {});
  const plan = planIssueMaintenanceRun({ state: { issues: 5 }, repository: REPO, issue: ISSUE });
  assert.equal(plan.run, true);
  assert.equal(plan.reason, 'first-attempt');
});

test('the maintenance start line keeps deferred issues visible every night', () => {
  assert.equal(
    formatMaintenanceIssueScheduleLine({ issueCount: 2, scheduledCount: 2, deferred: [] }),
    '별도 버그 이슈 작업: 미해결 2건을 각각 독립 스레드에서 처리',
  );
  assert.equal(
    formatMaintenanceIssueScheduleLine({ issueCount: 3, scheduledCount: 2, deferred: [{ number: 28 }] }),
    '별도 버그 이슈 작업: 미해결 3건 중 2건 처리, 1건 재시도 대기(#28 · 동일 blocker 반복)',
  );
  assert.match(
    formatMaintenanceIssueScheduleLine({
      issueCount: 7,
      scheduledCount: 0,
      deferred: [1, 2, 3, 4, 5, 6, 7].map((number) => ({ number })),
    }),
    /7건 재시도 대기\(#1, #2, #3, #4, #5 외 2건 · 동일 blocker 반복\)/,
  );
  assert.equal(
    formatMaintenanceIssueScheduleLine({ issueCount: 0, scheduledCount: 0, snapshotFailed: true }),
    '별도 버그 이슈 작업: GitHub 조회 실패를 장애로 기록하고 전체 점검에서 원인을 확인',
  );
});

test('daily maintenance only opens threads for issues the plan scheduled', async () => {
  const source = await fs.readFile('bridge-service.mjs', 'utf8');
  const start = source.indexOf('const issuePlan = await planGitHubIssueMaintenanceRuns({');
  const end = source.indexOf('\nfunction maintenanceIssueFollowupState', start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const scheduling = source.slice(start, end);
  assert.match(scheduling, /for \(const issue of issuePlan\.scheduled\)/);
  assert.match(scheduling, /deferredIssues: issuePlan\.deferred/);
  assert.doesNotMatch(scheduling, /for \(const issue of openIssues\)/);
});

test('a repeat blocker keeps the final report and its marker out of the channel', async () => {
  const source = await fs.readFile('bridge-service.mjs', 'utf8');
  const start = source.indexOf('async function finalizeMaintenanceIssue');
  const end = source.indexOf('\nasync function computeMaintenanceIssueOutcome', start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(
    source.slice(start, end),
    /followup\.report === false\) return \{ \.\.\.outcome, suppressChannelPost: true \}/,
  );
  assert.match(
    source,
    /postJobFinalMessage\(\s*job,[\s\S]{0,200}?threadOnly: Boolean\(maintenanceIssueOutcome\?\.suppressChannelPost\)/,
  );
  assert.match(
    source,
    /postJobCompletionMarker\(job, deliveries, \{[\s\S]{0,120}?threadOnly: Boolean\(maintenanceIssueOutcome\?\.suppressChannelPost\)/,
  );
});

test('threadOnly delivery targets the work thread for both direct and queued posts', async () => {
  const source = await fs.readFile('bridge-service.mjs', 'utf8');
  assert.match(
    source,
    /async function postJobFinalMessage\(job, content, \{[^}]*threadOnly = false[^}]*\} = \{\}\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(threadOnly \|\| !job\.finalChannelId\)/,
  );
  assert.match(
    source,
    /function jobFinalDestinationChannelId\(job, \{ threadOnly = false \} = \{\}\) \{\n\s*if \(threadOnly \|\| !job\.finalChannelId\)/,
  );
});
