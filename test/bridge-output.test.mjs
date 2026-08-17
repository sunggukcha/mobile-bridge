import assert from 'node:assert/strict';
import test from 'node:test';
import { formatOutboundMessage } from '../lib/bridge-output.mjs';

test('formatOutboundMessage removes raw worker labels and truncated markers', () => {
  assert.equal(
    formatOutboundMessage([
      '[codex/response_text] 작업 완료',
      '[codex/tool_output]',
      '[truncated]',
      'workerupdate [codex/response_text] 다음 작업',
      '# Subtest: runAgentJob does not fall back for non-runtime worker failures',
      '  ---',
      '  duration_ms: 12.34',
      "  type: 'test'",
      '  ...',
      '다음 줄',
    ].join('\n')),
    '작업 완료\n\n다음 작업\n\n다음 줄',
  );
});

test('formatOutboundMessage removes raw search citations and repairs mojibake', () => {
  const koreanMojibake = Buffer.from('한국 증시', 'utf8').toString('latin1');
  const emojiMojibake = Buffer.from('📈', 'utf8').toString('latin1');
  const cleaned = formatOutboundMessage([
    'S&P 500\u00E2\u20AC\u2122s rally \u00E2\u20AC\u201D breadth improved',
    'caf\u00C3\u00A9 and \u00C2\u00A31bn',
    `${koreanMojibake} ${emojiMojibake}`,
    'Fed\uFFFDs statement',
    '출처 \uE200cite\uE202turn0search0\uE201',
  ].join('\n'));

  assert.equal(
    cleaned,
    'S&P 500\u2019s rally \u2014 breadth improved\ncaf\u00E9 and \u00A31bn\n한국 증시 📈\nFed\'s statement\n출처',
  );
  assert.doesNotMatch(cleaned, /[\uE000-\uF8FF\uFFFD]/);
});

test('formatOutboundMessage preserves /model code block numbering', () => {
  const cleaned = formatOutboundMessage([
    '사용할 모델 번호를 답해주세요.',
    '```text',
    '0. codex: gpt-5.6-sol',
    '1. claude: Fable 5',
    '2. codex: gpt-5.6-terra',
    '3. claude: Opus 5',
    '```',
    '30분 안에 번호 하나만 보내면 그 모델 하나로 고정됩니다 (폴백 없음).',
  ].join('\n'));

  assert.match(cleaned, /^사용할 모델 번호를 답해주세요\.\n```text\n0\. codex: gpt-5\.6-sol/);
  assert.match(cleaned, /\n1\. claude: Fable 5\n2\. codex: gpt-5\.6-terra\n3\. claude: Opus 5\n```/);
});
