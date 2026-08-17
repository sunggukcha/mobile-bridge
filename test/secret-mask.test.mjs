import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets, containsSecret, redactEventSecrets } from '../lib/secret-mask.mjs';

// Build credential-shaped fixtures at runtime so secret scanners never mistake
// a committed test value for a usable credential.
const HF_TOKEN = `hf_${'a'.repeat(34)}`;
const GITHUB_TOKEN = `ghp_${'b'.repeat(36)}`;
const GITHUB_FINE_GRAINED_TOKEN = `github_pat_${'c'.repeat(32)}`;
const ANTHROPIC_TOKEN = `sk-ant-${'d'.repeat(24)}`;
const AWS_KEY = `AKIA${'E'.repeat(16)}`;
const GOOGLE_KEY = `AIza${'f'.repeat(35)}`;
const SLACK_TOKEN = `xoxb-${'1'.repeat(12)}-${'g'.repeat(18)}`;
const SLACK_APP_TOKEN = `xapp-${'2'.repeat(12)}-${'h'.repeat(32)}`;

test('masks a Hugging Face token but keeps the prefix', () => {
  const masked = maskSecrets(`here is ${HF_TOKEN} token`);
  assert.equal(masked.includes('a'.repeat(8)), false);
  assert.match(masked, /hf_\[REDACTED\]/);
});

test('masks GitHub, OpenAI, AWS, Google, and Slack token shapes', () => {
  assert.match(maskSecrets(GITHUB_TOKEN), /ghp_\[REDACTED\]/);
  assert.match(maskSecrets(GITHUB_FINE_GRAINED_TOKEN), /github_pat_\[REDACTED\]/);
  assert.match(maskSecrets(ANTHROPIC_TOKEN), /sk-\[REDACTED\]/);
  assert.match(maskSecrets(AWS_KEY), /AKIA\[REDACTED\]/);
  assert.match(maskSecrets(GOOGLE_KEY), /AIza\[REDACTED\]/);
  assert.match(maskSecrets(SLACK_TOKEN), /xoxb-\[REDACTED\]/);
  assert.match(maskSecrets(SLACK_APP_TOKEN), /xapp-\[REDACTED\]/);
});

test('masks an X OAuth2 bearer token pasted without an environment key', () => {
  const token = `${'A'.repeat(21)}${'0'.repeat(32)}%2B${'1'.repeat(20)}%3DTESTONLY`;
  const masked = maskSecrets(`use ${token} for read-only X access`);
  assert.equal(masked.includes('TESTONLY'), false);
  assert.match(masked, /AAAA\[REDACTED\]/);
  assert.equal(containsSecret(token), true);
});

test('leaves ordinary text untouched and is idempotent', () => {
  const plain = 'deploy the service and run npm test (sk- is fine in prose)';
  assert.equal(maskSecrets(plain), plain);
  const once = maskSecrets(`token ${HF_TOKEN} end`);
  assert.equal(maskSecrets(once), once);
});

test('handles non-string and empty input', () => {
  assert.equal(maskSecrets(''), '');
  assert.equal(maskSecrets(null), null);
  assert.equal(maskSecrets(42), 42);
});

test('containsSecret detects and clears correctly', () => {
  assert.equal(containsSecret(HF_TOKEN), true);
  assert.equal(containsSecret('just a normal sentence'), false);
  // Repeated calls must not be affected by global-regex lastIndex state.
  assert.equal(containsSecret(HF_TOKEN), true);
});

test('redactEventSecrets masks content, referenced and forwarded bodies without mutating input', () => {
  const event = {
    id: '1',
    content: `use ${HF_TOKEN} please`,
    referencedMessage: { id: '2', content: `old key ${GITHUB_TOKEN}` },
    forwardedMessages: [{ content: `fwd ${ANTHROPIC_TOKEN}` }],
  };
  const redacted = redactEventSecrets(event);
  assert.match(redacted.content, /hf_\[REDACTED\]/);
  assert.match(redacted.referencedMessage.content, /ghp_\[REDACTED\]/);
  assert.match(redacted.forwardedMessages[0].content, /sk-\[REDACTED\]/);
  // Original event object is left intact for in-memory dispatch.
  assert.equal(event.content.includes(HF_TOKEN), true);
  assert.equal(event.referencedMessage.content.includes(GITHUB_TOKEN), true);
});
