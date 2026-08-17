export const PENDING_ASKS_FILE = 'jobs/pending-asks.jsonl';
export const ASK_MARKER_OPEN = '<bridge_wait_for_user>';
export const ASK_MARKER_CLOSE = '</bridge_wait_for_user>';

const ASK_BLOCK_PATTERN = /<bridge_wait_for_user>\s*([\s\S]*?)\s*<\/bridge_wait_for_user>\s*$/i;
const COMPLETION_MARKER_PATTERN = /\s*【(?:응답완료(?::\s*[^【】\n]*)?|\([^【】\n]*\)\s*응답완료|작업시간:\s*[^【】\n]*\s+응답완료)】\s*$/u;
const PLACEHOLDER_QUESTIONS = new Set(['...', '…', 'one concise question']);
const DEFAULT_MAX_QUESTION_CHARS = 4000;
const DEFAULT_MAX_ANSWER_CHARS = 4000;

export function parsePendingAskFromOutput(output, { maxQuestionChars = DEFAULT_MAX_QUESTION_CHARS } = {}) {
  const text = String(output || '').trim();
  if (!text) return null;
  const match = text.match(ASK_BLOCK_PATTERN);
  if (!match) return null;

  const rawPayload = String(match[1] || '').trim();
  if (!rawPayload) return null;
  const payload = parseAskPayload(rawPayload);
  if (!payload) return null;
  const question = normalizeAskText(
    payload.question ?? payload.prompt ?? payload.message ?? payload.text,
    maxQuestionChars,
  );
  if (!isValidAskQuestion(question)) return null;

  return {
    question,
    reason: normalizeAskText(payload.reason, 1000),
    answerFormat: normalizeAskText(payload.answer_format ?? payload.answerFormat, 1000),
    choices: normalizeChoices(payload.choices),
    rawPayload,
    visibleText: normalizeVisibleText(text.replace(match[0], '')),
  };
}

export function formatPendingAskMessage(ask = {}) {
  return ['# Question', String(ask.question || '').trim()].filter(Boolean).join('\n');
}

export function activePendingAskFromEntries(entries = [], { now = new Date() } = {}) {
  const latestById = new Map();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const current = latestById.get(entry.id) || {};
    latestById.set(entry.id, { ...current, ...entry });
  }

  return [...latestById.values()]
    .filter((entry) => String(entry.status || '') === 'waiting')
    .filter((entry) => !isPendingAskExpired(entry, now))
    .filter((entry) => isValidAskQuestion(entry.question))
    .sort((a, b) => entryTimeMs(b) - entryTimeMs(a))
    .at(0) || null;
}

export function expiredPendingAsksFromEntries(entries = [], { now = new Date() } = {}) {
  const latestById = new Map();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const current = latestById.get(entry.id) || {};
    latestById.set(entry.id, { ...current, ...entry });
  }
  return [...latestById.values()]
    .filter((entry) => String(entry.status || '') === 'waiting')
    .filter((entry) => isPendingAskExpired(entry, now));
}

export function isPendingAskExpired(ask = {}, now = new Date()) {
  const expiresAt = Date.parse(ask.expiresAt || '');
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= now.getTime();
}

export function parsePendingAskCommand(content) {
  const text = String(content || '').trim();
  const match = text.match(/^\/(?:ask|질문)\s+(cancel|stop|취소|중지)$/i);
  if (!match) return null;
  return { action: 'cancel' };
}

export function compactPendingAskAnswer(answer, { maxAnswerChars = DEFAULT_MAX_ANSWER_CHARS } = {}) {
  if (!answer || typeof answer !== 'object') return null;
  const compact = {
    askId: answer.askId || answer.id || null,
    askedJobId: answer.askedJobId || answer.jobId || null,
    askedAt: answer.askedAt || answer.createdAt || null,
    answeredAt: answer.answeredAt || null,
    answerMessageId: answer.answerMessageId || null,
    worker: answer.worker || null,
    question: normalizeAskText(answer.question, DEFAULT_MAX_QUESTION_CHARS),
    reason: normalizeAskText(answer.reason, 1000),
    answer: normalizeAskText(answer.answer, maxAnswerChars),
  };
  if (!compact.askId && !compact.question && !compact.answer) return null;
  return compact;
}

export function pendingAskContinuationMarkdown(answer = {}) {
  const compact = compactPendingAskAnswer(answer);
  if (!compact?.askId) return '';
  return [
    'Pending ask answer:',
    `- askId: ${compact.askId}`,
    compact.askedJobId ? `- askedByJobId: ${compact.askedJobId}` : null,
    compact.worker ? `- askedByWorker: ${compact.worker}` : null,
    compact.askedAt ? `- askedAt: ${compact.askedAt}` : null,
    compact.answerMessageId ? `- answerMessageId: ${compact.answerMessageId}` : null,
    '',
    'Question:',
    compact.question || '(missing)',
    '',
    'User answer:',
    compact.answer || '(empty)',
    '',
    'Continue the original task using this answer. Do not treat the answer as a new unrelated request unless the user explicitly says to change tasks.',
  ].filter((line) => line !== null).join('\n');
}

function parseAskPayload(rawPayload) {
  try {
    const parsed = JSON.parse(rawPayload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // The bridge prompt asks workers to emit a JSON block. Plain text is ignored
    // to avoid treating inline examples as real pending questions.
  }
  return null;
}

function normalizeAskText(value, maxChars) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 20).trimEnd()}\n[truncated]`;
}

function normalizeVisibleText(value) {
  let text = String(value || '').trim();
  while (COMPLETION_MARKER_PATTERN.test(text)) {
    text = text.replace(COMPLETION_MARKER_PATTERN, '').trimEnd();
  }
  return text.trim();
}

function isValidAskQuestion(question) {
  const text = String(question || '').trim();
  if (!text) return false;
  return !PLACEHOLDER_QUESTIONS.has(text.toLowerCase());
}

function normalizeChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices
    .map((choice) => {
      if (typeof choice === 'string') return { label: normalizeAskText(choice, 200), description: '' };
      return {
        label: normalizeAskText(choice?.label ?? choice?.value, 200),
        description: normalizeAskText(choice?.description, 500),
        value: normalizeAskText(choice?.value, 200),
      };
    })
    .filter((choice) => choice.label || choice.value)
    .slice(0, 10);
}

function entryTimeMs(entry = {}) {
  for (const key of ['createdAt', 'updatedAt', 'answeredAt', 'cancelledAt', 'expiredAt']) {
    const value = Date.parse(entry?.[key] || '');
    if (Number.isFinite(value)) return value;
  }
  return 0;
}
