import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activePendingAskFromEntries,
  compactPendingAskAnswer,
  expiredPendingAsksFromEntries,
  formatPendingAskMessage,
  parsePendingAskCommand,
  parsePendingAskFromOutput,
  pendingAskContinuationMarkdown,
} from '../lib/pending-ask.mjs';

test('parsePendingAskFromOutput extracts bridge wait marker JSON', () => {
  const ask = parsePendingAskFromOutput([
    '잠깐 확인이 필요합니다.',
    '<bridge_wait_for_user>{"question":"어느 브랜치에 적용할까요?","reason":"대상 브랜치가 없으면 push 위치가 불명확합니다.","answer_format":"브랜치 이름"}</bridge_wait_for_user>',
  ].join('\n'));

  assert.equal(ask.question, '어느 브랜치에 적용할까요?');
  assert.equal(ask.reason, '대상 브랜치가 없으면 push 위치가 불명확합니다.');
  assert.equal(ask.answerFormat, '브랜치 이름');
  assert.equal(ask.visibleText, '잠깐 확인이 필요합니다.');
});

test('parsePendingAskFromOutput keeps completion marker out of visible text', () => {
  const ask = parsePendingAskFromOutput([
    '검증 결과를 정리했습니다.',
    '',
    '【(claude: Opus 5) 응답완료】',
    '<bridge_wait_for_user>{"question":"이어서 push할까요?","reason":"공유 브랜치 확인이 필요합니다.","answer_format":"예 또는 아니오"}</bridge_wait_for_user>',
  ].join('\n'));

  assert.equal(ask.visibleText, '검증 결과를 정리했습니다.');
});

test('parsePendingAskFromOutput strips the effort-bearing completion marker', () => {
  const ask = parsePendingAskFromOutput([
    '검증 결과를 정리했습니다.',
    '',
    '【응답완료: codex gpt-5.6-terra (xhigh)】',
    '<bridge_wait_for_user>{"question":"이어서 push할까요?","reason":"공유 브랜치 확인이 필요합니다.","answer_format":"예 또는 아니오"}</bridge_wait_for_user>',
  ].join('\n'));

  assert.equal(ask.visibleText, '검증 결과를 정리했습니다.');
});

test('parsePendingAskFromOutput strips the worker marker with effort suffix', () => {
  const ask = parsePendingAskFromOutput([
    '검증 결과를 정리했습니다.',
    '',
    '【(codex: gpt-5.6-terra (xhigh)) 응답완료】',
    '<bridge_wait_for_user>{"question":"이어서 push할까요?","reason":"공유 브랜치 확인이 필요합니다.","answer_format":"예 또는 아니오"}</bridge_wait_for_user>',
  ].join('\n'));

  assert.equal(ask.visibleText, '검증 결과를 정리했습니다.');
});

test('parsePendingAskFromOutput strips the completion marker with elapsed work time', () => {
  const ask = parsePendingAskFromOutput([
    '검증 결과를 정리했습니다.',
    '',
    '【(codex: gpt-5.6-terra (xhigh) · 작업시간: 1분) 응답완료】',
    '<bridge_wait_for_user>{"question":"이어서 push할까요?"}</bridge_wait_for_user>',
  ].join('\n'));

  assert.equal(ask.visibleText, '검증 결과를 정리했습니다.');
});

test('parsePendingAskFromOutput ignores inline marker examples', () => {
  const ask = parsePendingAskFromOutput([
    'Codex/Claude가 `<bridge_wait_for_user>...</bridge_wait_for_user>` 블록으로 질문을 남기면 이어서 진행합니다.',
    '현재 timeout은 7일입니다.',
  ].join('\n'));

  assert.equal(ask, null);
});

test('parsePendingAskFromOutput requires a final JSON ask block', () => {
  assert.equal(
    parsePendingAskFromOutput('<bridge_wait_for_user>어느 브랜치인가요?</bridge_wait_for_user>'),
    null,
  );
  assert.equal(
    parsePendingAskFromOutput('<bridge_wait_for_user>{"question":"..."}</bridge_wait_for_user>'),
    null,
  );
});

test('formatPendingAskMessage contains only the required heading and question', () => {
  const text = formatPendingAskMessage({
    question: '배포 환경은 어디인가요?',
    answerFormat: 'staging 또는 production',
    choices: [{ label: 'staging', description: '테스트 배포' }],
  });

  assert.equal(text, '# Question\n배포 환경은 어디인가요?');
});

test('activePendingAskFromEntries returns newest waiting ask and ignores answered or expired asks', () => {
  const now = new Date('2026-06-30T10:00:00.000Z');
  const entries = [
    { id: 'old', status: 'waiting', createdAt: '2026-06-30T09:00:00.000Z', expiresAt: '2026-06-30T09:30:00.000Z' },
    { id: 'answered', status: 'waiting', createdAt: '2026-06-30T09:10:00.000Z', question: '이미 답한 질문' },
    { id: 'answered', status: 'answered', answeredAt: '2026-06-30T09:20:00.000Z' },
    { id: 'active', status: 'waiting', createdAt: '2026-06-30T09:30:00.000Z', question: '배포 환경은 어디인가요?' },
  ];

  assert.equal(activePendingAskFromEntries(entries, { now }).id, 'active');
  assert.deepEqual(expiredPendingAsksFromEntries(entries, { now }).map((ask) => ask.id), ['old']);
});

test('activePendingAskFromEntries ignores placeholder waiting asks', () => {
  const now = new Date('2026-06-30T10:00:00.000Z');
  const entries = [
    { id: 'broken', status: 'waiting', createdAt: '2026-06-30T09:30:00.000Z', question: '...' },
    { id: 'active', status: 'waiting', createdAt: '2026-06-30T09:20:00.000Z', question: '배포 환경은 어디인가요?' },
  ];

  assert.equal(activePendingAskFromEntries(entries, { now }).id, 'active');
});

test('activePendingAskFromEntries returns null when only placeholder asks are waiting', () => {
  const now = new Date('2026-06-30T10:00:00.000Z');
  const entries = [
    { id: 'broken', status: 'waiting', createdAt: '2026-06-30T09:30:00.000Z', question: '...' },
  ];

  assert.equal(activePendingAskFromEntries(entries, { now }), null);
});

test('parsePendingAskCommand recognizes explicit cancel only', () => {
  assert.deepEqual(parsePendingAskCommand('/ask cancel'), { action: 'cancel' });
  assert.deepEqual(parsePendingAskCommand('/질문 취소'), { action: 'cancel' });
  assert.equal(parsePendingAskCommand('취소'), null);
});

test('pendingAskContinuationMarkdown carries question and answer into the next prompt', () => {
  const compact = compactPendingAskAnswer({
    askId: 'job-1_ask',
    askedJobId: 'job-1',
    answerMessageId: 'message-2',
    question: '배포 환경?',
    answer: 'staging',
    worker: 'codex',
  });
  const markdown = pendingAskContinuationMarkdown(compact);

  assert.match(markdown, /askId: job-1_ask/);
  assert.match(markdown, /Question:\n배포 환경\?/);
  assert.match(markdown, /User answer:\nstaging/);
  assert.match(markdown, /Continue the original task/);
});

test('compactPendingAskAnswer returns null for empty optional job metadata', () => {
  assert.equal(compactPendingAskAnswer(), null);
  assert.equal(compactPendingAskAnswer({}), null);
});
