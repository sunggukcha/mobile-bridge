// Workers emit CommonMark/GFM, but neither chat platform reads it that way.
// Slack has its own `mrkdwn` dialect (`*bold*`, `_italic_`, `<url|label>`) and
// renders anything else literally, and neither Slack nor Discord renders pipe
// tables at all. Convert at the platform API boundary so queued outbox content
// stays platform neutral and a single job can fan out to both destinations.

const MAX_TABLE_CELL_WIDTH = 60;
const HORIZONTAL_RULE = '─'.repeat(10);

// Sentinels keep freshly emitted markup out of later passes: a `**bold**` that
// became `*bold*` must not be re-read as Markdown italic. Input control
// characters are stripped first so these can never collide with real content.
const BOLD = String.fromCharCode(1);
const ITALIC = String.fromCharCode(2);
const STRIKE = String.fromCharCode(3);
const PLACEHOLDER = String.fromCharCode(4);

const FENCE_PATTERN = /^[ \t]*(```+|~~~+)(.*)$/;
const TABLE_DIVIDER_PATTERN = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// Slack control sequences (`<@U1>`, `<#C1|name>`, `<!here>`, `<https://x|y>`)
// are already platform markup and must survive entity escaping untouched.
const SLACK_CONTROL_PATTERN = /<(?:[@#!][A-Za-z0-9_.,^&/|-]+|(?:https?|mailto):[^\s<>]+)(?:\|[^<>]*)?>/g;

export function toSlackMrkdwn(content) {
  const text = renderMarkdownTables(content);
  if (!text) return text;
  const converted = mapMarkdownLines(text, {
    onCodeLine: escapeSlackEntities,
    onPlainLine: slackPlainLine,
  });
  return converted
    .replaceAll(BOLD, '*')
    .replaceAll(ITALIC, '_')
    .replaceAll(STRIKE, '~');
}

// Turns GFM pipe tables into width-aligned plain text inside a fenced code
// block, the only construct both platforms render in a monospace font and so
// the only way column alignment survives the trip.
export function renderMarkdownTables(content) {
  const text = normalizeMarkdownText(content);
  if (!text.includes('|')) return text;

  const lines = text.split('\n');
  const output = [];
  let openFence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (openFence) {
      output.push(line);
      if (closesFence(line, openFence)) openFence = null;
      continue;
    }
    const fence = line.match(FENCE_PATTERN);
    if (fence) {
      openFence = fence[1];
      output.push(line);
      continue;
    }

    const table = matchMarkdownTable(lines, index);
    if (!table) {
      output.push(line);
      continue;
    }
    output.push(...formatTableBlock(table));
    index = table.endIndex;
  }

  return output.join('\n');
}

export function normalizeMarkdownText(content) {
  return String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('')
    .filter((character) => !isControlCharacter(character))
    .join('');
}

// East Asian wide and fullwidth characters occupy two monospace columns, so a
// length-based pad misaligns every table that contains Korean text.
export function displayWidth(content) {
  let width = 0;
  for (const character of String(content ?? '')) {
    const codePoint = character.codePointAt(0);
    if (isZeroWidth(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

export function escapeSlackEntities(text) {
  return String(text ?? '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mapMarkdownLines(text, { onCodeLine, onPlainLine }) {
  const output = [];
  let openFence = null;

  for (const line of text.split('\n')) {
    if (openFence) {
      if (closesFence(line, openFence)) {
        openFence = null;
        output.push(line);
        continue;
      }
      output.push(onCodeLine(line));
      continue;
    }
    const fence = line.match(FENCE_PATTERN);
    if (fence) {
      openFence = fence[1];
      output.push(line);
      continue;
    }
    output.push(onPlainLine(line));
  }

  return output.join('\n');
}

function closesFence(line, openFence) {
  const fence = String(line).match(FENCE_PATTERN);
  if (!fence) return false;
  return fence[1][0] === openFence[0]
    && fence[1].length >= openFence.length
    && !fence[2].trim();
}

function slackPlainLine(line) {
  if (/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return HORIZONTAL_RULE;

  // `>` is a real mrkdwn quote marker, so it is re-emitted raw instead of being
  // escaped into `&gt;`.
  const quoted = line.match(/^([ \t]*(?:>[ \t]?)+)(.*)$/);
  const quotePrefix = quoted ? quoted[1].replace(/\t/g, ' ') : '';
  const body = quoted ? quoted[2] : line;

  const heading = body.match(/^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/);
  if (heading) {
    const title = slackInline(heading[2]).replaceAll(BOLD, '');
    return title ? `${quotePrefix}${BOLD}${title}${BOLD}` : quotePrefix.trimEnd();
  }

  const bullet = body.match(/^([ \t]*)[-*+][ \t]+(.*)$/);
  if (bullet) {
    const indent = bullet[1].replace(/\t/g, '  ');
    const checkbox = bullet[2].match(/^\[([ xX])\][ \t]+(.*)$/);
    const marker = checkbox ? `• ${checkbox[1] === ' ' ? '☐' : '☑'}` : '•';
    return `${quotePrefix}${indent}${marker} ${slackInline(checkbox ? checkbox[2] : bullet[2])}`;
  }

  return `${quotePrefix}${slackInline(body)}`;
}

function slackInline(text) {
  return splitInlineCode(text)
    .map((part) => (part.code ? slackCodeSpan(part) : slackInlineMarkup(part.text)))
    .join('');
}

function slackCodeSpan({ delimiter, inner }) {
  // Slack only understands single-backtick spans; collapse ``x`` when the inner
  // text allows it without breaking the span.
  const fence = inner.includes('`') ? delimiter : '`';
  return `${fence}${escapeSlackEntities(inner)}${fence}`;
}

function splitInlineCode(text) {
  const parts = [];
  const pattern = /(`+)([^\n]*?)\1/g;
  let cursor = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > cursor) {
      parts.push({ code: false, text: text.slice(cursor, match.index) });
    }
    parts.push({ code: true, delimiter: match[1], inner: match[2] });
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) parts.push({ code: false, text: text.slice(cursor) });
  return parts;
}

function slackInlineMarkup(text) {
  const preserved = [];
  let value = String(text).replace(SLACK_CONTROL_PATTERN, (matched) => {
    preserved.push(matched);
    return `${PLACEHOLDER}${preserved.length - 1}${PLACEHOLDER}`;
  });

  value = escapeSlackEntities(value);
  value = value.replace(
    /!?\[([^\]]*)\]\([ \t]*<?([^\s)]+)>?(?:[ \t]+"[^"]*")?[ \t]*\)/g,
    (matched, label, url) => {
      const target = url.trim();
      if (!target) return label;
      const caption = label.trim();
      return caption && caption !== target ? `<${target}|${caption}>` : `<${target}>`;
    },
  );

  value = value
    .replace(/(?<![\w*])\*\*\*(?=\S)([^*]*?\S|\S)\*\*\*(?!\w)/g, `${BOLD}${ITALIC}$1${ITALIC}${BOLD}`)
    .replace(/(?<![\w_])___(?=\S)([^_]*?\S|\S)___(?!\w)/g, `${BOLD}${ITALIC}$1${ITALIC}${BOLD}`)
    .replace(/(?<![\w*])\*\*(?=\S)([^*]*?\S|\S)\*\*(?!\w)/g, `${BOLD}$1${BOLD}`)
    .replace(/(?<![\w_])__(?=\S)([^_]*?\S|\S)__(?!\w)/g, `${BOLD}$1${BOLD}`)
    .replace(/(?<![\w*])\*(?=\S)([^*]*?\S|\S)\*(?!\w)/g, `${ITALIC}$1${ITALIC}`)
    .replace(/(?<![\w_])_(?=\S)([^_]*?\S|\S)_(?!\w)/g, `${ITALIC}$1${ITALIC}`)
    .replace(/~~(?=\S)([^~]*?\S|\S)~~/g, `${STRIKE}$1${STRIKE}`);

  return value.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'),
    (matched, index) => preserved[Number(index)] ?? matched,
  );
}

function matchMarkdownTable(lines, start) {
  const headerLine = lines[start];
  const dividerLine = lines[start + 1];
  if (!isTableRow(headerLine) || dividerLine === undefined) return null;
  if (!isTableRow(dividerLine) || !TABLE_DIVIDER_PATTERN.test(dividerLine)) return null;

  const header = splitTableRow(headerLine);
  const alignments = splitTableRow(dividerLine).map(tableAlignment);
  if (header.length === 0 || alignments.length !== header.length) return null;

  const rows = [];
  let endIndex = start + 1;
  for (let index = start + 2; index < lines.length; index += 1) {
    if (!isTableRow(lines[index]) || FENCE_PATTERN.test(lines[index])) break;
    rows.push(splitTableRow(lines[index]));
    endIndex = index;
  }

  return { header, alignments, rows, endIndex };
}

function isTableRow(line) {
  return String(line ?? '').includes('|');
}

function splitTableRow(line) {
  const body = String(line).trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');

  const cells = [];
  let current = '';
  let inCode = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\' && body[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (character === '`') inCode = !inCode;
    if (character === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignment(cell) {
  const value = String(cell).trim();
  if (value.startsWith(':') && value.endsWith(':')) return 'center';
  if (value.endsWith(':')) return 'right';
  return 'left';
}

function formatTableBlock({ header, alignments, rows }) {
  const columns = header.length;
  const grid = [header, ...rows].map((row) => {
    const cells = [];
    for (let index = 0; index < columns; index += 1) {
      cells.push(wrapTableCell(plainTableCell(row[index] ?? ''), MAX_TABLE_CELL_WIDTH));
    }
    return cells;
  });

  const widths = [];
  for (let column = 0; column < columns; column += 1) {
    widths.push(grid.reduce(
      (widest, row) => row[column].reduce(
        (cellWidest, line) => Math.max(cellWidest, displayWidth(line)),
        widest,
      ),
      1,
    ));
  }

  const [headerCells, ...bodyRows] = grid;
  const block = [
    '```',
    ...formatTableRow(headerCells, widths, alignments),
    widths.map((width) => '-'.repeat(width)).join('-+-'),
  ];
  for (const row of bodyRows) block.push(...formatTableRow(row, widths, alignments));
  block.push('```');
  return block;
}

function formatTableRow(cells, widths, alignments) {
  const lineCount = cells.reduce((longest, cell) => Math.max(longest, cell.length), 1);
  return Array.from({ length: lineCount }, (_, lineIndex) => joinTableRow(
    cells.map((cell) => cell[lineIndex] ?? ''),
    widths,
    alignments,
  ));
}

function joinTableRow(cells, widths, alignments) {
  return cells
    .map((cell, index) => padDisplay(cell, widths[index], alignments[index] || 'left'))
    .join(' | ')
    .trimEnd();
}

function padDisplay(text, width, alignment) {
  const padding = Math.max(width - displayWidth(text), 0);
  if (alignment === 'right') return `${' '.repeat(padding)}${text}`;
  if (alignment === 'center') {
    const left = Math.floor(padding / 2);
    return `${' '.repeat(left)}${text}${' '.repeat(padding - left)}`;
  }
  return `${text}${' '.repeat(padding)}`;
}

// Emphasis markers inside a monospace table are pure noise, since neither
// platform styles text inside a code block.
function plainTableCell(cell) {
  return String(cell ?? '')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*\*|\*\*|___|__|~~|`)/g, '')
    .trim();
}

function wrapTableCell(text, maxWidth) {
  const lines = [];
  let line = '';
  let used = 0;
  for (const character of String(text)) {
    const size = displayWidth(character);
    if (line && used + size > maxWidth) {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += character;
    used += size;
  }
  lines.push(line);
  return lines;
}

function isControlCharacter(character) {
  if (character === '\n' || character === '\t') return false;
  const codePoint = character.codePointAt(0);
  return codePoint < 0x20 || codePoint === 0x7F;
}

function isZeroWidth(codePoint) {
  return (codePoint >= 0x0300 && codePoint <= 0x036F)
    || (codePoint >= 0x200B && codePoint <= 0x200F)
    || (codePoint >= 0xFE00 && codePoint <= 0xFE0F)
    || codePoint === 0xFEFF;
}

function isWideCodePoint(codePoint) {
  return (codePoint >= 0x1100 && codePoint <= 0x115F)
    || (codePoint >= 0x2E80 && codePoint <= 0x303E)
    || (codePoint >= 0x3041 && codePoint <= 0x33FF)
    || (codePoint >= 0x3400 && codePoint <= 0x4DBF)
    || (codePoint >= 0x4E00 && codePoint <= 0x9FFF)
    || (codePoint >= 0xA000 && codePoint <= 0xA4CF)
    || (codePoint >= 0xA960 && codePoint <= 0xA97F)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0xFE10 && codePoint <= 0xFE19)
    || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
    || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
    || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
    || (codePoint >= 0x1F300 && codePoint <= 0x1F9FF)
    || (codePoint >= 0x20000 && codePoint <= 0x3FFFD);
}
