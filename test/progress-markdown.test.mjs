import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanOutboundText, formatOutboundMessage } from '../lib/bridge-output.mjs';
import { createProgressUpdateBuffer, createProgressUpdateForwarder, createTerminalResponseProgressGate } from '../lib/job-progress.mjs';
import { markdownCodeRanges, mapMarkdownProse, splitStreamingMarkdown } from '../lib/markdown-code.mjs';

const update = (text, extra = {}) => ({ worker: 'codex', type: 'reasoning', append: true, text, ...extra });
const code = (text) => markdownCodeRanges(text).map((range) => {
  assert.equal(range.closed, true, `unclosed code in ${JSON.stringify(text)}`);
  return text.slice(range.start, range.end);
});

// Synthetic fixture: no production chat IDs, names, timestamps, or job data.
const report = 'nonzero exit을 유지합니다. `valid=119`, `invalid=1`, '
  + '`invalid_item_ids=["sample-001"]`, `status=invalid`입니다. '
  + '출력 파일은 `attempts.jsonl`이며 `runner-migration*.json`을 확인하세요. '
  + 'CLI 재개는 `evaluate --resume-from-source ./sample`입니다.';

test('progress holds the unfinished inline code across timer drains', () => {
  const buffer = createProgressUpdateBuffer();
  buffer.add(update('검사: `valid=119`, `invalid=1'));
  assert.equal(buffer.drain({ final: false }), '검사: `valid=119`,');
  assert.equal(buffer.hasUpdates(), true);
  buffer.add(update('`, `status=invalid`입니다.'));
  assert.equal(buffer.drain({ final: false }), '`invalid=1`, `status=invalid`입니다.');
  assert.equal(buffer.hasUpdates(), false);
});

test('the report survives a timer drain at every possible two-part boundary', () => {
  for (let boundary = 0; boundary <= report.length; boundary += 1) {
    const buffer = createProgressUpdateBuffer();
    buffer.add(update(report.slice(0, boundary)));
    const first = buffer.drain({ final: false });
    buffer.add(update(report.slice(boundary)));
    const second = buffer.drain();
    assert.deepEqual([...code(first), ...code(second)], code(report), `boundary ${boundary}`);
    assert.equal(buffer.hasUpdates(), false);
  }
});

test('fences, inline delimiters, escapes and Unicode survive every two-part boundary', () => {
  const sources = [
    '앞말\n```python\nif ready:\n    print(" a ; ")\n\n\n# comment\n```\n끝말',
    '```sh\nprintf "%s\\n" "file_name*.json"\n```',
    '````md\n```js\nconst x = 1;\n```\n````\n끝',
    '~~~python\n    print("테스트 😀")\n~~~\n끝',
    '``literal `tick` and file_name``입니다.',
    'escape \\`literal\\` and `C:\\temp\\file_name` done.',
    '```text\nTAP version 13\nok 1 - sample\n---\n[truncated]\n```\n끝',
    '```text\r\n    😀 e\u0301\r\n\r\n```\r\n끝',
  ];
  for (const source of sources) {
    for (let boundary = 0; boundary <= source.length; boundary += 1) {
      const buffer = createProgressUpdateBuffer();
      buffer.add(update(source.slice(0, boundary)));
      const first = buffer.drain({ final: false });
      buffer.add(update(source.slice(boundary)));
      const second = buffer.drain();
      assert.deepEqual([...code(first), ...code(second)], code(source.replace(/\r\n?/g, '\n')), `${boundary}: ${JSON.stringify(source)}`);
    }
  }
});

test('raw streaming splits reconstruct their input without truncation or duplication', () => {
  const sources = [report, '1. 준비\n2. ```js\nconst x = 1;\n```\n', '```js\nconst x = "😀";\n```'];
  for (const source of sources) {
    let pending = '';
    let emitted = '';
    for (const character of source) {
      const split = splitStreamingMarkdown(pending + character);
      emitted += split.ready;
      pending = split.pending;
    }
    const final = splitStreamingMarkdown(pending, { final: true });
    assert.equal(emitted + final.ready, source);
  }
});

test('a code block survives one UTF-16 code unit per update with a drain after each', () => {
  const source = '```python\r\nif ready:\r\n    print("a b ; 😀")\r\n\r\n\r\n    next_step()\r\n```\r\n';
  const buffer = createProgressUpdateBuffer();
  const sent = [];
  for (let index = 0; index < source.length; index += 1) {
    buffer.add(update(source[index]));
    const text = buffer.drain({ final: false });
    if (text) sent.push(text);
  }
  const tail = buffer.drain();
  if (tail) sent.push(tail);
  assert.deepEqual(sent, [source.replace(/\r\n/g, '\n').trimEnd()]);
});

test('numbered-list prefixes are not sent as empty list items', () => {
  const buffer = createProgressUpdateBuffer();
  buffer.add(update('1. 준비했습니다.\n2.'));
  assert.equal(buffer.drain({ final: false }), '1. 준비했습니다.');
  buffer.add(update(' GPU 상태를 확인합니다.'));
  assert.equal(buffer.drain(), '2. GPU 상태를 확인합니다.');
});

test('whitespace-only deltas and code indentation are preserved before cleaning', () => {
  const buffer = createProgressUpdateBuffer();
  for (const text of ['```sh\n', 'echo', ' ', '"a', ' ', 'b"', '\n', '\n', '    ', 'echo done', '\n```']) {
    assert.equal(buffer.add(update(text)), true);
  }
  assert.equal(buffer.drain(), '```sh\necho "a b"\n\n    echo done\n```');
});

test('outbound cleanup does not rewrite code, remove TAP-like code or collapse code blank lines', () => {
  const block = '```text\nworkerupdate: literal\noutput: literal\nTAP version 13\nok 1 - sample\n---\n[truncated]\n'
    + '    x = " a ; [  b ] "  \n\n\n\npath = "file_name*.json"\n```';
  const input = `workerupdate [codex/response_text] 완료\n${block}\nworkerupdate 다음`;
  assert.equal(formatOutboundMessage(input), `완료\n${block}\n다음`);
  assert.equal(formatOutboundMessage(formatOutboundMessage(input)), `완료\n${block}\n다음`);
  const inline = '` a ; [  b ] file_name*.json \u00a0 e\u0301 `';
  assert.equal(cleanOutboundText(`workerupdate: ${inline}`), inline);
});

test('placeholder collisions do not replace literal source content', () => {
  const source = '\u0001BRIDGE_CODE_0\u0002 `a ; b`';
  assert.equal(mapMarkdownProse(source, (text) => text), source);
});

test('a new update or worker seals an unfinished old stream without swallowing the new prose', () => {
  const buffer = createProgressUpdateBuffer();
  buffer.add(update('```sh\necho old'));
  assert.equal(buffer.drain({ final: false }), '');
  buffer.add(update('new worker prose', { worker: 'claude', append: false }));
  assert.equal(buffer.drain({ final: false }), '```sh\necho old\n```\nnew worker prose');
});

test('explicit final drain closes a genuinely truncated code construct', () => {
  for (const [source, expected] of [
    ['command: `evaluate --resume', 'command: `evaluate --resume`'],
    ['```sh\necho done', '```sh\necho done\n```'],
    ['``literal `', '`` literal ` ``'],
  ]) {
    const buffer = createProgressUpdateBuffer();
    buffer.add(update(source));
    assert.equal(buffer.drain(), expected);
    assert.equal(buffer.hasUpdates(), false);
    code(expected);
  }
});

function timerForwarder(options = {}) {
  const timers = [];
  const sent = [];
  const forwarder = createProgressUpdateForwarder({
    send: async (message) => { sent.push(message); },
    setTimeoutFn: (fn) => { const handle = { fn, cleared: false }; timers.push(handle); return handle; },
    clearTimeoutFn: (handle) => { handle.cleared = true; },
    ...options,
  });
  return { forwarder, sent, timers, tick: async () => {
    const timer = timers.findLast((handle) => !handle.cleared);
    assert.ok(timer);
    timer.cleared = true;
    await timer.fn();
  } };
}

test('the scheduled forwarder uses a nonfinal drain and reschedules when the closer arrives', async () => {
  const { forwarder, sent, tick } = timerForwarder();
  forwarder.add(update('검사: `valid=119`, `invalid=1'));
  await tick();
  assert.deepEqual(sent, ['검사: `valid=119`,']);
  forwarder.add(update('`, `status=invalid`입니다.'));
  await tick();
  assert.deepEqual(sent, ['검사: `valid=119`,', '`invalid=1`, `status=invalid`입니다.']);
  forwarder.stop();
});

test('a pending fence does not cause a busy timer loop or a fake sent notification', async () => {
  let sentCount = 0;
  const { forwarder, sent, timers, tick } = timerForwarder({ onSent: () => { sentCount += 1; } });
  forwarder.add(update('```sh\necho pending'));
  await tick();
  assert.deepEqual(sent, []);
  assert.equal(timers.length, 1);
  assert.equal(sentCount, 0);
  forwarder.stop();
  await forwarder.flush();
  assert.deepEqual(sent, ['```sh\necho pending\n```']);
  assert.equal(sentCount, 1);
});

test('concurrent timer/manual flushes keep the remainder ordered and send it once', async () => {
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const sent = [];
  const { forwarder, tick } = timerForwarder({ send: async (message) => {
    sent.push(message);
    if (sent.length === 1) await blocked;
  } });
  forwarder.add(update('prefix `open'));
  const first = tick();
  forwarder.add(update(' code` done.'));
  const final = forwarder.flush();
  unblock();
  await Promise.all([first, final]);
  assert.deepEqual(sent, ['prefix', '`open code` done.']);
  forwarder.stop();
});

test('hidden tools remain hidden and terminal response suppression is unchanged', () => {
  const buffer = createProgressUpdateBuffer();
  const gate = createTerminalResponseProgressGate({ forward: (entry) => buffer.add(entry) });
  gate.add(update('intermediate `ok`', { type: 'response_text', append: false }));
  gate.add(update('hidden `tool`', { type: 'tool_output', append: false }));
  gate.add(update('terminal `answer`', { type: 'response_text', append: false }));
  gate.complete();
  assert.equal(buffer.drain(), 'intermediate `ok`');
});

test('partial internal control tags and bodies never leak across timed drains', () => {
  const source = 'visible\n<bridge_wait_for_user>{"question":"synthetic"}</bridge_wait_for_user>\nafter';
  for (let boundary = 0; boundary <= source.length; boundary += 1) {
    const buffer = createProgressUpdateBuffer();
    buffer.add(update(source.slice(0, boundary)));
    const first = buffer.drain({ final: false });
    buffer.add(update(source.slice(boundary)));
    const second = buffer.drain();
    assert.doesNotMatch(first + second, /bridge_|synthetic|question/);
    assert.equal((first + second).replace(/\s/g, ''), 'visibleafter');
  }
});

test('code spanning more than one Discord-sized message is not truncated by the progress buffer', () => {
  const source = '```python\n' + '    print("file_name*.json")\n'.repeat(250) + '```\n';
  const buffer = createProgressUpdateBuffer();
  for (let offset = 0; offset < source.length; offset += 317) {
    buffer.add(update(source.slice(offset, offset + 317)));
    if (offset + 317 < source.length) assert.equal(buffer.drain({ final: false }), '');
  }
  assert.equal(buffer.drain(), source.trimEnd());
});
