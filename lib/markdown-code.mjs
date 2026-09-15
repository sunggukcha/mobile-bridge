// Shared by outbound cleanup and the progress buffer. In particular, do not run
// prose cleanup on individual deltas: a delta may be whitespace or half a fence.
export function markdownCodeRanges(content) {
  const source = String(content ?? '');
  const ranges = [];
  let index = 0;
  while (index < source.length) {
    if (index === 0 || source[index - 1] === '\n') {
      const lineEnd = endOfLine(source, index);
      const opening = source.slice(index, lineEnd).match(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?$/);
      if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
        const delimiter = opening[1];
        let cursor = lineEnd < source.length ? lineEnd + 1 : source.length;
        let end = source.length;
        let closed = false;
        while (cursor < source.length) {
          const closingEnd = endOfLine(source, cursor);
          const closing = source.slice(cursor, closingEnd).match(/^[ \t]*(`+|~+)[ \t]*\r?$/);
          if (closing && closing[1][0] === delimiter[0] && closing[1].length >= delimiter.length) {
            end = closingEnd;
            closed = true;
            break;
          }
          cursor = closingEnd < source.length ? closingEnd + 1 : source.length;
        }
        ranges.push({ start: index, end, delimiter, fenced: true, closed });
        index = end;
        continue;
      }
    }
    if (source[index] !== '`') {
      index += 1;
      continue;
    }
    let openingEnd = index + 1;
    while (source[openingEnd] === '`') openingEnd += 1;
    if (isEscaped(source, index)) {
      index = openingEnd;
      continue;
    }
    const delimiter = source.slice(index, openingEnd);
    let cursor = openingEnd;
    let end = source.length;
    let closed = false;
    while ((cursor = source.indexOf('`', cursor)) !== -1) {
      let closingEnd = cursor + 1;
      while (source[closingEnd] === '`') closingEnd += 1;
      // Backslashes are literal inside code; only the run length matters.
      if (closingEnd - cursor === delimiter.length) {
        end = closingEnd;
        closed = true;
        break;
      }
      cursor = closingEnd;
    }
    ranges.push({ start: index, end, delimiter, fenced: false, closed });
    index = end;
  }
  return ranges;
}

// Opaque, collision-free placeholders allow existing line-oriented prose
// cleanup to work unchanged, including when code spans occur in a prose line.
export function mapMarkdownProse(content, transform) {
  const source = String(content ?? '');
  let marker = '\u0001BRIDGE_CODE_';
  while (source.includes(marker)) marker += '_';
  const saved = [];
  let cursor = 0;
  let masked = '';
  for (const range of markdownCodeRanges(source)) {
    masked += source.slice(cursor, range.start);
    masked += `${marker}${saved.length}\u0002`;
    saved.push(source.slice(range.start, range.end));
    cursor = range.end;
  }
  masked += source.slice(cursor);
  return transform(masked).replace(
    new RegExp(`${marker}(\\d+)\u0002`, 'g'),
    (match, index) => saved[Number(index)] ?? match,
  );
}

// Keep an unfinished code construct in the *source* buffer, not in the platform
// API: deliveries can be retried and different jobs can share a channel. This
// also keeps rich-content parsing from seeing half of a code/table/math fence.
export function splitStreamingMarkdown(content, { final = false, streaming = true } = {}) {
  const source = String(content ?? '');
  const lastCode = markdownCodeRanges(source).at(-1);
  if (final) {
    return { ready: closeUnfinishedCode(source, lastCode), pending: '' };
  }
  let end = source.length;
  if (lastCode && (!lastCode.closed || (streaming && lastCode.end === source.length))) {
    // A terminal run may gain another backtick in the next delta. Do not commit
    // a closing delimiter until its end is known, even if the current run fits.
    end = lastCode.start;
  }
  const trailingMarker = source.match(/(?:^|\n)[ \t]*(?:\d{1,9}[.)]?|[-+*]|#{1,6}|>|~{1,2})[ \t]*$/);
  if (trailingMarker) end = Math.min(end, trailingMarker.index);
  if (source.endsWith('\\') && isEscaped(source, source.length)) end = Math.min(end, source.length - 1);
  if (/[\r\uD800-\uDBFF]$/.test(source)) end = Math.min(end, source.length - 1);
  return { ready: source.slice(0, end), pending: source.slice(end) };
}

function closeUnfinishedCode(source, range) {
  if (!range || range.closed) return source;
  if (range.fenced) return `${source}${source.endsWith('\n') ? '' : '\n'}${range.delimiter}`;
  const body = source.slice(range.start + range.delimiter.length);
  if (!body) {
    return source.slice(0, range.start) + range.delimiter.replaceAll('`', '\\`');
  }
  if (body.endsWith('`')) {
    // Padding prevents a literal trailing run from merging with our closer.
    return `${source.slice(0, range.start)}${range.delimiter} ${body} ${range.delimiter}`;
  }
  return source + range.delimiter;
}

function endOfLine(source, index) {
  const end = source.indexOf('\n', index);
  return end === -1 ? source.length : end;
}

function isEscaped(source, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) count += 1;
  return count % 2 === 1;
}
