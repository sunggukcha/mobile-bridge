import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { clampEffortForModel, compactThreadModelOverride, defaultThreadModelFallbackChain, effortOptionsForModel, formatThreadModelOptions, formatThreadModelOptionsCodeBlock, getModelFamily, modelOptionByNumber, modelOptionBySelector, orderedThreadModelOptions, threadModelOptions, threadModelSelectionOptions, workerProfileForChainEntry } from '../lib/thread-models.mjs';
import { codexSubagentTarget } from '../lib/codex-runner.mjs';

test('formatThreadModelOptions appends live quota summaries when provided', () => {
  const text = formatThreadModelOptions({
    codex: { model: 'gpt-5.6-terra' },
    claude: { model: 'opus' },
    gemini: { model: 'gemini-3.1-pro-preview' },
    codexSpark: { model: 'gpt-5.3-codex-spark' },
  }, {
    usageSummary: {
      workers: [
        {
          id: 'codex',
          windows: [
            { label: '5시간', remainingPercent: 77 },
            { label: '주간', remainingPercent: 12 },
          ],
          spark: {
            windows: [
              { label: '5시간', remainingPercent: 89 },
              { label: '주간', remainingPercent: 97 },
            ],
          },
        },
        {
          id: 'claude',
          windows: [
            { label: '5시간', remainingPercent: 0 },
            { label: '주간', remainingPercent: 80 },
          ],
        },
        {
          id: 'antigravity',
          state: 'available',
          detail: '로그인됨',
          // Antigravity quota arrives as Gemini model tiers (retrieveUserQuota), same shape as
          // native Gemini. Its Claude models carry no per-model bucket.
          windows: [
            { key: 'pro', label: 'Pro', remainingPercent: 62 },
            { key: 'flash', label: 'Flash', remainingPercent: 94 },
            { key: 'flash-lite', label: 'Flash Lite', remainingPercent: 100 },
          ],
        },
        {
          id: 'gemini',
          windows: [
            { key: 'pro', label: 'Pro', remainingPercent: 0 },
            { key: 'flash', label: 'Flash', remainingPercent: 93 },
            { key: 'flash-lite', label: 'Flash Lite', remainingPercent: 100 },
          ],
        },
      ],
    },
  });

  assert.match(text, /^0\. codex: gpt-5\.6-sol \(5시간: 77%/);
  assert.match(text, /1\. codex: gpt-5\.6-terra \(5시간: 77%/);
  assert.match(text, /2\. codex: gpt-5\.6-luna \(5시간: 77%/);
  assert.match(text, /3\. claude: Fable 5 \(5시간: 0%/);
  assert.match(text, /4\. claude: Opus 5 \(5시간: 0%/);
  assert.match(text, /5\. antigravity: claude-opus-4\.6 \(로그인됨\)/);
  assert.match(text, /6\. antigravity: gemini-3\.7-flash \(일간: 94%/);
  assert.match(text, /7\. codex: gpt-5\.3-codex-spark \(5시간: 89%/);
  assert.doesNotMatch(text, /gemini: gemini-/);
  assert.doesNotMatch(text, /claude-sonnet-4\.6|gpt-oss-120b/);
});

test('formatThreadModelOptions uses separate Claude model quota windows when present', () => {
  const text = formatThreadModelOptions({
    claude: { model: 'opus', maintenanceModel: 'claude-fable-5' },
  }, {
    usageSummary: {
      workers: [
        {
          id: 'claude',
          state: 'available',
          detail: '로그인됨',
          windows: [
            { key: '5h', label: '5시간', remainingPercent: 50 },
          ],
          modelWindows: {
            'claude-fable-5': [
              { key: '5h', label: '5시간', remainingPercent: 7 },
            ],
            'claude-opus-5': [
              { key: '5h', label: '5시간', remainingPercent: 82 },
            ],
          },
        },
      ],
    },
  });

  assert.match(text, /^0\. codex: gpt-5\.6-sol/);
  assert.match(text, /3\. claude: Fable 5 \(5시간: 7%/);
  assert.match(text, /4\. claude: Opus 5 \(5시간: 82%/);
  assert.doesNotMatch(text, /claude: Fable 5 \(5시간: 50%/);
});

test('formatThreadModelOptions keeps multi-account Claude quota records separate', () => {
  const config = {
    claude: {
      accounts: [
        { id: 'primary', label: '개인', home: '/tmp/claude-personal' },
        { id: 'secondary', label: '업무', home: '/tmp/claude-work' },
      ],
    },
  };
  const text = formatThreadModelOptions(config, {
    usageSummary: {
      workers: [{
        id: 'claude',
        accounts: {
          primary: { state: 'available', windows: [{ label: '5시간', remainingPercent: 82 }] },
          secondary: { state: 'available', windows: [{ label: '5시간', remainingPercent: 31 }] },
        },
      }],
    },
  });

  assert.match(text, /claude: Fable 5 · 개인 \(5시간: 82%\)/);
  assert.match(text, /claude: Fable 5 · 업무 \(5시간: 31%\)/);
  assert.match(text, /claude: Opus 5 · 개인 \(5시간: 82%\)/);
  assert.match(text, /claude: Opus 5 · 업무 \(5시간: 31%\)/);
});

test('formatThreadModelOptions marks an unlogged Claude account as requiring authentication', () => {
  const text = formatThreadModelOptions({
    claude: {
      accounts: [
        { id: 'primary', label: '개인', home: '/tmp/claude-personal' },
        { id: 'secondary', label: '업무', home: '/tmp/claude-work' },
      ],
    },
  }, {
    usageSummary: {
      workers: [{
        id: 'claude',
        accounts: {
          primary: { state: 'available', windows: [{ label: '5시간', remainingPercent: 82 }] },
          secondary: { state: 'unavailable', detail: '자격 증명 없음', windows: [] },
        },
      }],
    },
  });

  assert.match(text, /claude: Fable 5 · 업무 \(인증 필요\)/);
  assert.match(text, /claude: Opus 5 · 업무 \(인증 필요\)/);
});

test('formatThreadModelOptions does not borrow native Gemini numbers for Antigravity', () => {
  const text = formatThreadModelOptions({}, {
    usageSummary: {
      workers: [
        {
          id: 'antigravity',
          state: 'available',
          detail: '인증됨',
          note: '잔여 쿼터 조회만 미확인(Antigravity /model 쿼터 패널 미수신)',
          windows: [],
        },
        {
          id: 'gemini',
          state: 'available',
          windows: [
            { key: 'pro', label: 'Pro', remainingPercent: 99 },
            { key: 'flash', label: 'Flash', remainingPercent: 100 },
          ],
        },
      ],
    },
  });

  assert.match(text, /5\. antigravity: claude-opus-4\.6 \(잔여 쿼터 조회만 미확인\(Antigravity \/model 쿼터 패널 미수신\)\)/);
  assert.match(text, /6\. antigravity: gemini-3\.7-flash \(잔여 쿼터 조회만 미확인\(Antigravity \/model 쿼터 패널 미수신\)\)/);
  assert.doesNotMatch(text, /antigravity: gemini-3\.1-pro \(일간: 99%/);
  assert.doesNotMatch(text, /^.*gemini: gemini-/m);
});

test('formatThreadModelOptions does not borrow another Antigravity Gemini model tier', () => {
  const text = formatThreadModelOptions({}, {
    usageSummary: {
      workers: [
        {
          id: 'antigravity',
          state: 'available',
          detail: '로그인됨',
          // Only a pro-tier window is present; the Antigravity Gemini Flash option must not
          // borrow it.
          windows: [
            { key: 'pro', label: 'Pro', remainingPercent: 100 },
          ],
        },
      ],
    },
  });

  assert.match(text, /6\. antigravity: gemini-3\.7-flash \(로그인됨\)/);
  assert.doesNotMatch(text, /6\. antigravity: gemini-3\.7-flash \(일간: 100%/);
});

test('formatThreadModelOptions shows authenticated Antigravity models without quota buckets', () => {
  const text = formatThreadModelOptions({}, {
    usageSummary: {
      workers: [
        { id: 'antigravity', state: 'available', detail: '로그인됨', windows: [] },
      ],
    },
  });

  assert.match(text, /5\. antigravity: claude-opus-4\.6 \(로그인됨\)/);
  assert.match(text, /6\. antigravity: gemini-3\.7-flash \(로그인됨\)/);
});

test('threadModelOptions starts with Sol, then uses the configured fallback order', () => {
  assert.deepEqual(threadModelOptions({}).map((option) => option.label), [
    'codex: gpt-5.6-sol',
    'codex: gpt-5.6-terra',
    'claude: Opus 5',
    'antigravity: claude-opus-4.6',
    'antigravity: gemini-3.7-flash',
    'codex: gpt-5.3-codex-spark',
    'codex: gpt-5.6-luna',
  ]);
});

test('GPT-5.6 Codex model options default to xhigh while Codex Spark remains at xhigh', () => {
  const options = threadModelOptions({});
  assert.equal(options.find((option) => option.label === 'codex: gpt-5.6-sol').reasoningEffort, 'xhigh');
  assert.equal(options.find((option) => option.label === 'codex: gpt-5.6-terra').reasoningEffort, 'xhigh');
  assert.equal(options.find((option) => option.label === 'codex: gpt-5.6-luna').reasoningEffort, 'xhigh');
  assert.equal(options.find((option) => option.label === 'codex: gpt-5.3-codex-spark').reasoningEffort, 'xhigh');
});

test('effortOptionsForModel exposes each provider\'s documented effort levels', () => {
  // `ultra` is per-slug, not GPT-5.6-wide: the codex-cli 0.146.0 model catalog
  // lists it for Sol and Terra only, so Luna must stay capped at max.
  assert.deepEqual(effortOptionsForModel('codex', 'gpt-5.6-sol'), ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(effortOptionsForModel('codex', 'gpt-5.6-terra'), ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(effortOptionsForModel('codex', 'gpt-5.6-luna'), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortOptionsForModel('codex', 'gpt-5.5'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(effortOptionsForModel('codex', 'gpt-5.3-codex-spark'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(effortOptionsForModel('claude', 'opus'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(effortOptionsForModel('antigravity', 'gemini-3.7-flash-high'), ['low', 'medium', 'high']);
  assert.deepEqual(effortOptionsForModel('gemini', 'gemini-3.1-pro'), []);
});

test('clampEffortForModel lowers an effort the target model does not support', () => {
  assert.equal(clampEffortForModel('codex', 'gpt-5.6-terra', 'ultra'), 'ultra');
  assert.equal(clampEffortForModel('codex', 'gpt-5.6-luna', 'ultra'), 'max');
  assert.equal(clampEffortForModel('codex', 'gpt-5.5', 'ultra'), 'xhigh');
  assert.equal(clampEffortForModel('codex', 'gpt-5.3-codex-spark', 'max'), 'xhigh');
  assert.equal(clampEffortForModel('claude', 'opus', 'max'), 'xhigh');
  // A supported tier, an unknown value, and a family without CLI effort control
  // all pass through untouched so validateConfig stays the single place that warns.
  assert.equal(clampEffortForModel('codex', 'gpt-5.6-luna', 'high'), 'high');
  assert.equal(clampEffortForModel('codex', 'gpt-5.6-luna', 'bogus'), 'bogus');
  assert.equal(clampEffortForModel('gemini', 'gemini-3.1-pro', 'ultra'), 'ultra');
  // Spark has no `none`, so the weakest request lands on its lowest tier.
  assert.equal(clampEffortForModel('codex', 'gpt-5.3-codex-spark', 'none'), 'low');
});

test('an ultra CODEX_REASONING_EFFORT reaches Sol and Terra but is clamped for Luna', () => {
  const options = threadModelOptions({ codex: { reasoningEffort: 'ultra' } });
  assert.equal(options.find((option) => option.label === 'codex: gpt-5.6-sol').reasoningEffort, 'ultra');
  assert.equal(options.find((option) => option.label === 'codex: gpt-5.6-terra').reasoningEffort, 'ultra');
  assert.equal(options.find((option) => option.label === 'codex: gpt-5.6-luna').reasoningEffort, 'max');
});

test('the maintenance sol worker runs Sol at ultra and delegates to Luna at max', () => {
  const config = {
    codex: {
      maintenanceSolModel: 'gpt-5.6-sol',
      maintenanceSolReasoningEffort: 'ultra',
      subagentModel: 'gpt-5.6-luna',
      subagentReasoningEffort: 'max',
    },
  };
  const profile = workerProfileForChainEntry(config, 'codex-sol');
  assert.equal(profile.worker, 'codex');
  assert.equal(profile.model, 'gpt-5.6-sol');
  // Sol has the ultra tier, so the maintenance effort must survive the clamp.
  assert.equal(profile.reasoningEffort, 'ultra');
  assert.deepEqual(codexSubagentTarget(config), { model: 'gpt-5.6-luna', effort: 'max' });
});

test('compactThreadModelOverride keeps effort fields needed after service recovery', () => {
  assert.deepEqual(compactThreadModelOverride({
    id: 'codex-gpt-5.6-sol',
    label: 'codex: gpt-5.6-sol',
    worker: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max',
    reasoningSummary: 'auto',
    effort: 'max',
    selectedAt: 'not-needed-in-job-state',
  }), {
    id: 'codex-gpt-5.6-sol',
    label: 'codex: gpt-5.6-sol',
    worker: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max',
    reasoningSummary: 'auto',
    effort: 'max',
  });
});

test('threadModelSelectionOptions groups the menu by provider and keeps Fable selectable', () => {
  assert.deepEqual(threadModelSelectionOptions({}).map((option) => option.label), [
    'codex: gpt-5.6-sol',
    'codex: gpt-5.6-terra',
    'codex: gpt-5.6-luna',
    'claude: Fable 5',
    'claude: Opus 5',
    'antigravity: claude-opus-4.6',
    'antigravity: gemini-3.7-flash',
    'codex: gpt-5.3-codex-spark',
  ]);
  assert.deepEqual(threadModelSelectionOptions({}).map((option) => option.selectionNumber), [0, 1, 2, 3, 4, 5, 6, 7]);
});

// One number must mean the same model in every channel, so the company Claude-first
// priority stays in the fallback chain instead of reordering the visible menu.
test('threadModelSelectionOptions renders the same menu for company and non-company channels', () => {
  assert.deepEqual(
    threadModelSelectionOptions({}, { company: true }).map((option) => option.label),
    threadModelSelectionOptions({}).map((option) => option.label),
  );
  assert.equal(orderedThreadModelOptions({}, { company: true })[1].label, 'claude: Opus 5');
});

test('/model expands each Claude model into account-specific executable profiles', () => {
  const config = {
    claude: {
      model: 'opus',
      maintenanceModel: 'claude-fable-5',
      accounts: [
        { id: 'primary', label: '개인', home: '/tmp/claude-personal' },
        { id: 'secondary', label: '업무', home: '/tmp/claude-work' },
      ],
    },
  };
  const options = threadModelSelectionOptions(config);

  assert.deepEqual(options.slice(0, 7).map((option) => option.label), [
    'codex: gpt-5.6-sol',
    'codex: gpt-5.6-terra',
    'codex: gpt-5.6-luna',
    'claude: Fable 5 · 개인',
    'claude: Fable 5 · 업무',
    'claude: Opus 5 · 개인',
    'claude: Opus 5 · 업무',
  ]);
  assert.equal(modelOptionBySelector(config, 'fable:primary').claudeAccount.id, 'primary');
  assert.equal(modelOptionBySelector(config, 'opus:secondary').claudeAccount.id, 'secondary');
  assert.equal(modelOptionBySelector(config, 'opus').claudeAccount.id, 'primary');
  assert.equal(defaultThreadModelFallbackChain(config).filter((option) => option.worker === 'claude').length, 1);
  assert.equal(defaultThreadModelFallbackChain(config).find((option) => option.worker === 'claude').claudeAccount.id, 'primary');
});

test('/model rendered numbers use the same mapping as number selection', () => {
  const options = threadModelSelectionOptions({});
  const lines = formatThreadModelOptions({}).split('\n');
  assert.equal(lines.length, options.length);
  for (const [index, option] of options.entries()) {
    assert.equal(lines[index], `${option.selectionNumber}. ${option.label}`);
    assert.equal(modelOptionByNumber({}, option.selectionNumber)?.id, option.id);
  }
  assert.equal(modelOptionByNumber({}, '1abc'), null);
});

test('/model friendly selectors resolve single models and ordered fallback aliases', () => {
  assert.equal(modelOptionBySelector({}, 'sol').label, 'codex: gpt-5.6-sol');
  assert.equal(modelOptionBySelector({}, 'fable').label, 'claude: Fable 5');
  assert.equal(modelOptionBySelector({}, 'terra').label, 'codex: gpt-5.6-terra');
  assert.equal(modelOptionBySelector({}, 'opus').label, 'claude: Opus 5');
  assert.equal(modelOptionBySelector({}, 'agy-opus').label, 'antigravity: claude-opus-4.6');
  assert.equal(modelOptionBySelector({}, 'gemini').label, 'antigravity: gemini-3.7-flash');
  assert.equal(modelOptionBySelector({}, 'agy-pro').label, 'antigravity: gemini-3.7-flash');
  assert.equal(modelOptionBySelector({}, 'spark').label, 'codex: gpt-5.3-codex-spark');
  assert.equal(modelOptionBySelector({}, 'luna').label, 'codex: gpt-5.6-luna');
  assert.equal(modelOptionBySelector({}, 'gpt-5.6-sol').label, 'codex: gpt-5.6-sol');
  assert.equal(modelOptionBySelector({}, 'missing'), null);

  assert.deepEqual(
    ['sol', 'opus', 'terra'].map((selector) => modelOptionBySelector({}, selector).label),
    ['codex: gpt-5.6-sol', 'claude: Opus 5', 'codex: gpt-5.6-terra'],
  );
  assert.equal(modelOptionBySelector({}, '1').label, 'codex: gpt-5.6-terra');
  assert.equal(modelOptionBySelector({}, '2').label, 'codex: gpt-5.6-luna');
});

test('/model colon aliases stay on their own provider instead of falling back to Claude', () => {
  // `agy:opus`는 접두사가 잘려 `opus`(claude)로 조용히 매칭됐다가, `모델:계정` 문법이
  // 들어온 뒤에는 아예 실패했다. 이제 둘 다 안티그래비티로 간다.
  assert.equal(modelOptionBySelector({}, 'agy:opus').label, 'antigravity: claude-opus-4.6');
  assert.equal(modelOptionBySelector({}, 'antigravity:opus').label, 'antigravity: claude-opus-4.6');
  assert.equal(modelOptionBySelector({}, 'agy:pro').label, 'antigravity: gemini-3.7-flash');
  assert.equal(modelOptionBySelector({}, 'antigravity:pro').label, 'antigravity: gemini-3.7-flash');
  assert.equal(modelOptionBySelector({}, 'agy opus').label, 'antigravity: claude-opus-4.6');

  // 메뉴 라벨을 그대로 붙여넣는 경로는 유지한다.
  assert.equal(modelOptionBySelector({}, 'antigravity: claude-opus-4.6').label, 'antigravity: claude-opus-4.6');
  assert.equal(modelOptionBySelector({}, 'antigravity: gemini-3.7-flash').label, 'antigravity: gemini-3.7-flash');
  assert.equal(modelOptionBySelector({}, 'codex: gpt-5.6-terra').label, 'codex: gpt-5.6-terra');
  assert.equal(modelOptionBySelector({}, 'claude: Opus 5').label, 'claude: Opus 5');
  assert.equal(modelOptionBySelector({}, 'claude:opus').label, 'claude: Opus 5');

  // 접두사가 가리키는 워커에 없는 모델은 다른 워커로 넘어가지 않고 실패해야 한다.
  assert.equal(modelOptionBySelector({}, 'codex:opus'), null);
  assert.equal(modelOptionBySelector({}, 'agy:fable'), null);
});

test('/model scoped Claude account selectors still win over the alias fallback', () => {
  const config = {
    claude: {
      accounts: [
        { id: 'primary', label: '개인', home: '/tmp/claude-personal' },
        { id: 'secondary', label: '업무', home: '/tmp/claude-work' },
      ],
    },
  };
  assert.equal(modelOptionBySelector(config, 'fable:primary').claudeAccount.id, 'primary');
  assert.equal(modelOptionBySelector(config, 'opus:secondary').claudeAccount.id, 'secondary');
  assert.equal(modelOptionBySelector(config, 'opus:missing'), null);
  assert.equal(modelOptionBySelector(config, 'agy:opus').label, 'antigravity: claude-opus-4.6');
});

test('/model Discord menu wraps numbered choices in a code block', () => {
  const text = formatThreadModelOptionsCodeBlock({});
  assert.match(text, /^```text\n0\. codex: gpt-5\.6-sol\n1\. codex: gpt-5\.6-terra\n2\. codex: gpt-5\.6-luna/);
  assert.match(text, /\n7\. codex: gpt-5\.3-codex-spark\n```$/);
  assert.equal(text.includes('\n```text\n'), false);
});

test('/model Discord menu keeps the same numbering for a company channel', () => {
  assert.equal(
    formatThreadModelOptionsCodeBlock({}, { company: true }),
    formatThreadModelOptionsCodeBlock({}),
  );
});

test('defaultThreadModelFallbackChain excludes manual-only Sol and Fable for every channel', () => {
  assert.deepEqual(defaultThreadModelFallbackChain({}).map((option) => option.label), [
    'codex: gpt-5.6-terra',
    'claude: Opus 5',
    'antigravity: claude-opus-4.6',
    'antigravity: gemini-3.7-flash',
    'codex: gpt-5.3-codex-spark',
    'codex: gpt-5.6-luna',
  ]);
  assert.deepEqual(defaultThreadModelFallbackChain({}, { company: true }).map((option) => option.label), [
    'claude: Opus 5',
    'codex: gpt-5.6-terra',
    'antigravity: claude-opus-4.6',
    'antigravity: gemini-3.7-flash',
    'codex: gpt-5.3-codex-spark',
    'codex: gpt-5.6-luna',
  ]);
  assert.equal(defaultThreadModelFallbackChain({}).some((option) => option.label === 'codex: gpt-5.6-sol'), false);
  assert.equal(defaultThreadModelFallbackChain({}).some((option) => option.label === 'claude: Fable 5'), false);
});

test('defaultThreadModelFallbackChain reflects a custom configured model fallback order', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex-luna,claude,antigravity,codex-spark',
    CODEX_REASONING_EFFORT: 'max',
    CLAUDE_EFFORT: 'xhigh',
    ANTIGRAVITY_MODEL: 'Claude Opus 4.6 (Thinking)',
    ANTIGRAVITY_FALLBACK_MODEL: 'gemini-3.7-flash-high',
    ANTIGRAVITY_EFFORT: 'high',
  });

  assert.deepEqual(defaultThreadModelFallbackChain(config).map((option) => ({
    label: option.label,
    reasoningEffort: option.reasoningEffort,
    effort: option.effort,
  })), [
    { label: 'codex: gpt-5.6-luna', reasoningEffort: 'max', effort: null },
    { label: 'claude: Opus 5', reasoningEffort: null, effort: 'xhigh' },
    { label: 'antigravity: Claude Opus 4.6 (Thinking)', reasoningEffort: null, effort: 'high' },
    { label: 'antigravity: gemini-3.7-flash-high', reasoningEffort: null, effort: 'high' },
    { label: 'codex: gpt-5.3-codex-spark', reasoningEffort: 'xhigh', effort: null },
  ]);
});

test('/model numbering is channel-independent while the chain stays channel-aware', () => {
  // Every channel sees the same provider-grouped menu, so a number is unambiguous.
  assert.equal(modelOptionByNumber({}, 0).label, 'codex: gpt-5.6-sol');
  assert.equal(modelOptionByNumber({}, 1).label, 'codex: gpt-5.6-terra');
  assert.equal(modelOptionByNumber({}, 2).label, 'codex: gpt-5.6-luna');
  assert.equal(modelOptionByNumber({}, 3).label, 'claude: Fable 5');
  assert.equal(modelOptionByNumber({}, 4).label, 'claude: Opus 5');
  assert.match(
    formatThreadModelOptions({}),
    /^0\. codex: gpt-5\.6-sol\n1\. codex: gpt-5\.6-terra\n2\. codex: gpt-5\.6-luna\n3\. claude: Fable 5\n4\. claude: Opus 5/,
  );

  // The automatic fallback order still starts with Sol and gives company channels Claude.
  assert.equal(orderedThreadModelOptions({})[0].label, 'codex: gpt-5.6-sol');
  assert.equal(orderedThreadModelOptions({})[1].label, 'codex: gpt-5.6-terra');
  assert.equal(orderedThreadModelOptions({}, { company: true })[0].label, 'codex: gpt-5.6-sol');
  assert.equal(orderedThreadModelOptions({}, { company: true })[1].label, 'claude: Opus 5');

  // Same set of 7 chain options; Fable is menu-only, so the menu has one more row.
  assert.equal(orderedThreadModelOptions({}, { company: true }).length, 7);
  assert.equal(threadModelSelectionOptions({}).length, 8);
});

test('getModelFamily classifies workers/models correctly', () => {
  assert.equal(getModelFamily('claude', 'opus'), 'claude');
  assert.equal(getModelFamily('antigravity', 'claude-opus-4.6'), 'claude');
  assert.equal(getModelFamily('antigravity', 'gemini-3.7-flash-high'), 'gemini');
  assert.equal(getModelFamily('gemini', 'gemini-3.1-pro-preview'), 'gemini');
  assert.equal(getModelFamily('codex', 'gpt-5.6-sol'), 'codex');
  assert.equal(getModelFamily('codex', 'gpt-5.6-terra'), 'codex');
  assert.equal(getModelFamily('codex-spark', 'gpt-5.3-codex-spark'), 'codex');
  assert.equal(getModelFamily('antigravity', 'gpt-oss-120b'), 'other');
});
