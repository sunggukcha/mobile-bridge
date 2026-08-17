import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDailyMaintenanceResult,
  parseDailyMaintenanceResultFromOutput,
} from '../lib/maintenance-report.mjs';

test('daily maintenance result parser accepts only a final structured result', () => {
  const parsed = parseDailyMaintenanceResultFromOutput([
    '상세 작업 내용은 스레드에 남겼습니다.',
    '<bridge_daily_maintenance_result>{"improvements":["실패 상태 필드까지 장애 탐지 범위를 넓혔습니다.","최종 결과를 일반 채널 신규 메시지로 보냅니다."]}</bridge_daily_maintenance_result>',
    '【(codex: test (max)) 응답완료】',
  ].join('\n'));

  assert.deepEqual(parsed, {
    improvements: [
      '실패 상태 필드까지 장애 탐지 범위를 넓혔습니다.',
      '최종 결과를 일반 채널 신규 메시지로 보냅니다.',
    ],
    noneReason: '',
    rawPayload: '{"improvements":["실패 상태 필드까지 장애 탐지 범위를 넓혔습니다.","최종 결과를 일반 채널 신규 메시지로 보냅니다."]}',
  });
  assert.equal(formatDailyMaintenanceResult(parsed), [
    '적용한 개선',
    '- 실패 상태 필드까지 장애 탐지 범위를 넓혔습니다.',
    '- 최종 결과를 일반 채널 신규 메시지로 보냅니다.',
  ].join('\n'));
});

test('daily maintenance result formats a concrete no-change reason', () => {
  const parsed = parseDailyMaintenanceResultFromOutput(
    '<bridge_daily_maintenance_result>{"improvements":[],"none_reason":"확인된 장애가 없고 회귀 테스트가 모두 통과했습니다."}</bridge_daily_maintenance_result>',
  );

  assert.equal(
    formatDailyMaintenanceResult(parsed),
    '적용한 개선 없음 — 확인된 장애가 없고 회귀 테스트가 모두 통과했습니다.',
  );
});

test('daily maintenance result suppresses claimed improvements without a verified new change', () => {
  assert.equal(
    formatDailyMaintenanceResult({
      improvements: ['전날 변경 내용을 다시 보고합니다.'],
    }, {
      changesVerified: false,
      unverifiedReason: '이번 유지보수 실행에서 새로 반영된 변경이 없습니다.',
    }),
    '적용한 개선 없음 — 이번 유지보수 실행에서 새로 반영된 변경이 없습니다.',
  );
});

test('daily maintenance result rejects prose and incomplete payloads', () => {
  assert.equal(parseDailyMaintenanceResultFromOutput('적용한 개선\n- 완료'), null);
  assert.equal(parseDailyMaintenanceResultFromOutput(
    '<bridge_daily_maintenance_result>{"improvements":[]}</bridge_daily_maintenance_result>',
  ), null);
  assert.equal(parseDailyMaintenanceResultFromOutput([
    '<bridge_daily_maintenance_result>{"improvements":["예시"]}</bridge_daily_maintenance_result>',
    '뒤쪽 텍스트',
  ].join('\n')), null);
});
