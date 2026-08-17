export function formatJobCompletionSummary(marker, result = {}, {
  finishedAt = new Date(),
  previousDurationMs = 0,
} = {}) {
  const normalizedMarker = String(marker || '').trim();
  if (!normalizedMarker) return '';

  const startedAt = firstWorkerStartedAt(result);
  const finishedAtMs = toTimestamp(finishedAt);
  const carriedDurationMs = Math.max(0, Number(previousDurationMs) || 0);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAtMs)) {
    return carriedDurationMs > 0
      ? appendJobDurationToMarker(normalizedMarker, formatJobDuration(carriedDurationMs))
      : normalizedMarker;
  }

  const currentDurationMs = Math.max(0, finishedAtMs - startedAt);
  return appendJobDurationToMarker(
    normalizedMarker,
    formatJobDuration(carriedDurationMs + currentDurationMs),
  );
}

export function formatJobDuration(durationMs) {
  const totalSeconds = Math.floor(Math.max(0, Number(durationMs) || 0) / 1_000);
  if (totalSeconds === 0) return '1초 미만';

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0) parts.push(`${minutes}분`);
  if (seconds > 0) parts.push(`${seconds}초`);
  return parts.join(' ');
}

export function shouldPostStandaloneCompletionMarker(mode, finalDelivery = {}) {
  const normalizedMode = String(mode || 'inline');
  if (normalizedMode === 'separate') return true;
  if (normalizedMode !== 'inline') return false;

  // In inline mode the marker normally travels with the final body. Codex can
  // expose that body first as worker progress, though, and terminal dedupe then
  // reuses the already-visible progress message instead of posting it twice.
  // That reused message has no bridge completion marker, so deliver only the
  // marker as a follow-up.
  return finalDelivery?.duplicatePurpose === 'worker-progress';
}

function firstWorkerStartedAt(result = {}) {
  const starts = Array.isArray(result.workerTranscripts)
    ? result.workerTranscripts.map((transcript) => toTimestamp(transcript?.startedAt))
    : [];
  return starts.find(Number.isFinite);
}

function appendJobDurationToMarker(marker, duration) {
  const workerSuffix = ') 응답완료】';
  if (marker.endsWith(workerSuffix)) {
    return `${marker.slice(0, -workerSuffix.length)} · 작업시간: ${duration}${workerSuffix}`;
  }
  return marker.replace(/응답완료】$/u, `작업시간: ${duration} 응답완료】`);
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : NaN;
}
