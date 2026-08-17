import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMeaningfulRuntimeRestartReason,
  parseServiceRestartRequestFromOutput,
  resolveRuntimeSourceRestartExplanation,
} from '../lib/service-restart-request.mjs';

test('parseServiceRestartRequestFromOutput extracts final JSON service restart marker', () => {
  const request = parseServiceRestartRequestFromOutput([
    '서비스 재시작 요청을 처리하겠습니다.',
    '<bridge_restart_service>{"reason":"사용자가 서버 재부팅을 직접 요청","improvement":"idle 확인 후 service process restart"}</bridge_restart_service>',
  ].join('\n'));

  assert.deepEqual(request, {
    reason: '사용자가 서버 재부팅을 직접 요청',
    improvement: 'idle 확인 후 service process restart',
    rawPayload: '{"reason":"사용자가 서버 재부팅을 직접 요청","improvement":"idle 확인 후 service process restart"}',
    visibleText: '서비스 재시작 요청을 처리하겠습니다.',
  });
});

test('restart marker parsing provides safe visible output without granting restart authority', () => {
  const request = parseServiceRestartRequestFromOutput([
    '데이터 생성 파이프라인을 정리했습니다.',
    '<bridge_restart_service>{"reason":"데이터 생성 기준을 확정","improvement":"VLM 호출을 줄일 수 있음"}</bridge_restart_service>',
  ].join('\n'));

  assert.equal(request.visibleText, '데이터 생성 파이프라인을 정리했습니다.');
  assert.equal(request.reason, '데이터 생성 기준을 확정');
});

test('parseServiceRestartRequestFromOutput ignores examples and invalid payloads', () => {
  assert.equal(parseServiceRestartRequestFromOutput([
    'Example:',
    '<bridge_restart_service>{"reason":"example"}</bridge_restart_service>',
    'Do not actually restart.',
  ].join('\n')), null);
  assert.equal(parseServiceRestartRequestFromOutput('<bridge_restart_service>서버 재부팅 해줘</bridge_restart_service>'), null);
  assert.equal(parseServiceRestartRequestFromOutput('<bridge_restart_service>{"improvement":"restart"}</bridge_restart_service>'), null);
});

test('parseServiceRestartRequestFromOutput strips completion marker around final block', () => {
  const request = parseServiceRestartRequestFromOutput([
    '진행합니다.',
    '<bridge_restart_service>{"reason":"direct restart request"}</bridge_restart_service>',
    '【(codex: test) 응답완료】',
  ].join('\n'));

  assert.equal(request.reason, 'direct restart request');
  assert.equal(request.visibleText, '진행합니다.');
  assert.equal(request.improvement, '요청에 따라 서비스 재시작');
});

test('parseServiceRestartRequestFromOutput strips the effort-bearing completion marker', () => {
  const request = parseServiceRestartRequestFromOutput([
    '진행합니다.',
    '<bridge_restart_service>{"reason":"direct restart request"}</bridge_restart_service>',
    '【응답완료: codex gpt-5.6-terra (xhigh)】',
  ].join('\n'));

  assert.equal(request.reason, 'direct restart request');
  assert.equal(request.visibleText, '진행합니다.');
});

test('parseServiceRestartRequestFromOutput strips the worker marker with effort suffix', () => {
  const request = parseServiceRestartRequestFromOutput([
    '진행합니다.',
    '<bridge_restart_service>{"reason":"direct restart request"}</bridge_restart_service>',
    '【(codex: gpt-5.6-terra (xhigh)) 응답완료】',
  ].join('\n'));

  assert.equal(request.reason, 'direct restart request');
  assert.equal(request.visibleText, '진행합니다.');
});

test('resolveRuntimeSourceRestartExplanation preserves a concrete model-authored explanation', () => {
  const explanation = resolveRuntimeSourceRestartExplanation({
    request: {
      reason: '재시작 알림이 파일 목록 대신 모델이 작성한 동작 변경 내용을 표시하도록 수정',
      improvement: '운영 채널에서 재시작으로 적용되는 기능을 즉시 파악할 수 있음',
      visibleText: '재시작 사유 전달 방식을 수정하고 테스트했습니다.',
    },
    output: 'ignored raw output',
    changedPaths: ['bridge-service.mjs', 'lib/bridge-prompt.mjs'],
  });

  assert.deepEqual(explanation, {
    reason: '재시작 알림이 파일 목록 대신 모델이 작성한 동작 변경 내용을 표시하도록 수정',
    improvement: '운영 채널에서 재시작으로 적용되는 기능을 즉시 파악할 수 있음',
    usedFallback: false,
    reasonSource: 'restart-marker',
  });
});

test('resolveRuntimeSourceRestartExplanation rejects boilerplate and uses visible model output', () => {
  const explanation = resolveRuntimeSourceRestartExplanation({
    request: {
      reason: '런타임 소스 변경 반영: bridge-service.mjs, lib/bridge-prompt.mjs',
      improvement: '변경된 소스를 반영',
      visibleText: [
        '완료했습니다.',
        '- 재시작 알림이 모델이 설명한 실제 동작 변경과 적용 효과를 전달하도록 고쳤습니다.',
      ].join('\n'),
    },
    changedPaths: ['bridge-service.mjs', 'lib/bridge-prompt.mjs'],
  });

  assert.equal(
    explanation.reason,
    '재시작 알림이 모델이 설명한 실제 동작 변경과 적용 효과를 전달하도록 고쳤습니다.',
  );
  assert.equal(explanation.improvement, '위 변경 동작을 새 브리지 프로세스에 적용');
  assert.equal(explanation.usedFallback, true);
  assert.equal(explanation.reasonSource, 'visible-model-output');
});

test('runtime restart reasons reject changed-file lists and generic restart text', () => {
  assert.equal(isMeaningfulRuntimeRestartReason('bridge-service.mjs, lib/bridge-prompt.mjs'), false);
  assert.equal(isMeaningfulRuntimeRestartReason('런타임 소스 변경 반영'), false);
  assert.equal(isMeaningfulRuntimeRestartReason('runtime source changes applied'), false);
  assert.equal(
    isMeaningfulRuntimeRestartReason('재시작 알림에 모델이 작성한 실제 변경 사유를 표시'),
    true,
  );
});
