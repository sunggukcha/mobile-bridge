import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineMathUnicode, renderFormulaSvg, splitRichContent } from '../lib/rich-content.mjs';

test('splitRichContent turns GFM tables into PNG image attachments', async () => {
  const parts = await splitRichContent([
    '결과입니다.',
    '',
    '| 이름 | 상태 |',
    '| --- | :-: |',
    '| ixiparser | 통과 |',
  ].join('\n'));

  assert.deepEqual(parts.map((part) => part.type), ['text', 'image']);
  assertPngAttachment(parts[1].attachment, /^codex-table-[a-f0-9]{12}\.png$/);
  assert.match(parts[1].attachment.description, /Table:/);
});

test('splitRichContent renders Korean table text with a real glyph font', async () => {
  const parts = await splitRichContent([
    '| 항목 | 상태 |',
    '| --- | --- |',
    '| 한국어 | 정상 |',
  ].join('\n'));

  const image = parts.find((part) => part.type === 'image');
  assert.ok(image);
  assertPngAttachment(image.attachment, /^codex-table-[a-f0-9]{12}\.png$/);
  assert.match(image.attachment.description, /한국어/);
  assert.ok(image.attachment.data.length > 4_000, 'Korean glyphs should not render as tiny tofu placeholders');
});

test('splitRichContent downscales a large comparison table into the raster budget', async () => {
  const content = [
    '| 옵션 | 가격 | 메모 |',
    '|---|---|---|',
    '| **기본 플랜** | **$45~** / 사용량 증가 시 **$60~71** | 동적 가격. 피크 시간에는 상단 구간 |',
    '| 기본 + 분석 | $73~ | 분석 대시보드 포함 (기본 대비 +$28) |',
    '| 팀 번들 | $63~ | 개별 구매보다 14% 절약 |',
    '| 엔터프라이즈 | $207~ | 전용 지원·감사 로그·우선 처리 |',
    '| 추가 저장공간 | $35 | **월 단위 결제만**, 일할 계산 불가 |',
    '| 할인 리셀러 | 월 **$34.50~**, 분석 $48.87~ | 최저가지만 현재 페이지에 "Temporarily unavailable" 표시. 피크 시간 슬롯은 거의 안 열림 |',
    '| 플렉스 패스 | $85 (2개) | **1개만 쓸 거면 오히려 손해** |',
    '| 팀 패스 | $119 (3개) | 3개 이상일 때만 이득 |',
    '| 전체 패스 | $214 (5개) | 단기간 평가용으로는 비쌈 |',
  ].join('\n');
  const parts = await splitRichContent(content, { styleId: 'warm-noir' });

  assert.deepEqual(parts.map((part) => part.type), ['image']);
  const [{ attachment }] = parts;
  assertPngAttachment(attachment, /^codex-table-[a-f0-9]{12}\.png$/);
  assert.match(attachment.description, /피크 시간 슬롯은 거의 안 열림/);
  const width = attachment.data.readUInt32BE(16);
  const height = attachment.data.readUInt32BE(20);
  assert.ok(width <= 1_600 && height <= 1_600);
  assert.ok(width * height <= 1_000_000);
});

test('splitRichContent leaves raster rounding headroom near the pixel limit', async () => {
  const content = [
    '| A | description |',
    '| --- | --- |',
    `| 1 | ${'x'.repeat(931)} |`,
    '| 2 | ok |',
    '| 3 | ok |',
    '| 4 | ok |',
  ].join('\n');
  const parts = await splitRichContent(content);

  assert.deepEqual(parts.map((part) => part.type), ['image']);
  const [{ attachment }] = parts;
  assertPngAttachment(attachment, /^codex-table-[a-f0-9]{12}\.png$/);
  const width = attachment.data.readUInt32BE(16);
  const height = attachment.data.readUInt32BE(20);
  assert.ok(width * height <= 1_000_000, `${width}x${height}`);
});

test('splitRichContent falls back to a monospace block for oversized tables instead of blocking on rasterization', async () => {
  const longCell = `${'상세 설명 '.repeat(35)}UNIQUE_END_MARKER`.trim();
  const content = [
    '| 항목 | 상태 | 상세 |',
    '| --- | --- | --- |',
    ...Array.from({ length: 8 }, (_, index) =>
      `| ${index + 1} | 정상 | ${longCell} |`),
  ].join('\n');
  const parts = await splitRichContent(content);

  assert.deepEqual(parts.map((part) => part.type), ['text']);
  // Neither Discord nor Slack renders GFM pipe syntax, so the raw source must
  // never reach the user (issue #25).
  const [{ content: fallback }] = parts;
  assert.ok(fallback.startsWith('```') && fallback.trimEnd().endsWith('```'), fallback.slice(0, 80));
  assert.doesNotMatch(fallback, /\| --- \|/);
  assert.match(fallback, /항목\s+\| 상태\s+\| 상세/);
  assert.match(fallback, /^8 +\| 정상/m);
  assert.match(fallback, /UNIQUE_END/);
  assert.match(fallback, /_MARKER/);
  assert.doesNotMatch(fallback, /…/);
});

test('splitRichContent caps aggregate synchronous image rendering per message', async () => {
  const longCell = '상세 설명 '.repeat(35).trim();
  const content = Array.from({ length: 6 }, (_, index) => [
    '| 항목 | 상태 | 상세 |',
    '| --- | --- | --- |',
    `| 항목 ${index + 1} | 정상 | ${longCell} |`,
  ].join('\n')).join('\n\n');
  const parts = await splitRichContent(content);

  assert.equal(parts.filter((part) => part.type === 'image').length, 1);
  const fallbackText = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join('');
  assert.match(fallbackText, /항목 2/);
  assert.match(fallbackText, /항목 6/);
});

test('splitRichContent detects displayed, inline, bare-bracket, and undelimited TeX formulas', async () => {
  const displayed = await splitRichContent('\\[\nL=L_{x}+\\lambda\\text{dir}\n\\]');
  const inline = await splitRichContent('앞 $L=L_{x}+\\lambda$ 뒤');
  const bare = await splitRichContent('[\nL=L_{x}+\\lambda\\text{dir}\n]');
  const undelimited = await splitRichContent('L=L_{x}+\\lambda\\text{dir}');

  for (const parts of [displayed, inline, bare, undelimited]) {
    const image = parts.find((part) => part.type === 'image');
    assert.ok(image);
    assertPngAttachment(image.attachment, /^codex-formula-[a-f0-9]{12}\.png$/);
  }
  assert.equal(inline.filter((part) => part.type === 'text').map((part) => part.content).join(''), '앞  뒤');
});

test('formula rendering typesets accents and special notation as embedded SVG paths', async () => {
  const source = String.raw`\begin{aligned}
L &= \frac{1}{N}\sum_i (y_i-\hat{y}_i)^2 \\
\theta &\leftarrow \theta-\alpha\nabla L,\quad \bar{x},\quad \vec{v},\quad \mathbb{R},\quad ŷ,\quad A\pitchfork B
\end{aligned}`;
  const svg = await renderFormulaSvg(source);

  assert.match(svg, /<path\b/);
  assert.doesNotMatch(svg, /<text\b/);
  assert.match(svg, /data-mml-node="mover"/);
  assert.match(svg, /data-mml-node="mfrac"/);
  assert.match(svg, /data-mml-node="mtable"/);
  assert.match(svg, /data-latex="\\pitchfork"/);

  const rendered = await splitRichContent(`\`\`\`math\n${source}\n\`\`\``);
  const flattened = await splitRichContent('```math\nhaty\n```');
  const image = rendered.find((part) => part.type === 'image');
  const flattenedImage = flattened.find((part) => part.type === 'image');
  assert.ok(image);
  assert.ok(flattenedImage);
  assertPngAttachment(image.attachment, /^codex-formula-[a-f0-9]{12}\.png$/);
  assert.notDeepEqual(image.attachment.data, flattenedImage.attachment.data);
  assert.match(image.attachment.description, /\\hat\{y\}/);
});

test('splitRichContent preserves malformed or oversized formulas as source text', async () => {
  const malformed = '```math\n\\frac{1}{\n```';
  const oversized = `\`\`\`math\n${'x+'.repeat(4_200)}\n\`\`\``;

  assert.deepEqual(await splitRichContent(malformed), [{
    type: 'text',
    content: malformed,
  }]);
  assert.deepEqual(await splitRichContent(oversized), [{
    type: 'text',
    content: oversized,
  }]);
});

test('splitRichContent rasterizes fenced and raw SVG without leaking markup', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" fill="#123456"/><text x="20" y="70">Gateway handoff</text></svg>';
  const fenced = await splitRichContent(`앞\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n뒤`);
  const raw = await splitRichContent(`설명\n${svg}\n완료`);

  for (const parts of [fenced, raw]) {
    const image = parts.find((part) => part.type === 'image');
    assert.ok(image);
    assertPngAttachment(image.attachment, /^codex-diagram-[a-f0-9]{12}\.png$/);
    assert.equal(parts.filter((part) => part.type === 'text').some((part) => part.content.includes('<svg')), false);
  }
});

test('splitRichContent turns a fenced architecture text diagram into PNG', async () => {
  const parts = await splitRichContent([
    '구조입니다.',
    '```text',
    '[Supervisor]',
    ' ├─ [Worker Host]',
    ' ├─ [Bridge A]',
    ' └─ [Bridge B]',
    '       ↕',
    ' [SQLite/WAL]',
    '```',
  ].join('\n'));

  assert.deepEqual(parts.map((part) => part.type), ['text', 'image']);
  assertPngAttachment(parts[1].attachment, /^codex-diagram-[a-f0-9]{12}\.png$/);
  assert.match(parts[1].attachment.description, /Worker Host/);
});

test('splitRichContent preserves ordinary code fences and dollar amounts as text', async () => {
  const code = await splitRichContent('```js\nconst total = price * 2;\n```');
  const money = await splitRichContent('가격은 $100 입니다.');

  assert.deepEqual(code, [{ type: 'text', content: '```js\nconst total = price * 2;\n```' }]);
  assert.deepEqual(money, [{ type: 'text', content: '가격은 $100 입니다.' }]);
});

test('splitRichContent preserves prose containing multiple currency amounts as one text part', async () => {
  const content = '이유: 피크 시간에는 **추가요금 약 +$10**이 붙습니다. 사용 시간 제한이 없다면 기본 시간대에 시작해 같은 기능을 계속 쓰는 편이 피크 슬롯 대비 1인 $10 정도 절약됩니다.';

  assert.deepEqual(await splitRichContent(content, { styleId: 'warm-noir' }), [{
    type: 'text',
    content,
  }]);
});

test('splitRichContent preserves currency prose when the closing price is not digit-led', async () => {
  // The closing `$` is separated from its amount, so the digit-pair guard alone
  // does not fire and the Hangul in the span has to reject the match.
  const spaced = '이유: 피크 추가요금 약 +$10 이 붙습니다. 기본 시간대를 쓰면 1인 $ 10 절약.';
  assert.deepEqual(await splitRichContent(spaced, { styleId: 'warm-noir' }), [{
    type: 'text',
    content: spaced,
  }]);

  const english = 'Adults pay $10 + tax, tips extra $ 5 on top.';
  assert.deepEqual(await splitRichContent(english), [{ type: 'text', content: english }]);
});

test('splitRichContent keeps digit-leading single-dollar formulas', async () => {
  assert.deepEqual(await splitRichContent('계산: $2+2$, $10\\times 2$'), [{
    type: 'text',
    content: '계산: 2+2, 10× 2',
  }]);

  const laidOut = await splitRichContent('거듭제곱 $2^{10}$');
  assert.deepEqual(laidOut.map((part) => part.type), ['text', 'image']);
  assertPngAttachment(laidOut[1].attachment, /^codex-formula-[a-f0-9]{12}\.png$/);
});

test('splitRichContent preserves a price before a digit-leading formula', async () => {
  const inline = await splitRichContent('가격은 $100; 합계는 $2+2$');
  assert.deepEqual(inline, [{
    type: 'text',
    content: '가격은 $100; 합계는 2+2',
  }]);

  const laidOut = await splitRichContent('가격은 $100; 거듭제곱은 $2^{10}$');
  assert.deepEqual(laidOut.map((part) => part.type), ['text', 'image']);
  assert.equal(laidOut[0].content, '가격은 $100; 거듭제곱은 ');
  assertPngAttachment(laidOut[1].attachment, /^codex-formula-[a-f0-9]{12}\.png$/);
});

test('splitRichContent does not render labeled source code with TeX-like backslashes', async () => {
  const content = [
    '```js',
    "const command = '\\\\lambda';",
    'const words = input.match(/\\\\[A-Za-z]+/g);',
    '```',
  ].join('\n');

  assert.deepEqual(await splitRichContent(content), [{
    type: 'text',
    content,
  }]);
});

test('splitRichContent inlines trivial symbol-only math instead of attaching an image', async () => {
  const arrow = await splitRichContent('**전담 서빙** $\\rightarrow$ **팁 18~20%**');
  const bare = await splitRichContent('\\Rightarrow');

  assert.deepEqual(arrow, [{ type: 'text', content: '**전담 서빙** → **팁 18~20%**' }]);
  assert.deepEqual(bare, [{ type: 'text', content: '⇒' }]);
});

test('inlineMathUnicode converts symbol runs but defers laid-out formulas to the typesetter', () => {
  assert.equal(inlineMathUnicode('\\rightarrow'), '→');
  assert.equal(inlineMathUnicode('\\alpha \\le \\beta'), 'α ≤ β');
  assert.equal(inlineMathUnicode('A \\to B'), 'A → B');
  // Subscripts, fractions and grouping all position glyphs, so they still need
  // a rasterized image rather than a lossy Unicode approximation.
  assert.equal(inlineMathUnicode('L=L_{x}+\\lambda'), null);
  assert.equal(inlineMathUnicode('\\frac{a}{b}'), null);
  assert.equal(inlineMathUnicode('x^2'), null);
  assert.equal(inlineMathUnicode('\\sqrt{2}'), null);
  assert.equal(inlineMathUnicode(`\\alpha ${'\\to \\beta '.repeat(8)}`), null);
});

function assertPngAttachment(attachment, filenamePattern) {
  assert.equal(attachment.contentType, 'image/png');
  assert.match(attachment.filename, filenamePattern);
  assert.equal(attachment.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert(attachment.data.readUInt32BE(16) > 0);
  assert(attachment.data.readUInt32BE(20) > 0);
}
