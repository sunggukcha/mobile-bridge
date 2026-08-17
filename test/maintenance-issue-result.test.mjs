import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMaintenanceIssueResultFromOutput } from '../lib/maintenance-issue-result.mjs';

test('parseMaintenanceIssueResultFromOutput extracts a resolved result and visible text', () => {
  assert.deepEqual(parseMaintenanceIssueResultFromOutput([
    '회귀 테스트까지 통과했습니다.',
    '<bridge_maintenance_issue_result>{"resolved":true,"summary":"재시작 중 작업 유실 방지"}</bridge_maintenance_issue_result>',
  ].join('\n')), {
    resolved: true,
    summary: '재시작 중 작업 유실 방지',
    reason: '',
    head: '',
    rawPayload: '{"resolved":true,"summary":"재시작 중 작업 유실 방지"}',
    visibleText: '회귀 테스트까지 통과했습니다.',
  });
});

test('parseMaintenanceIssueResultFromOutput accepts a concrete unresolved reason', () => {
  const result = parseMaintenanceIssueResultFromOutput(
    '<bridge_maintenance_issue_result>{"resolved":false,"reason":"재현 환경 없음"}</bridge_maintenance_issue_result>',
  );
  assert.equal(result.resolved, false);
  assert.equal(result.reason, '재현 환경 없음');
});

test('parseMaintenanceIssueResultFromOutput accepts an existing verified fix head', () => {
  const result = parseMaintenanceIssueResultFromOutput(
    '<bridge_maintenance_issue_result>{"resolved":true,"summary":"기존 수정 검증","head":"ABCDEF1234567"}</bridge_maintenance_issue_result>',
  );
  assert.equal(result.head, 'abcdef1234567');
});

test('parseMaintenanceIssueResultFromOutput rejects missing, invalid, and non-final blocks', () => {
  assert.equal(parseMaintenanceIssueResultFromOutput('완료'), null);
  assert.equal(parseMaintenanceIssueResultFromOutput(
    '<bridge_maintenance_issue_result>{"resolved":true}</bridge_maintenance_issue_result>',
  ), null);
  assert.equal(parseMaintenanceIssueResultFromOutput([
    '<bridge_maintenance_issue_result>{"resolved":false,"reason":"예시"}</bridge_maintenance_issue_result>',
    '실제 결과 아님',
  ].join('\n')), null);
});
