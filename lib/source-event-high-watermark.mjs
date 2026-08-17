import fs from 'node:fs/promises';
import { withFileLock } from './file-lock.mjs';
import { compareThreadEvents } from './job-recovery.mjs';

export const SOURCE_EVENT_HIGH_WATERMARK_FILE = 'memory/source-event-high-water.json';

export async function observeSourceEventHighWatermark({
  state,
  event,
  isIgnoredEvent = () => false,
} = {}) {
  if (!state?.file || !state?.readJson || !state?.writeJson) {
    throw new TypeError('source event high-water mark requires a JsonState-compatible state');
  }
  if (!event?.id) return null;

  const file = state.file(SOURCE_EVENT_HIGH_WATERMARK_FILE);
  return withFileLock(file, async () => {
    const ignoredIncomingEvent = isIgnoredEvent(event);
    const stored = normalizeWatermark(
      await state.readJson(SOURCE_EVENT_HIGH_WATERMARK_FILE, null),
    );
    const historical = stored || newestEligibleEvent(
      await readHistoricalEvents(state),
      isIgnoredEvent,
    );
    const newerEvent = historical && compareThreadEvents(historical, event) > 0
      ? historical
      : null;
    // Control-only messages must not advance the watermark, but they still
    // need to see a later persisted task or `/cancel` when delayed delivery
    // would otherwise resurrect work that was explicitly replaced or stopped.
    const next = ignoredIncomingEvent ? historical : newestEvent(historical, event);

    if (next && (!stored || compareThreadEvents(next, stored) > 0)) {
      await state.writeJson(
        SOURCE_EVENT_HIGH_WATERMARK_FILE,
        compactWatermark(next),
      );
    }
    return newerEvent ? compactWatermark(newerEvent) : null;
  });
}

function newestEligibleEvent(events, isIgnoredEvent) {
  let newest = null;
  for (const event of events) {
    if (!event?.id || isIgnoredEvent(event)) continue;
    newest = newestEvent(newest, event);
  }
  return newest;
}

function newestEvent(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return compareThreadEvents(right, left) > 0 ? right : left;
}

async function readHistoricalEvents(state) {
  const names = [
    // Compaction moves old lines into `.archive`, and archive rotation moves
    // those into `.archive.1`. Both are read so this bootstrap fallback keeps
    // the same history in view after either one runs.
    'memory/events.jsonl.archive.1',
    'memory/events.jsonl.archive',
    'memory/events.jsonl',
  ];
  const groups = await Promise.all(names.map(async (name) => {
    try {
      return (await fs.readFile(state.file(name), 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }));
  return groups.flat();
}

function normalizeWatermark(value) {
  return value?.id ? compactWatermark(value) : null;
}

function compactWatermark(event) {
  return {
    id: String(event.id),
    timestamp: String(event.timestamp || ''),
    source: event.source || null,
    platform: event.platform || null,
    sourceEventId: event.sourceEventId || null,
    sourceMessageId: event.sourceMessageId || null,
  };
}
