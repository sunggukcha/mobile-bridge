import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  flushSlackOutbox,
  queueSlackOutbox,
  slackOutboxProgressFromError,
} from '../lib/slack-outbox.mjs';
import { JsonState } from '../lib/state.mjs';

test('Slack outbox preserves thread destinations and retries in order', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'slack-outbox-')));
  await state.init();
  const first = await queueSlackOutbox(state, {
    channelId: 'C123',
    threadTs: '1785218300.000001',
    destinationId: 'slack-T1-C123-1785218300.000001',
    content: 'answer',
    job: { id: 'job-1', channelId: 'logical', threadId: 'slack-thread' },
  });
  await queueSlackOutbox(state, {
    channelId: 'C123',
    threadTs: '1785218300.000001',
    content: 'done',
    afterOutboxIds: [first.id],
  });

  const sent = [];
  const result = await flushSlackOutbox(state, {
    async postMessage(channelId, content, options) {
      sent.push({ channelId, content, options });
      return [{ id: `m-${sent.length}` }];
    },
  }, { now: new Date(Date.now() + 1000) });

  assert.equal(result.sent, 2);
  assert.equal(result.pending, 0);
  assert.deepEqual(sent, [
    {
      channelId: 'C123',
      content: 'answer',
      options: { threadTs: '1785218300.000001' },
    },
    {
      channelId: 'C123',
      content: 'done',
      options: { threadTs: '1785218300.000001' },
    },
  ]);
});

test('Slack outbox checkpoints successful rich-message parts before retrying', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'slack-outbox-resume-')));
  await state.init();
  const entry = await queueSlackOutbox(state, {
    channelId: 'C123',
    threadTs: '1785218300.000001',
    content: 'text then table',
    job: { id: 'job-1', channelId: 'logical', threadId: 'slack-thread' },
  });
  const calls = [];
  let fail = true;
  const api = {
    async postMessage(channelId, content, options) {
      calls.push({ channelId, content, options });
      if (fail) {
        const error = new Error('attachment failed');
        error.slackCompletedParts = 1;
        error.slackMessageIds = ['m-1'];
        error.slackTotalParts = 3;
        throw error;
      }
      return [{ id: 'm-2' }, { id: 'm-3' }];
    },
  };

  const firstAttemptAt = new Date(Date.parse(entry.createdAt) + 1_000);
  const first = await flushSlackOutbox(state, api, {
    now: firstAttemptAt,
  });
  assert.equal(first.pending, 1);
  const [checkpointed] = await state.readJson('slack-outbox.json');
  assert.equal(checkpointed.id, entry.id);
  assert.equal(checkpointed.deliveredPartCount, 1);
  assert.deepEqual(checkpointed.deliveredMessageIds, ['m-1']);

  fail = false;
  let delivered = null;
  const second = await flushSlackOutbox(state, api, {
    now: new Date(firstAttemptAt.getTime() + 60_000),
    onDelivered(_deliveredEntry, messages) {
      delivered = messages;
    },
  });

  assert.equal(second.sent, 1);
  assert.equal(second.pending, 0);
  assert.deepEqual(calls[1].options, {
    threadTs: '1785218300.000001',
    startPartIndex: 1,
  });
  assert.deepEqual(delivered.map((message) => message.id), ['m-1', 'm-2', 'm-3']);
  assert.deepEqual(await state.readJson('slack-outbox.json'), []);
});

test('Slack outbox preserves style and contact-sheet flags across delivery', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'slack-style-outbox-')));
  await state.init();
  await queueSlackOutbox(state, {
    channelId: 'C123',
    threadTs: '1785218300.000001',
    content: 'themes',
    options: { styleId: 'synthwave', includeStylePreview: true },
  });

  const calls = [];
  await flushSlackOutbox(state, {
    async postMessage(channelId, content, options) {
      calls.push({ channelId, content, options });
      return [{ id: 'style-message' }];
    },
  }, { now: new Date(Date.now() + 1_000) });
  assert.deepEqual(calls[0].options, {
    threadTs: '1785218300.000001',
    styleId: 'synthwave',
    includeStylePreview: true,
  });
});

test('Slack direct-send progress hands off to a new outbox entry without duplicating text', async () => {
  const state = new JsonState(await fs.mkdtemp(path.join(os.tmpdir(), 'slack-handoff-outbox-')));
  await state.init();
  const directError = new Error('preview failed after text');
  directError.slackCompletedParts = 1;
  directError.slackCompletedMessageIds = ['direct-text-1'];
  await queueSlackOutbox(state, {
    channelId: 'C123',
    threadTs: '1785218300.000001',
    content: 'Rendering themes',
    ...slackOutboxProgressFromError(directError),
  });

  const [stored] = await state.readJson('slack-outbox.json', []);
  assert.equal(stored.deliveredPartCount, 1);
  assert.deepEqual(stored.deliveredMessageIds, ['direct-text-1']);
  let delivered;
  const calls = [];
  await flushSlackOutbox(state, {
    async postMessage(channelId, content, options) {
      calls.push({ channelId, content, options });
      return [{ id: 'retry-preview-1' }];
    },
  }, {
    now: new Date(Date.now() + 1_000),
    onDelivered(_entry, messages) {
      delivered = messages;
    },
  });
  assert.equal(calls[0].options.startPartIndex, 1);
  assert.deepEqual(delivered.map((message) => message.id), ['direct-text-1', 'retry-preview-1']);
});
