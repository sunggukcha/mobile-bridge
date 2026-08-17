export const DAILY_MAINTENANCE_RESULT_MARKER_OPEN = '<bridge_daily_maintenance_result>';
export const DAILY_MAINTENANCE_RESULT_MARKER_CLOSE = '</bridge_daily_maintenance_result>';

const RESULT_BLOCK_PATTERN = /<bridge_daily_maintenance_result>\s*([\s\S]*?)\s*<\/bridge_daily_maintenance_result>\s*$/i;
const COMPLETION_MARKER_PATTERN = /\s*【(?:응답완료(?::\s*[^【】\n]*)?|\([^【】\n]*\)\s*응답완료|작업시간:\s*[^【】\n]*\s+응답완료)】\s*$/u;

export function parseDailyMaintenanceResultFromOutput(output, {
  maxImprovements = 20,
  maxItemChars = 500,
  maxReasonChars = 1_000,
} = {}) {
  const text = stripCompletionMarker(String(output || '').trim());
  if (!text) return null;
  const match = text.match(RESULT_BLOCK_PATTERN);
  if (!match) return null;

  let payload;
  try {
    payload = JSON.parse(String(match[1] || '').trim());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.improvements)) return null;

  const limit = Math.max(1, Number.parseInt(maxImprovements, 10) || 20);
  const improvements = payload.improvements
    .map((item) => normalizeLine(item, maxItemChars))
    .filter(Boolean)
    .slice(0, limit);
  const noneReason = normalizeLine(payload.none_reason ?? payload.noneReason, maxReasonChars);
  if (improvements.length === 0 && !noneReason) return null;

  return {
    improvements,
    noneReason: improvements.length > 0 ? '' : noneReason,
    rawPayload: String(match[1] || '').trim(),
  };
}

export function formatDailyMaintenanceResult(result, {
  changesVerified = true,
  unverifiedReason = '',
} = {}) {
  const improvements = Array.isArray(result?.improvements)
    ? result.improvements.map((item) => normalizeLine(item, 500)).filter(Boolean)
    : [];
  if (improvements.length > 0) {
    if (!changesVerified) {
      const reason = normalizeLine(unverifiedReason, 1_000)
        || '이번 유지보수 실행에서 새로 반영된 변경을 검증하지 못했습니다.';
      return `적용한 개선 없음 — ${reason}`;
    }
    return [
      '적용한 개선',
      ...improvements.map((item) => `- ${item}`),
    ].join('\n');
  }

  const reason = normalizeLine(result?.noneReason, 1_000)
    || '실행 결과를 검증 가능한 형식으로 받지 못했습니다.';
  return `적용한 개선 없음 — ${reason}`;
}

function normalizeLine(value, maxChars) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stripCompletionMarker(value) {
  let text = String(value || '').trim();
  while (COMPLETION_MARKER_PATTERN.test(text)) {
    text = text.replace(COMPLETION_MARKER_PATTERN, '').trimEnd();
  }
  return text.trim();
}
