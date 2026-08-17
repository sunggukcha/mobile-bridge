import path from 'node:path';
import { channelStateDir } from './config.mjs';
import { readJsonlTail } from './state.mjs';

export async function readChannelPreferences(config, channelId, { limit = 50 } = {}) {
  const filePath = path.join(channelStateDir(config, channelId), 'memory', 'preferences.jsonl');
  return (await readJsonlTail(filePath, { limit }))
    .filter((entry) => String(entry.status || 'active') !== 'deleted');
}

export function formatChannelPreferencesForPrompt(preferences, {
  maxPreferences = 20,
  maxInstructionChars = 1200,
} = {}) {
  if (!Array.isArray(preferences) || preferences.length === 0) {
    return 'No channel memory preferences.';
  }

  return [
    'Channel memory preferences:',
    'These are durable user preferences for this Discord channel. Apply them unless the current user explicitly overrides them.',
    ...preferences.slice(-maxPreferences).map((preference) => {
      const id = preference.id || 'pref';
      const subject = preference.subject || preference.title || 'preference';
      const instruction = compactInlineText(preference.instruction || preference.content || '', maxInstructionChars);
      return `- [${id}] ${subject}: ${instruction || '(no instruction)'}`;
    }),
  ].join('\n');
}

function compactInlineText(value, maxChars) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}
