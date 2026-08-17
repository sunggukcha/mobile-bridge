export const RESTART_EXIT_CODE = 75;

// Kept in sync with restart-notices.formatRestartNoticeTitle so the supervisor's
// planned-restart notice matches the service-side one-line title, including the
// worker + effort persisted in pending-restart.json.
function formatRestartNoticeTitle(status, { workerLabel = null, workerEffort = null } = {}) {
  const label = String(workerLabel || '').trim();
  const effort = String(workerEffort || '').trim();
  const workerName = label.replace(/:\s*/, ' ');
  const workerDisplay = workerName ? [workerName, effort].filter(Boolean).join(' ') : '';
  const displayStatus = status === '서비스 재시작 진행' ? '서비스 재시작' : status;
  return workerDisplay ? `【${workerDisplay}: ${displayStatus}】` : `【${displayStatus}】`;
}

export function formatServiceExitNotice(result, { consecutiveFailures = 0, pendingRestart = null } = {}) {
  const planned = result.code === RESTART_EXIT_CODE;
  if (planned) {
    return formatRestartNoticeTitle('서비스 재시작 진행', {
      workerLabel: pendingRestart?.workerLabel || null,
      workerEffort: pendingRestart?.workerEffort || null,
    });
  }

  const exitText = `code=${result.code ?? 'none'}, signal=${result.signal ?? 'none'}`;
  const lines = [
    '서버 다운 감지',
    `사유: 비정상 종료 (${exitText}, 연속 실패 ${consecutiveFailures}회)`,
  ];
  lines.push('재시작: 자동 시도');
  return lines.join('\n');
}

export function formatSupervisorStopNotice(signal) {
  return [
    '서버 다운 예정',
    `사유: supervisor가 ${signal} 신호를 받아 종료 절차에 들어감`,
    '개선: 종료 사유를 일반 채널에 기록하고 현재 child service를 같은 신호로 정리',
    '재시작: 호스트/관리자 재기동 필요',
  ].join('\n');
}
