export const RESERVED_COMMANDS_FILE = 'reserved-commands/reservations.jsonl';
export const MAX_RESERVE_TIMER_DELAY_MS = 2_147_483_647;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function parseReserveCommand(content) {
  const split = shellSplit(content);
  if (!split.ok) {
    return { action: 'invalid', errors: split.errors };
  }

  const [command, ...tokens] = split.tokens;
  if (!/^\/(?:reserve|예약)$/i.test(command || '')) return null;
  if (tokens.length === 0) return { action: 'help' };

  const first = String(tokens[0] || '').toLowerCase();
  if (['list', 'ls', '목록'].includes(first)) return { action: 'list' };
  if (['cancel', 'stop', '취소'].includes(first)) {
    return { action: 'cancel', id: tokens[1] || '' };
  }

  const result = {
    action: 'schedule',
    timeText: '',
    modelNumbers: [],
    order: '',
    verboseProgress: false,
    errors: [],
  };
  const modelParts = [];
  const orderParts = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      orderParts.push(...tokens.slice(index + 1));
      break;
    }

    const option = parseLongOption(token);
    if (!option) {
      orderParts.push(token);
      continue;
    }

    if (option.key === 'time' || option.key === 'at' || option.key === 'when') {
      const value = option.value ?? tokens[++index];
      if (!value || isLongOption(value)) result.errors.push('--time requires YYMMDDHHmm or YYYYMMDDHHmm');
      else result.timeText = value;
      continue;
    }

    if (option.key === 'model') {
      if (option.value != null) {
        modelParts.push(option.value);
        continue;
      }
      while (index + 1 < tokens.length && !isLongOption(tokens[index + 1]) && tokens[index + 1] !== '--') {
        modelParts.push(tokens[++index]);
      }
      if (modelParts.length === 0) result.errors.push('--model requires one or more /model numbers');
      continue;
    }

    if (option.key === 'verbose') {
      const parsed = parseBooleanOption(option.value, true);
      if (parsed === null) result.errors.push('--verbose must be true or false');
      else result.verboseProgress = parsed;
      continue;
    }

    if (option.key === 'no-verbose' || option.key === 'quiet') {
      result.verboseProgress = false;
      continue;
    }

    if (option.key === 'order' || option.key === 'message' || option.key === 'cmd') {
      if (option.value != null) orderParts.push(option.value);
      else orderParts.push(...tokens.slice(index + 1));
      break;
    }

    result.errors.push(`unknown option: --${option.key}`);
  }

  if (modelParts.length > 0) {
    const numbers = modelParts.join(' ').split(/[\s,]+/).filter(Boolean);
    if (numbers.length === 0 || numbers.some((number) => !/^\d+$/.test(number))) {
      result.errors.push('--model must contain only numeric /model choices');
    } else {
      result.modelNumbers = numbers;
    }
  }

  result.order = orderParts.join(' ').trim();
  if (!result.timeText) result.errors.push('--time is required');
  if (!result.order) result.errors.push('--order is required');
  return result;
}

export function parseReserveTime(value, { now = new Date() } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, error: 'time is required' };

  let parts = null;
  let match = raw.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (match) {
    parts = {
      year: 2000 + Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
    };
  }

  match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!parts && match) {
    parts = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
    };
  }

  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):?(\d{2})$/);
  if (!parts && match) {
    parts = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
    };
  }

  if (!parts) {
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp) && /(?:z|[+-]\d\d:?\d\d)$/i.test(raw)) {
      const scheduledAt = new Date(timestamp).toISOString();
      return validateFutureTime(scheduledAt, now);
    }
    return { ok: false, error: 'time must be YYMMDDHHmm or YYYYMMDDHHmm in KST' };
  }

  const scheduledAt = kstPartsToIso(parts);
  if (!scheduledAt) return { ok: false, error: 'time is not a valid KST date/time' };
  return validateFutureTime(scheduledAt, now);
}

export function formatReserveTimeLabel(iso) {
  const timestamp = Date.parse(iso || '');
  if (!Number.isFinite(timestamp)) return String(iso || '');
  const shifted = new Date(timestamp + KST_OFFSET_MS);
  return [
    shifted.getUTCFullYear(),
    '-',
    pad2(shifted.getUTCMonth() + 1),
    '-',
    pad2(shifted.getUTCDate()),
    ' ',
    pad2(shifted.getUTCHours()),
    ':',
    pad2(shifted.getUTCMinutes()),
    ' KST',
  ].join('');
}

export function activeReservationsFromEntries(entries = [], { now = new Date() } = {}) {
  const nowMs = now.getTime();
  return [...latestReservationsById(entries).values()]
    .filter((entry) => entry.status === 'active')
    .filter((entry) => Number.isFinite(Date.parse(entry.scheduledAt || '')))
    .filter((entry) => !entry.expiresAt || Date.parse(entry.expiresAt) >= nowMs)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
}

export function dueReservationsFromEntries(entries = [], { now = new Date() } = {}) {
  const nowMs = now.getTime();
  return activeReservationsFromEntries(entries, { now })
    .filter((entry) => Date.parse(entry.scheduledAt) <= nowMs);
}

export function latestReservationsById(entries = []) {
  const latest = new Map();
  for (const entry of entries) {
    if (!entry?.id) continue;
    latest.set(entry.id, { ...(latest.get(entry.id) || {}), ...entry });
  }
  return latest;
}

export function formatReserveCommandUsage() {
  return [
    '예약 사용법',
    '`/reserve --time 2607062130 --model 0 --order "continue"`',
    '- `--time`: KST 기준 `YYMMDDHHmm` 또는 `YYYYMMDDHHmm`',
    '- `--model`: `/model`과 같은 번호. `0`은 Fable 5, 여러 개면 그 순서대로 폴백',
    '- `--order`: 예약 시각에 실행할 지시문',
    '- `--verbose`: 명령 실행/툴 출력 진행 로그까지 예약 작업에 표시',
  ].join('\n');
}

function validateFutureTime(scheduledAt, now) {
  if (Date.parse(scheduledAt) <= now.getTime()) {
    return { ok: false, error: 'time must be in the future' };
  }
  return {
    ok: true,
    scheduledAt,
    label: formatReserveTimeLabel(scheduledAt),
  };
}

function kstPartsToIso({ year, month, day, hour, minute }) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS;
  const shifted = new Date(timestamp + KST_OFFSET_MS);
  if (
    shifted.getUTCFullYear() !== year ||
    shifted.getUTCMonth() + 1 !== month ||
    shifted.getUTCDate() !== day ||
    shifted.getUTCHours() !== hour ||
    shifted.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function shellSplit(value) {
  const text = String(value || '').trim();
  const tokens = [];
  const errors = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += '\\';
  if (quote) errors.push('unterminated quote');
  if (current) tokens.push(current);
  return { ok: errors.length === 0, tokens, errors };
}

function parseLongOption(token) {
  const match = String(token || '').match(/^--([A-Za-z][A-Za-z0-9_-]*)(?:=(.*))?$/);
  if (!match) return null;
  return {
    key: match[1].toLowerCase(),
    value: match[2] == null ? null : match[2],
  };
}

function isLongOption(token) {
  return /^--[A-Za-z][A-Za-z0-9_-]*(?:=.*)?$/.test(String(token || ''));
}

function parseBooleanOption(value, defaultValue) {
  if (value == null || value === '') return defaultValue;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  return null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
