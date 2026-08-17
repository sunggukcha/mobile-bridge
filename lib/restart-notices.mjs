export function resolveRestartNoticeDestination({
  channelId = '',
} = {}, {
  discordGeneralChannelId = '',
} = {}) {
  // Restart notices are global operational messages. They must not follow the
  // platform or channel where the triggering work happened.
  return {
    platform: 'discord',
    channelId: String(discordGeneralChannelId || channelId),
  };
}

export function restartSourceLabel(source) {
  switch (source) {
    case 'manual':
      return '명시적 사용자 재시작 명령';
    case 'manual-understood':
      return '사용자 지시 이해 기반 재시작 요청';
    case 'runtime-source-change':
      return '브리지 런타임 소스 변경 적용';
    case 'daily-maintenance':
      return '새벽 유지보수 완료 후 반영';
    default:
      return source ? `시스템 재시작 요청 (${source})` : '시스템 재시작 요청';
  }
}

// One-line restart title in the user-directed format, e.g.
// "【codex gpt-5.6-terra xhigh: 서비스 재시작】". Manual restarts have no worker context
// and fall back to the bare "【서비스 재시작】" title.
export function formatRestartNoticeTitle(status, { workerLabel = null, workerEffort = null } = {}) {
  const label = String(workerLabel || '').trim();
  const effort = String(workerEffort || '').trim();
  const workerName = label.replace(/:\s*/, ' ');
  const workerDisplay = workerName ? [workerName, effort].filter(Boolean).join(' ') : '';
  const displayStatus = status === '서비스 재시작 진행' ? '서비스 재시작' : status;
  return workerDisplay ? `【${workerDisplay}: ${displayStatus}】` : `【${displayStatus}】`;
}

export function formatRestartRequestNotice({
  reason,
  improvement,
  source = 'manual',
  deferred = false,
  blockers = [],
  workerLabel = null,
  workerEffort = null,
} = {}) {
  const displayReason = displayRestartReason(source, reason);
  const displayImprovement = displayRestartImprovement(source, improvement);
  const lines = [
    formatRestartNoticeTitle(deferred ? '서비스 재시작 대기' : '서비스 재시작 진행', { workerLabel, workerEffort }),
  ];
  // Only meaningful, non-default detail survives. Runtime changes carry the
  // model-authored behavior explanation instead of a generated changed-file list.
  if (displayReason && !isDefaultRestartReason(source, displayReason)) {
    lines.push(`사유: ${displayReason}`);
  }
  if (displayImprovement && !isDefaultRestartImprovement(displayImprovement)) {
    lines.push(`효과: ${displayImprovement}`);
  }

  if (deferred) {
    lines.push(`대기: 실행 중 작업 ${blockers.length}개 완료 후 재시작`);
  }

  return lines.join('\n');
}

function displayRestartReason(source, reason) {
  const text = cleanRestartText(reason);
  switch (source) {
    case 'runtime-source-change':
      return text;
    case 'daily-maintenance':
      return '새벽 유지보수 결과 반영';
    default:
      return text;
  }
}

function displayRestartImprovement(source, improvement) {
  const text = cleanRestartText(improvement);
  switch (source) {
    case 'daily-maintenance':
      return '최신 코드와 상태를 서비스에 적용';
    default:
      return text;
  }
}

function isDefaultRestartReason(source, reason) {
  return (
    (source === 'runtime-source-change' && /^런타임\s*소스\s*변경\s*반영(?:\s*[:：-].*)?$/iu.test(reason))
    || (source === 'daily-maintenance' && reason === '새벽 유지보수 결과 반영')
  );
}

function isDefaultRestartImprovement(improvement) {
  return [
    '최신 코드와 상태를 서비스에 적용',
    '변경된 소스를 반영',
    '서비스 재시작 및 중단 작업 복구',
    '요청에 따라 서비스 재시작',
    '위 변경 동작을 새 브리지 프로세스에 적용',
  ].includes(improvement);
}

function cleanRestartText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
