import fs from 'node:fs/promises';
import path from 'node:path';

// Messages sent while the service process was down are not replayed by a
// gateway RESUME (the session dies with the process). On startup the bridge
// REST-fetches recent messages for allowed channels and recently active
// threads and re-feeds them through normal handling; per-message dedupe
// locks make overlap with already-processed or live gateway events safe.

export function selectCatchupMessages(messages, { notBefore } = {}) {
  const floorMs = notBefore instanceof Date ? notBefore.getTime() : Date.parse(notBefore || '');
  return (messages || [])
    .filter((message) => {
      const atMs = Date.parse(message?.timestamp || '');
      if (!Number.isFinite(atMs)) return false;
      return !Number.isFinite(floorMs) || atMs >= floorMs;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export async function recentlyActiveThreadIds(stateRoot, channelIds, {
  now = new Date(),
  activeWindowMs = 48 * 60 * 60 * 1000,
  maxThreads = 25,
} = {}) {
  const found = [];
  for (const channelId of channelIds) {
    const channelDir = path.join(stateRoot, String(channelId));
    let entries;
    try {
      entries = await fs.readdir(channelDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isBridgeThreadStateDirectory(entry.name)) continue;
      if (entry.name === String(channelId)) continue;
      const eventsFile = path.join(channelDir, entry.name, 'memory', 'events.jsonl');
      const stat = await fs.stat(eventsFile).catch(() => null);
      if (!stat) continue;
      if (now.getTime() - stat.mtimeMs > activeWindowMs) continue;
      found.push({ channelId: String(channelId), threadId: entry.name, mtimeMs: stat.mtimeMs });
    }
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxThreads)
    .map(({ channelId, threadId }) => ({ channelId, threadId }));
}

function isBridgeThreadStateDirectory(name) {
  return /^\d+$/.test(name) || /^slack-[A-Z0-9]+-[A-Z0-9]+-\d+\.\d+$/i.test(name);
}
