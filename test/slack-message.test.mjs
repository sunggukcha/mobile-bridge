import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactSlackFiles,
  isSlackUserMessageEvent,
  parseSlackThreadStateId,
  slackCommandToBridgeCommand,
  slackMessageReservationId,
  slackThreadStateId,
  slackTimestampToIso,
} from '../lib/slack-message.mjs';

test('Slack bang commands translate to existing bridge slash commands only on Slack input', () => {
  assert.equal(slackCommandToBridgeCommand('!model sol'), '/model sol');
  assert.equal(slackCommandToBridgeCommand('!/model sol /effort max'), '/model sol /effort max');
  assert.equal(
    slackCommandToBridgeCommand(' !/model sol terra opus /effort max xhigh low'),
    ' /model sol terra opus /effort max xhigh low',
  );
  assert.equal(slackCommandToBridgeCommand('  !EFFORT max'), '  /EFFORT max');
  assert.equal(slackCommandToBridgeCommand('!yolo'), '/yolo');
  assert.equal(slackCommandToBridgeCommand('!help'), '/help');
  assert.equal(slackCommandToBridgeCommand('!style minimal-light'), '/style minimal-light');
  assert.equal(slackCommandToBridgeCommand('!할일 추가 문서 정리'), '/할일 추가 문서 정리');
  assert.equal(
    slackCommandToBridgeCommand(
      'Fix it !yolo !model sol terra !effort max xhigh !repo mobile-codex-bridge',
    ),
    'Fix it /yolo /model sol terra /effort max xhigh /repo mobile-codex-bridge',
  );
  assert.equal(slackCommandToBridgeCommand('!hello 그대로'), '!hello 그대로');
  assert.equal(slackCommandToBridgeCommand('/model sol'), '/model sol');
  assert.equal(slackCommandToBridgeCommand('blah blah my message !yolo'), 'blah blah my message /yolo');
  assert.equal(slackCommandToBridgeCommand('문장 안의 !model sol'), '문장 안의 /model sol');
  assert.equal(slackCommandToBridgeCommand('we have `!/model` function'), 'we have `!/model` function');
  assert.equal(slackCommandToBridgeCommand('we have `!model` function'), 'we have `!model` function');
  assert.equal(
    slackCommandToBridgeCommand('document `!model sol` and !yolo'),
    'document `!model sol` and /yolo',
  );
});

test('Slack thread state IDs are reversible and safe channel-thread keys', () => {
  const id = slackThreadStateId({
    teamId: 'T0123',
    channelId: 'C0456',
    threadTs: '1785218400.123456',
  });
  assert.equal(id, 'slack-T0123-C0456-1785218400.123456');
  assert.deepEqual(parseSlackThreadStateId(id), {
    teamId: 'T0123',
    channelId: 'C0456',
    threadTs: '1785218400.123456',
  });
  assert.equal(parseSlackThreadStateId('1000000000000000003'), null);
});

test('Slack message helpers accept user messages and compact files', () => {
  assert.equal(isSlackUserMessageEvent({
    type: 'message',
    channel: 'C1',
    ts: '1785218400.123456',
    user: 'U1',
  }), true);
  assert.equal(isSlackUserMessageEvent({
    type: 'message',
    channel: 'C1',
    ts: '1785218400.123456',
    user: 'U1',
    bot_id: 'B1',
  }), false);
  assert.equal(isSlackUserMessageEvent({
    type: 'message',
    channel: 'C1',
    ts: '1785218400.123456',
    user: 'U1',
    subtype: 'message_changed',
  }), false);
  assert.equal(slackMessageReservationId({
    channel: 'C1',
    ts: '1785218400.123456',
  }), 'slack-C1-1785218400-123456');
  assert.equal(slackTimestampToIso('1785218400.123456'), '2026-07-28T06:00:00.123Z');
  assert.deepEqual(compactSlackFiles([{
    id: 'F1',
    name: 'report.pdf',
    url_private_download: 'https://files.slack.test/report.pdf',
    mimetype: 'application/pdf',
    size: 42,
  }]), [{
    id: 'F1',
    filename: 'report.pdf',
    url: 'https://files.slack.test/report.pdf',
    content_type: 'application/pdf',
    size: 42,
  }]);
});
