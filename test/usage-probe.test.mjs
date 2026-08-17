import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearUsageSummaryCache,
  collectCachedUsageSummary,
  collectUsageSummary,
  formatLiveUsageSummary as formatLiveUsageSummaryWithConfig,
} from '../lib/usage-probe.mjs';
import { loadConfig } from '../lib/config.mjs';

process.env.GEMINI_OAUTH_CLIENT_ID = 'test-gemini-client-id';
process.env.GEMINI_OAUTH_CLIENT_SECRET = 'test-gemini-client-secret';
process.env.CLAUDE_OAUTH_CLIENT_ID = 'test-claude-client-id';

const FIXED_NOW = Date.UTC(2026, 5, 15, 7, 0, 0); // 2026-06-15T07:00:00Z
const TEST_CONFIG = loadConfig({
  PROJECT_ROOT: '/tmp/projects',
  BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
});
const formatLiveUsageSummary = (summary, config = TEST_CONFIG, options = {}) =>
  formatLiveUsageSummaryWithConfig(summary, config, options);
const ANTIGRAVITY_MODEL_PANEL = `
└ Models & Quota

  Account: user@example.com

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit
    [███████████████████████████████████████████████░░░] 93.51%
    94% remaining · Refreshes in 164h 18m

  Five Hour Limit
    [███████████████████████████████░░░░░░░░░░░░░░░░░░░] 61.76%
    62% remaining · Refreshes in 1h 18m

CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available

  Five Hour Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available
`;

test('/usage lists one row per quota bucket in a fixed order', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  });
  const summary = {
    checkedAt: '2026-06-15T07:00:00.000Z',
    workers: [],
  };

  const labels = (company) => formatLiveUsageSummary(summary, config, { company })
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^- /, ''));

  const expected = ['Codex', 'Claude', 'Gemini', 'Codex Spark', 'AGY Opus'];
  // The view is quota buckets, not execution order, so a company channel's
  // Claude-first fallback must not reshuffle it.
  assert.deepEqual(labels(false), expected);
  assert.deepEqual(labels(true), expected);
});

test('/usage keeps a chain-only worker that owns its own quota bucket', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex,gemini',
  });
  const labels = formatLiveUsageSummary({ checkedAt: '2026-06-15T07:00:00.000Z', workers: [] }, config)
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^- /, '').replace(/ \(.*$/, ''));

  // Native Gemini is a separate account from Antigravity's Gemini tiers; its
  // numbers have nowhere else to appear.
  assert.deepEqual(labels.slice(0, 5), ['Codex', 'Claude', 'Gemini', 'Codex Spark', 'AGY Opus']);
  assert.ok(labels.slice(5).some((label) => label.startsWith('gemini: ')), labels.join(' | '));
});

test('collectUsageSummary reports separate Codex/Claude/Antigravity/Gemini numbers', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir);
  await writeCreds(tempDir, 'claude-home', '.claude/.credentials.json', {
    claudeAiOauth: {
      accessToken: 'claude-oauth-token-SECRET',
      subscriptionType: 'team',
      // Claude credentials may store this in seconds; compare after timestamp normalization.
      expiresAt: Math.floor((FIXED_NOW + 3_600_000) / 1000),
    },
  });
  await writeCreds(tempDir, 'gemini-home', '.gemini/oauth_creds.json', {
    access_token: 'gemini-oauth-token-SECRET',
    expiry_date: FIXED_NOW + 3_600_000,
  });
  // Antigravity stores a Google OAuth credential under its own HOME; a valid token means the
  // probe reads quota straight from the daily Code Assist API (no CLI self-heal needed).
  await writeCreds(tempDir, 'antigravity-home', '.gemini/antigravity-cli/antigravity-oauth-token', {
    auth_method: 'consumer',
    token: {
      access_token: 'antigravity-token-SECRET',
      refresh_token: 'antigravity-refresh-SECRET',
      token_type: 'Bearer',
      expiry: new Date(FIXED_NOW + 3_600_000).toISOString(),
    },
  });
  const agyBin = await writeFakeAgy(tempDir, { panel: ANTIGRAVITY_MODEL_PANEL });

  const fetchImpl = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    if (key === 'GET https://api.anthropic.com/api/oauth/usage') {
      return jsonResponse(200, {
        five_hour: { utilization: 31.0, resets_at: '2026-06-15T12:39:59+00:00' },
        seven_day: { utilization: 14.0, resets_at: '2026-06-21T12:59:59+00:00' },
        extra_usage: { is_enabled: false },
      });
    }
    if (key === 'POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      const auth = options.headers?.Authorization || '';
      if (auth === 'Bearer gemini-oauth-token-SECRET') {
        return jsonResponse(200, { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'native-project-id-SECRET' });
      }
    }
    if (key === 'POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
      const project = JSON.parse(options.body || '{}').project;
      if (project === 'native-project-id-SECRET') {
        return jsonResponse(200, {
          buckets: [
            { modelId: 'gemini-3.1-pro-preview', remainingFraction: 0, resetTime: '2026-06-16T05:42:22Z' },
            { modelId: 'gemini-3-flash-preview', remainingFraction: 0.949, resetTime: '2026-06-16T06:19:16Z' },
            // A second flash-tier model with a lower remaining fraction must win the tier.
            { modelId: 'gemini-2.5-flash', remainingFraction: 0.4, resetTime: '2026-06-16T06:19:16Z' },
            { modelId: 'gemini-3.1-flash-lite', remainingFraction: 1, resetTime: '2026-06-16T08:18:24Z' },
            // A null-fraction bucket is ignored, not crashed on.
            { modelId: 'gemini-2.5-pro', remainingFraction: null, resetTime: '2026-06-16T05:42:22Z' },
          ],
        });
      }
    }
    // Antigravity uses the same API on the daily- host, scoped to its own account/project.
    if (key === 'POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      if ((options.headers?.Authorization || '') === 'Bearer antigravity-token-SECRET') {
        return jsonResponse(200, { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'antigravity-project-SECRET' });
      }
    }
    if (key === 'POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
      if (JSON.parse(options.body || '{}').project === 'antigravity-project-SECRET') {
        return jsonResponse(200, {
          buckets: [
            { modelId: 'gemini-3.1-pro-preview', remainingFraction: 0.5, resetTime: '2026-06-16T05:42:22Z' },
            { modelId: 'gemini-3-flash-preview', remainingFraction: 1, resetTime: '2026-06-16T06:19:16Z' },
          ],
        });
      }
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home') },
    antigravity: { home: path.join(tempDir, 'antigravity-home'), bin: agyBin },
    gemini: { home: path.join(tempDir, 'gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const byId = new Map(summary.workers.map((worker) => [worker.id, worker]));

  const codex = byId.get('codex');
  assert.equal(codex.state, 'available');
  assert.equal(codex.plan, 'prolite');
  assert.deepEqual(codex.windows.map((w) => [w.key, w.usedPercent, w.remainingPercent]), [
    ['5h', 22, 78],
    ['weekly', 88, 12],
  ]);
  assert.ok(codex.spark, 'spark fallback bucket is surfaced');

  const claude = byId.get('claude');
  assert.equal(claude.state, 'available');
  assert.equal(claude.plan, 'team');
  assert.deepEqual(claude.windows.map((w) => [w.key, w.usedPercent, w.remainingPercent]), [
    ['5h', 31, 69],
    ['weekly', 14, 86],
  ]);

  const gemini = byId.get('gemini');
  assert.equal(gemini.state, 'available');
  assert.equal(gemini.plan, 'standard');
  assert.equal(gemini.source, 'retrieveUserQuota');
  // Buckets fold into one window per tier (lowest remaining fraction wins the tier),
  // ordered Pro -> Flash -> Flash Lite, just like the CLI /model panel.
  assert.deepEqual(gemini.windows.map((w) => [w.key, w.usedPercent, w.remainingPercent]), [
    ['pro', 100, 0],
    ['flash', 60, 40],
    ['flash-lite', 0, 100],
  ]);

  // Antigravity quota is its own account's Gemini tiers (distinct numbers from native Gemini),
  // fetched from the daily- Code Assist host.
  const antigravity = byId.get('antigravity');
  assert.equal(antigravity.state, 'available');
  assert.equal(antigravity.source, 'antigravity retrieveUserQuota');
  assert.deepEqual(antigravity.windows.map((w) => [w.key, w.usedPercent, w.remainingPercent]), [
    ['pro', 50, 50],
    ['flash', 0, 100],
  ]);

  const text = formatLiveUsageSummary(summary);
  assert.match(text, /- Codex \(5시간: 78%/);
  assert.match(text, /주간: 12%/);
  assert.match(text, /- Claude \(5시간: 69%/);
  // Antigravity's Claude model has no per-model quota bucket -> authenticated line.
  assert.match(text, /- AGY Opus \(로그인됨\)/);
  // Antigravity's Gemini Flash tier shows its own 100%, not native Gemini's 40%.
  assert.match(text, /- Gemini \(일간: 100%/);
  // Sol/Terra/Luna share one Codex window, so the view carries one Codex row.
  assert.doesNotMatch(text, /gpt-5\.6-luna/);
  assert.doesNotMatch(text, /- gemini: gemini-/);
  // Never leak token material or account identifiers (project id included).
  assert.doesNotMatch(text, /SECRET/);
});

test('Claude model-specific quota keeps Fable 5 separate from Opus', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'claude-home', '.claude/.credentials.json', {
    claudeAiOauth: {
      accessToken: 'claude-oauth-token-SECRET',
      subscriptionType: 'team',
      expiresAt: Math.floor((FIXED_NOW + 3_600_000) / 1000),
    },
  });

  const fetchImpl = makeFetchImpl({
    [`GET https://api.anthropic.com/api/oauth/usage`]: jsonResponse(200, {
      five_hour: { utilization: 50, resets_at: '2026-06-15T12:39:59+00:00' },
      seven_day: { utilization: 10, resets_at: '2026-06-21T12:59:59+00:00' },
      model_usage: {
        'claude-fable-5': {
          five_hour: { utilization: 91, resets_at: '2026-06-15T12:39:59+00:00' },
          seven_day: { utilization: 40, resets_at: '2026-06-21T12:59:59+00:00' },
        },
        'claude-opus-5': {
          five_hour: { utilization: 26, resets_at: '2026-06-15T12:39:59+00:00' },
          seven_day: { utilization: 23, resets_at: '2026-06-21T12:59:59+00:00' },
        },
      },
    }),
  });

  const config = {
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home'), model: 'opus', maintenanceModel: 'claude-fable-5' },
    gemini: { home: path.join(tempDir, 'missing-gemini-home') },
  };
  const summary = await collectUsageSummary(config, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });
  const claude = summary.workers.find((worker) => worker.id === 'claude');

  assert.deepEqual(Object.keys(claude.modelWindows).sort(), ['claude-fable-5', 'claude-opus-5']);
  const text = formatLiveUsageSummary(summary, config);
  assert.match(text, /- Claude \(5시간: 74%/);
  assert.match(text, /주간: 77%/);
  assert.doesNotMatch(text, /\(5시간: 50%/);
  assert.doesNotMatch(text, /SECRET/);
});

test('Codex usage probe finds a bare codex command through worker tool PATH', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const toolBinDir = path.join(tempDir, 'worker-tools', 'node_modules', '.bin');
  await fs.mkdir(toolBinDir, { recursive: true });
  const fakeCodex = await writeFakeCodexAppServer(tempDir);
  const codexOnToolPath = path.join(toolBinDir, 'codex');
  await fs.copyFile(fakeCodex, codexOnToolPath);
  await fs.chmod(codexOnToolPath, 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = '';
  const missingCwd = path.join(tempDir, 'missing-workspace');
  try {
    const summary = await collectUsageSummary({
      workers: { toolBinDir },
      codex: { bin: 'codex', home: path.join(tempDir, 'codex-home'), cwd: missingCwd },
      claude: { home: path.join(tempDir, 'missing-claude-home') },
      antigravity: { home: path.join(tempDir, 'missing-antigravity-home') },
      gemini: { home: path.join(tempDir, 'missing-gemini-home') },
    }, {
      timeoutMs: 5000,
      fetchImpl: () => { throw new Error('network should not be needed'); },
      now: () => FIXED_NOW,
    });

    const codex = summary.workers.find((worker) => worker.id === 'codex');
    assert.equal(codex.state, 'available');
    assert.equal(codex.windows[0].remainingPercent, 78);
    assert.equal((await fs.stat(missingCwd)).isDirectory(), true);
  } finally {
    process.env.PATH = savedPath;
  }
});

test('Antigravity reports its own account quota, never native Gemini numbers', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'gemini-home', '.gemini/oauth_creds.json', {
    access_token: 'gemini-oauth-token-SECRET',
    expiry_date: FIXED_NOW + 3_600_000,
  });
  await writeCreds(tempDir, 'antigravity-home', '.gemini/antigravity-cli/antigravity-oauth-token', {
    auth_method: 'consumer',
    token: {
      access_token: 'antigravity-token-SECRET',
      refresh_token: 'antigravity-refresh-SECRET',
      token_type: 'Bearer',
      expiry: new Date(FIXED_NOW + 3_600_000).toISOString(),
    },
  });
  const agyBin = await writeFakeAgy(tempDir);

  const fetchImpl = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    // Native Gemini has live Pro quota (99%).
    if (key === 'POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      return jsonResponse(200, { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'native-project-SECRET' });
    }
    if (key === 'POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
      return jsonResponse(200, {
        buckets: [{ modelId: 'gemini-3.1-pro-preview', remainingFraction: 0.99, resetTime: '2026-06-16T05:42:22Z' }],
      });
    }
    // Antigravity is authenticated on the daily- host but its own quota lookup yields no buckets.
    if (key === 'POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      return jsonResponse(200, { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'antigravity-project-SECRET' });
    }
    if (key === 'POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
      return jsonResponse(200, { buckets: [] });
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'missing-claude-home') },
    antigravity: { home: path.join(tempDir, 'antigravity-home'), bin: agyBin },
    gemini: { home: path.join(tempDir, 'gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const antigravity = summary.workers.find((worker) => worker.id === 'antigravity');
  const gemini = summary.workers.find((worker) => worker.id === 'gemini');
  assert.equal(gemini.windows.length > 0, true);
  assert.deepEqual(antigravity.windows, []);
  assert.equal(antigravity.state, 'available');

  const text = formatLiveUsageSummary(summary);
  assert.doesNotMatch(text, /- gemini: gemini-/);
  // Antigravity has no quota buckets of its own -> authenticated line, never native Gemini's 99%.
  assert.match(text, /- Gemini \(로그인됨\)/);
  assert.doesNotMatch(text, /- Gemini \(일간: 99%/);
  assert.doesNotMatch(text, /SECRET/);
});

test('Antigravity still asks for quota account-scoped when loadCodeAssist returns no project', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'antigravity-home', '.gemini/antigravity-cli/antigravity-oauth-token', {
    auth_method: 'consumer',
    token: {
      access_token: 'antigravity-token-SECRET',
      refresh_token: 'antigravity-refresh-SECRET',
      token_type: 'Bearer',
      expiry: new Date(FIXED_NOW + 3_600_000).toISOString(),
    },
  });
  const agyBin = await writeFakeAgy(tempDir);

  const quotaBodies = [];
  const fetchImpl = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    // This account answers with eligibility only: no cloudaicompanionProject, no currentTier.
    if (key === 'POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      return jsonResponse(200, {
        allowedTiers: [{ id: 'free-tier' }],
        ineligibleTiers: [{ id: 'standard-tier' }],
      });
    }
    if (key === 'POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
      quotaBodies.push(JSON.parse(options.body || '{}'));
      return jsonResponse(200, {
        buckets: [{ modelId: 'gemini-3.7-flash', remainingFraction: 0.77, resetTime: '2026-06-16T06:19:16Z' }],
      });
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'missing-claude-home') },
    antigravity: { home: path.join(tempDir, 'antigravity-home'), bin: agyBin },
    gemini: { home: path.join(tempDir, 'missing-gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  // A missing project must not skip step 2 outright.
  assert.deepEqual(quotaBodies, [{}]);
  const antigravity = summary.workers.find((worker) => worker.id === 'antigravity');
  assert.equal(antigravity.state, 'available');
  assert.equal(antigravity.source, 'antigravity retrieveUserQuota');
  assert.deepEqual(antigravity.windows.map((w) => [w.key, w.remainingPercent]), [['flash', 77]]);

  const text = formatLiveUsageSummary(summary);
  assert.match(text, /- Gemini \(일간: 77%/);
  assert.doesNotMatch(text, /SECRET/);
});

test('Antigravity reports a failed quota lookup instead of a bare login line', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'antigravity-home', '.gemini/antigravity-cli/antigravity-oauth-token', {
    auth_method: 'consumer',
    token: {
      access_token: 'antigravity-token-SECRET',
      refresh_token: 'antigravity-refresh-SECRET',
      token_type: 'Bearer',
      expiry: new Date(FIXED_NOW + 3_600_000).toISOString(),
    },
  });
  const agyBin = await writeFakeAgy(tempDir);

  const fetchImpl = makeFetchImpl({
    'POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist': jsonResponse(200, {
      allowedTiers: [{ id: 'free-tier' }],
    }),
    'POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota': jsonResponse(400, {
      error: { message: 'project is required' },
    }),
  });

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'missing-claude-home') },
    antigravity: { home: path.join(tempDir, 'antigravity-home'), bin: agyBin },
    gemini: { home: path.join(tempDir, 'missing-gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const antigravity = summary.workers.find((worker) => worker.id === 'antigravity');
  assert.equal(antigravity.state, 'available');
  assert.deepEqual(antigravity.windows, []);
  assert.match(antigravity.note, /쿼터 조회 실패\(쿼터 API HTTP 400\)/);

  const text = formatLiveUsageSummary(summary);
  const rows = text.split('\n').filter((line) => /^- (Gemini|AGY Opus) /.test(line));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row, /\(로그인됨 · 쿼터 조회 실패\(쿼터 API HTTP 400\)\)$/);
  }
  assert.doesNotMatch(text, /SECRET/);
});

test('/usage keeps Claude extra usage and Codex credits on the model rows', () => {
  const summary = {
    checkedAt: '2026-06-15T07:00:00.000Z',
    workers: [
      {
        id: 'codex',
        state: 'available',
        detail: '로그인됨',
        plan: 'prolite',
        windows: [{ key: '5h', label: '5시간', usedPercent: 20, remainingPercent: 80, resetsAtMs: FIXED_NOW + 3_600_000 }],
        credits: '크레딧 무제한',
        spark: {
          label: 'Spark',
          windows: [{ key: '5h', label: '5시간', usedPercent: 5, remainingPercent: 95, resetsAtMs: FIXED_NOW + 3_600_000 }],
        },
      },
      {
        id: 'claude',
        state: 'available',
        detail: '로그인됨',
        plan: 'team',
        windows: [
          { key: '5h', label: '5시간', usedPercent: 89, remainingPercent: 11, resetsAtMs: FIXED_NOW + 3_600_000 },
          { key: 'weekly', label: '주간', usedPercent: 65, remainingPercent: 35, resetsAtMs: FIXED_NOW + 86_400_000 },
        ],
        extra: '추가사용 42% 사용',
      },
    ],
  };

  const rows = formatLiveUsageSummary(summary).split('\n');
  const claudeRow = rows.find((line) => line.startsWith('- Claude '));
  assert.match(claudeRow, /5시간: 11%/);
  // Burning 42% of extra usage is part of "how much is left" and must stay visible.
  assert.match(claudeRow, / · 추가사용 42% 사용\)$/);

  const codexRow = rows.find((line) => line.startsWith('- Codex ('));
  assert.match(codexRow, / · 크레딧 무제한\)$/);

  // The Spark fallback row draws on the same balance; it does not repeat it.
  const sparkRow = rows.find((line) => line.startsWith('- Codex Spark '));
  assert.doesNotMatch(sparkRow, /크레딧/);
});

test('Gemini degrades to an honest tier-only line when the quota lookup fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'gemini-home', '.gemini/oauth_creds.json', {
    access_token: 'gemini-oauth-token-SECRET',
    expiry_date: FIXED_NOW + 3_600_000,
  });

  const fetchImpl = makeFetchImpl({
    [`POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`]: jsonResponse(200, {
      currentTier: { id: 'standard-tier' },
      cloudaicompanionProject: 'project-id-SECRET',
    }),
    [`POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`]: jsonResponse(500, {}),
  });

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'missing-claude-home') },
    gemini: { home: path.join(tempDir, 'gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const gemini = summary.workers.find((w) => w.id === 'gemini');
  assert.equal(gemini.state, 'available');
  assert.equal(gemini.plan, 'standard');
  assert.equal(gemini.windows.length, 0);
  // A quota call that never answered must say so, not read as a healthy login-only line.
  assert.match(gemini.note, /쿼터 조회 실패\(쿼터 API HTTP 500\)/);
  assert.match(gemini.note, /로그인됨/);

  const text = formatLiveUsageSummary(summary);
  assert.doesNotMatch(text, /- gemini: gemini-/);
  assert.doesNotMatch(text, /SECRET/);
});

test('Claude probe reports re-auth when the token is expired without calling the API', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'claude-home', '.claude/.credentials.json', {
    claudeAiOauth: { accessToken: 'token', subscriptionType: 'team', expiresAt: FIXED_NOW - 1000 },
  });

  let claudeCalls = 0;
  const fetchImpl = makeFetchImpl({}, () => { claudeCalls += 1; return jsonResponse(200, {}); });

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home') },
    gemini: { home: path.join(tempDir, 'gemini-home') }, // no creds file
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const byId = new Map(summary.workers.map((worker) => [worker.id, worker]));
  assert.equal(byId.get('claude').state, 'unavailable');
  assert.equal(byId.get('claude').detail, '토큰 만료/재인증 필요');
  assert.equal(claudeCalls, 0, 'expired token short-circuits the network call');
  assert.equal(byId.get('gemini').state, 'unavailable');
  assert.equal(byId.get('gemini').detail, '자격 증명 없음');
  // Codex app-server returning a JSON-RPC error degrades gracefully.
  assert.equal(byId.get('codex').state, 'unknown');
});

test('expired refreshable OAuth tokens do not get reported as re-auth failures', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'claude-home', '.claude/.credentials.json', {
    claudeAiOauth: {
      accessToken: 'stale-access-token',
      refreshToken: 'refresh-token-SECRET',
      subscriptionType: 'team',
      expiresAt: FIXED_NOW - 1000,
    },
  });
  await writeCreds(tempDir, 'gemini-home', '.gemini/oauth_creds.json', {
    access_token: 'stale-access-token',
    refresh_token: 'refresh-token-SECRET',
    expiry_date: FIXED_NOW - 1000,
  });

  // Both stale tokens trigger a refresh attempt; when that refresh also fails (and the API still
  // 401s) each probe must land on an authenticated — not a re-auth-failure — line.
  const fetchImpl = makeFetchImpl({
    [`GET https://api.anthropic.com/api/oauth/usage`]: jsonResponse(401, {}),
    [`POST https://console.anthropic.com/v1/oauth/token`]: jsonResponse(400, { error: 'invalid_grant' }),
    [`POST https://oauth2.googleapis.com/token`]: jsonResponse(400, { error: 'invalid_grant' }),
    [`POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`]: jsonResponse(401, {}),
  });

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home') },
    gemini: { home: path.join(tempDir, 'gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const byId = new Map(summary.workers.map((worker) => [worker.id, worker]));
  assert.equal(byId.get('claude').state, 'available');
  assert.equal(byId.get('claude').detail, '인증됨');
  assert.match(byId.get('claude').note, /잔여 쿼터 조회만 미확인/);
  assert.equal(byId.get('gemini').state, 'available');
  assert.equal(byId.get('gemini').detail, '인증됨');
  assert.match(byId.get('gemini').note, /잔여 쿼터 조회만 미확인/);

  const text = formatLiveUsageSummary(summary);
  assert.match(text, /- Claude \(잔여 쿼터 조회만 미확인/);
  assert.doesNotMatch(text, /- gemini: gemini-/);
  assert.doesNotMatch(text, /CLI 토큰 갱신 전/);
  assert.doesNotMatch(text, /실패/);
  assert.doesNotMatch(text, /토큰 만료\/재인증 필요/);
  assert.doesNotMatch(text, /SECRET/);
});

test('Gemini refreshes a stale access token and still reports live quota numbers', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  // Stored token already expired by the clock — the probe must mint a fresh one before the API call.
  await writeCreds(tempDir, 'gemini-home', '.gemini/oauth_creds.json', {
    access_token: 'stale-access-token-SECRET',
    refresh_token: 'refresh-token-SECRET',
    expiry_date: FIXED_NOW - 1000,
  });

  let refreshCalls = 0;
  const quotaBearers = [];
  const fetchImpl = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    if (key === 'POST https://oauth2.googleapis.com/token') {
      refreshCalls += 1;
      assert.match(String(options.body), /grant_type=refresh_token/);
      assert.match(String(options.body), /refresh_token=refresh-token-SECRET/);
      return jsonResponse(200, { access_token: 'fresh-access-token', expires_in: 3599 });
    }
    if (key === 'POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      quotaBearers.push(options.headers?.Authorization);
      return jsonResponse(200, { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'project-id-SECRET' });
    }
    if (key === 'POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
      quotaBearers.push(options.headers?.Authorization);
      return jsonResponse(200, {
        buckets: [
          { modelId: 'gemini-3-pro-preview', remainingFraction: 0, resetTime: '2026-06-16T05:42:22Z' },
          { modelId: 'gemini-2.5-flash', remainingFraction: 0.93, resetTime: '2026-06-16T06:19:16Z' },
          { modelId: 'gemini-3.1-flash-lite', remainingFraction: 1, resetTime: '2026-06-16T08:18:24Z' },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'missing-claude-home') },
    gemini: { home: path.join(tempDir, 'gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const gemini = summary.workers.find((w) => w.id === 'gemini');
  assert.equal(refreshCalls, 1, 'the stale token is refreshed exactly once');
  assert.equal(gemini.state, 'available');
  assert.equal(gemini.detail, '로그인됨');
  assert.equal(gemini.source, 'retrieveUserQuota');
  assert.deepEqual(gemini.windows.map((w) => [w.key, w.remainingPercent]), [
    ['pro', 0],
    ['flash', 93],
    ['flash-lite', 100],
  ]);
  // The refreshed token — not the stale one — must be used for the quota calls.
  assert.ok(quotaBearers.length > 0 && quotaBearers.every((b) => b === 'Bearer fresh-access-token'),
    'quota calls use the freshly minted token');

  const text = formatLiveUsageSummary(summary);
  assert.doesNotMatch(text, /- gemini: gemini-/);
  assert.match(text, /- Gemini \(자격 증명 없음\)/);
  assert.doesNotMatch(text, /잔여 쿼터 조회만 미확인/);
  assert.doesNotMatch(text, /SECRET/);
});

test('Gemini refreshes and retries once when a not-yet-expired token is rejected', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  // Clock says the token is still valid, but the server rejects it (revoked/clock skew).
  await writeCreds(tempDir, 'gemini-home', '.gemini/oauth_creds.json', {
    access_token: 'rejected-token-SECRET',
    refresh_token: 'refresh-token-SECRET',
    expiry_date: FIXED_NOW + 3_600_000,
  });

  let loadCalls = 0;
  let refreshCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    if (key === 'POST https://oauth2.googleapis.com/token') {
      refreshCalls += 1;
      return jsonResponse(200, { access_token: 'fresh-access-token' });
    }
    if (key === 'POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      loadCalls += 1;
      if (loadCalls === 1) return jsonResponse(401, {}); // first try with the stale token is rejected
      return jsonResponse(200, { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'p-SECRET' });
    }
    if (key === 'POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
      return jsonResponse(200, {
        buckets: [{ modelId: 'gemini-3-pro-preview', remainingFraction: 0.5, resetTime: '2026-06-16T05:42:22Z' }],
      });
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'missing-claude-home') },
    gemini: { home: path.join(tempDir, 'gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const gemini = summary.workers.find((w) => w.id === 'gemini');
  assert.equal(refreshCalls, 1, 'refresh is attempted once on rejection');
  assert.equal(loadCalls, 2, 'loadCodeAssist is retried once with the refreshed token');
  assert.equal(gemini.state, 'available');
  assert.deepEqual(gemini.windows.map((w) => [w.key, w.remainingPercent]), [['pro', 50]]);
});

test('Claude refreshes a stale access token, persists the rotated creds, and reports live quota', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  const credsRel = '.claude/.credentials.json';
  // Stored token already expired by the clock — the probe must mint a fresh one before the API call.
  await writeCreds(tempDir, 'claude-home', credsRel, {
    claudeAiOauth: {
      accessToken: 'stale-access-token-SECRET',
      refreshToken: 'old-refresh-token-SECRET',
      subscriptionType: 'team',
      expiresAt: FIXED_NOW - 1000,
    },
  });

  let refreshCalls = 0;
  const usageBearers = [];
  const fetchImpl = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    if (key === 'POST https://console.anthropic.com/v1/oauth/token') {
      refreshCalls += 1;
      assert.match(String(options.body), /"grant_type":"refresh_token"/);
      assert.match(String(options.body), /"refresh_token":"old-refresh-token-SECRET"/);
      // Anthropic rotates the refresh token on every grant.
      return jsonResponse(200, {
        access_token: 'fresh-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
      });
    }
    if (key === 'GET https://api.anthropic.com/api/oauth/usage') {
      usageBearers.push(options.headers?.Authorization);
      return jsonResponse(200, {
        five_hour: { utilization: 26, resets_at: '2026-06-16T04:19:00+00:00' },
        seven_day: { utilization: 23, resets_at: '2026-06-21T21:59:00+00:00' },
        extra_usage: { is_enabled: false },
      });
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home') },
    gemini: { home: path.join(tempDir, 'missing-gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const claude = summary.workers.find((w) => w.id === 'claude');
  assert.equal(refreshCalls, 1, 'the stale token is refreshed exactly once');
  assert.equal(claude.state, 'available');
  assert.equal(claude.detail, '로그인됨');
  assert.deepEqual(claude.windows.map((w) => [w.key, w.remainingPercent]), [['5h', 74], ['weekly', 77]]);
  // The refreshed token — not the stale one — must be used for the usage call.
  assert.ok(usageBearers.length > 0 && usageBearers.every((b) => b === 'Bearer fresh-access-token'),
    'the usage call uses the freshly minted token');

  // The rotated creds MUST be written back: Anthropic invalidates the previous refresh token, so
  // without persistence the worker's next run would authenticate with a now-dead token.
  const persisted = JSON.parse(await fs.readFile(path.join(tempDir, 'claude-home', credsRel), 'utf8'));
  assert.equal(persisted.claudeAiOauth.accessToken, 'fresh-access-token');
  assert.equal(persisted.claudeAiOauth.refreshToken, 'rotated-refresh-token');
  assert.equal(persisted.claudeAiOauth.expiresAt, FIXED_NOW + 3600 * 1000);
  assert.equal(persisted.claudeAiOauth.subscriptionType, 'team', 'unrelated fields are preserved');

  const text = formatLiveUsageSummary(summary);
  assert.match(text, /- Claude \(5시간: 74%/);
  assert.match(text, /주간: 77%/);
  assert.doesNotMatch(text, /잔여 쿼터 조회만 미확인/);
  assert.doesNotMatch(text, /SECRET/);
});

test('Claude refreshes and retries once when a not-yet-expired token is rejected', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  const credsRel = '.claude/.credentials.json';
  // Clock says the token is still valid, but the server rejects it (revoked / clock skew).
  await writeCreds(tempDir, 'claude-home', credsRel, {
    claudeAiOauth: {
      accessToken: 'rejected-token-SECRET',
      refreshToken: 'old-refresh-token-SECRET',
      subscriptionType: 'team',
      expiresAt: FIXED_NOW + 3_600_000,
    },
  });

  let usageCalls = 0;
  let refreshCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    if (key === 'POST https://console.anthropic.com/v1/oauth/token') {
      refreshCalls += 1;
      return jsonResponse(200, { access_token: 'fresh-access-token', refresh_token: 'rotated-refresh-token', expires_in: 3600 });
    }
    if (key === 'GET https://api.anthropic.com/api/oauth/usage') {
      usageCalls += 1;
      if (usageCalls === 1) return jsonResponse(401, {}); // first try with the rejected token
      return jsonResponse(200, {
        five_hour: { utilization: 40, resets_at: '2026-06-16T04:19:00+00:00' },
        seven_day: { utilization: 10, resets_at: '2026-06-21T21:59:00+00:00' },
      });
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home') },
    gemini: { home: path.join(tempDir, 'missing-gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const claude = summary.workers.find((w) => w.id === 'claude');
  assert.equal(refreshCalls, 1, 'refresh is attempted once on rejection');
  assert.equal(usageCalls, 2, 'the usage call is retried once with the refreshed token');
  assert.equal(claude.state, 'available');
  assert.equal(claude.detail, '로그인됨');
  assert.deepEqual(claude.windows.map((w) => [w.key, w.remainingPercent]), [['5h', 60], ['weekly', 90]]);

  // The reactive refresh must also persist the rotated token.
  const persisted = JSON.parse(await fs.readFile(path.join(tempDir, 'claude-home', credsRel), 'utf8'));
  assert.equal(persisted.claudeAiOauth.refreshToken, 'rotated-refresh-token');
});

test('Claude does not clobber credentials a worker rotated concurrently', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  const credsRel = '.claude/.credentials.json';
  const credsPath = path.join(tempDir, 'claude-home', credsRel);
  await writeCreds(tempDir, 'claude-home', credsRel, {
    claudeAiOauth: {
      accessToken: 'stale-SECRET',
      refreshToken: 'original-refresh-SECRET',
      subscriptionType: 'team',
      expiresAt: FIXED_NOW - 1000,
    },
  });

  const fetchImpl = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    if (key === 'POST https://console.anthropic.com/v1/oauth/token') {
      // Simulate a Claude worker that refreshed AND persisted in the meantime, rotating the token
      // on disk after the probe read it but before the probe writes its own result.
      await fs.writeFile(credsPath, JSON.stringify({
        claudeAiOauth: {
          accessToken: 'worker-access',
          refreshToken: 'worker-refresh',
          subscriptionType: 'team',
          expiresAt: FIXED_NOW + 3_600_000,
        },
      }), 'utf8');
      return jsonResponse(200, { access_token: 'probe-access', refresh_token: 'probe-refresh', expires_in: 3600 });
    }
    if (key === 'GET https://api.anthropic.com/api/oauth/usage') {
      return jsonResponse(200, { five_hour: { utilization: 10, resets_at: '2026-06-16T04:19:00+00:00' } });
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home') },
    gemini: { home: path.join(tempDir, 'missing-gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  // The probe still answers with live numbers using its own freshly minted token...
  const claude = summary.workers.find((w) => w.id === 'claude');
  assert.equal(claude.state, 'available');
  assert.equal(claude.detail, '로그인됨');
  // ...but it must NOT overwrite the newer creds the worker just wrote.
  const persisted = JSON.parse(await fs.readFile(credsPath, 'utf8'));
  assert.equal(persisted.claudeAiOauth.refreshToken, 'worker-refresh', 'the concurrently-rotated token is preserved');
  assert.equal(persisted.claudeAiOauth.accessToken, 'worker-access');
});

test('Claude usage API throttling reports authenticated state without a failure line', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'claude-home', '.claude/.credentials.json', {
    claudeAiOauth: {
      accessToken: 'claude-oauth-token-SECRET',
      refreshToken: 'refresh-token-SECRET',
      subscriptionType: 'team',
      expiresAt: FIXED_NOW + 3_600_000,
    },
  });

  const fetchImpl = makeFetchImpl({
    [`GET https://api.anthropic.com/api/oauth/usage`]: jsonResponse(429, {}),
  });

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home') },
    gemini: { home: path.join(tempDir, 'missing-gemini-home') },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const claude = summary.workers.find((worker) => worker.id === 'claude');
  assert.equal(claude.state, 'available');
  assert.equal(claude.detail, '인증됨');
  assert.match(claude.note, /사용량 API 제한/);

  const text = formatLiveUsageSummary(summary);
  assert.match(text, /- Claude \(잔여 쿼터 조회만 미확인/);
  assert.doesNotMatch(text, /실패|토큰 만료|재인증 필요|SECRET/);
});

test('collectCachedUsageSummary reuses recent live usage results', async () => {
  clearUsageSummaryCache();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  await writeCreds(tempDir, 'claude-home', '.claude/.credentials.json', {
    claudeAiOauth: {
      accessToken: 'claude-oauth-token-SECRET',
      refreshToken: 'refresh-token-SECRET',
      subscriptionType: 'team',
      expiresAt: FIXED_NOW + 3_600_000,
    },
  });
  await writeCreds(tempDir, 'gemini-home', '.gemini/oauth_creds.json', {
    access_token: 'gemini-oauth-token-SECRET',
    refresh_token: 'refresh-token-SECRET',
    expiry_date: FIXED_NOW + 3_600_000,
  });

  const config = {
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'claude-home') },
    gemini: { home: path.join(tempDir, 'gemini-home') },
  };
  let calls = 0;
  const fetchImpl = makeFetchImpl({
    [`GET https://api.anthropic.com/api/oauth/usage`]: jsonResponse(429, {}),
    [`POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`]: jsonResponse(429, {}),
  }, () => {
    calls += 1;
    return jsonResponse(429, {});
  });
  const countingFetchImpl = async (url, options) => {
    calls += 1;
    return fetchImpl(url, options);
  };

  const first = await collectCachedUsageSummary(config, {
    timeoutMs: 5000,
    fetchImpl: countingFetchImpl,
    now: () => FIXED_NOW,
  });
  const second = await collectCachedUsageSummary(config, {
    timeoutMs: 5000,
    fetchImpl: () => {
      throw new Error('cache miss');
    },
    now: () => FIXED_NOW + 1_000,
  });
  const third = await collectCachedUsageSummary(config, {
    timeoutMs: 5000,
    fetchImpl: countingFetchImpl,
    now: () => FIXED_NOW + 61_000,
  });

  assert.equal(second, first);
  assert.notEqual(third, first);
  assert.equal(calls, 4);
  clearUsageSummaryCache();
});

test('a thrown probe never breaks the whole summary', async () => {
  const summary = await collectUsageSummary({
    codex: { bin: path.join(os.tmpdir(), 'definitely-missing-codex-bin') },
    claude: { home: path.join(os.tmpdir(), 'missing-claude-home') },
    gemini: { home: path.join(os.tmpdir(), 'missing-gemini-home') },
  }, {
    timeoutMs: 3000,
    fetchImpl: () => { throw new Error('network down'); },
    now: () => FIXED_NOW,
  });

  assert.equal(summary.workers.length, 4);
  assert.equal(summary.workers.find((w) => w.id === 'codex').state, 'unavailable');
  const text = formatLiveUsageSummary(summary);
  assert.match(text, /남은 쿼터 요약/);
});

test('Antigravity quota probe runs the CLI to self-heal a stale token, then reports live quota', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = await writeFakeCodexAppServer(tempDir, { error: true });
  // Stored Antigravity token is already expired by the clock. Antigravity signs tokens with its
  // own OAuth client, so the Gemini refresh_token grant can't mint a new one — the probe must let
  // the Antigravity CLI refresh + persist a fresh token, then read live quota with it.
  await writeCreds(tempDir, 'antigravity-home', '.gemini/antigravity-cli/antigravity-oauth-token', {
    auth_method: 'oauth-personal',
    token: {
      access_token: 'antigravity-stale-token-SECRET',
      refresh_token: 'antigravity-refresh-SECRET',
      token_type: 'Bearer',
      expiry: new Date(FIXED_NOW - 1000).toISOString(),
    },
  });
  const agyBin = await writeFakeAgy(tempDir);

  // Quota is fetched from the daily- Code Assist host with the freshly minted token.
  const fetchImpl = makeFetchImpl({
    ['POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist']: jsonResponse(200, {
      currentTier: { id: 'standard-tier' },
      cloudaicompanionProject: 'antigravity-project-SECRET',
    }),
    ['POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota']: jsonResponse(200, {
      buckets: [{ modelId: 'gemini-3-flash-preview', remainingFraction: 0.62, resetTime: '2026-06-17T05:42:22Z' }],
    }),
  });

  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'missing-claude-home') },
    gemini: { home: path.join(tempDir, 'missing-gemini-home') },
    antigravity: { home: path.join(tempDir, 'antigravity-home'), bin: agyBin },
  }, { timeoutMs: 5000, fetchImpl, now: () => FIXED_NOW });

  const antigravity = summary.workers.find((w) => w.id === 'antigravity');
  assert.equal(antigravity.state, 'available');
  assert.equal(antigravity.source, 'antigravity retrieveUserQuota');
  assert.ok(antigravity.windows.length > 0, 'self-healed token yields live quota windows');
  // The CLI run refreshed + persisted the token on disk.
  const refreshed = JSON.parse(await fs.readFile(path.join(tempDir, 'antigravity-home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'));
  assert.equal(refreshed.token.access_token, 'antigravity-fresh-token-SECRET');
  const text = formatLiveUsageSummary(summary);
  assert.match(text, /- Gemini \(일간: 62%/);
  assert.doesNotMatch(text, /SECRET/);
});

// --- fixtures -------------------------------------------------------------

// A stand-in for the `agy` CLI: running it rewrites the on-disk Antigravity token with a
// fresh one, mirroring how the real CLI's auth layer refreshes + persists on an API call.
async function writeFakeAgy(tempDir, { panel = ANTIGRAVITY_MODEL_PANEL } = {}) {
  const filePath = path.join(tempDir, 'fake-agy');
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    '// Any authenticated invocation (incl. `models`) refreshes + persists the OAuth token,',
    "// mirroring how the real CLI's auth layer self-heals on an API call.",
    "const tokenPath = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');",
    'const fresh = {',
    "  auth_method: 'oauth-personal',",
    '  token: {',
    "    access_token: 'antigravity-fresh-token-SECRET',",
    "    refresh_token: 'antigravity-refresh-SECRET',",
    "    token_type: 'Bearer',",
    "    expiry: '2030-01-01T00:00:00.000Z',",
    '  },',
    '};',
    'fs.mkdirSync(path.dirname(tokenPath), { recursive: true });',
    'fs.writeFileSync(tokenPath, JSON.stringify(fresh));',
    'if (process.argv[2] === "models") {',
    "  console.log('Gemini 3.7 Flash');",
    '  process.exit(0);',
    '}',
    `console.log(${JSON.stringify(panel)});`,
    '',
  ].join('\n');
  await fs.writeFile(filePath, script, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
  return filePath;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function makeFetchImpl(routes, fallback) {
  return async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    if (Object.hasOwn(routes, key)) return routes[key];
    if (fallback) return fallback(url, options);
    throw new Error(`unexpected fetch: ${key}`);
  };
}

async function writeCreds(tempDir, homeName, relativePath, payload) {
  const filePath = path.join(tempDir, homeName, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload), 'utf8');
}

async function writeFakeCodexAppServer(tempDir, { error = false } = {}) {
  const filePath = path.join(tempDir, error ? 'codex-appserver-error' : 'codex-appserver');
  const rateLimits = {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1781517844 },
      secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: 1781755152 },
      planType: 'prolite',
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: 'codex_bengalfox',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1781514695 },
        secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1782017541 },
        planType: 'prolite',
      },
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1781517844 },
        secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: 1781755152 },
        planType: 'prolite',
        credits: { hasCredits: false, unlimited: false, balance: '0' },
      },
    },
  };
  const script = [
    '#!/usr/bin/env node',
    `const RATE_LIMITS = ${JSON.stringify(rateLimits)};`,
    `const FAIL = ${JSON.stringify(error)};`,
    "let buffer = '';",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    "  const lines = buffer.split(/\\r?\\n/);",
    "  buffer = lines.pop() || '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    let msg; try { msg = JSON.parse(line); } catch { continue; }',
    "    if (msg.method === 'initialize') {",
    "      reply(msg.id, { userAgent: 'fake' });",
    "      // emit an unrelated notification to exercise the reader's filtering",
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'configWarning', params: {} }) + '\\n');",
    "    } else if (msg.method === 'account/rateLimits/read') {",
    '      if (FAIL) reply(msg.id, undefined, { code: -32000, message: "not logged in" });',
    '      else reply(msg.id, RATE_LIMITS);',
    '    }',
    '  }',
    '});',
    'function reply(id, result, error) {',
    "  const payload = { jsonrpc: '2.0', id };",
    '  if (error) payload.error = error; else payload.result = result;',
    "  process.stdout.write(JSON.stringify(payload) + '\\n');",
    '}',
    '',
  ].join('\n');
  await fs.writeFile(filePath, script, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
  return filePath;
}

test('Codex probe settles immediately when the app-server exits before answering', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-probe-'));
  const codexBin = path.join(tempDir, 'codex-appserver-exits');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "console.error('You are not logged in');",
    'process.exit(1);',
    '',
  ].join('\n'), { mode: 0o755 });
  await fs.chmod(codexBin, 0o755);

  const startedAt = Date.now();
  const summary = await collectUsageSummary({
    codex: { bin: codexBin, home: path.join(tempDir, 'codex-home'), cwd: tempDir },
    claude: { home: path.join(tempDir, 'missing-claude-home') },
    gemini: { home: path.join(tempDir, 'gemini-home') },
  }, { timeoutMs: 30_000, fetchImpl: makeFetchImpl({}), now: () => FIXED_NOW });
  const elapsedMs = Date.now() - startedAt;

  const codex = summary.workers.find((worker) => worker.id === 'codex');
  assert.equal(codex.state, 'unknown');
  assert.equal(codex.detail, '로그인 필요');
  // The close handler must settle the probe; without it this waits out the full 30s timeout.
  assert.ok(elapsedMs < 15_000, `probe took ${elapsedMs}ms, expected an early settle`);
});
