const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const CONTINUATION_MARKER = '_continue_';

function twoDigit(value) {
  return String(value).padStart(2, '0');
}

export function formatKstCompactTimestamp(date = new Date()) {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return [
    shifted.getUTCFullYear(),
    twoDigit(shifted.getUTCMonth() + 1),
    twoDigit(shifted.getUTCDate()),
    twoDigit(shifted.getUTCHours()),
    twoDigit(shifted.getUTCMinutes()),
    twoDigit(shifted.getUTCSeconds()),
  ].join('');
}

// Second-resolution timestamps collide when two continuations of the same
// root job are created within one second (e.g. abort-requeue and git-poll
// racing), which poisons the running-job map and message dedupe. Append
// milliseconds plus a process-local counter so every generated id is unique.
let continuationSequence = 0;

export function continuationJobId(rootJobId, date = new Date()) {
  const ms = String(date.getTime() % 1000).padStart(3, '0');
  continuationSequence = (continuationSequence + 1) % 1000;
  const seq = String(continuationSequence).padStart(3, '0');
  return `${rootJobId}${CONTINUATION_MARKER}${formatKstCompactTimestamp(date)}${ms}${seq}`;
}

export function rootJobId(jobId) {
  const text = String(jobId || '');
  const markerIndex = text.indexOf(CONTINUATION_MARKER);
  return markerIndex === -1 ? text : text.slice(0, markerIndex);
}
