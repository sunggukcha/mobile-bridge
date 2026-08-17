export const MAINTENANCE_ISSUE_RESULT_MARKER_OPEN = '<bridge_maintenance_issue_result>';
export const MAINTENANCE_ISSUE_RESULT_MARKER_CLOSE = '</bridge_maintenance_issue_result>';

const RESULT_BLOCK_PATTERN = /<bridge_maintenance_issue_result>\s*([\s\S]*?)\s*<\/bridge_maintenance_issue_result>\s*$/i;
const COMPLETION_MARKER_PATTERN = /\s*【(?:응답완료(?::\s*[^【】\n]*)?|\([^【】\n]*\)\s*응답완료|작업시간:\s*[^【】\n]*\s+응답완료)】\s*$/u;

export function parseMaintenanceIssueResultFromOutput(output, {
  maxSummaryChars = 2_000,
  maxReasonChars = 2_000,
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
  if (typeof payload.resolved !== 'boolean') return null;

  const summary = normalizeText(payload.summary ?? payload.result, maxSummaryChars);
  const reason = normalizeText(payload.reason ?? payload.blocker, maxReasonChars);
  const head = normalizeCommitHead(payload.head ?? payload.commitHead ?? payload.commit);
  if (payload.resolved && !summary) return null;
  if (!payload.resolved && !reason) return null;

  return {
    resolved: payload.resolved,
    summary,
    reason,
    head,
    rawPayload: String(match[1] || '').trim(),
    visibleText: stripCompletionMarker(text.replace(match[0], '')).trim(),
  };
}

function normalizeText(value, maxChars) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
  if (!text) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

function stripCompletionMarker(value) {
  let text = String(value || '').trim();
  while (COMPLETION_MARKER_PATTERN.test(text)) {
    text = text.replace(COMPLETION_MARKER_PATTERN, '').trimEnd();
  }
  return text.trim();
}

function normalizeCommitHead(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(text) ? text : '';
}
