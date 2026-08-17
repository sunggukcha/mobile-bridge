// Redacts well-known credential/token shapes from message text before it is
// persisted to durable state (memory/events.jsonl) or copied into daily
// maintenance raw-context artifacts. The live in-memory event handed to command
// routing and worker dispatch is left untouched, so a user can still paste a
// token for a worker to use in that session — only the stored copy is masked.
// This protects conversation logs and maintenance raw-context artifacts from
// accidentally retaining credentials pasted into a chat.

import { createHash } from 'node:crypto';

const REDACTION = '[REDACTED]';

// Each pattern keeps a recognizable leading prefix so masked logs stay
// debuggable (e.g. "hf_[REDACTED]") while the secret body is removed. `keep` is
// the number of leading characters of the match to preserve. Patterns are
// deliberately narrow (long, fixed-shape bodies) to avoid mangling normal text.
const SECRET_PATTERNS = [
  // Hugging Face user/access tokens: hf_ + ~34 base62 chars.
  { re: /\bhf_[A-Za-z0-9]{16,}\b/g, keep: 3 },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 30+ chars.
  { re: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, keep: 4 },
  // GitHub fine-grained personal access token.
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, keep: 11 },
  // OpenAI / Anthropic style secret keys: sk-... (incl. sk-proj-, sk-ant-).
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, keep: 3 },
  // AWS access key id.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, keep: 4 },
  // Google API key.
  { re: /\bAIza[0-9A-Za-z_\-]{35,}\b/g, keep: 4 },
  // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs-.
  { re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g, keep: 5 },
  // Slack app-level Socket Mode tokens.
  { re: /\bxapp-[A-Za-z0-9\-]{10,}\b/g, keep: 5 },
  // X OAuth2 app bearer tokens use a long run of leading "A" characters and
  // a URL-encoded base64-like body (commonly containing %2B and %3D).
  { re: /\bA{16,}[A-Za-z0-9%]{40,}\b/g, keep: 4 },
];

// Replace any embedded secret in `text` with "<prefix>[REDACTED]". Returns the
// input unchanged when there is no secret, and is idempotent (already-masked
// text contains no token-shaped substrings to match again).
export function maskSecrets(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const { re, keep } of SECRET_PATTERNS) {
    out = out.replace(re, (match) => match.slice(0, keep) + REDACTION);
  }
  return out;
}

// Fingerprint of the pattern set above. The startup sweep over already
// persisted state uses it to decide whether a full historical rescan can find
// anything: live writes are masked with these same patterns, so only a change
// here makes old files worth reading again.
export function secretPatternVersion() {
  const source = SECRET_PATTERNS
    .map(({ re, keep }) => `${re.source}|${re.flags}|${keep}`)
    .join('|');
  return createHash('sha1').update(`${REDACTION}|${source}`).digest('hex').slice(0, 16);
}

// True when `text` contains at least one recognized secret shape.
export function containsSecret(text) {
  if (typeof text !== 'string' || text === '') return false;
  return SECRET_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

// Return a shallow copy of a conversation event with secrets masked in its
// content and in any referenced / forwarded message bodies. Does not mutate the
// input, so the caller's in-memory event keeps the original text for dispatch.
export function redactEventSecrets(event) {
  if (!event || typeof event !== 'object') return event;
  const redacted = { ...event };
  if (typeof redacted.content === 'string') {
    redacted.content = maskSecrets(redacted.content);
  }
  if (redacted.referencedMessage && typeof redacted.referencedMessage.content === 'string') {
    redacted.referencedMessage = {
      ...redacted.referencedMessage,
      content: maskSecrets(redacted.referencedMessage.content),
    };
  }
  if (Array.isArray(redacted.forwardedMessages)) {
    redacted.forwardedMessages = redacted.forwardedMessages.map((snapshot) =>
      snapshot && typeof snapshot.content === 'string'
        ? { ...snapshot, content: maskSecrets(snapshot.content) }
        : snapshot,
    );
  }
  return redacted;
}
