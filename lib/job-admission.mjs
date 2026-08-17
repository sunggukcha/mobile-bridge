import { rootJobId } from './job-id.mjs';

// User events with no request-bearing content must not enter source ordering or
// the job queue. Keep this predicate platform-neutral so Discord hydration,
// Slack normalization and recovery callers apply the same definition.
export function isActionableJobEvent(event = {}) {
  if (String(event?.content || '').trim()) return true;
  if (hasEntries(event?.attachments) || hasEntries(event?.embeds)) return true;
  if (hasEntries(event?.forwardedMessages) || hasEntries(event?.message_snapshots)) return true;
  if (
    hasReference(event?.referencedMessage)
    || hasReference(event?.referenced_message)
    || hasReference(event?.message_reference)
  ) return true;
  return Boolean(
    event?.resumeContext
    || event?.pendingAskAnswer
    || event?.recoveredFromJobId
    || event?.continuationJobId,
  );
}

// A supersede notice is useful only when the replaced work had actually begun
// or had produced something visible. Both job records and outbound events are
// accepted so the decision remains correct after a service restart.
export function shouldPostSupersededNotice({
  jobId = '',
  workerStarted = false,
  visibleDelivery = false,
  jobRecords = [],
  outboundEvents = [],
} = {}) {
  if (workerStarted || visibleDelivery) return true;
  const currentRootId = rootJobId(jobId);
  if (!currentRootId) return true;
  const sameJobRecord = (entry) => rootJobId(entry?.id || '') === currentRootId;
  const sameOutboundEvent = (event) =>
    rootJobId(event?.jobId || event?.id || '') === currentRootId;
  if (jobRecords.some((entry) =>
    sameJobRecord(entry)
      && (
        String(entry?.status || '') === 'worker-started'
        || Boolean(entry?.delivered)
        || hasEntries(entry?.messageIds)
      ))) {
    return true;
  }
  return outboundEvents.some((event) =>
    sameOutboundEvent(event)
      && (Boolean(event?.delivered) || hasEntries(event?.messageIds)),
  );
}

function hasEntries(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasReference(value) {
  if (!value) return false;
  if (typeof value !== 'object') return Boolean(String(value).trim());
  return Object.keys(value).length > 0;
}
