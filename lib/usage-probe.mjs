import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, workerToolSearchPath } from './config.mjs';
import { formatModelQuota, usageQuotaRows } from './thread-models.mjs';
import { claudeAccountOptions } from './claude-accounts.mjs';


const PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_USAGE_CACHE_TTL_MS = 60_000;
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const GEMINI_LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const GEMINI_RETRIEVE_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
// Antigravity talks to the same Code Assist API on a separate host. Its OAuth token (stored
// under the Antigravity HOME) is a standard Google credential, so /usage reads live quota the
// same way the Gemini probe does — loadCodeAssist -> retrieveUserQuota — instead of scraping a
// CLI panel that current `agy` builds no longer emit.
const ANTIGRAVITY_LOAD_CODE_ASSIST_URL = process.env.ANTIGRAVITY_LOAD_CODE_ASSIST_URL
  || 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const ANTIGRAVITY_RETRIEVE_QUOTA_URL = process.env.ANTIGRAVITY_RETRIEVE_QUOTA_URL
  || 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const GEMINI_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Direct OAuth refresh is opt-in. Do not copy third-party client credentials
// into this repository; operators may provide their own values through env.
const CLAUDE_OAUTH_TOKEN_URL = process.env.CLAUDE_OAUTH_TOKEN_URL
  || 'https://console.anthropic.com/v1/oauth/token';
let usageSummaryCache = null;
let credsWriteSeq = 0;

// `/usage` reports the live remaining quota for each worker by going straight to
// the source the official clients use, instead of parsing login-status text:
//   - Codex : `codex app-server` JSON-RPC `account/rateLimits/read` (5h + weekly used%).
//   - Claude: GET https://api.anthropic.com/api/oauth/usage with the worker OAuth token. The
//             token expires within the hour; when it is stale (or rejected) we mint a fresh one
//             from the refresh token AND persist the rotated creds back (Anthropic rotates the
//             refresh token on every grant, unlike Google) so the worker's token stays valid.
//   - Gemini: the same path the CLI `/model` panel uses — `loadCodeAssist` yields the
//             account's `cloudaicompanionProject`, then `retrieveUserQuota` returns the
//             per-model `remainingFraction` buckets we fold into model-tier windows. The
//             stored access token expires hourly, so when it is stale (or gets rejected)
//             we mint a fresh one in memory from the refresh token, like the CLI does.
//   - Antigravity: the same two-step Code Assist path, but against Antigravity's own host and
//             OAuth token (stored under the Antigravity HOME), so the numbers stay scoped to that
//             account and never resolve to native Gemini's. Current `agy` builds no longer emit a
//             scrapable `/model` quota panel, so the CLI is only used to refresh the token.
//             When the quota call does not answer, the row says so instead of degrading silently.
// Account identifiers (email, uuid, project id, token) are never copied into the summary.

export async function collectUsageSummary(config, {
  timeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const checkedAt = new Date(now()).toISOString();
  const [codex, claude, antigravity, gemini] = await Promise.all([
    safeProbe(() => probeCodexUsage(config, { timeoutMs }), codexFallback),
    safeProbe(() => probeClaudeUsage(config, { timeoutMs, fetchImpl, now }), claudeFallback),
    safeProbe(() => probeAntigravityUsage(config, { timeoutMs, fetchImpl, now }), antigravityFallback),
    safeProbe(() => probeGeminiUsage(config, { timeoutMs, fetchImpl, now }), geminiFallback),
  ]);
  return { checkedAt, workers: [codex, claude, antigravity, gemini] };
}

export async function collectCachedUsageSummary(config, {
  cacheTtlMs = DEFAULT_USAGE_CACHE_TTL_MS,
  timeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const nowMs = now();
  const key = usageCacheKey(config);
  if (
    cacheTtlMs > 0 &&
    usageSummaryCache?.key === key &&
    nowMs - usageSummaryCache.cachedAtMs < cacheTtlMs
  ) {
    return usageSummaryCache.summary;
  }

  const summary = await collectUsageSummary(config, { timeoutMs, fetchImpl, now });
  usageSummaryCache = { key, cachedAtMs: nowMs, summary };
  return summary;
}

export function clearUsageSummaryCache() {
  usageSummaryCache = null;
}

export function formatLiveUsageSummary(summary, config = null, { company = false } = {}) {
  if (!config) {
    try {
      config = loadConfig();
    } catch {
      config = {};
    }
  }
  const lines = [`남은 쿼터 요약 (자동 조회, ${formatKst(summary?.checkedAt)} KST):`];
  // One row per quota bucket in a fixed order (see usageQuotaRows), not the
  // channel's fallback order: reading "how much is left" should not change
  // shape when the execution chain is retuned.
  const options = usageQuotaRows(config, { company });
  for (const option of options) {
    const quota = formatModelQuota(option, summary);
    lines.push(`- ${option.label}${quota ? ` ${quota}` : ''}`);
  }
  return lines.join('\n');
}

async function safeProbe(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    return fallback(error);
  }
}

// ---------------------------------------------------------------------------
// Codex: app-server JSON-RPC
// ---------------------------------------------------------------------------

async function probeCodexUsage(config, { timeoutMs }) {
  const bin = config?.codex?.bin || 'codex';
  const home = config?.codex?.home || '';
  const cwd = config?.codex?.cwd || home || process.cwd();
  await fsp.mkdir(cwd, { recursive: true });
  const env = {
    ...process.env,
    CODEX_HOME: home,
    PATH: workerToolSearchPath(config, bin),
  };

  const probe = await fetchCodexRateLimits(bin, args(['app-server']), { env, cwd, timeoutMs });
  if (probe.error) {
    return {
      id: 'codex',
      label: 'Codex',
      state: probe.error === 'missing' ? 'unavailable' : 'unknown',
      detail: codexErrorDetail(probe.error),
      plan: null,
      windows: [],
      source: 'app-server',
    };
  }

  const snapshot = probe.result?.rateLimits || {};
  const byId = probe.result?.rateLimitsByLimitId || {};
  const main = byId.codex || snapshot;
  const spark = findSparkSnapshot(byId);

  return {
    id: 'codex',
    label: 'Codex',
    state: 'available',
    detail: '로그인됨',
    plan: normalizePlan(main.planType),
    windows: rateLimitWindows(main),
    spark: spark ? { label: spark.limitName || 'Spark', windows: rateLimitWindows(spark) } : null,
    credits: creditNote(main.credits),
    source: 'app-server account/rateLimits/read',
  };
}

function findSparkSnapshot(byId) {
  for (const [key, value] of Object.entries(byId || {})) {
    if (key === 'codex') continue;
    if (/spark|bengalfox/i.test(key) || /spark/i.test(value?.limitName || '')) return value;
  }
  return null;
}

function rateLimitWindows(snapshot) {
  const windows = [];
  const primary = rateLimitWindow(snapshot?.primary, '5시간', '5h');
  const secondary = rateLimitWindow(snapshot?.secondary, '주간', 'weekly');
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  return windows;
}

function rateLimitWindow(window, label, key) {
  if (!window || !Number.isFinite(Number(window.usedPercent))) return null;
  const usedPercent = clampPercent(Number(window.usedPercent));
  return {
    key,
    label: window.windowDurationMins ? labelFromDurationMins(window.windowDurationMins, label) : label,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAtMs: toMs(window.resetsAt),
    // Carried so callers can reason about the window's real length instead of
    // assuming one (adaptive maintenance compares budget against elapsed window).
    windowDurationMins: Number(window.windowDurationMins) > 0
      ? Number(window.windowDurationMins)
      : null,
  };
}

function fetchCodexRateLimits(bin, spawnArgs, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, spawnArgs, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error: error.code === 'ENOENT' ? 'missing' : error.message });
      return;
    }

    let buffer = '';
    let settled = false;
    let nextId = 1;
    const pending = new Map();

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(value);
    };

    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);

    const send = (method, params) => {
      const id = nextId++;
      const response = new Promise((res) => pending.set(id, res));
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        finish({ error: error.message });
      }
      return response;
    };

    child.on('error', (error) => finish({ error: error.code === 'ENOENT' ? 'missing' : error.message }));
    // Async EPIPE from writing to an already-exited app-server must not crash the
    // bridge; the close handler below settles the probe.
    child.stdin.on('error', () => {});
    let stderrText = '';
    child.stderr.on('data', (chunk) => {
      stderrText += chunk;
      if (stderrText.length > 4000) stderrText = stderrText.slice(-4000);
    });
    // An app-server that exits before answering (e.g. logged out) would otherwise
    // leave the JSON-RPC responses pending until the full timeout. setImmediate
    // lets a response already sitting in the stdout buffer settle first.
    child.on('close', (code) => {
      setImmediate(() => finish({ error: stderrText.trim() || `codex app-server exited early (code ${code})` }));
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === undefined) continue;
        if (message.result === undefined && message.error === undefined) continue;
        const resolver = pending.get(message.id);
        if (resolver) {
          pending.delete(message.id);
          resolver(message);
        }
      }
    });

    (async () => {
      const init = await send('initialize', { clientInfo: { name: 'codex-bridge-usage', version: '1.0.0' } });
      if (settled) return;
      if (init?.error) {
        finish({ error: init.error.message || 'initialize failed' });
        return;
      }
      const rateLimits = await send('account/rateLimits/read', null);
      if (settled) return;
      if (rateLimits?.error) {
        finish({ error: rateLimits.error.message || 'rate limit read failed' });
        return;
      }
      finish({ result: rateLimits.result });
    })().catch((error) => finish({ error: error.message }));
  });
}

function codexErrorDetail(error) {
  if (error === 'missing') return 'Codex CLI 없음';
  if (error === 'timeout') return 'Codex 사용량 조회 timeout';
  if (/not logged in|unauthenticated|login/i.test(String(error))) return '로그인 필요';
  return `Codex 사용량 조회 실패: ${shortError(error)}`;
}

// ---------------------------------------------------------------------------
// Claude: OAuth usage endpoint
// ---------------------------------------------------------------------------

async function probeClaudeUsage(config, { timeoutMs, fetchImpl, now }) {
  const accounts = claudeAccountOptions(config);
  const configured = accounts.length > 0
    ? accounts
    : [{ id: 'primary', label: '기본', home: config?.claude?.home || '' }];
  const records = await Promise.all(configured.map(async (account) => {
    try {
      return [account.id, await probeClaudeHomeUsage(account.home, { timeoutMs, fetchImpl, now })];
    } catch (error) {
      return [account.id, claudeFallback(error)];
    }
  }));
  const byAccount = Object.fromEntries(records);
  const primary = byAccount[configured[0].id] || claudeFallback(new Error('Claude 계정 설정 없음'));

  // Keep the existing top-level shape for `/usage` and old callers, while
  // exposing account-specific records to the `/model` menu. No email/token is
  // included in either record.
  return {
    ...primary,
    accounts: byAccount,
  };
}

async function probeClaudeHomeUsage(home, { timeoutMs, fetchImpl, now }) {
  const credsPath = path.join(home, '.claude', '.credentials.json');
  const creds = await readJsonFile(credsPath);
  const oauth = creds?.claudeAiOauth || creds || {};
  const plan = normalizeClaudePlan(oauth.subscriptionType);
  const refreshToken = claudeRefreshToken(oauth);
  const refreshable = Boolean(refreshToken);
  let token = oauth.accessToken || null;

  if (!token && !refreshable) {
    return claudeRecord({ state: 'unavailable', detail: '자격 증명 없음', plan });
  }
  // Token present but expired and we have no way to refresh it → re-auth needed; skip the call.
  if (!refreshable && isExpiredAt(oauth.expiresAt, now)) {
    return claudeRecord({ state: 'unavailable', detail: '토큰 만료/재인증 필요', plan });
  }

  // The Anthropic access token expires within the hour. When it is missing or stale we mint a
  // fresh one from the refresh token — exactly what the CLI does — and PERSIST the rotated creds:
  // Anthropic invalidates the previous refresh token on every grant (unlike Google), so writing it
  // back is what keeps the worker's own stored token valid. The write is atomic and best-effort.
  let refreshed = false;
  if ((!token || isExpiredAt(oauth.expiresAt, now)) && refreshable) {
    const fresh = await refreshClaudeAccessToken(refreshToken, { fetchImpl, timeoutMs, now });
    if (fresh) {
      token = fresh.accessToken;
      refreshed = true;
      await persistClaudeCreds(credsPath, fresh, { expectedRefreshToken: refreshToken });
    }
  }
  if (!token) {
    // Refreshable but the refresh itself failed (offline / Cloudflare 403 / endpoint down). Auth
    // is intact — the CLI can still run — so report authenticated, just without live numbers now.
    if (refreshable) return authOnlyClaudeRecord({ plan, reason: '토큰 갱신 일시 실패' });
    return claudeRecord({ state: 'unavailable', detail: '토큰 만료/재인증 필요', plan });
  }

  const callUsage = (accessToken) => fetchWithTimeout(fetchImpl, ANTHROPIC_USAGE_URL, {
    method: 'GET',
    headers: claudeHeaders(accessToken),
  }, timeoutMs);

  let response;
  try {
    response = await callUsage(token);
    // A stored token can be revoked/rejected even before its recorded expiry; refresh once + retry.
    if ((response.status === 401 || response.status === 403) && refreshable && !refreshed) {
      const fresh = await refreshClaudeAccessToken(refreshToken, { fetchImpl, timeoutMs, now });
      if (fresh) {
        token = fresh.accessToken;
        refreshed = true;
        await persistClaudeCreds(credsPath, fresh, { expectedRefreshToken: refreshToken });
        response = await callUsage(token);
      }
    }
  } catch (error) {
    return authOnlyClaudeRecord({ plan, reason: `API 연결 확인 필요: ${shortError(error)}` });
  }

  if (response.status === 401 || response.status === 403) {
    if (refreshable) return authOnlyClaudeRecord({ plan });
    return claudeRecord({ state: 'unavailable', detail: '토큰 만료/재인증 필요', plan });
  }
  if (response.status === 429) {
    return authOnlyClaudeRecord({ plan, reason: '사용량 API 제한' });
  }
  if (!response.ok) {
    return authOnlyClaudeRecord({ plan, reason: `사용량 API HTTP ${response.status}` });
  }

  let data;
  try { data = await response.json(); } catch { data = null; }
  const windows = [];
  const fiveHour = utilizationWindow(data?.five_hour, '5시간', '5h');
  const sevenDay = utilizationWindow(data?.seven_day, '주간', 'weekly');
  if (fiveHour) windows.push(fiveHour);
  if (sevenDay) windows.push(sevenDay);
  const modelWindows = claudeModelQuotaWindows(data);

  return claudeRecord({
    state: 'available',
    detail: '로그인됨',
    plan,
    windows,
    modelWindows,
    extra: extraUsageNote(data?.extra_usage),
    source: 'oauth/usage',
  });
}

function claudeRecord(fields) {
  return { id: 'claude', label: 'Claude', windows: [], source: 'oauth/usage', ...fields };
}

function authOnlyClaudeRecord({ plan, reason = '' }) {
  return claudeRecord({
    state: 'available',
    detail: authOnlyDetail(),
    plan,
    note: usageUnavailableNote(reason),
    source: 'oauth-creds',
  });
}

function claudeHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    'User-Agent': 'claude-cli (bridge-usage-probe)',
    Accept: 'application/json',
  };
}

function utilizationWindow(window, label, key) {
  if (!window || !Number.isFinite(Number(window.utilization))) return null;
  const usedPercent = clampPercent(Math.round(Number(window.utilization)));
  return {
    key,
    label,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAtMs: toMs(window.resets_at),
  };
}

function claudeModelQuotaWindows(data) {
  const byModel = {};
  for (const entry of claudeModelUsageEntries(data)) {
    const key = modelQuotaKey(entry.modelId || entry.model_id || entry.model || entry.id || entry.name || entry.key);
    if (!key) continue;
    const windows = usageWindowsFromModelEntry(entry);
    if (windows.length > 0) byModel[key] = windows;
  }
  return Object.keys(byModel).length > 0 ? byModel : null;
}

function claudeModelUsageEntries(data) {
  const candidates = [
    data?.model_usage,
    data?.modelUsage,
    data?.model_quotas,
    data?.modelQuotas,
    data?.model_limits,
    data?.modelLimits,
    data?.models,
    data?.buckets,
  ];
  const entries = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      entries.push(...candidate.filter((entry) => entry && typeof entry === 'object'));
      continue;
    }
    if (typeof candidate === 'object') {
      for (const [key, value] of Object.entries(candidate)) {
        if (value && typeof value === 'object') entries.push({ key, ...value });
      }
    }
  }
  return entries;
}

function usageWindowsFromModelEntry(entry) {
  const windows = [];
  const fiveHour = utilizationWindow(entry?.five_hour || entry?.fiveHour || entry?.primary, '5시간', '5h');
  const sevenDay = utilizationWindow(entry?.seven_day || entry?.sevenDay || entry?.secondary, '주간', 'weekly');
  if (fiveHour) windows.push(fiveHour);
  if (sevenDay) windows.push(sevenDay);
  if (windows.length > 0) return windows;

  const fraction = Number(entry?.remainingFraction ?? entry?.remaining_fraction);
  if (!Number.isFinite(fraction)) return [];
  const remainingPercent = clampPercent(Math.round(fraction * 100));
  const label = entry?.label || entry?.windowLabel || entry?.window_label || '일간';
  return [{
    key: entry?.period || entry?.window || 'model',
    label,
    usedPercent: clampPercent(100 - remainingPercent),
    remainingPercent,
    resetsAtMs: toMs(entry?.resetTime || entry?.reset_time || entry?.resetsAt || entry?.resets_at),
  }];
}

function extraUsageNote(extra) {
  if (!extra || !extra.is_enabled) return null;
  if (Number.isFinite(Number(extra.utilization))) {
    return `추가사용 ${clampPercent(Math.round(Number(extra.utilization)))}% 사용`;
  }
  return '추가사용 활성';
}

// ---------------------------------------------------------------------------
// Gemini: Code Assist per-model quota (same data the CLI `/model` panel shows)
// ---------------------------------------------------------------------------

const GEMINI_TIER_ORDER = ['pro', 'flash', 'flash-lite'];
const GEMINI_TIER_LABEL = { pro: 'Pro', flash: 'Flash', 'flash-lite': 'Flash Lite' };

async function probeGeminiUsage(config, { timeoutMs, fetchImpl, now }) {
  const home = config?.gemini?.home || '';
  const creds = await readJsonFile(path.join(home, '.gemini', 'oauth_creds.json'));
  const refreshToken = geminiRefreshToken(creds);
  const refreshable = Boolean(refreshToken);
  let token = geminiAccessToken(creds);

  if (!token && !refreshable) {
    return geminiRecord({ state: 'unavailable', detail: '자격 증명 없음' });
  }

  // The stored access token expires hourly. When it is missing or stale we mint a fresh one
  // from the refresh token — in memory only, exactly like the CLI does on its next run — so
  // `/usage` keeps reporting real quota instead of degrading the moment the token ages out.
  let refreshed = false;
  if ((!token || isExpiredAt(geminiExpiry(creds), now)) && refreshable) {
    const fresh = await refreshGeminiAccessToken(refreshToken, { fetchImpl, timeoutMs });
    if (fresh) {
      token = fresh;
      refreshed = true;
    }
  }
  if (!token) {
    // Refreshable but the refresh itself failed (offline / endpoint down). Auth is intact —
    // the CLI can still run — so report authenticated, just without live numbers right now.
    if (refreshable) return authOnlyGeminiRecord({ reason: '토큰 갱신 일시 실패' });
    return geminiRecord({ state: 'unavailable', detail: '토큰 만료/재인증 필요' });
  }

  const loadCodeAssist = (accessToken) => fetchWithTimeout(fetchImpl, GEMINI_LOAD_CODE_ASSIST_URL, {
    method: 'POST',
    headers: geminiHeaders(accessToken),
    body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
  }, timeoutMs);

  // Step 1: loadCodeAssist -> account tier + the project id quota is scoped to.
  let tier = null;
  let project = null;
  try {
    let response = await loadCodeAssist(token);
    // A stored token can be revoked/rejected even before its recorded expiry; refresh once and retry.
    if ((response.status === 401 || response.status === 403) && refreshable && !refreshed) {
      const fresh = await refreshGeminiAccessToken(refreshToken, { fetchImpl, timeoutMs });
      if (fresh) {
        token = fresh;
        refreshed = true;
        response = await loadCodeAssist(token);
      }
    }
    if (response.status === 401 || response.status === 403) {
      if (refreshable) return authOnlyGeminiRecord();
      return geminiRecord({ state: 'unavailable', detail: '토큰 만료/재인증 필요' });
    }
    if (response.status === 429) return authOnlyGeminiRecord({ reason: '사용량 API 제한' });
    if (response.ok) {
      let data;
      try { data = await response.json(); } catch { data = null; }
      tier = normalizeGeminiTier(data?.currentTier?.id || data?.currentTier?.name);
      project = data?.cloudaicompanionProject || null;
    }
  } catch (error) {
    return authOnlyGeminiRecord({ reason: `API 연결 확인 필요: ${shortError(error)}` });
  }

  // Step 2: retrieveUserQuota -> per-model remainingFraction buckets -> tier windows.
  const quota = await fetchModelQuota({
    fetchImpl, url: GEMINI_RETRIEVE_QUOTA_URL, token, project, timeoutMs,
  });

  if (quota.windows.length) {
      return geminiRecord({
        state: 'available',
        detail: '로그인됨',
        plan: tier,
        windows: quota.windows,
        quotaScopeFingerprint: quotaScopeFingerprint(project),
        source: 'retrieveUserQuota',
      });
  }

  return geminiRecord({
    state: 'available',
    detail: authOnlyDetail(),
    plan: tier,
    note: quota.failure
      ? quotaFailureNote(quota.failure)
      : usageUnavailableNote(tier ? '모델별 잔여 쿼터 미수신' : ''),
    publishedLimit: tier && tier !== 'free' ? null : '무료 한도 1,000회/일·60회/분(모델 요청)',
    source: tier ? 'loadCodeAssist' : 'oauth-creds',
  });
}

// `retrieveUserQuota` is normally scoped to the Code Assist project `loadCodeAssist` hands back.
// When that response carries no project (the account is not onboarded to this host's project
// scope) we still ask for the quota account-scoped instead of skipping step 2 entirely, which
// used to make the row read as a plain "로그인됨" with no hint that nothing was ever queried.
// A project-scoped call that answers with no buckets also gets the account-scoped retry.
// `failure` is set only for a call that did not answer (HTTP error / network / bad body); a 200
// with no buckets is a real answer ("no per-model quota for this account"), not a failure.
async function fetchModelQuota({ fetchImpl, url, token, project, timeoutMs, foldWindows = geminiTierWindows }) {
  const bodies = project ? [{ project }, {}] : [{}];
  let failure = '';
  let answered = false;
  for (const body of bodies) {
    try {
      const response = await fetchWithTimeout(fetchImpl, url, {
        method: 'POST',
        headers: geminiHeaders(token),
        body: JSON.stringify(body),
      }, timeoutMs);
      if (!response.ok) {
        failure = `쿼터 API HTTP ${response.status}`;
        continue;
      }
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!data) {
        failure = '쿼터 응답 해석 불가';
        continue;
      }
      const windows = foldWindows(data.buckets);
      if (windows.length) return { windows, failure: '' };
      // Answered, just with nothing to report. A later attempt failing must not turn this
      // into a "조회 실패" line — the API did tell us there is no per-model quota here.
      answered = true;
    } catch (error) {
      failure = `쿼터 API 연결 실패: ${shortError(error)}`;
    }
  }
  return { windows: [], failure: answered ? '' : failure };
}

function geminiRecord(fields) {
  return { id: 'gemini', label: 'Gemini', windows: [], source: 'retrieveUserQuota', ...fields };
}

function authOnlyGeminiRecord({ plan = null, reason = '' } = {}) {
  return geminiRecord({
    state: 'available',
    detail: authOnlyDetail(),
    plan,
    note: usageUnavailableNote(reason),
    source: 'oauth-creds',
  });
}

function geminiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// Fold the per-model quota buckets into model-tier windows, matching how the
// Gemini CLI `/model` panel groups them: one row per tier, keeping the most-used
// (lowest remainingFraction) model in that tier.
function geminiTierWindows(buckets) {
  const byTier = new Map();
  for (const bucket of buckets || []) {
    const fraction = Number(bucket?.remainingFraction);
    if (!bucket?.modelId || bucket.remainingFraction == null || !Number.isFinite(fraction)) continue;
    const tier = geminiTier(bucket.modelId);
    const existing = byTier.get(tier);
    if (!existing || fraction < Number(existing.remainingFraction)) byTier.set(tier, bucket);
  }
  return [...byTier.entries()]
    .sort((a, b) => geminiTierRank(a[0]) - geminiTierRank(b[0]))
    .map(([tier, bucket]) => {
      const remainingPercent = clampPercent(Math.round(Number(bucket.remainingFraction) * 100));
      return {
        key: tier,
        label: GEMINI_TIER_LABEL[tier] || tier,
        usedPercent: clampPercent(100 - remainingPercent),
        remainingPercent,
        resetsAtMs: toMs(bucket.resetTime),
      };
    });
}

function geminiTier(modelId) {
  const id = String(modelId).toLowerCase();
  if (id.includes('flash-lite') || id.includes('flashlite')) return 'flash-lite';
  if (id.includes('flash')) return 'flash';
  if (id.includes('pro')) return 'pro';
  return id;
}

function geminiTierRank(tier) {
  const index = GEMINI_TIER_ORDER.indexOf(tier);
  return index < 0 ? GEMINI_TIER_ORDER.length : index;
}

// ---------------------------------------------------------------------------
// Antigravity: CLI `/model` quota panel under its own HOME/account
// ---------------------------------------------------------------------------

async function probeAntigravityUsage(config, { timeoutMs, fetchImpl, now }) {
  const home = config?.antigravity?.home || '';
  if (!home) return antigravityRecord({ state: 'unavailable', detail: '자격 증명 없음', source: 'antigravity oauth-creds' });

  let creds = await readAntigravityCreds(home);
  let token = geminiAccessToken(creds);
  const refreshable = Boolean(geminiRefreshToken(creds));

  // Antigravity signs tokens with its own OAuth client, so the Gemini refresh_token grant
  // can't mint a fresh one. When the stored token is missing/stale we let the `agy` CLI
  // refresh + persist it (what it does on any authenticated call), then re-read from disk.
  if ((!token || isExpiredAt(geminiExpiry(creds), now)) && config?.antigravity?.bin) {
    await refreshAntigravityTokenViaCli(config, { timeoutMs });
    creds = await readAntigravityCreds(home);
    token = geminiAccessToken(creds);
  }

  if (!token) {
    if (refreshable) return authOnlyAntigravityRecord({ reason: '토큰 갱신 필요(CLI 재로그인)' });
    return antigravityRecord({ state: 'unavailable', detail: '자격 증명 없음', source: 'antigravity oauth-creds' });
  }

  // Step 1: loadCodeAssist -> account tier + the project id quota is scoped to.
  let tier = null;
  let project = null;
  try {
    const response = await fetchWithTimeout(fetchImpl, ANTIGRAVITY_LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: geminiHeaders(token),
      body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
    }, timeoutMs);
    if (response.status === 401 || response.status === 403) return authOnlyAntigravityRecord({ reason: '토큰 만료/재인증 필요' });
    if (response.status === 429) return authOnlyAntigravityRecord({ reason: '사용량 API 제한' });
    if (response.ok) {
      let data;
      try { data = await response.json(); } catch { data = null; }
      tier = normalizeGeminiTier(data?.currentTier?.id || data?.currentTier?.name);
      project = data?.cloudaicompanionProject || null;
    }
  } catch (error) {
    return authOnlyAntigravityRecord({ reason: `API 연결 확인 필요: ${shortError(error)}` });
  }

  // Step 2: retrieveUserQuota -> per-model remainingFraction buckets -> Gemini tier windows.
  // Antigravity's API only returns Gemini-model buckets; its Claude/GPT models carry no
  // per-model quota, so those rows surface as authenticated ("로그인됨") below.
  const quota = await fetchModelQuota({
    fetchImpl, url: ANTIGRAVITY_RETRIEVE_QUOTA_URL, token, project, timeoutMs,
  });

  if (quota.windows.length) {
    return antigravityRecord({
      state: 'available',
      detail: '로그인됨',
      plan: tier,
      windows: quota.windows,
      source: 'antigravity retrieveUserQuota',
    });
  }

  // The quota call never answered. Auth is intact, so keep the row usable, but say the numbers
  // are missing instead of printing a bare "로그인됨" that reads like a healthy lookup.
  if (quota.failure) {
    return antigravityRecord({
      state: 'available',
      detail: '로그인됨',
      plan: tier,
      note: quotaFailureNote(quota.failure),
      source: tier ? 'antigravity loadCodeAssist' : 'antigravity oauth-creds',
    });
  }

  // Authenticated and the API answered with no buckets (e.g. Claude-only account):
  // report as logged-in/eligible rather than a failure line.
  return antigravityRecord({
    state: 'available',
    detail: '로그인됨',
    plan: tier,
    source: tier ? 'antigravity loadCodeAssist' : 'antigravity oauth-creds',
  });
}

async function readAntigravityCreds(home) {
  for (const credPath of antigravityCredsPaths(home)) {
    const data = await readJsonFile(credPath);
    if (data && (geminiAccessToken(data) || geminiRefreshToken(data))) return data;
  }
  return null;
}

// Best-effort: a quick `agy models` run makes the CLI refresh + persist its OAuth token on disk.
async function refreshAntigravityTokenViaCli(config, { timeoutMs }) {
  const bin = config?.antigravity?.bin;
  if (!bin) return;
  const limit = Math.max(1, Math.min(timeoutMs || PROBE_TIMEOUT_MS, config?.antigravity?.preflightTimeoutMs || 15_000));
  await runCommandCapture(bin, ['models'], {
    cwd: config?.codex?.cwd || config?.antigravity?.home,
    env: antigravityEnv(config),
    timeoutMs: limit,
  });
}

function antigravityCredsPaths(home) {
  return [
    path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(home, '.gemini', 'oauth_creds.json'),
    path.join(home, '.antigravity', 'oauth_creds.json'),
    path.join(home, '.config', 'antigravity', 'oauth_creds.json'),
    path.join(home, '.config', 'gemini', 'oauth_creds.json'),
  ];
}

function antigravityEnv(config) {
  const bin = config?.antigravity?.bin || '';
  const home = config?.antigravity?.home || '';
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    ANTIGRAVITY_CLI_TRUST_WORKSPACE: 'true',
    COLUMNS: process.env.COLUMNS || '100',
    LINES: process.env.LINES || '40',
    PATH: workerToolSearchPath(config, bin),
  };
}

function runCommandCapture(command, spawnArgs, {
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  inputSteps = [],
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, spawnArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error: error.code === 'ENOENT' ? 'missing' : error.message, stdout: '', stderr: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const stepTimers = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stepTimer of stepTimers) clearTimeout(stepTimer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ code: null, signal: 'SIGKILL', timedOut, stdout, stderr });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => { /* EPIPE from an already-exited CLI */ });
    child.on('error', (error) => finish({ error: error.code === 'ENOENT' ? 'missing' : error.message, stdout, stderr }));
    child.on('close', (code, signal) => finish({ code, signal, timedOut, stdout, stderr }));

    for (const step of inputSteps) {
      stepTimers.push(setTimeout(() => {
        try { child.stdin.write(step.data); } catch { /* process already exited */ }
      }, Math.max(0, step.delayMs || 0)));
    }
    // CLIs that read stdin to EOF hang until the timeout SIGKILL unless stdin is
    // closed once all scripted input has been written.
    const lastStepDelayMs = inputSteps.reduce((max, step) => Math.max(max, step.delayMs || 0), 0);
    stepTimers.push(setTimeout(() => {
      try { child.stdin.end(); } catch { /* process already exited */ }
    }, inputSteps.length > 0 ? lastStepDelayMs + 100 : 0));
  });
}

function antigravityRecord(fields) {
  return { id: 'antigravity', label: 'Antigravity', windows: [], source: 'antigravity', ...fields };
}

function authOnlyAntigravityRecord({ plan = null, reason = '' } = {}) {
  return antigravityRecord({
    state: 'available',
    detail: authOnlyDetail(),
    plan,
    note: usageUnavailableNote(reason),
    source: 'antigravity oauth-creds',
  });
}

function modelQuotaWindows(buckets) {
  const byModel = new Map();
  for (const bucket of buckets || []) {
    const fraction = Number(bucket?.remainingFraction);
    if (!bucket?.modelId || bucket.remainingFraction == null || !Number.isFinite(fraction)) continue;
    const key = modelQuotaKey(bucket.modelId);
    const existing = byModel.get(key);
    if (!existing || fraction < Number(existing.remainingFraction)) byModel.set(key, bucket);
  }
  return [...byModel.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, bucket]) => {
      const remainingPercent = clampPercent(Math.round(Number(bucket.remainingFraction) * 100));
      return {
        key,
        modelId: bucket.modelId,
        label: bucket.modelId,
        usedPercent: clampPercent(100 - remainingPercent),
        remainingPercent,
        resetsAtMs: toMs(bucket.resetTime),
      };
    });
}

function modelQuotaKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/^[a-z]+:\s*/, '')
    .replace(/-preview$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeGeminiTier(value) {
  const tier = String(value || '').toLowerCase();
  if (!tier) return null;
  if (tier.includes('free')) return 'free';
  if (tier.includes('legacy')) return 'legacy';
  if (tier.includes('standard')) return 'standard';
  if (tier.includes('enterprise')) return 'enterprise';
  return tier;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// `/usage` renders one row per fallback-chain model via `formatModelQuota`, so the old
// per-worker line renderer is gone. `credits`/`extra` are attached to those rows there.

function creditNote(credits) {
  if (!credits) return null;
  if (credits.unlimited) return '크레딧 무제한';
  if (credits.hasCredits && credits.balance != null) return `크레딧 ${credits.balance}`;
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function args(list) {
  return list;
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readFirstJsonFile(filePaths) {
  for (const filePath of filePaths) {
    const value = await readJsonFile(filePath);
    if (value) return value;
  }
  return null;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function toMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isExpiredAt(value, now) {
  const expiresAt = toMs(value);
  return Number.isFinite(expiresAt) && now() > expiresAt;
}

function claudeRefreshToken(oauth) {
  return oauth?.refreshToken
    || oauth?.refresh_token
    || oauth?.oauthRefreshToken
    || oauth?.claudeAiOauth?.refreshToken
    || oauth?.claudeAiOauth?.refresh_token
    || null;
}

function geminiRefreshToken(creds) {
  return creds?.refresh_token || creds?.refreshToken || creds?.token?.refresh_token || creds?.token?.refreshToken || null;
}

function geminiAccessToken(creds) {
  return creds?.access_token || creds?.accessToken || creds?.token?.access_token || creds?.token?.accessToken || null;
}

function geminiExpiry(creds) {
  return creds?.expiry_date
    || creds?.expiryDate
    || creds?.expiry
    || creds?.expires_at
    || creds?.expiresAt
    || creds?.token?.expiry_date
    || creds?.token?.expiryDate
    || creds?.token?.expiry
    || creds?.token?.expires_at
    || creds?.token?.expiresAt
    || null;
}

// Exchange the user's long-lived refresh token for a short-lived access token (Google's
// standard refresh_token grant). Returns the access token string, or null on any failure.
// Google does NOT return a new refresh token here, so nothing is rotated and nothing is
// written to disk — the call is side-effect-free.
async function refreshGeminiAccessToken(refreshToken, { fetchImpl, timeoutMs }) {
  if (!refreshToken) return null;
  const clientId = String(process.env.GEMINI_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GEMINI_OAUTH_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, GEMINI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, timeoutMs);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let data;
  try { data = await response.json(); } catch { return null; }
  return data?.access_token || null;
}

// Exchange the user's refresh token for a fresh Claude access token (OAuth refresh_token grant).
// Anthropic ROTATES the refresh token on every grant — the response carries a NEW refresh token
// and the old one is invalidated — so callers MUST persist the result (see persistClaudeCreds) or
// the worker's stored token goes stale. Returns { accessToken, refreshToken, expiresAt } or null.
async function refreshClaudeAccessToken(refreshToken, { fetchImpl, timeoutMs, now }) {
  if (!refreshToken) return null;
  const clientId = String(process.env.CLAUDE_OAUTH_CLIENT_ID || '').trim();
  if (!clientId) return null;
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, CLAUDE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'claude-cli (bridge-usage-probe)',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    }, timeoutMs);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let data;
  try { data = await response.json(); } catch { return null; }
  const accessToken = data?.access_token || null;
  if (!accessToken) return null;
  const expiresInSec = Number(data?.expires_in) > 0 ? Number(data.expires_in) : 3600;
  return {
    accessToken,
    // Anthropic returns a rotated refresh token; fall back to the old one only if it's absent.
    refreshToken: data?.refresh_token || refreshToken,
    expiresAt: now() + expiresInSec * 1000,
  };
}

// Persist refreshed Claude creds back to .credentials.json so the rotated refresh token survives
// for the worker's next run. Merge into the existing structure (preserving unrelated fields),
// write atomically (temp + rename, mode 0600), and never throw. Compare-and-set: if a worker
// rotated the token out from under us between our read and now, leave its newer creds alone.
async function persistClaudeCreds(credsPath, fresh, { expectedRefreshToken } = {}) {
  try {
    const current = await readJsonFile(credsPath);
    if (!current || typeof current !== 'object') return false;
    const oauth = (current.claudeAiOauth && typeof current.claudeAiOauth === 'object')
      ? current.claudeAiOauth
      : current;
    const onDisk = oauth.refreshToken || oauth.refresh_token || null;
    if (expectedRefreshToken && onDisk && onDisk !== expectedRefreshToken) return false;
    oauth.accessToken = fresh.accessToken;
    oauth.refreshToken = fresh.refreshToken;
    if (fresh.expiresAt) oauth.expiresAt = fresh.expiresAt;
    const tmp = `${credsPath}.tmp-${process.pid}-${credsWriteSeq++}`;
    await fsp.writeFile(tmp, JSON.stringify(current), { mode: 0o600 });
    await fsp.rename(tmp, credsPath);
    return true;
  } catch {
    return false;
  }
}

function usageCacheKey(config) {
  return JSON.stringify({
    codex: {
      bin: config?.codex?.bin || 'codex',
      home: config?.codex?.home || '',
      cwd: config?.codex?.cwd || '',
    },
    claude: {
      home: config?.claude?.home || '',
      accounts: claudeAccountOptions(config).map((account) => ({
        id: account.id,
        home: account.home,
      })),
    },
    gemini: {
      home: config?.gemini?.home || '',
    },
    antigravity: {
      home: config?.antigravity?.home || '',
    },
  });
}

function authOnlyDetail() {
  return '인증됨';
}

function usageUnavailableNote(reason = '') {
  const trimmed = String(reason || '').trim();
  return trimmed ? `잔여 쿼터 조회만 미확인(${trimmed})` : '잔여 쿼터 조회만 미확인';
}

// A failed quota lookup on an authenticated worker. The auth state rides along in the note text
// because the compact `/usage` and `/model` rows print the note in place of the detail, and
// "쿼터 조회 실패" on its own would read as if the worker itself were unusable.
function quotaFailureNote(reason = '') {
  const trimmed = String(reason || '').trim();
  return `로그인됨 · 쿼터 조회 실패${trimmed ? `(${trimmed})` : ''}`;
}

function quotaScopeFingerprint(value) {
  const scope = String(value || '').trim();
  if (!scope) return null;
  return createHash('sha256').update(scope).digest('hex');
}

function labelFromDurationMins(mins, fallback) {
  const minutes = Number(mins);
  if (!Number.isFinite(minutes)) return fallback;
  if (minutes <= 360) return `${Math.round(minutes / 60)}시간`;
  if (minutes >= 1440) return minutes >= 10080 ? '주간' : `${Math.round(minutes / 1440)}일`;
  return fallback;
}

function normalizePlan(planType) {
  const plan = String(planType || '').trim();
  if (!plan || plan === 'unknown') return null;
  return plan;
}

function normalizeClaudePlan(subscriptionType) {
  const plan = String(subscriptionType || '').trim();
  return plan || null;
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.split(/\r?\n/)[0].slice(0, 80) || 'unknown';
}

function formatKst(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '시간 확인 불가';
  return kstStamp(date);
}

function kstStamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('month')}/${get('day')} ${hour}:${get('minute')}`;
}

function codexFallback(error) {
  return { id: 'codex', label: 'Codex', state: 'unknown', detail: `조회 실패: ${shortError(error)}`, windows: [], source: 'app-server' };
}

function claudeFallback(error) {
  return { id: 'claude', label: 'Claude', state: 'unknown', detail: `조회 실패: ${shortError(error)}`, windows: [], source: 'oauth/usage' };
}

function geminiFallback(error) {
  return { id: 'gemini', label: 'Gemini', state: 'unknown', detail: `조회 실패: ${shortError(error)}`, windows: [], source: 'retrieveUserQuota' };
}

function antigravityFallback(error) {
  return { id: 'antigravity', label: 'Antigravity', state: 'unknown', detail: `조회 실패: ${shortError(error)}`, windows: [], source: 'antigravity' };
}
