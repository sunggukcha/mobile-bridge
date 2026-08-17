export const SERVICE_RESTART_MARKER_OPEN = '<bridge_restart_service>';
export const SERVICE_RESTART_MARKER_CLOSE = '</bridge_restart_service>';

const SERVICE_RESTART_BLOCK_PATTERN = /<bridge_restart_service>\s*([\s\S]*?)\s*<\/bridge_restart_service>\s*$/i;
const COMPLETION_MARKER_PATTERN = /\s*【(?:응답완료(?::\s*[^【】\n]*)?|\([^【】\n]*\)\s*응답완료)】\s*$/u;
const DEFAULT_MAX_REASON_CHARS = 1000;
const DEFAULT_MAX_IMPROVEMENT_CHARS = 1000;
const DEFAULT_RUNTIME_REASON_CHARS = 500;
const RUNTIME_RESTART_IMPROVEMENT_FALLBACK = '위 변경 동작을 새 브리지 프로세스에 적용';
const GENERIC_RUNTIME_RESTART_REASONS = [
  /^런타임\s*소스\s*변경\s*반영(?:\s*[:：-].*)?$/iu,
  /^브리지\s*런타임\s*소스\s*변경(?:사항)?(?:을|를)?\s*반영(?:\s*[:：-].*)?$/iu,
  /^변경된\s+(?:bridge\/lib\s+)?소스(?:를|을)?\s*(?:현재\s+프로세스에\s+)?반영(?:\s*[:：-].*)?$/iu,
  /^(?:서비스\s*)?(?:재시작|재부팅)(?:이|가|을|를)?\s*(?:필요|진행|요청|수행|적용)(?:합니다|함|됨|됐습니다|되었습니다)?[.!]?$/iu,
  /^사용자(?:가|의)?\s*(?:서비스\s*)?(?:재시작|재부팅)(?:을|를)?\s*요청(?:했습니다|함)?[.!]?$/iu,
  /^(?:완료|수정|처리|적용)(?:했습니다|함|됨)[.!]?$/iu,
  /^runtime\s+(?:source|code)\s+changes?\s+(?:applied|loaded|reflected)(?:\s*[:：-].*)?[.!]?$/iu,
  /^(?:service\s+)?restart\s+(?:required|requested|needed|in progress)[.!]?$/iu,
];
const GENERIC_RUNTIME_RESTART_IMPROVEMENTS = new Set([
  '요청에 따라 서비스 재시작',
  '최신 코드와 상태를 서비스에 적용',
  '변경된 소스를 반영',
  '변경된 bridge/lib 소스를 현재 프로세스에 즉시 반영하고 같은 thread 작업을 continuation job으로 복구',
]);

export function parseServiceRestartRequestFromOutput(
  output,
  {
    maxReasonChars = DEFAULT_MAX_REASON_CHARS,
    maxImprovementChars = DEFAULT_MAX_IMPROVEMENT_CHARS,
  } = {},
) {
  const text = stripCompletionMarker(String(output || '').trim());
  if (!text) return null;
  const match = text.match(SERVICE_RESTART_BLOCK_PATTERN);
  if (!match) return null;

  const rawPayload = String(match[1] || '').trim();
  if (!rawPayload) return null;
  const payload = parseRestartPayload(rawPayload);
  if (!payload) return null;

  const reason = normalizeRestartText(
    payload.reason ?? payload.request ?? payload.message ?? payload.text,
    maxReasonChars,
  );
  if (!reason) return null;

  const improvement = normalizeRestartText(
    payload.improvement ?? payload.effect ?? payload.expected_result ?? payload.expectedResult,
    maxImprovementChars,
  ) || '요청에 따라 서비스 재시작';

  return {
    reason,
    improvement,
    rawPayload,
    visibleText: normalizeVisibleText(text.replace(match[0], '')),
  };
}

export function resolveRuntimeSourceRestartExplanation({
  request = null,
  output = '',
  changedPaths = [],
  maxReasonChars = DEFAULT_RUNTIME_REASON_CHARS,
} = {}) {
  const explicitReason = normalizeRestartText(request?.reason, maxReasonChars);
  const visibleText = normalizeVisibleText(request?.visibleText || stripServiceRestartBlock(output));
  const visibleReason = meaningfulVisibleReason(visibleText, maxReasonChars);
  const reason = isMeaningfulRuntimeRestartReason(explicitReason)
    ? explicitReason
    : visibleReason || missingRuntimeRestartReason(changedPaths, maxReasonChars);

  const explicitImprovement = normalizeRestartText(
    request?.improvement,
    DEFAULT_MAX_IMPROVEMENT_CHARS,
  );
  const improvement = isMeaningfulRuntimeRestartImprovement(explicitImprovement)
    ? explicitImprovement
    : RUNTIME_RESTART_IMPROVEMENT_FALLBACK;

  return {
    reason,
    improvement,
    usedFallback: !isMeaningfulRuntimeRestartReason(explicitReason),
    reasonSource: isMeaningfulRuntimeRestartReason(explicitReason)
      ? 'restart-marker'
      : visibleReason
        ? 'visible-model-output'
        : 'protocol-violation',
  };
}

export function isMeaningfulRuntimeRestartReason(value) {
  const text = normalizeRestartText(value, DEFAULT_MAX_REASON_CHARS);
  if (text.length < 8) return false;
  return !GENERIC_RUNTIME_RESTART_REASONS.some((pattern) => pattern.test(text))
    && !looksLikeChangedFileList(text);
}

function parseRestartPayload(rawPayload) {
  try {
    const payload = JSON.parse(rawPayload);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function normalizeRestartText(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeVisibleText(value) {
  return stripCompletionMarker(String(value || '').trim()).trim();
}

function stripServiceRestartBlock(value) {
  const text = stripCompletionMarker(String(value || '').trim());
  return text.replace(SERVICE_RESTART_BLOCK_PATTERN, '').trim();
}

function meaningfulVisibleReason(value, maxChars) {
  const lines = String(value || '').split(/\r?\n/);
  for (const line of lines) {
    const candidate = normalizeRestartText(
      line
        .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, '')
        .replace(/\*\*/g, ''),
      maxChars,
    );
    if (isMeaningfulRuntimeRestartReason(candidate)) return candidate;
  }
  return '';
}

function isMeaningfulRuntimeRestartImprovement(value) {
  const text = normalizeRestartText(value, DEFAULT_MAX_IMPROVEMENT_CHARS);
  return text.length >= 8 && !GENERIC_RUNTIME_RESTART_IMPROVEMENTS.has(text);
}

function looksLikeChangedFileList(value) {
  const text = String(value || '')
    .replace(/^(?:변경\s*파일|changed\s*files?)\s*[:：-]\s*/iu, '')
    .replace(/,\s*\+\d+\s+more$/iu, '');
  const items = text.split(/\s*,\s*/u).filter(Boolean);
  return items.length > 0 && items.every((item) =>
    /^(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:m?js|cjs|json|md|ya?ml|toml|sh)$/iu.test(item),
  );
}

function missingRuntimeRestartReason(changedPaths, maxChars) {
  const paths = (Array.isArray(changedPaths) ? changedPaths : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const pathDetail = paths.length > 0 ? ` (변경 파일: ${paths.join(', ')})` : '';
  return normalizeRestartText(
    `모델이 구체적인 변경 설명을 남기지 않음${pathDetail}`,
    maxChars,
  );
}

function stripCompletionMarker(value) {
  return String(value || '').replace(COMPLETION_MARKER_PATTERN, '').trim();
}
