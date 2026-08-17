import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasForwardedMessageContent,
  mergeForwardedMessageHydration,
  needsForwardedMessageHydration,
} from '../lib/forwarded-messages.mjs';

const BASE = { id: 'msg-1', channel_id: 'ch-1' };

test('needsForwardedMessageHydration flags a forward whose snapshots are missing', () => {
  assert.equal(needsForwardedMessageHydration({
    ...BASE,
    content: '원문:',
    message_reference: { type: 1, message_id: 'msg-0' },
  }), true);
});

test('needsForwardedMessageHydration flags an empty message with no snapshots', () => {
  assert.equal(needsForwardedMessageHydration({ ...BASE, content: '' }), true);
});

test('needsForwardedMessageHydration skips messages that already carry a body', () => {
  assert.equal(needsForwardedMessageHydration({ ...BASE, content: '작업해줘' }), false);
  assert.equal(needsForwardedMessageHydration({
    ...BASE,
    content: '',
    attachments: [{ url: 'https://cdn.example/file.png' }],
  }), false);
  assert.equal(needsForwardedMessageHydration({
    ...BASE,
    content: '',
    message_snapshots: [{ message: { content: 'forwarded body' } }],
  }), false);
});

test('needsForwardedMessageHydration skips payloads without ids to re-fetch', () => {
  assert.equal(needsForwardedMessageHydration(null), false);
  assert.equal(needsForwardedMessageHydration({ content: '' }), false);
});

test('mergeForwardedMessageHydration adopts fetched snapshots and keeps the comment text', () => {
  const original = {
    ...BASE,
    content: '원문:',
    message_reference: { type: 1, message_id: 'msg-0' },
  };
  const fetched = {
    ...original,
    content: '',
    message_snapshots: [{ message: { content: 'forwarded body', attachments: [], embeds: [] } }],
  };
  const merged = mergeForwardedMessageHydration(original, fetched);
  assert.equal(merged.content, '원문:');
  assert.equal(hasForwardedMessageContent(merged), true);
  assert.equal(merged.message_snapshots[0].message.content, 'forwarded body');
});

test('mergeForwardedMessageHydration is a no-op when the fetch has no snapshot body', () => {
  const original = { ...BASE, content: '' };
  assert.equal(mergeForwardedMessageHydration(original, { ...BASE, content: '', message_snapshots: [] }), original);
  assert.equal(mergeForwardedMessageHydration(original, null), original);
});
