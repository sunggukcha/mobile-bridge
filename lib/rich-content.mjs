import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import MathJaxModule from 'mathjax';
import {
  KOREAN_IMAGE_FONT_FAMILY,
  KOREAN_IMAGE_FONT_FILES,
  missingKoreanImageFontFiles,
} from './image-font.mjs';
import { displayWidth, renderMarkdownTables } from './message-markdown.mjs';
import {
  DEFAULT_RICH_STYLE_ID,
  RICH_STYLE_PRESETS,
  renderRichStyleContactSheetSvg,
  richStyleById,
} from './rich-style-themes.mjs';

const FENCE_PATTERN = /^[ \t]*(```+|~~~+)([^\r\n]*)$/;
const TABLE_DIVIDER_PATTERN = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const MATH_FENCE_LANGUAGES = new Set(['math', 'tex', 'latex', 'katex']);
const TEXT_DIAGRAM_FENCE_LANGUAGES = new Set(['text', 'txt', 'ascii', 'diagram']);
const MAX_ATTACHMENT_ALT_TEXT = 900;
const MAX_SVG_SOURCE_BYTES = 1_000_000;
const MAX_FORMULA_SOURCE_LENGTH = 8 * 1_024;
// Rasterization runs on Reception's event loop, so keep one image comfortably
// below the 10-second role lease even on a busy WSL host.
const MAX_RASTER_DIMENSION = 1_600;
const MAX_RASTER_PIXELS = 1_000_000;
// Resvg rounds fitted width and height independently. Reserve enough area for
// both dimensions to round up without crossing the hard post-render limit.
const MAX_RASTER_TARGET_PIXELS = MAX_RASTER_PIXELS - MAX_RASTER_DIMENSION * 2 - 1;
const MAX_RICH_IMAGES_PER_MESSAGE = 1;
const TABLE_FONT_SIZE = 26;
const TABLE_LINE_HEIGHT = 38;
const TABLE_CELL_PADDING = 22;
const MAX_TABLE_COLUMN_WIDTH = 520;
const MIN_TABLE_RASTER_SCALE = 0.8;
const MATHJAX_OPTIONS = {
  loader: {
    load: [
      'input/tex-base',
      '[tex]/ams',
      '[tex]/textmacros',
      'output/svg',
    ],
  },
  tex: {
    packages: { '[+]': ['ams', 'textmacros'] },
    maxBuffer: MAX_FORMULA_SOURCE_LENGTH,
    formatError(_jax, error) {
      throw error;
    },
  },
  svg: { fontCache: 'local' },
};
let mathJaxReady = null;
let mathJaxRenderQueue = Promise.resolve();
let richStylePreviewPng = null;

// Chat clients do not typeset GFM tables or TeX.  Split those constructs out
// before the platform formatter runs so each service can send a real image
// attachment while ordinary Markdown remains selectable text.
export async function splitRichContent(content, {
  styleId = DEFAULT_RICH_STYLE_ID,
  includeStylePreview = false,
} = {}) {
  const style = richStyleById(styleId);
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let plain = '';
  let renderedImages = 0;

  const appendText = (value) => {
    if (!value) return;
    plain += value;
  };
  const flushText = () => {
    if (!plain) return;
    appendPart(output, { type: 'text', content: plain });
    plain = '';
  };
  const appendImage = async (kind, source, table = null, fallback = source) => {
    if (renderedImages >= MAX_RICH_IMAGES_PER_MESSAGE) {
      appendText(fallback);
      return false;
    }
    let attachment;
    try {
      attachment = await richImageAttachment(kind, source, table, style);
    } catch (error) {
      if (kind !== 'formula' && kind !== 'table') throw error;
      appendText(fallback);
      return false;
    }
    flushText();
    appendPart(output, { type: 'image', attachment });
    renderedImages += 1;
    return true;
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const fence = line.match(FENCE_PATTERN);
    if (fence) {
      const end = closingFenceIndex(lines, index, fence[1]);
      if (end !== -1) {
        const body = lines.slice(index + 1, end).join('\n');
        const fencedSource = lines.slice(index, end + 1).join('\n');
        const language = fence[2].trim().split(/\s+/, 1)[0].toLowerCase();
        if (looksLikeSvgDocument(body)) {
          await appendImage('svg-diagram', body, null, fencedSource);
        } else if (TEXT_DIAGRAM_FENCE_LANGUAGES.has(language) && looksLikeTextDiagram(body)) {
          await appendImage('diagram', body, null, fencedSource);
        } else if (
          MATH_FENCE_LANGUAGES.has(language)
          || (!language && looksLikeMathBlock(body))
        ) {
          await appendImage('formula', body, null, fencedSource);
        } else {
          appendText(fencedSource);
        }
        index = end + 1;
        if (index < lines.length) appendText('\n');
        continue;
      }
    }

    const svgBlock = svgBlockAt(lines, index);
    if (svgBlock) {
      appendText(svgBlock.before);
      await appendImage(
        'svg-diagram',
        svgBlock.source,
        null,
        diagramAltText(svgBlock.source),
      );
      appendText(svgBlock.after);
      index = svgBlock.endIndex + 1;
      if (index < lines.length) appendText('\n');
      continue;
    }

    const table = markdownTableAt(lines, index);
    if (table) {
      // Resvg runs synchronously. Skip rasterizing unusually large tables
      // instead of blocking Reception while it builds a multi-megapixel image
      // on its health-critical event loop.  Neither Discord nor Slack renders
      // GFM pipe syntax, so the fallback has to be the width-aligned monospace
      // block, never the raw source (issue #25).
      const monospace = monospaceTable(table);
      if (
        renderedImages < MAX_RICH_IMAGES_PER_MESSAGE
        && tableFitsRasterBudget(table)
      ) {
        await appendImage('table', table.source, table, monospace);
      }
      else appendText(monospace);
      index = table.endIndex + 1;
      if (index < lines.length) appendText('\n');
      continue;
    }

    if (line.trim() === '$$') {
      const end = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.trim() === '$$');
      if (end !== -1) {
        await appendImage(
          'formula',
          lines.slice(index + 1, end).join('\n'),
          null,
          lines.slice(index, end + 1).join('\n'),
        );
        index = end + 1;
        if (index < lines.length) appendText('\n');
        continue;
      }
    }

    if (line.trim() === '\\[') {
      const end = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.trim() === '\\]');
      if (end !== -1) {
        await appendImage(
          'formula',
          lines.slice(index + 1, end).join('\n'),
          null,
          lines.slice(index, end + 1).join('\n'),
        );
        index = end + 1;
        if (index < lines.length) appendText('\n');
        continue;
      }
    }

    // Some bridges/clients drop the leading backslash from `\\[` and `\\]`.
    // Accept the bare form only when the enclosed lines are unmistakably TeX.
    if (line.trim() === '[') {
      const end = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.trim() === ']');
      if (end !== -1) {
        const body = lines.slice(index + 1, end).join('\n');
        if (looksLikeMathBlock(body)) {
          await appendImage(
            'formula',
            body,
            null,
            lines.slice(index, end + 1).join('\n'),
          );
          index = end + 1;
          if (index < lines.length) appendText('\n');
          continue;
        }
      }
    }

    // Workers occasionally emit a display formula without delimiters.  Keep
    // this intentionally strict so prose that merely mentions a command such
    // as `\\lambda` remains normal text.
    if (looksLikeBareFormulaLine(line)) {
      let end = index + 1;
      while (end < lines.length && looksLikeBareFormulaLine(lines[end])) end += 1;
      const source = lines.slice(index, end).join('\n');
      const unicode = end === index + 1 ? inlineMathUnicode(source) : null;
      if (unicode !== null) appendText(unicode);
      else await appendImage('formula', source, null, source);
      index = end;
      if (index < lines.length) appendText('\n');
      continue;
    }

    await appendInlineMath(appendText, appendImage, line);
    index += 1;
    if (index < lines.length) appendText('\n');
  }
  flushText();
  if (includeStylePreview) {
    appendPart(output, { type: 'image', attachment: renderRichStylePreviewAttachment() });
  }
  return output.filter((part) => part.type === 'image' || part.content.trim());
}

async function appendInlineMath(appendText, appendImage, line) {
  const pattern = /\\\(([^\n]*?)\\\)|\$\$([^\n]*?)\$\$|(?<!\$)\$([^\n$]+?)\$(?!\$)/g;
  let cursor = 0;
  let match = pattern.exec(line);
  while (match) {
    const source = match[1] ?? match[2] ?? match[3] ?? '';
    const afterClosingDollar = line.slice(match.index + match[0].length);
    if (match[3] !== undefined && !looksLikeDollarDelimitedMath(source, afterClosingDollar)) {
      // Re-scan after the first price marker so the second `$` can still open
      // a genuine formula, as in `price $10, exponent $2^{10}$`.
      pattern.lastIndex = match.index + 1;
      match = pattern.exec(line);
      continue;
    }
    if (!looksLikeMath(source)) {
      match = pattern.exec(line);
      continue;
    }
    // A lone `$\rightarrow$` is punctuation, not a formula. Rasterizing it
    // costs an attachment, breaks the sentence across two Discord messages and
    // consumes the single rich-image slot the real formula on the next line
    // may need, so inline the Unicode character instead (issue #24).
    const unicode = inlineMathUnicode(source);
    appendText(line.slice(cursor, match.index));
    if (unicode !== null) appendText(unicode);
    else await appendImage('formula', source, null, match[0]);
    cursor = match.index + match[0].length;
    match = pattern.exec(line);
  }
  appendText(line.slice(cursor));
}

// TeX macros that carry no layout of their own, so a plain Unicode character is
// a faithful — and selectable, copyable, searchable — rendering.
const UNICODE_MATH_MACROS = new Map(Object.entries({
  to: '→', rightarrow: '→', longrightarrow: '⟶', Rightarrow: '⇒', implies: '⇒',
  gets: '←', leftarrow: '←', longleftarrow: '⟵', Leftarrow: '⇐', impliedby: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⇔', mapsto: '↦',
  uparrow: '↑', downarrow: '↓', nearrow: '↗', searrow: '↘',
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡',
  approx: '≈', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', neg: '¬',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  land: '∧', lor: '∨', oplus: '⊕', otimes: '⊗', perp: '⊥', parallel: '∥',
  dots: '…', ldots: '…', cdots: '⋯', therefore: '∴', because: '∵',
  degree: '°', circ: '∘', prime: '′', angle: '∠', triangle: '△', square: '□',
  checkmark: '✓', dagger: '†', bullet: '•',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  quad: ' ', qquad: '  ', ',': ' ', ';': ' ', '!': '', ' ': ' ',
}));
// Anything that positions glyphs relative to each other (fractions, scripts,
// radicals, matrices, grouping) still needs a typeset image.
const STRUCTURAL_TEX_PATTERN = /[{}^_&\\]/;
const MAX_UNICODE_INLINE_MATH_LENGTH = 48;

// Returns the Unicode rendering of a trivial inline formula, or null when the
// source needs real typesetting.
export function inlineMathUnicode(source) {
  const compact = String(source ?? '').trim();
  if (!compact || compact.length > MAX_UNICODE_INLINE_MATH_LENGTH) return null;
  let rendered = '';
  let cursor = 0;
  while (cursor < compact.length) {
    if (compact[cursor] !== '\\') {
      rendered += compact[cursor];
      cursor += 1;
      continue;
    }
    const macro = /^\\(?:[A-Za-z]+|[,;! ])/.exec(compact.slice(cursor))?.[0];
    const replacement = macro && UNICODE_MATH_MACROS.get(macro.slice(1));
    if (replacement === undefined) return null;
    rendered += replacement;
    cursor += macro.length;
  }
  // The macro pass consumed every backslash it understood; a leftover
  // structural character means the remainder still has to be typeset.
  if (STRUCTURAL_TEX_PATTERN.test(rendered)) return null;
  return rendered.replace(/\s+/g, ' ').trim();
}

function appendPart(parts, part) {
  const previous = parts.at(-1);
  if (part.type === 'text' && previous?.type === 'text') {
    previous.content += part.content;
    return;
  }
  parts.push(part);
}

function closingFenceIndex(lines, start, opening) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const candidate = lines[index].match(FENCE_PATTERN);
    if (candidate && candidate[1][0] === opening[0] && candidate[1].length >= opening.length && !candidate[2].trim()) {
      return index;
    }
  }
  return -1;
}

function svgBlockAt(lines, start) {
  const firstLine = String(lines[start] || '');
  const opening = firstLine.search(/<svg\b/i);
  if (opening === -1) return null;

  const joined = [];
  for (let index = start; index < lines.length; index += 1) {
    joined.push(lines[index]);
    const candidate = joined.join('\n');
    const closing = candidate.search(/<\/svg\s*>/i);
    if (closing === -1) continue;
    const closingTag = candidate.slice(closing).match(/^<\/svg\s*>/i)?.[0] || '</svg>';
    return {
      before: candidate.slice(0, opening),
      source: candidate.slice(opening, closing + closingTag.length),
      after: candidate.slice(closing + closingTag.length),
      endIndex: index,
    };
  }
  return null;
}

function markdownTableAt(lines, start) {
  if (!isTableRow(lines[start]) || !TABLE_DIVIDER_PATTERN.test(lines[start + 1] || '')) return null;
  const header = splitTableRow(lines[start]);
  const alignments = splitTableRow(lines[start + 1]).map(tableAlignment);
  if (header.length === 0 || header.length !== alignments.length) return null;

  const rows = [];
  let endIndex = start + 1;
  for (let index = start + 2; index < lines.length && isTableRow(lines[index]); index += 1) {
    const row = splitTableRow(lines[index]);
    if (row.length !== header.length) break;
    rows.push(row);
    endIndex = index;
  }
  return {
    header: header.map(plainTableText),
    rows: rows.map((row) => row.map(plainTableText)),
    alignments,
    endIndex,
    source: lines.slice(start, endIndex + 1).join('\n'),
  };
}

function isTableRow(line) {
  return String(line || '').includes('|');
}

function splitTableRow(line) {
  const body = String(line || '').trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells = [];
  let current = '';
  let escaped = false;
  let ticks = 0;
  for (const character of body) {
    if (character === '`') ticks = ticks ? 0 : 1;
    if (character === '|' && !escaped && !ticks) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += character;
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignment(divider) {
  const value = String(divider || '').trim();
  return value.startsWith(':') && value.endsWith(':') ? 'center' : value.endsWith(':') ? 'right' : 'left';
}

function plainTableText(value) {
  return String(value || '')
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeMathBlock(value) {
  const compact = String(value || '').trim();
  if (/\\(?:[A-Za-z]+|[,;!])/.test(compact)) return true;
  return compact.split('\n').length > 1
    && !/\b(?:const|let|var|function|class|import|return)\b|=>|;/.test(compact)
    && (compact.match(/[=+*/^_≤≥≠≈∑∫√]/gu) || []).length >= 3;
}

// `$` is a currency sign as well as a TeX delimiter, so `$...$` is the only
// ambiguous inline form: two prices on one line otherwise capture the prose
// between them, which is then typeset and rasterized mid-sentence (issue #28).
// `\(...\)` and `$$...$$` are unambiguous and stay exempt from these checks.
const NATURAL_LANGUAGE_SPAN_PATTERN = /[ᄀ-ᇿ぀-ヿ㐀-䶿一-鿿가-힯]/u;
// Function names that read as words but are ordinary math notation.
const MATH_WORDS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'sinh', 'cosh', 'tanh',
  'arcsin', 'arccos', 'arctan', 'log', 'exp', 'lim', 'limsup', 'liminf',
  'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'lcm',
  'mod', 'arg', 'rank', 'var', 'cov', 'std', 'sum', 'prod', 'int', 'abs',
]);
const MAX_DOLLAR_MATH_LENGTH = 64;
const MAX_DOLLAR_MATH_PROSE_WORDS = 2;

function looksLikeDollarDelimitedMath(source, afterClosingDollar) {
  const compact = String(source ?? '').trim();
  // Both delimiters introduce a digit-led token, so they are two prices. A
  // blanket "no digit after the opening $" rule would also reject valid
  // formulas such as `$2^{10}$`, hence the check on the closing side too.
  if (/^[0-9]/.test(compact) && /^[0-9]/.test(afterClosingDollar)) return false;
  // Hangul, kana or Han inside the span means the "formula" is a sentence.
  if (NATURAL_LANGUAGE_SPAN_PATTERN.test(compact)) return false;
  // A TeX macro is decisive evidence of real math at any length.
  if (/\\[A-Za-z]/.test(compact)) return true;
  // Without a macro, an inline formula is short; a long run is prose.
  if (compact.length > MAX_DOLLAR_MATH_LENGTH) return false;
  // Sentence punctuation does not occur inside inline math.
  if (/[.!?]\s/.test(compact)) return false;
  // Several ordinary words are prose even when an operator sits between them,
  // as in `$10 + tax, tips extra $`; one or two are variable-ish enough to keep.
  const words = (compact.match(/[A-Za-z]{3,}/g) || [])
    .filter((word) => !MATH_WORDS.has(word.toLowerCase()));
  return words.length <= MAX_DOLLAR_MATH_PROSE_WORDS;
}

function looksLikeMath(value) {
  const compact = String(value || '').trim();
  if (!compact || compact.length > 12_000) return false;
  return /\\(?:[A-Za-z]+|[,;!])/.test(compact)
    || /(?:\b(?:sin|cos|log|exp|lim|max|min)\b|[=+*/^_≤≥≠≈∑∫√])/u.test(compact);
}

function looksLikeBareFormulaLine(value) {
  const compact = String(value || '').trim();
  if (!/\\[A-Za-z]+/.test(compact)) return false;
  if (!/^[A-Za-z0-9_{}\\^=+*/().,;:\-\[\] \t]+$/.test(compact)) return false;
  return compact.startsWith('\\') || /[=^_+*/]/.test(compact) || (compact.match(/\\[A-Za-z]+/g) || []).length >= 2;
}

function looksLikeSvgDocument(value) {
  const compact = String(value || '').trim();
  return /<svg\b/i.test(compact) && /<\/svg\s*>\s*$/i.test(compact);
}

function looksLikeTextDiagram(value) {
  const lines = String(value || '').split('\n').filter((line) => line.trim());
  if (lines.length < 3) return false;
  const diagramCharacters = (lines.join('\n').match(/[┌┐└┘├┤┬┴┼─│╭╮╰╯╱╲↕↔→←⇄⇒]/gu) || []).length;
  return diagramCharacters >= 3;
}

async function richImageAttachment(kind, source, table, style) {
  const text = String(source || '').trim();
  const layout = kind === 'table' ? tableLayout(table) : null;
  const svg = kind === 'table'
    ? renderTableSvg(table, style, layout)
    : kind === 'formula'
      ? await renderFormulaSvg(text, { styleId: style.id })
      : kind === 'diagram'
        ? renderTextDiagramSvg(text, style)
        : sanitizeSvg(text);
  const attachmentKind = kind === 'svg-diagram' ? 'diagram' : kind;
  const digest = createHash('sha256').update(`${style.id}\0${kind}\0${text}`).digest('hex').slice(0, 12);
  const display = kind === 'table'
    ? tableAltText(table)
    : kind === 'formula'
      ? formulaAltText(text)
      : diagramAltText(text);
  return {
    filename: `codex-${attachmentKind}-${digest}.png`,
    contentType: 'image/png',
    data: rasterizeSvg(svg, layout),
    description: display,
  };
}

function renderTableSvg(table, style, layout = tableLayout(table)) {
  const colors = style.colors;
  const {
    columnCount,
    columns,
    wrapped,
    rowHeights,
    width,
    height,
  } = layout;
  const parts = [svgOpen(width, height), `<rect width="100%" height="100%" rx="16" fill="${colors.background}"/>`];
  let y = 2;
  for (let rowIndex = 0; rowIndex < wrapped.length; rowIndex += 1) {
    const rowHeight = rowHeights[rowIndex];
    let x = 2;
    for (let column = 0; column < columnCount; column += 1) {
      const fill = rowIndex === 0 ? colors.accent : rowIndex % 2 ? colors.surface : colors.background;
      const textFill = rowIndex === 0 ? colors.headerText : colors.text;
      parts.push(`<rect x="${x}" y="${y}" width="${columns[column] - 1}" height="${rowHeight - 1}" fill="${fill}"/>`);
      const lines = wrapped[rowIndex][column];
      const available = columns[column] - TABLE_CELL_PADDING * 2;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const label = escapeXml(lines[lineIndex]);
        const textWidth = Math.min(available, displayWidth(lines[lineIndex]) * 15);
        const alignedX = table.alignments[column] === 'right'
          ? x + columns[column] - TABLE_CELL_PADDING - textWidth
          : table.alignments[column] === 'center'
            ? x + (columns[column] - textWidth) / 2
            : x + TABLE_CELL_PADDING;
        const fontWeight = rowIndex === 0 ? '700' : '400';
        parts.push(`<text x="${Math.max(x + TABLE_CELL_PADDING, alignedX)}" y="${y + TABLE_CELL_PADDING + TABLE_FONT_SIZE + lineIndex * TABLE_LINE_HEIGHT}" fill="${textFill}" font-family="${KOREAN_IMAGE_FONT_FAMILY}, Inter, Pretendard, Arial, sans-serif" font-size="${TABLE_FONT_SIZE}" font-weight="${fontWeight}">${label}</text>`);
      }
      x += columns[column];
    }
    y += rowHeight;
  }
  parts.push('</svg>');
  return parts.join('');
}

// The fallback for every table the rasterizer declines. `renderMarkdownTables`
// is the same converter the Slack path uses, and it leaves its own output alone
// on a second pass, so the Slack formatter downstream is a no-op here.
function monospaceTable(table) {
  const rendered = renderMarkdownTables(table.source);
  return rendered.trim() ? rendered : table.source;
}

function tableFitsRasterBudget(table) {
  const { width, height } = tableLayout(table);
  return width <= MAX_RASTER_DIMENSION
    && height <= MAX_RASTER_DIMENSION
    // The shared rasterizer downscales accepted SVGs to the pixel budget.
    // Admit modestly oversized tables when their text remains readable after
    // that scaling, while still rejecting genuinely large source layouts.
    && rasterOutputScale(width, height) >= MIN_TABLE_RASTER_SCALE;
}

function tableLayout(table) {
  const rows = [table.header, ...table.rows];
  const columnCount = table.header.length;
  const columns = Array.from({ length: columnCount }, (_, column) => {
    const widest = Math.max(...rows.map((row) => displayWidth(row[column] || '')));
    return Math.min(MAX_TABLE_COLUMN_WIDTH, Math.max(120, widest * 15 + TABLE_CELL_PADDING * 2));
  });
  const wrapped = rows.map((row) => row.map((cell, column) => wrapText(cell, Math.max(8, Math.floor((columns[column] - TABLE_CELL_PADDING * 2) / 15)))));
  const rowHeights = wrapped.map((row) => Math.max(1, ...row.map((cell) => cell.length)) * TABLE_LINE_HEIGHT + TABLE_CELL_PADDING * 2);
  const width = columns.reduce((sum, value) => sum + value, 0) + 4;
  const height = rowHeights.reduce((sum, value) => sum + value, 0) + 4;
  return {
    columnCount,
    columns,
    wrapped,
    rowHeights,
    width,
    height,
  };
}

export async function renderFormulaSvg(source, { styleId = DEFAULT_RICH_STYLE_ID } = {}) {
  const text = String(source || '').trim();
  const style = richStyleById(styleId);
  if (!text) throw new Error('Formula source is empty');
  if (text.length > MAX_FORMULA_SOURCE_LENGTH) {
    throw new Error(`Formula exceeds the ${MAX_FORMULA_SOURCE_LENGTH}-character rendering limit`);
  }

  const render = mathJaxRenderQueue.then(async () => {
    mathJaxReady ||= MathJaxModule.init(MATHJAX_OPTIONS);
    const mathJax = await mathJaxReady;
    mathJax.texReset();
    const container = await mathJax.tex2svgPromise(text, { display: true });
    const svgNode = mathJax.startup.adaptor.tags(container, 'svg')[0];
    if (!svgNode) throw new Error('MathJax produced no SVG output');
    return frameFormulaSvg(mathJax.startup.adaptor.serializeXML(svgNode), style);
  });
  mathJaxRenderQueue = render.catch(() => undefined);
  return render;
}

function frameFormulaSvg(mathSvg, style) {
  const viewBoxMatch = String(mathSvg).match(/\bviewBox="([^"]+)"/);
  const viewBox = viewBoxMatch?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
    throw new Error('MathJax SVG has an invalid viewBox');
  }
  const openingEnd = mathSvg.indexOf('>');
  const closingStart = mathSvg.lastIndexOf('</svg>');
  if (openingEnd === -1 || closingStart <= openingEnd) {
    throw new Error('MathJax produced malformed SVG output');
  }

  const [contentX, contentY, contentWidth, contentHeight] = viewBox;
  const unitsPerPixel = 1_000 / 36;
  const leftPadding = 48 * unitsPerPixel;
  const rightPadding = 40 * unitsPerPixel;
  const verticalPadding = 20 * unitsPerPixel;
  const width = Math.max(440 * unitsPerPixel, contentWidth + leftPadding + rightPadding);
  const height = Math.max(116 * unitsPerPixel, contentHeight + verticalPadding * 2);
  const x = contentX - leftPadding;
  const y = contentY - (height - contentHeight) / 2;
  const barWidth = 8 * unitsPerPixel;
  const barRadius = 4 * unitsPerPixel;
  const cornerRadius = 16 * unitsPerPixel;
  const inner = mathSvg.slice(openingEnd + 1, closingStart);
  const colors = style.colors;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.ceil(width / unitsPerPixel)}" height="${Math.ceil(height / unitsPerPixel)}" viewBox="${svgNumber(x)} ${svgNumber(y)} ${svgNumber(width)} ${svgNumber(height)}" role="img">`,
    `<defs><linearGradient id="styleAccentBar" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="${colors.formulaAccent || colors.accent}"/><stop offset="100%" stop-color="${colors.accentAlt}"/></linearGradient></defs>`,
    `<rect x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(width)}" height="${svgNumber(height)}" rx="${svgNumber(cornerRadius)}" fill="${colors.background}"/>`,
    `<rect x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(barWidth)}" height="${svgNumber(height)}" rx="${svgNumber(barRadius)}" fill="url(#styleAccentBar)"/>`,
    `<g color="${colors.text}">${inner}</g>`,
    '</svg>',
  ].join('');
}

function svgNumber(value) {
  return Number(value.toFixed(3));
}

function renderTextDiagramSvg(source, style) {
  const colors = style.colors;
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n').slice(0, 120);
  const widest = Math.max(1, ...lines.map((line) => displayWidth(line)));
  const fontSize = 27;
  const lineHeight = 40;
  const horizontalPadding = 42;
  const verticalPadding = 34;
  const width = Math.min(MAX_RASTER_DIMENSION, Math.max(440, widest * 17 + horizontalPadding * 2));
  const height = Math.max(108, lines.length * lineHeight + verticalPadding * 2);
  const parts = [
    svgOpen(width, height),
    `<rect width="100%" height="100%" rx="16" fill="${colors.background}"/>`,
  ];
  lines.forEach((line, index) => {
    parts.push(`<text x="${horizontalPadding}" y="${verticalPadding + fontSize + index * lineHeight}" fill="${colors.text}" font-family="${KOREAN_IMAGE_FONT_FAMILY}, DejaVu Sans Mono, Noto Sans Mono CJK KR, monospace" font-size="${fontSize}" xml:space="preserve">${escapeXml(line)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

function sanitizeSvg(source) {
  const text = String(source || '').trim();
  if (!looksLikeSvgDocument(text)) throw new Error('SVG diagram must contain a complete <svg> element');
  if (Buffer.byteLength(text, 'utf8') > MAX_SVG_SOURCE_BYTES) {
    throw new Error(`SVG diagram exceeds the ${MAX_SVG_SOURCE_BYTES}-byte rendering limit`);
  }
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(text)) {
    throw new Error('SVG diagram contains a disallowed document type or entity');
  }
  return text
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\s+on[a-z][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\s+(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi, (attribute, quote, target) => (
      String(target).trim().startsWith('#') ? attribute : ''
    ))
    .replace(/@import\b[^;}]*(?:;|(?=}))/gi, '')
    .replace(/url\(\s*(?!["']?#)[^)]+\)/gi, 'none');
}

function rasterizeSvg(source, intrinsicSize = null) {
  const missingFontFiles = missingKoreanImageFontFiles();
  if (missingFontFiles.length > 0) {
    throw new Error(`Korean image font is unavailable: ${missingFontFiles.join(', ')}`);
  }
  const options = {
    font: {
      defaultFontFamily: KOREAN_IMAGE_FONT_FAMILY,
      fontFiles: KOREAN_IMAGE_FONT_FILES,
      // WSL exposes Windows fonts through DrvFS. Scanning that tree can block
      // Reception's event loop long enough for its health lease to expire.
      // The bundled Korean font is deterministic and covers bridge images.
      loadSystemFonts: false,
    },
    logLevel: 'off',
  };
  let renderer = null;
  let width = Number(intrinsicSize?.width);
  let height = Number(intrinsicSize?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    renderer = new Resvg(source, options);
    width = Number(renderer.width);
    height = Number(renderer.height);
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('SVG diagram has invalid dimensions');
  }
  const scale = rasterOutputScale(width, height);
  if (!renderer || scale < 1) {
    renderer = new Resvg(source, {
      ...options,
      ...(scale < 1 ? { fitTo: { mode: 'zoom', value: scale } } : {}),
    });
  }
  if (renderer.imagesToResolve().length > 0) {
    throw new Error('SVG diagram contains unresolved external images');
  }
  const rendered = renderer.render();
  if (rendered.width > MAX_RASTER_DIMENSION
    || rendered.height > MAX_RASTER_DIMENSION
    || rendered.width * rendered.height > MAX_RASTER_PIXELS) {
    throw new Error('SVG diagram exceeds the raster output limit');
  }
  return rendered.asPng();
}

function rasterOutputScale(width, height) {
  return Math.min(
    1,
    MAX_RASTER_DIMENSION / width,
    MAX_RASTER_DIMENSION / height,
    Math.sqrt(MAX_RASTER_TARGET_PIXELS / (width * height)),
  );
}

export function renderRichStylePreviewAttachment() {
  const source = renderRichStyleContactSheetSvg();
  const digest = createHash('sha256')
    .update(RICH_STYLE_PRESETS.map((theme) => theme.id).join('\0'))
    .digest('hex')
    .slice(0, 12);
  return {
    filename: `codex-style-preview-${digest}.png`,
    contentType: 'image/png',
    data: Buffer.from(richStylePreviewPng ||= rasterizeSvg(source)),
    description: 'Preview of all bridge rendering themes',
  };
}

function svgOpen(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" role="img">`;
}

function wrapText(value, maxWidth) {
  const result = [];
  let line = '';
  let width = 0;
  for (const character of String(value || '')) {
    const nextWidth = displayWidth(character);
    if (line && width + nextWidth > maxWidth) {
      result.push(line);
      line = '';
      width = 0;
    }
    line += character;
    width += nextWidth;
  }
  if (line || result.length === 0) result.push(line);
  return result;
}

function tableAltText(table) {
  return clip(`Table: ${[table.header, ...table.rows].map((row) => row.join(' | ')).join('; ')}`);
}

function formulaAltText(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n').trim();
  return clip(`Formula: ${text || '(empty formula)'}`);
}

function diagramAltText(source) {
  const visible = String(source || '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
  return clip(`Diagram: ${visible}`) || 'Diagram rendered as PNG';
}

function clip(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= MAX_ATTACHMENT_ALT_TEXT ? text : `${text.slice(0, MAX_ATTACHMENT_ALT_TEXT - 1)}…`;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
