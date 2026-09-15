import { TextDecoder } from 'node:util';
import { mapMarkdownProse } from './markdown-code.mjs';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function formatOutboundMessage(content) {
  const cleaned = cleanOutboundText(content);
  return cleaned || '(empty)';
}

export function cleanOutboundText(content, { trim = true, collapseBlankLines = true } = {}) {
  const text = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
  return mapMarkdownProse(text, (prose) => {
    let cleaned = repairEncodingArtifacts(prose)
      .split('\n')
      .map((line) => cleanOutboundLine(line))
      .join('\n');
    if (collapseBlankLines) cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return trim ? cleaned.trim() : cleaned;
  });
}

function cleanOutboundLine(line) {
  let cleaned = String(line || '')
    .replace(/\[truncated\]/gi, '')
    .trimEnd();
  if (/^\s*<!--\s*-->\s*$/.test(cleaned)) return '';

  for (let index = 0; index < 4; index += 1) {
    const previous = cleaned;
    cleaned = cleaned
      .replace(/^\s*worker\s*update:?\s*/i, '')
      .replace(/^\s*workerupdate:?\s*/i, '')
      .replace(/^\s*\[(?:[A-Za-z0-9_.-]+\/)?(?:response_text|tool_output|reasoning|output)\]\s*/i, '')
      .replace(/^\s*(?:response_text|tool_output|reasoning|output):\s*/i, '');
    if (cleaned === previous) break;
  }

  return isRawTestProtocolLine(cleaned) ? '' : cleaned.trimEnd();
}

function repairEncodingArtifacts(text) {
  return removeRawSearchCitationMarkers(repairUtf8Mojibake(String(text || '')))
    .replace(/\u00A0/g, ' ')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/[ \t]+([,.;:!?\])}])/g, '$1')
    .replace(/([([{]) [ \t]+/g, '$1')
    .normalize('NFC');
}

function removeRawSearchCitationMarkers(text) {
  return String(text || '')
    .replace(/\uE200cite\uE202[^\uE201\n]{1,240}\uE201/g, '')
    .replace(/\uE200cite\uE202[^\s\uE201]{1,120}/g, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1');
}

const CP1252_BYTES = new Map([
  [0x20AC, 0x80],
  [0x201A, 0x82],
  [0x0192, 0x83],
  [0x201E, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02C6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8A],
  [0x2039, 0x8B],
  [0x0152, 0x8C],
  [0x017D, 0x8E],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201C, 0x93],
  [0x201D, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02DC, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9A],
  [0x203A, 0x9B],
  [0x0153, 0x9C],
  [0x017E, 0x9E],
  [0x0178, 0x9F],
]);

const MOJIBAKE_SEQUENCE_PATTERN = /(?:[\u00C2-\u00F4][\u0080-\u00BF\u00A0-\u00BF\u20AC\u201A-\u201E\u2020-\u2022\u02C6\u2030\u0160\u2039\u0152\u017D\u2018-\u201D\u2026\u2122\u0161\u203A\u0153\u017E\u0178]{1,5})+/g;

function repairUtf8Mojibake(text) {
  let repaired = String(text || '');
  for (let pass = 0; pass < 2; pass += 1) {
    const next = repaired.replace(MOJIBAKE_SEQUENCE_PATTERN, (segment) => decodeCp1252Utf8Segment(segment));
    if (next === repaired) break;
    repaired = next;
  }
  return repaired
    .replace(/([A-Za-z0-9])\uFFFD([A-Za-z0-9])/g, "$1'$2")
    .replace(/\uFFFD+/g, '')
    .replace(/[\u0080-\u009F]/g, '');
}

function decodeCp1252Utf8Segment(segment) {
  const bytes = [];
  for (const character of segment) {
    const byte = cp1252Byte(character);
    if (byte === null) return segment;
    bytes.push(byte);
  }

  try {
    const decoded = UTF8_DECODER.decode(Uint8Array.from(bytes));
    if (!decoded || decoded === segment || decoded.includes('\uFFFD')) return segment;
    return suspectEncodingScore(decoded) < suspectEncodingScore(segment) ? decoded : segment;
  } catch {
    return segment;
  }
}

function cp1252Byte(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0xFF) return codePoint;
  return CP1252_BYTES.get(codePoint) ?? null;
}

function suspectEncodingScore(text) {
  const value = String(text || '');
  let score = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0xFFFD) score += 4;
    else if (codePoint >= 0xE000 && codePoint <= 0xF8FF) score += 3;
    else if (codePoint >= 0x80 && codePoint <= 0x9F) score += 3;
    else if (CP1252_BYTES.has(codePoint)) score += 2;
    else if (codePoint >= 0x00C2 && codePoint <= 0x00F4) score += 2;
    else if (codePoint >= 0x00A0 && codePoint <= 0x00BF) score += 1;
  }
  return score;
}

function isRawTestProtocolLine(line) {
  const trimmed = String(line || '').trim();
  return /^#?\s*Subtest:\s+/.test(trimmed)
    || /^TAP version \d+/i.test(trimmed)
    || /^(?:ok|not ok)\s+\d+\s+-\s+/.test(trimmed)
    || /^1\.\.\d+$/.test(trimmed)
    || /^---$/.test(trimmed)
    || /^\.\.\.$/.test(trimmed)
    || /^duration_ms:\s*\d/i.test(trimmed)
    || /^type:\s*'test'$/i.test(trimmed)
    || /^#\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(trimmed);
}
