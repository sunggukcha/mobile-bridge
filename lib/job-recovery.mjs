import { rootJobId } from './job-id.mjs';
import { isRecoverableJobStatus } from './retry-policy.mjs';
import { isQueueCommandRequest } from './bridge-commands.mjs';

export function interruptedJobCandidatesFromEntries(entries = [], scope = {}) {
  const latestById = latestJobEntriesById(entries);
  const latestEntries = [...latestById.values()];
  const recoverable = latestEntries
    .filter((entry) => isRecoveryCandidate(entry, entries))
    .map((entry) => ({ ...entry, channelId: scope.channelId, threadId: scope.threadId }));
  return newestCandidateByRootJob(recoverable, latestEntries)
    .filter((entry) => !hasNewerBlockingLifecycleEntry(entries, entry))
    .sort((a, b) => recoveryEntryTimeMs(a) - recoveryEntryTimeMs(b));
}

export function latestJobEntriesById(entries = []) {
  const latestById = new Map();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const current = latestById.get(entry.id) || {};
    const merged = { ...current, ...entry };
    if (isInformationalJobStatus(entry.status) && current.status !== undefined) {
      merged.status = current.status;
    }
    latestById.set(entry.id, merged);
  }
  return latestById;
}

export function newestThreadEventAfter(events = [], baseEvent = {}) {
  return events
    .filter((event) => event?.id && String(event.id) !== String(baseEvent?.id || ''))
    .filter((event) => compareThreadEvents(event, baseEvent) > 0)
    .sort(compareThreadEvents)
    .at(-1) || null;
}

export function newestThreadJobAfter(jobs = [], baseJob = {}) {
  return jobs
    .filter((job) => job?.id && String(job.id) !== String(baseJob?.id || ''))
    .filter((job) => compareThreadEvents(job.event || {}, baseJob.event || {}) > 0)
    .sort((left, right) => compareThreadEvents(left.event || {}, right.event || {}))
    .at(-1) || null;
}

export function newestSupersedingThreadEventAfter(events = [], baseEvent = {}, { isControlEvent = () => false } = {}) {
  return newestThreadEventAfter(
    events.filter((event) => !isControlEvent(event)),
    baseEvent,
  );
}

export function newestRecoverySupersedingThreadEventAfter(events = [], job = {}, baseEvent = {}, options = {}) {
  if (isPostSuccessRuntimeRestartRecovery(job)) return null;
  const isControlEvent = typeof options.isControlEvent === 'function'
    ? options.isControlEvent
    : () => false;
  // `/queue` is still a task-bearing event for source ordering, but its explicit
  // contract is to preserve earlier work when both jobs pass through recovery.
  return newestSupersedingThreadEventAfter(events, baseEvent, {
    ...options,
    isControlEvent: (event) => (
      isQueueCommandRequest(event?.content)
      || isControlEvent(event)
    ),
  });
}

// The other half of the `/queue` contract. `newestRecoverySupersedingThreadEventAfter`
// keeps a `/queue` job alive across recovery, but a live queued or running one
// stayed killable by whatever message arrived next, so a `/queue` job could
// still be dropped minutes after it was accepted (issue #22). Protection has to
// travel with the job, not just with the event that would replace it.
export function isQueueProtectedJob(job = {}) {
  return isQueueCommandRequest(job?.event?.content);
}

// Live scheduler and running-worker paths must make the same replacement
// decision. Accept either the raw incoming event (running path) or a job wrapper
// containing `.event` (queued path), then protect the job already in flight.
export function shouldSupersedeLiveJob(incoming = {}, existingJob = {}) {
  const incomingEvent = incoming?.event || incoming;
  return compareThreadEvents(incomingEvent, existingJob?.event || {}) > 0
    && !isQueueProtectedJob(existingJob);
}

export function isPostSuccessRuntimeRestartRecovery(job = {}) {
  if (String(job?.status || '') === 'needs-runtime-restart') return true;
  return Array.isArray(job?.runtimeChangedPaths) && job.runtimeChangedPaths.length > 0;
}

export function eventForRecoverableJob(events = [], job = {}) {
  const answerMessageId = String(job?.pendingAskAnswer?.answerMessageId || '').trim();
  if (answerMessageId) {
    const answerEvent = events.find((event) => String(event?.id || '') === answerMessageId);
    if (answerEvent) return answerEvent;
  }

  const jobId = String(job?.id || '');
  if (!jobId) return null;
  return events.find((event) => {
    const eventId = String(event?.id || '');
    return eventId && (jobId === eventId || jobId.startsWith(`${eventId}_continue_`));
  }) || null;
}

function isInformationalJobStatus(status) {
  return INFORMATIONAL_JOB_STATUSES.has(String(status || ''));
}

function isRecoveryCandidate(entry, entries = []) {
  if (isRecoverableJobStatus(entry?.status)) return true;
  if (isRecoverableInterruptedHandoff(entry, entries)) return true;
  return isRecoverableRuntimeRestartSupersede(entry);
}

function isRecoverableInterruptedHandoff(entry, entries = []) {
  if (String(entry?.status || '') !== 'interrupted-recovered') return false;
  const continuationJobId = String(entry.continuationJobId || '');
  if (!continuationJobId) return true;
  return !entries.some((candidate) =>
    String(candidate?.id || '') === continuationJobId
      && !isInformationalJobStatus(candidate?.status),
  );
}

function isRecoverableRuntimeRestartSupersede(entry = {}) {
  if (String(entry?.status || '') !== 'superseded') return false;
  if (!isPostSuccessRuntimeRestartRecovery(entry)) return false;
  return String(entry?.error || '').includes('superseded by newer thread event');
}

function newestCandidateByRootJob(entries = [], allEntries = entries) {
  const byRoot = new Map();
  const allByRoot = entriesByRoot(allEntries);
  for (const entry of entries) {
    const rootId = rootJobId(entry.id);
    const current = byRoot.get(rootId);
    if (!current) {
      byRoot.set(rootId, { newest: entry, entries: [entry] });
      continue;
    }
    current.entries.push(entry);
    if (recoveryEntryTimeMs(entry) >= recoveryEntryTimeMs(current.newest)) {
      current.newest = entry;
    }
  }
  return [...byRoot.values()].map(({ newest, entries }) =>
    backfillRecoveryMetadata(newest, [...entries, ...(allByRoot.get(rootJobId(newest.id)) || [])]),
  );
}

function entriesByRoot(entries = []) {
  const byRoot = new Map();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const rootId = rootJobId(entry.id);
    if (!byRoot.has(rootId)) byRoot.set(rootId, []);
    byRoot.get(rootId).push(entry);
  }
  return byRoot;
}

function hasNewerBlockingLifecycleEntry(entries = [], candidate = {}) {
  const candidateRootId = rootJobId(candidate.id);
  const candidateTime = recoveryLifecycleTimeMs(candidate, entries);
  return entries.some((entry) => {
    if (!entry?.id || rootJobId(entry.id) !== candidateRootId) return false;
    if (isInformationalJobStatus(entry.status)) return false;
    if (!isBlockingRecoveryStatus(entry.status)) return false;
    return recoveryEntryTimeMs(entry) > candidateTime;
  });
}

function recoveryLifecycleTimeMs(candidate, entries = []) {
  const candidateId = String(candidate?.id || '');
  let timeMs = isRecoveryCandidate(candidate, entries) ? recoveryEntryTimeMs(candidate) : 0;
  for (const entry of entries) {
    if (String(entry?.id || '') !== candidateId) continue;
    if (!isRecoveryCandidate(entry, entries)) continue;
    timeMs = Math.max(timeMs, recoveryEntryTimeMs(entry));
  }
  return timeMs || recoveryEntryTimeMs(candidate);
}

function isBlockingRecoveryStatus(status) {
  const text = String(status || '');
  if (!text) return false;
  if (isRecoverableJobStatus(text)) return false;
  if (isInformationalJobStatus(text)) return false;
  if (text === 'interrupted-recovered') return false;
  return true;
}

function backfillRecoveryMetadata(candidate, entries = []) {
  const filled = { ...candidate };
  const newestFirst = [...entries].sort((a, b) => recoveryEntryTimeMs(b) - recoveryEntryTimeMs(a));
  for (const entry of newestFirst) {
    for (const key of RECOVERY_METADATA_KEYS) {
      if (filled[key] === undefined && entry[key] !== undefined) filled[key] = entry[key];
    }
  }
  return filled;
}

function recoveryEntryTimeMs(entry) {
  for (const key of ['updatedAt', 'finishedAt', 'recoveredAt', 'createdAt', 'timestamp', 'retryAt']) {
    const value = Date.parse(entry?.[key] || '');
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

export function compareThreadEvents(left, right) {
  const leftTime = eventTimeMs(left);
  const rightTime = eventTimeMs(right);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return compareEventIds(left?.id, right?.id);
}

function eventTimeMs(event = {}) {
  const timestamp = Date.parse(event.timestamp || '');
  if (Number.isFinite(timestamp)) return timestamp;
  return snowflakeTimeMs(event.id) ?? 0;
}

function compareEventIds(left, right) {
  const leftId = numericBigInt(left);
  const rightId = numericBigInt(right);
  if (leftId === null || rightId === null) return String(left || '').localeCompare(String(right || ''));
  if (leftId === rightId) return 0;
  return leftId > rightId ? 1 : -1;
}

function snowflakeTimeMs(id) {
  const value = numericBigInt(id);
  if (value === null) return null;
  return Number((value >> 22n) + 1420070400000n);
}

function numericBigInt(value) {
  const text = String(value || '');
  if (!/^\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

const RECOVERY_METADATA_KEYS = [
  'repoAccess',
  'repoPath',
  'stateAccess',
  'threadModelOverride',
  'preserveThreadModelOverride',
  'codexFastMode',
  'richStyleId',
  'maintenance',
  'maintenanceIssue',
  'concurrencyKey',
  'maintenanceMode',
  'maintenanceInputLimitResume',
  'maintenanceManifestPath',
  'maintenanceRawContextPath',
  'maintenanceSummaryPath',
  'maintenanceGitBaselinePaths',
  'search',
  'verboseProgress',
  'priority',
  'attempt',
  'nextAttempt',
  'finalChannelId',
  'recoveredFromJobId',
  'pendingAskAnswer',
  'workerMode',
  'mockPlan',
  'runtimeSourceBaseline',
  'artifactDeliveryBaseline',
  'runtimeChangedPaths',
  'checkpointPath',
  'checkpointStatus',
  'finalAnswerReady',
];

const INFORMATIONAL_JOB_STATUSES = new Set([
  'checkpoint-saved',
  'progress-update',
  'transcript-saved',
  'worker-started',
  'detached-worker-reattached',
]);
