import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertParentChannelDestination,
  assertThreadDestination,
  isParentChannelDestination,
  isThreadDestination,
} from '../lib/thread-delivery.mjs';

test('isThreadDestination rejects posting job responses to the parent channel', () => {
  assert.equal(isThreadDestination('channel-1', 'channel-1'), false);
  assert.equal(isThreadDestination('channel-1', ''), false);
  assert.equal(isThreadDestination('channel-1', 'thread-1'), true);
});

test('assertThreadDestination throws before a job response can leak to feed', () => {
  assert.throws(
    () => assertThreadDestination('channel-1', 'channel-1'),
    /refusing to post job response outside a thread/,
  );
});

test('parent channel final destination must be explicit and same channel', () => {
  assert.equal(isParentChannelDestination('channel-1', 'channel-1'), true);
  assert.equal(isParentChannelDestination('channel-1', 'thread-1'), false);
  assert.doesNotThrow(() => assertParentChannelDestination('channel-1', 'channel-1'));
  assert.throws(
    () => assertParentChannelDestination('channel-1', 'other-channel'),
    /refusing to post job final outside its parent channel/,
  );
});
