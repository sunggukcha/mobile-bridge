import {
  claudeAccountBySelector,
  claudeAccountOptions,
  defaultClaudeAccount,
} from './claude-accounts.mjs';

export const THREAD_MODEL_SELECTION_TTL_MS = 30 * 60_000;

const BASE_WORKERS = new Set(['codex', 'claude', 'gemini', 'antigravity', 'codex-spark']);
const CLAUDE_MAINTENANCE_WORKERS = new Set(['claude-fable', 'claude-opus']);
const CODEX_MAINTENANCE_WORKERS = new Set(['codex-sol', 'codex-terra']);
const LEGACY_CODEX_TERRA_MODEL = `gpt-${'5.5'}`;
const LEGACY_CODEX_TERRA_KEYS = new Set([
  `codex-${LEGACY_CODEX_TERRA_MODEL}`,
  `codex: ${LEGACY_CODEX_TERRA_MODEL}`,
  LEGACY_CODEX_TERRA_MODEL,
]);

// Ordered weakest → strongest. Used to clamp an effort a given model does not
// support down to its best available tier instead of sending a value the CLI or
// API would refuse for that model.
const EFFORT_TIER_ORDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// `ultra` is not a GPT-5.6-wide tier. `codex debug models` (codex-cli 0.146.0)
// reports supported_reasoning_levels per slug: gpt-5.6-sol and gpt-5.6-terra list
// low…max plus ultra ("Maximum reasoning with automatic task delegation"), while
// gpt-5.6-luna stops at max. Ultra is a CLI-side tier: it is sent to the API as
// `effort: max` and additionally turns on proactive subagent delegation, which the
// bridge points at CODEX_SUBAGENT_MODEL (see lib/codex-runner.mjs).
const CODEX_ULTRA_MODELS = /^gpt-5\.6-(?:sol|terra)$/i;

export function effortOptionsForModel(family, model = '') {
  if (family === 'claude') return ['low', 'medium', 'high', 'xhigh'];
  if (family === 'antigravity') return ['low', 'medium', 'high'];
  if (family !== 'codex') return [];

  // GPT-5.6 adds `none` and the quality-first `max` tier. Older Codex variants,
  // including the configured 5.3 Spark worker, retain the levels that are known to
  // be supported for them: Spark answers a `max` request with HTTP 400
  // `unsupported_value` and names low/medium/high/xhigh as its supported set,
  // so xhigh is Spark's top tier.
  const slug = String(model).trim();
  if (/^gpt-5\.6(?:-|$)/i.test(slug)) {
    const tiers = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    return CODEX_ULTRA_MODELS.test(slug) ? [...tiers, 'ultra'] : tiers;
  }
  return ['low', 'medium', 'high', 'xhigh'];
}

// One CODEX_REASONING_EFFORT is shared by every Codex profile, but the tiers are
// per-model. Clamp a request the target model does not support down to its
// strongest available tier (ultra → max on Luna, max → xhigh on 5.5) so a single
// configured value can never make one model's jobs fail at the first API call.
// An unrecognized value is returned verbatim so validateConfig still warns about it.
export function clampEffortForModel(family, model, effort) {
  const requested = String(effort || '').trim().toLowerCase();
  const supported = effortOptionsForModel(family, model);
  if (!requested || supported.length === 0 || supported.includes(requested)) return requested;

  const requestedTier = EFFORT_TIER_ORDER.indexOf(requested);
  if (requestedTier < 0) return requested;
  const ranked = supported
    .map((option) => ({ option, tier: EFFORT_TIER_ORDER.indexOf(option) }))
    .filter((entry) => entry.tier >= 0)
    .sort((a, b) => a.tier - b.tier);
  if (ranked.length === 0) return requested;
  const nearestBelow = [...ranked].reverse().find((entry) => entry.tier <= requestedTier);
  return (nearestBelow || ranked[0]).option;
}

// `/model` menu order, grouped by provider: codex sol/terra/luna, then claude
// fable/opus, then antigravity opus/gemini, then codex spark. This is
// deliberately independent of threadModelOptions order, which defines automatic
// fallback priority (see defaultThreadModelFallbackChain), so reordering the
// visible list can never silently repoint the fallback chain. Keys match the
// `/model` aliases the menu message documents.
const MODEL_MENU_ORDER = ['sol', 'terra', 'luna', 'fable', 'opus', 'agy-opus', 'gemini', 'spark'];

// Models exposed by /model. Each entry is one executable profile: provider,
// model, and (for Claude) the isolated account HOME it must use. This order is
// the automatic fallback priority: Sol leads it but is dropped from the default
// chain (see defaultThreadModelFallbackChain), and the remaining entries run in
// the order listed here. `menuKey` places the profile in the display order
// above without tying that display to this priority.
export function threadModelOptions(config = {}) {
  const codexSolModel = String(config.codex?.solModel || 'gpt-5.6-sol').trim();
  const codexModel = String(config.codex?.model || 'gpt-5.6-terra').trim();
  const codexLunaModel = String(config.codex?.lunaModel || 'gpt-5.6-luna').trim();
  const codexSparkModel = String(config.codexSpark?.model || 'gpt-5.3-codex-spark').trim();
  const claudeModel = String(config.claude?.model || 'opus').trim();
  // Antigravity model strings are CLI-version sensitive (see ANTIGRAVITY_*_MODEL
  // in .env.example); keep them config-driven so they can be retuned without a
  // code change if the `agy` CLI renames a model.
  const antigravityOpusModel = String(config.antigravity?.opusModel || 'Claude Opus 4.6 (Thinking)').trim();
  const antigravityProModel = String(config.antigravity?.proModel || 'gemini-3.7-flash-high').trim();
  const antigravityEffort = String(config.antigravity?.effort || 'high').trim().toLowerCase();
  const codexEffort = config.codex?.reasoningEffort || 'xhigh';

  return [
    modelOption('codex', 'codex: gpt-5.6-sol', {
      menuKey: 'sol',
      model: codexSolModel,
      reasoningEffort: clampEffortForModel('codex', codexSolModel, codexEffort),
      reasoningSummary: config.codex?.reasoningSummary || 'auto',
    }),
    modelOption('codex', 'codex: gpt-5.6-terra', {
      menuKey: 'terra',
      model: codexModel,
      reasoningEffort: clampEffortForModel('codex', codexModel, codexEffort),
      reasoningSummary: config.codex?.reasoningSummary || 'auto',
    }),
    ...claudeModelOptions(config, 'claude: Opus 5', {
      menuKey: 'opus',
      model: claudeModel,
      effort: config.claude?.effort || 'xhigh',
    }),
    modelOption('antigravity', 'antigravity: claude-opus-4.6', {
      menuKey: 'agy-opus',
      model: antigravityOpusModel,
      effort: antigravityEffort,
    }),
    modelOption('antigravity', 'antigravity: gemini-3.7-flash', {
      menuKey: 'gemini',
      model: antigravityProModel,
      effort: antigravityEffort,
    }),
    modelOption('codex-spark', 'codex: gpt-5.3-codex-spark', {
      menuKey: 'spark',
      model: codexSparkModel,
      reasoningEffort: config.codexSpark?.reasoningEffort || 'xhigh',
      reasoningSummary: config.codexSpark?.reasoningSummary || config.codex?.reasoningSummary || 'auto',
    }),
    modelOption('codex', 'codex: gpt-5.6-luna', {
      menuKey: 'luna',
      model: codexLunaModel,
      // Luna has no `ultra` tier, so a global CODEX_REASONING_EFFORT=ultra lands
      // here as max rather than as a value Luna would reject.
      reasoningEffort: clampEffortForModel('codex', codexLunaModel, codexEffort),
      reasoningSummary: config.codex?.reasoningSummary || 'auto',
    }),
  ];
}

// The selection list every channel sees. One number always means the same model
// everywhere, so the menu is not reordered per channel; a company channel's
// Claude-first priority lives in the fallback chain, not in this list.
export function threadModelSelectionOptions(config = {}) {
  const options = [...threadModelOptions(config), ...claudeFableModelOptions(config)];
  return [
    ...MODEL_MENU_ORDER.flatMap((key) => options.filter((option) => option.menuKey === key)),
    // A profile with no menu key (a newly configured one) still has to be
    // selectable, so it follows the grouped rows instead of disappearing.
    ...options.filter((option) => !MODEL_MENU_ORDER.includes(option.menuKey)),
  ].map((option, selectionNumber) => ({ ...option, selectionNumber }));
}

// The automatic fallback priority for a channel. Sol is always first. Company channels
// then lead with Claude; everyone else keeps the threadModelOptions order. Resolve Claude
// by worker (not index) so reordering that list can't silently break priority.
export function orderedThreadModelOptions(config = {}, { company = false } = {}) {
  const options = threadModelOptions(config);
  if (!company) return options;
  const [sol, ...remaining] = options;
  const claudeIndex = remaining.findIndex((option) => option.worker === 'claude');
  if (claudeIndex <= 0) return options;
  return [sol, remaining[claudeIndex], ...remaining.slice(0, claudeIndex), ...remaining.slice(claudeIndex + 1)];
}

export function defaultThreadModelFallbackChain(config = {}, { company = false } = {}) {
  const configured = configuredThreadModelFallbackChain(config, { company });
  if (configured) return configured;

  const [, ...withoutSol] = orderedThreadModelOptions(config, { company });
  const defaultAccountId = defaultClaudeAccount(config)?.id || 'primary';
  // A secondary Claude account is selectable, but never becomes an implicit
  // fallback. Crossing accounts is always an explicit `/model` chain choice.
  return withoutSol
    .filter((option) => option.worker !== 'claude' || option.claudeAccount?.id === defaultAccountId)
    .map((option) => ({ ...option, exactFallback: true }));
}

// `/usage` answers "how much is left", not "what runs first", so it is one row
// per distinct quota bucket in a fixed reading order instead of the fallback
// chain's order. A bucket belongs to an account or a sub-limit, never to a
// single model: Sol, Terra and Luna all draw down the same Codex window, and
// Opus/Fable share the same Claude account, so spelling the model out only adds
// noise. Only Codex Spark (its own sub-limit) and the Antigravity rows need a
// name beyond the provider.
const USAGE_QUOTA_ROWS = [
  { menuKey: 'terra', label: 'Codex' },
  { menuKey: 'opus', label: 'Claude' },
  { menuKey: 'gemini', label: 'Gemini' },
  { menuKey: 'spark', label: 'Codex Spark' },
  { menuKey: 'agy-opus', label: 'AGY Opus' },
];

export function usageQuotaRows(config = {}, { company = false } = {}) {
  const options = threadModelOptions(config);
  const accounts = claudeAccountOptions(config);
  const defaultAccountId = defaultClaudeAccount(config)?.id || 'primary';
  const rows = [];
  for (const { menuKey, label } of USAGE_QUOTA_ROWS) {
    const matches = options.filter((option) => option.menuKey === menuKey);
    const option = matches.find((candidate) =>
      !candidate.claudeAccount || candidate.claudeAccount.id === defaultAccountId
    ) || matches[0];
    if (!option) continue;
    // With a second Claude account configured, "Claude" alone would not say
    // whose quota this is.
    const suffix = accounts.length > 1 && option.claudeAccount ? ` · ${option.claudeAccount.label}` : '';
    rows.push({ ...option, label: `${label}${suffix}` });
  }

  // A chain pointed at a worker with its own quota bucket (native Gemini) has
  // numbers none of the fixed rows can show, so it keeps its own row rather
  // than dropping out of the view.
  const covered = new Set(rows.map((row) => row.worker));
  for (const option of defaultThreadModelFallbackChain(config, { company })) {
    if (covered.has(option.worker)) continue;
    covered.add(option.worker);
    rows.push(option);
  }
  return rows;
}

// The historical provider-only default routes are expanded into the automatic
// menu order above. A deliberately customized worker chain must instead be
// presented exactly as it will execute, including configured Gemini or
// Antigravity fallback models. This keeps /usage and an unpinned /effort
// selection aligned with the runner.
function configuredThreadModelFallbackChain(config, { company }) {
  const configuredChain = company ? config.workers?.companyChain : config.workers?.defaultChain;
  if (!Array.isArray(configuredChain) || configuredChain.length === 0) return null;

  const key = configuredChain.map((entry) => String(entry || '').trim()).filter(Boolean).join(',');
  if (automaticFallbackChainKeys(company).has(key)) return null;

  const options = threadModelOptions(config);
  const chain = [];
  for (const entry of configuredChain) {
    const worker = String(entry || '').trim();
    if (worker === 'antigravity' || worker === 'gemini') {
      chain.push(...providerFallbackOptions(config, worker));
      continue;
    }

    const option = configuredWorkerOption(options, config, worker);
    if (option) chain.push(option);
  }

  return chain.length > 0 ? chain.map((option) => ({ ...option, exactFallback: true })) : null;
}

function automaticFallbackChainKeys(company) {
  return company
    ? new Set([
      'claude,codex,antigravity,codex-spark,codex-luna',
      'claude,codex,gemini,codex-spark',
      'claude,codex,antigravity,gemini,codex-spark',
    ])
    : new Set([
      'codex,claude,antigravity,codex-spark,codex-luna',
      'codex,claude,gemini,codex-spark',
      'codex,claude,antigravity,gemini,codex-spark',
    ]);
}

function configuredWorkerOption(options, config, worker) {
  if (worker === 'codex-luna') {
    const lunaModel = String(config.codex?.lunaModel || 'gpt-5.6-luna').trim();
    return options.find((option) => option.worker === 'codex' && option.model === lunaModel) || null;
  }
  if (worker === 'codex') {
    const codexModel = String(config.codex?.model || 'gpt-5.6-terra').trim();
    return options.find((option) => option.worker === 'codex' && option.model === codexModel) || null;
  }
  return options.find((option) => option.worker === worker) || null;
}

function providerFallbackOptions(config, worker) {
  const provider = config[worker] || {};
  const models = [provider.model, provider.fallbackModel]
    .map((model) => String(model || '').trim())
    .filter((model, index, values) => model && values.indexOf(model) === index);

  return models.map((model) => ({
    id: `${worker}-${slug(model)}`,
    label: `${worker}: ${model}`,
    worker,
    model,
    reasoningEffort: null,
    reasoningSummary: null,
    effort: worker === 'antigravity' ? String(provider.effort || 'high').trim().toLowerCase() : null,
  }));
}

export function modelOptionByNumber(config, number) {
  const raw = String(number ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return threadModelSelectionOptions(config).find((option) => option.selectionNumber === parsed) || null;
}

export function modelOptionBySelector(config, selector) {
  const raw = String(selector ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return modelOptionByNumber(config, raw);

  const options = threadModelSelectionOptions(config);
  const scopedClaudeSelector = parseScopedClaudeSelector(raw);
  if (scopedClaudeSelector) {
    const account = claudeAccountBySelector(config, scopedClaudeSelector.account);
    const scoped = account
      ? modelOptionForSelector(options, scopedClaudeSelector.model, account.id)
      : null;
    if (scoped) return scoped;
    // `모델:계정` 문법이 아닌 `agy:opus` 같은 셀렉터는 여기서 끝내지 않고 일반 별칭
    // 경로로 넘긴다. 계정 문법이 들어오기 전에는 이런 입력이 조용히 다른 워커로
    // 매칭됐고, 그 뒤에는 무조건 실패했다.
  }

  for (const candidate of selectorMatchCandidates(options, raw)) {
    const scope = candidate.worker
      ? options.filter((option) => option.worker === candidate.worker)
      : options;
    const friendlyMatch = friendlyModelAliasMatcher(candidate.key);
    const match = friendlyMatch
      ? scope.find(friendlyMatch)
      : scope.find((option) => modelSelectorKeys(option).has(candidate.key));
    if (match) return match;
  }

  return null;
}

export function modelOptionById(config, id) {
  const key = normalizeModelKey(id);
  if (!key) return null;
  const options = [...threadModelOptions(config), ...claudeFableModelOptions(config)];
  if (isLegacyCodexTerraKey(key)) return options.find((option) => option.worker === 'codex') || null;
  const exact = options.find((option) =>
    [option.id, option.label, option.worker].some((value) => normalizeModelKey(value) === key)
  );
  if (exact) return exact;

  // Pre-account-selection status files stored generic Claude ids/labels. Keep
  // those on the primary account after upgrading the bridge.
  return options.find((option) => option.worker === 'claude' && (
    `${option.worker}-${slug(option.model)}` === key
    || normalizeModelKey(claudeLabelWithoutAccount(option.label)) === key
  )) || null;
}

export function modelSelectionFromOption(option, { messageId = null, selectedAt = new Date().toISOString() } = {}) {
  if (!option) return null;
  const selection = {
    id: option.id,
    label: option.label,
    worker: option.worker,
    model: option.model || '',
    reasoningEffort: option.reasoningEffort || null,
    reasoningSummary: option.reasoningSummary || null,
    effort: option.effort || null,
    selectedAt,
    selectedByMessageId: messageId,
  };
  const claudeAccount = compactClaudeAccount(option.claudeAccount);
  if (claudeAccount) selection.claudeAccount = claudeAccount;
  return selection;
}

export function compactThreadModelOverride(override) {
  if (!override) return null;
  const compactEntry = (entry = {}) => {
    const compact = {
    id: entry.id || null,
    label: entry.label || null,
    worker: entry.worker || null,
    model: entry.model || '',
    reasoningEffort: entry.reasoningEffort || null,
    reasoningSummary: entry.reasoningSummary || null,
    effort: entry.effort || null,
    };
    const claudeAccount = compactClaudeAccount(entry.claudeAccount);
    if (claudeAccount) compact.claudeAccount = claudeAccount;
    return compact;
  };
  const compact = compactEntry(override);
  if (Array.isArray(override.chain) && override.chain.length > 0) {
    compact.chain = override.chain.map(compactEntry);
  }
  return compact;
}

export function pendingModelSelection({ messageId = null, requestedAt = new Date().toISOString() } = {}) {
  return {
    messageId,
    requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + THREAD_MODEL_SELECTION_TTL_MS).toISOString(),
  };
}

export function isPendingModelSelectionActive(pending, now = new Date()) {
  if (!pending?.requestedAt) return false;
  const expiresAt = Date.parse(pending.expiresAt || pending.requestedAt) || 0;
  return Number.isFinite(expiresAt) && expiresAt >= now.getTime();
}

export function formatThreadModelOptions(config, { usageSummary = null } = {}) {
  return threadModelSelectionOptions(config)
    .map((option, index) => {
      const quota = formatModelQuota(option, usageSummary);
      const number = Number.isInteger(option.selectionNumber) ? option.selectionNumber : index;
      return `${number}. ${option.label}${quota ? ` ${quota}` : ''}`;
    })
    .join('\n');
}

export function formatThreadModelOptionsCodeBlock(config, { usageSummary = null } = {}) {
  return `\`\`\`text\n${formatThreadModelOptions(config, { usageSummary })}\n\`\`\``;
}

export function workerProfileForChainEntry(config, entry) {
  if (entry && typeof entry === 'object') {
    const selection = normalizeModelSelection(config, entry);
    if (selection) return { ...selection, name: entry.name || selection.id };
  }

  const id = typeof entry === 'string' ? entry : entry?.id;
  const name = String(id || '').trim();
  if (name === 'codex-luna') {
    const luna = modelOptionById(config, 'codex: gpt-5.6-luna');
    if (luna) return { ...luna, name };
  }
  if (CLAUDE_MAINTENANCE_WORKERS.has(name)) {
    const fallback = name === 'claude-opus';
    const model = String(
      fallback
        ? config.claude?.maintenanceFallbackModel || 'claude-opus-5'
        : config.claude?.maintenanceModel || 'claude-fable-5'
    ).trim();
    return {
      id: name,
      label: model ? `claude: ${model}` : name,
      name,
      worker: 'claude',
      model,
      reasoningEffort: null,
      reasoningSummary: null,
      effort: fallback
        ? config.claude?.maintenanceFallbackEffort || 'xhigh'
        : config.claude?.maintenanceEffort || 'xhigh',
    };
  }

  if (CODEX_MAINTENANCE_WORKERS.has(name)) {
    const sol = name === 'codex-sol';
    const model = String(
      sol
        ? config.codex?.maintenanceSolModel || 'gpt-5.6-sol'
        : config.codex?.maintenanceModel || 'gpt-5.6-terra'
    ).trim();
    return {
      id: name,
      label: model ? `codex: ${model}` : name,
      name,
      worker: 'codex',
      model,
      reasoningEffort: clampEffortForModel('codex', model, sol
        ? config.codex?.maintenanceSolReasoningEffort || 'max'
        : config.codex?.reasoningEffort || 'xhigh'),
      reasoningSummary: config.codex?.reasoningSummary || 'auto',
      effort: null,
    };
  }

  const override = modelOptionById(config, id);
  if (override && !BASE_WORKERS.has(String(id || '').trim())) {
    return { ...override, name: override.id };
  }

  const worker = BASE_WORKERS.has(name) ? name : 'codex';
  return {
    id: name || worker,
    label: name || worker,
    name: name || worker,
    worker,
    model: null,
    reasoningEffort: null,
    reasoningSummary: null,
    effort: null,
  };
}

export function normalizeModelSelection(config, selection) {
  if (!selection) return null;
  const base = normalizeModelSelectionEntry(config, selection);
  if (!base) return null;
  // A /model fallback sequence ("3 4 1") stores its ordered models in `chain`.
  // Re-normalize each entry on read and keep the chain only when it still has
  // more than one distinct model; a single-entry chain collapses to a plain pin.
  if (Array.isArray(selection.chain) && selection.chain.length > 0) {
    const chain = selection.chain
      .map((entry) => normalizeModelSelectionEntry(config, entry))
      .filter(Boolean);
    if (chain.length > 1) return { ...base, chain };
  }
  return base;
}

function normalizeModelSelectionEntry(config, selection) {
  if (!selection) return null;
  const option = [selection.id, selection.label]
    .map((value) => modelOptionById(config, value))
    .find(Boolean);
  if (option) {
    const selected = modelSelectionFromOption(option, {
      messageId: selection.selectedByMessageId || null,
      selectedAt: selection.selectedAt || new Date().toISOString(),
    });
    return {
      ...selected,
      reasoningEffort: selection.reasoningEffort || selected.reasoningEffort,
      reasoningSummary: selection.reasoningSummary || selected.reasoningSummary,
      effort: selection.effort || selected.effort,
      selectedAt: selection.selectedAt || new Date().toISOString(),
    };
  }
  const worker = String(selection.worker || '').trim();
  if (!BASE_WORKERS.has(worker)) return null;
  const normalized = {
    id: String(selection.id || `${worker}-${slug(selection.model || 'default')}`),
    label: String(selection.label || `${worker}-${selection.model || 'default'}`),
    worker,
    model: String(selection.model || ''),
    reasoningEffort: selection.reasoningEffort || null,
    reasoningSummary: selection.reasoningSummary || null,
    effort: selection.effort || null,
    selectedAt: selection.selectedAt || new Date().toISOString(),
    selectedByMessageId: selection.selectedByMessageId || null,
  };
  const claudeAccount = compactClaudeAccount(selection.claudeAccount);
  if (claudeAccount) normalized.claudeAccount = claudeAccount;
  return normalized;
}

function modelOption(worker, label, extra = {}) {
  const actualModel = Object.hasOwn(extra, 'model') ? extra.model : label;
  const claudeAccount = compactClaudeAccount(extra.claudeAccount);
  return {
    id: `${worker}-${slug(actualModel || label || 'default')}${claudeAccount ? `-${slug(claudeAccount.id)}` : ''}`,
    label,
    worker,
    model: actualModel,
    menuKey: extra.menuKey || null,
    reasoningEffort: extra.reasoningEffort || null,
    reasoningSummary: extra.reasoningSummary || null,
    effort: extra.effort || null,
    ...(claudeAccount ? { claudeAccount } : {}),
  };
}

function claudeFableModelOptions(config = {}) {
  return claudeModelOptions(config, 'claude: Fable 5', {
    menuKey: 'fable',
    model: String(config.claude?.maintenanceModel || 'claude-fable-5').trim(),
    effort: config.claude?.maintenanceEffort || 'xhigh',
  });
}

function claudeModelOptions(config, label, extra) {
  const accounts = claudeAccountOptions(config);
  const showAccount = accounts.length > 1;
  return accounts.map((account) => modelOption('claude', showAccount ? `${label} · ${account.label}` : label, {
    ...extra,
    claudeAccount: account,
  }));
}

export function getModelFamily(worker, model) {
  const w = String(worker || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (w === 'codex' || w === 'codex-spark') {
    return 'codex';
  }
  if (w === 'claude' || m.includes('claude') || m.includes('opus') || m.includes('sonnet')) {
    return 'claude';
  }
  if (w === 'gemini' || m.includes('gemini') || m.includes('pro') || m.includes('flash')) {
    return 'gemini';
  }
  return 'other';
}

export function formatModelQuota(option, usageSummary) {
  const workers = new Map((usageSummary?.workers || []).map((worker) => [worker.id, worker]));
  const codex = workers.get('codex');
  const claude = workers.get('claude');
  const claudeForOption = claudeUsageForOption(claude, option);
  const gemini = workers.get('gemini');
  const antigravity = workers.get('antigravity');

  let windows = [];
  let note = '';

  if (option.worker === 'codex') {
    windows = codex?.windows || [];
  } else if (option.worker === 'claude') {
    const modelWindows = workerModelWindowsForOption(claudeForOption, option);
    if (modelWindows) {
      windows = modelWindows;
    } else if (hasWorkerModelWindows(claudeForOption)) {
      note = claudeForOption?.note || '모델별 잔여 쿼터 미수신';
    } else {
      windows = claudeForOption?.windows || [];
    }
  } else if (option.worker === 'antigravity') {
    // Antigravity quota windows are Gemini model tiers (pro/flash/flash-lite); match this
    // option's tier. Claude-family Antigravity models carry no per-model quota bucket, so they
    // fall through to the authenticated ("로그인됨") line below.
    if (getModelFamily('antigravity', option.model) === 'gemini') {
      const tier = modelTier(option.model);
      const win = (antigravity?.windows || []).find((window) => window.key === tier);
      if (win) windows = [win];
    }
  } else if (option.worker === 'gemini') {
    const tier = modelTier(option.model);
    const win = gemini?.windows?.find((w) => w.key === tier);
    if (win) windows = [win];
  } else if (option.worker === 'codex-spark') {
    windows = codex?.spark?.windows || [];
  }

  // Account-level facts that are not a quota window but change how the remaining % should be
  // read: Claude extra usage already burned past the plan, and Codex prepaid credits.
  const extras = quotaExtras(option, { codex, claude: claudeForOption });

  if (windows.length > 0) {
    const now = Date.now();
    const parts = windows.map((win) => {
      let label = win.label;
      if (isDailyQuotaWindow(win)) {
        label = '일간';
      }
      if (!Number.isFinite(win.resetsAtMs)) {
        return `${label}: ${win.remainingPercent}%`;
      }
      const remainingMs = Math.max(0, (win.resetsAtMs || 0) - now);
      const totalMins = Math.floor(remainingMs / 60_000);
      const minutes = totalMins % 60;
      const totalHours = Math.floor(totalMins / 60);
      const hours = totalHours % 24;
      const days = Math.floor(totalHours / 24);

      const isLong = label?.includes('주간') || days > 0;
      if (isLong) {
        return `${label}: ${win.remainingPercent}%, ${days}일 ${hours}시간 ${minutes}분 남음`;
      } else {
        return `${label}: ${win.remainingPercent}%, ${totalHours}시간 ${minutes}분 남음`;
      }
    });
    return wrapQuota([parts.join('; ')], extras);
  }

  if (option.worker === 'antigravity' && antigravity?.state === 'available') {
    const antigravityNote = String(antigravity.note || '').trim();
    if (antigravityNote) return `(${antigravityNote})`;
    const detail = String(antigravity.detail || '').trim();
    if (detail && !/^(로그인됨|인증됨)$/.test(detail)) return `(${detail})`;
    return '(로그인됨)';
  }

  let worker;
  if (option.worker === 'codex-spark') {
    worker = codex;
  } else if (option.worker === 'claude') {
    worker = claudeForOption;
  } else if (option.worker === 'antigravity') {
    worker = antigravity;
  } else {
    worker = workers.get(option.worker);
  }

  if (worker) {
    note = note || worker.note || worker.detail || worker.publishedLimit || '';
    if (worker.state === 'unknown' || worker.state === 'unavailable') {
      note = note || '조회 실패';
    }
  }

  // The model picker should make a not-yet-logged-in Claude profile obvious.
  // Keep detailed expiry diagnostics in `/usage`, but use one concise status
  // in this compact selection list.
  if (
    option.worker === 'claude'
    && worker?.state === 'unavailable'
    && /(?:자격\s*증명|로그인|토큰.*(?:만료|인증))/i.test(note)
  ) {
    return '(인증 필요)';
  }

  if (note) {
    const cleaned = note.replace(/^(로그인됨|인증됨)$/, '').trim();
    return wrapQuota([cleaned], extras);
  }

  return wrapQuota([], extras);
}

// One parenthesised group per row: quota windows (or the status note) first, then the
// account-level extras. Empty pieces drop out so a row with nothing to say stays bare.
function wrapQuota(parts, extras = []) {
  const all = [...parts, ...extras].map((part) => String(part || '').trim()).filter(Boolean);
  return all.length ? `(${all.join(' · ')})` : '';
}

function quotaExtras(option, { codex, claude }) {
  const extras = [];
  if (option.worker === 'claude' && claude?.extra) extras.push(claude.extra);
  // One account-wide balance, shown on the Codex model rows. The Spark row is a sub-limit of
  // the same account, so it is left out rather than repeating the same number a third time.
  if (option.worker === 'codex' && codex?.credits) extras.push(codex.credits);
  return extras;
}

function claudeUsageForOption(worker, option) {
  const accountId = String(option?.claudeAccount?.id || '').trim().toLowerCase();
  if (!accountId) return worker;
  if (worker?.accounts && typeof worker.accounts === 'object' && worker.accounts[accountId]) {
    return worker.accounts[accountId];
  }
  // Older cached summaries only have the primary-account record. Do not paint
  // those numbers onto a distinct selected account.
  if (accountId !== 'primary') {
    return { state: 'unknown', detail: '계정별 사용량 미확인', windows: [] };
  }
  return worker;
}

function isDailyQuotaWindow(window) {
  const label = String(window?.label || '');
  const period = String(window?.period || '').toLowerCase();
  if (label.includes('5시간') || label.includes('주간') || ['5h', 'weekly'].includes(period)) return false;
  const key = String(window?.key || '').toLowerCase();
  return ['pro', 'flash', 'flash-lite'].includes(key)
    || key.includes('gemini')
    || key.includes('claude')
    || key.includes('opus')
    || key.includes('sonnet');
}

function modelTier(model) {
  const modelLower = String(model || '').toLowerCase();
  if (modelLower.includes('flash-lite') || modelLower.includes('flashlite')) return 'flash-lite';
  if (modelLower.includes('flash')) return 'flash';
  if (modelLower.includes('pro')) return 'pro';
  return quotaModelKey(modelLower);
}

function quotaModelKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/^[a-z]+:\s*/, '')
    .replace(/-preview$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function workerModelWindowsForOption(worker, option) {
  if (!worker?.modelWindows || typeof worker.modelWindows !== 'object') return null;
  for (const alias of modelQuotaAliases(option)) {
    const windows = worker.modelWindows[alias];
    if (Array.isArray(windows) && windows.length > 0) return windows;
  }
  return null;
}

function hasWorkerModelWindows(worker) {
  if (!worker?.modelWindows || typeof worker.modelWindows !== 'object') return false;
  return Object.values(worker.modelWindows).some((windows) => Array.isArray(windows) && windows.length > 0);
}

function modelQuotaAliases(option) {
  const rawValues = [
    option?.model,
    option?.id,
    option?.label,
    String(option?.label || '').replace(/^[^:]+:\s*/, ''),
  ].filter(Boolean);
  const text = rawValues.join(' ').toLowerCase();
  if (text.includes('fable')) {
    rawValues.push('claude-fable-5', 'fable-5', 'fable');
  }
  if (text.includes('opus')) {
    rawValues.push('claude-opus-5', 'opus-5', 'opus');
  }
  return [...new Set(rawValues.map((value) => quotaModelKey(value)).filter(Boolean))];
}

function normalizeModelKey(value) {
  return String(value || '').trim().toLowerCase();
}

function plainSelectorKey(value) {
  return normalizeModelKey(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function selectorKey(value) {
  return plainSelectorKey(normalizeModelKey(value).replace(/^[a-z]+:\s*/, ''));
}

// 사용자가 입력한 셀렉터를 매칭 후보로 편다. `antigravity: gemini-3.7-flash`처럼
// 메뉴 라벨을 그대로 붙여넣는 경우를 위해 접두사를 떼어낸 키도 후보에 넣되, 접두사가
// 실제 워커 이름일 때만 그 워커 안에서 찾는다. 접두사를 무조건 잘라내면 `agy:opus`가
// `opus`가 되어 안티그래비티 대신 Claude Opus로 조용히 매칭된다.
function selectorMatchCandidates(options, value) {
  const raw = String(value || '').trim();
  const candidates = [];
  const full = plainSelectorKey(raw);
  if (full) candidates.push({ key: full, worker: null });

  const prefixed = raw.match(/^([a-z][a-z0-9_-]*):\s*(.+)$/i);
  if (!prefixed) return candidates;

  const worker = workerBySelectorPrefix(options, prefixed[1]);
  const key = plainSelectorKey(prefixed[2]);
  if (worker && key) candidates.push({ key, worker });
  return candidates;
}

function workerBySelectorPrefix(options, prefix) {
  const key = plainSelectorKey(prefix);
  if (!key) return null;
  return options.find((option) => plainSelectorKey(option.worker) === key)?.worker || null;
}

function modelSelectorKeys(option = {}) {
  const values = [
    option.id,
    option.model,
    option.label,
    String(option.label || '').replace(/^[^:]+:\s*/, ''),
  ];
  return new Set(values.map(selectorKey).filter(Boolean));
}

function parseScopedClaudeSelector(value) {
  const match = String(value || '').trim().match(/^(.+):([a-z0-9_-]+)$/i);
  if (!match) return null;
  const model = match[1].trim();
  const account = match[2].trim();
  if (!model || !account) return null;
  return { model, account };
}

function modelOptionForSelector(options, selector, claudeAccountId) {
  const key = selectorKey(selector);
  const friendlyMatch = friendlyModelAliasMatcher(key);
  return options.find((option) =>
    option.worker === 'claude'
    && option.claudeAccount?.id === claudeAccountId
    && (friendlyMatch ? friendlyMatch(option) : modelSelectorKeys(option).has(key))
  ) || null;
}

function claudeLabelWithoutAccount(label) {
  return String(label || '').split(' · ')[0].trim();
}

function compactClaudeAccount(account) {
  const id = String(account?.id || '').trim().toLowerCase();
  if (!id) return null;
  const label = String(account?.label || '').trim();
  return label ? { id, label } : { id };
}

function friendlyModelAliasMatcher(key) {
  const matchers = {
    sol: (option) => option.worker === 'codex' && /(?:^|-)sol(?:-|$)/i.test(option.model),
    terra: (option) => option.worker === 'codex' && /(?:^|-)terra(?:-|$)/i.test(option.model),
    luna: (option) => option.worker === 'codex' && /(?:^|-)luna(?:-|$)/i.test(option.model),
    spark: (option) => option.worker === 'codex-spark',
    fable: (option) => option.worker === 'claude' && /fable/i.test(`${option.model} ${option.label}`),
    opus: (option) => option.worker === 'claude' && /opus/i.test(`${option.model} ${option.label}`),
    gemini: (option) => option.worker === 'antigravity' && getModelFamily(option.worker, option.model) === 'gemini',
    'agy-opus': (option) => option.worker === 'antigravity' && getModelFamily(option.worker, option.model) === 'claude',
    'antigravity-opus': (option) => option.worker === 'antigravity' && getModelFamily(option.worker, option.model) === 'claude',
    'agy-pro': (option) => option.worker === 'antigravity' && getModelFamily(option.worker, option.model) === 'gemini',
    'antigravity-pro': (option) => option.worker === 'antigravity' && getModelFamily(option.worker, option.model) === 'gemini',
  };
  return matchers[key] || null;
}

function isLegacyCodexTerraKey(key) {
  return LEGACY_CODEX_TERRA_KEYS.has(key);
}

function slug(value) {
  return normalizeModelKey(value).replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}
