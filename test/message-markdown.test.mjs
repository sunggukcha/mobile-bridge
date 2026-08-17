import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displayWidth,
  escapeSlackEntities,
  renderMarkdownTables,
  toSlackMrkdwn,
} from '../lib/message-markdown.mjs';

test('toSlackMrkdwn converts Markdown emphasis to the Slack dialect', () => {
  assert.equal(toSlackMrkdwn('예, **something** 입니다'), '예, *something* 입니다');
  assert.equal(toSlackMrkdwn('*italic* and _also_'), '_italic_ and _also_');
  assert.equal(toSlackMrkdwn('__bold__ and ***both***'), '*bold* and *_both_*');
  assert.equal(toSlackMrkdwn('~~dropped~~'), '~dropped~');
});

test('toSlackMrkdwn converts headings, bullets, checkboxes and rules', () => {
  assert.equal(toSlackMrkdwn('## 결과 요약'), '*결과 요약*');
  assert.equal(toSlackMrkdwn('### **강조** 제목'), '*강조 제목*');
  assert.equal(toSlackMrkdwn('- 첫째\n* 둘째\n  + 셋째'), '• 첫째\n• 둘째\n  • 셋째');
  assert.equal(toSlackMrkdwn('- [ ] 남음\n- [x] 완료'), '• ☐ 남음\n• ☑ 완료');
  assert.equal(toSlackMrkdwn('---'), '──────────');
  assert.equal(toSlackMrkdwn('1. **첫 항목**'), '1. *첫 항목*');
});

test('toSlackMrkdwn rewrites Markdown links as Slack links', () => {
  assert.equal(toSlackMrkdwn('[이슈](https://example.com/1)'), '<https://example.com/1|이슈>');
  assert.equal(toSlackMrkdwn('![shot](https://example.com/a.png)'), '<https://example.com/a.png|shot>');
  assert.equal(toSlackMrkdwn('[https://x.test](https://x.test)'), '<https://x.test>');
});

test('toSlackMrkdwn escapes entities and preserves Slack control sequences', () => {
  assert.equal(toSlackMrkdwn('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
  assert.equal(toSlackMrkdwn('already &amp; escaped'), 'already &amp; escaped');
  assert.equal(toSlackMrkdwn('cc <@U123> and <#C456|ops> and <!here>'), 'cc <@U123> and <#C456|ops> and <!here>');
  assert.equal(toSlackMrkdwn('link <https://x.test|label>'), 'link <https://x.test|label>');
});

test('toSlackMrkdwn leaves code spans and fenced blocks unstyled', () => {
  assert.equal(toSlackMrkdwn('run `npm test -- **all**`'), 'run `npm test -- **all**`');
  assert.equal(
    toSlackMrkdwn('```js\nif (a < b) return **x**;\n```'),
    '```js\nif (a &lt; b) return **x**;\n```',
  );
  assert.equal(toSlackMrkdwn('``a`b``'), '``a`b``');
});

test('toSlackMrkdwn keeps quote markers and identifiers intact', () => {
  assert.equal(toSlackMrkdwn('> 인용 **강조**'), '> 인용 *강조*');
  assert.equal(toSlackMrkdwn('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(toSlackMrkdwn('2 * 3 * 4'), '2 * 3 * 4');
});

test('renderMarkdownTables aligns columns in a monospace block', () => {
  const table = [
    '| name | ok | ms |',
    '| --- | :-: | ---: |',
    '| parser | yes | 1204 |',
    '| miner | no | 87 |',
  ].join('\n');

  assert.equal(renderMarkdownTables(table), [
    '```',
    'name   | ok  |   ms',
    '-------+-----+-----',
    'parser | yes | 1204',
    'miner  | no  |   87',
    '```',
  ].join('\n'));
});

test('renderMarkdownTables pads CJK cells by display width', () => {
  const table = [
    '| 이름 | 상태 |',
    '| --- | --- |',
    '| ixiparser | 통과 |',
  ].join('\n');

  const lines = renderMarkdownTables(table).split('\n');
  assert.deepEqual(lines.slice(0, 2), ['```', '이름      | 상태']);
  assert.equal(displayWidth(lines[1].split(' | ')[0]), displayWidth('ixiparser'));
  assert.equal(lines[3], 'ixiparser | 통과');
});

test('renderMarkdownTables wraps long cells without dropping their tail', () => {
  const longCell = `${'상세 설명 '.repeat(12)}UNIQUE_END_MARKER`;
  const table = [
    '| 이름 | 메모 |',
    '| --- | --- |',
    `| 항목 | ${longCell} |`,
  ].join('\n');

  const rendered = renderMarkdownTables(table);
  const lines = rendered.split('\n');
  const dividerIndex = lines.findIndex((line) => /^-+\+-+$/.test(line));
  const reconstructed = lines
    .slice(dividerIndex + 1, -1)
    .map((line) => line.split(' | ')[1] ?? '')
    .join('');
  assert.equal(reconstructed.replace(/\s/gu, ''), longCell.replace(/\s/gu, ''));
  assert.doesNotMatch(rendered, /…/);
  assert.ok(lines.length > 5, rendered);
});

test('renderMarkdownTables strips cell markup and keeps surrounding text', () => {
  const text = [
    '결과:',
    '',
    '| step | note |',
    '|---|---|',
    '| **build** | see [log](https://x.test) |',
    '',
    '끝.',
  ].join('\n');

  assert.equal(renderMarkdownTables(text), [
    '결과:',
    '',
    '```',
    'step  | note',
    '------+--------',
    'build | see log',
    '```',
    '',
    '끝.',
  ].join('\n'));
});

test('renderMarkdownTables ignores pipes inside fenced blocks and prose', () => {
  const fenced = '```sh\ncat a | wc -l\n--- | ---\n```';
  assert.equal(renderMarkdownTables(fenced), fenced);
  assert.equal(renderMarkdownTables('a | b without divider'), 'a | b without divider');
});

test('toSlackMrkdwn renders tables before styling the rest of the message', () => {
  const converted = toSlackMrkdwn('**표**\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(converted, '*표*\n\n```\na | b\n--+--\n1 | 2\n```');
});

test('escapeSlackEntities leaves numeric and named entities alone', () => {
  assert.equal(escapeSlackEntities('&#39;&lt;&gt;&amp;&x'), '&#39;&lt;&gt;&amp;&amp;x');
});

test('displayWidth counts wide characters as two columns', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('한글'), 4);
  assert.equal(displayWidth(''), 0);
});
