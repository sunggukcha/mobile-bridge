import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  channelEnvFilePath,
  channelEnvOverrides,
  channelStateDir,
  hostGitHubAuthEnv,
  loadConfig,
  dotEnvAuthoritativeChildEnv,
  loadDotEnv,
  statePathPart,
  threadStateDir,
  todoStateFiles,
  validateConfig,
  workerToolSearchPath,
} from '../lib/config.mjs';

test('loadConfig defaults to one cross-thread concurrent job', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111,222',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  });

  assert.equal(config.queue.maxConcurrentJobs, 1);
  assert.equal(config.queue.singleJobMode, false);
  assert.equal(config.codex.maxConcurrentJobs, 1);
  assert.equal(config.codex.reasoningEffort, 'xhigh');
  assert.equal(config.codex.reasoningSummary, 'auto');
  assert.equal(config.codex.sandboxMode, 'workspace-write');
  assert.equal(config.codex.maintenanceSandboxMode, 'workspace-write');
  assert.equal(config.codex.solModel, 'gpt-5.6-sol');
  assert.equal(config.codex.lunaModel, 'gpt-5.6-luna');
  assert.equal(config.codex.maintenanceModel, 'gpt-5.6-terra');
  assert.equal(config.codex.maintenanceSolModel, 'gpt-5.6-sol');
  assert.equal(config.codex.maintenanceSolReasoningEffort, 'ultra');
  assert.equal(config.codex.home, '/tmp/projects/.bridge_state/codex-home');
  assert.equal(config.codex.cwd, '/tmp/projects/.bridge_state/workspace');
  assert.equal(config.channelEnv.filename, 'channel.env');
  assert.equal(config.channelEnv.allowlist.size, 0);
  assert.equal(config.workerEnvAllowlist.size, 0);
  assert.deepEqual(config.python, {
    channelVenvEnabled: true,
    autoCreateChannelVenv: false,
    requireChannelVenv: false,
    autoUpgradeChannelVenv: true,
    bootstrapPip: false,
    pipBootstrapUrl: 'https://bootstrap.pypa.io/get-pip.py',
    channelVenvDir: '.venv',
    bin: '',
    candidates: [
      'python3.14',
      'python3.13',
      'python3.12',
      'python3.11',
      'python3.10',
      'python3.9',
      'python3.8',
      'python3',
      'python',
    ],
  });
  assert.deepEqual(config.workers.defaultChain, ['codex', 'claude', 'antigravity', 'codex-spark', 'codex-luna']);
  assert.deepEqual(config.workers.companyChain, ['claude', 'codex', 'antigravity', 'codex-spark', 'codex-luna']);
  assert.deepEqual(config.workers.maintenanceChain, ['codex-sol']);
  assert.deepEqual(config.workers.maintenanceChainRotation, []);
  assert.equal(config.workers.maintenanceChainRotationStartDate, '');
  assert.equal(config.workers.quotaCooldownMs, 30 * 60_000);
  assert.equal(config.workers.capacityCooldownMs, 5 * 60_000);
  assert.equal(config.workers.maxCooldownMs, 24 * 60 * 60_000);
  assert.deepEqual(config.codexSpark, {
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'xhigh',
    requestedReasoningEffort: null,
    reasoningSummary: 'auto',
  });
  assert.equal(config.claude.bin, 'claude');
  assert.equal(config.gemini.bin, 'gemini');
  assert.equal(config.claude.home, '/tmp/projects/.bridge_state/claude-home');
  assert.deepEqual(config.claude.accounts, [{
    id: 'primary',
    label: '기본',
    home: '/tmp/projects/.bridge_state/claude-home',
  }]);
  assert.equal(config.gemini.home, '/tmp/projects/.bridge_state/gemini-home');
  assert.equal(config.gemini.model, 'gemini-3.1-pro-preview');
  assert.equal(config.gemini.fallbackModel, 'gemini-3-flash-preview');
  assert.equal(config.claude.model, 'opus');
  assert.equal(config.claude.effort, 'xhigh');
  assert.equal(config.claude.maintenanceModel, 'claude-fable-5');
  assert.equal(config.claude.maintenanceEffort, 'xhigh');
  assert.equal(config.claude.maintenanceFallbackModel, 'claude-opus-5');
  assert.equal(config.claude.maintenanceFallbackEffort, 'xhigh');
  assert.equal(config.claude.permissionMode, 'default');
  assert.equal(config.claude.maintenancePermissionMode, 'default');
  assert.equal(config.gemini.sandbox, 'false');
  assert.equal(config.antigravity.bin, 'agy');
  assert.equal(config.antigravity.home, '/tmp/projects/.bridge_state/antigravity-home');
  assert.equal(config.antigravity.model, 'gemini-3.7-flash-high');
  assert.equal(config.antigravity.opusModel, 'Claude Opus 4.6 (Thinking)');
  assert.equal(config.antigravity.proModel, 'gemini-3.7-flash-high');
  assert.equal(config.antigravity.effort, 'high');
  assert.equal(config.jobProgressIntervalMs, 60_000);
  assert.equal(config.jobProgressMinSilenceMs, 60_000);
  assert.equal(config.jobProgressForwardDelayMs, 1_000);
  assert.equal(config.jobNoProgressKillMs, 10 * 60_000);
  assert.equal(config.workerProgressUpdatesEnabled, true);
  assert.equal(config.jobCompletionMarkerMode, 'inline');
  assert.equal(config.jobThreadLockRetryMs, 5_000);
  assert.deepEqual(config.activeAsks, {
    enabled: true,
    timeoutMs: 7 * 24 * 60 * 60_000,
  });
  assert.deepEqual([...config.discord.allowedChannelIds], ['111', '222']);
  assert.equal(config.stateRoot, '/tmp/projects/.bridge_state');
  assert.equal(config.repositoriesRoot, '/tmp/projects/.bridge_state/repositories');
  assert.deepEqual(config.allowedRoots, []);
  assert.equal(config.dailyReports.enabled, false);
  assert.equal(config.dailyReports.hourKst, 9);
  assert.deepEqual(config.maintenance, {
    mode: 'off',
    enabled: false,
    gitRemote: 'origin',
    gitBranch: 'main',
    bugReportRepository: '',
    inputBudgetChars: 120_000,
    inlineItems: 40,
  });
  assert.equal(config.usage.codexRemainingQuota, null);
  assert.equal(config.usage.claudeRemainingQuota, null);
  assert.equal(config.usage.geminiRemainingQuota, null);
  assert.deepEqual(config.todoAlerts, {
    enabled: true,
    intervalMs: 15_000,
  });
  assert.equal(config.slack.enabled, false);
  assert.equal(config.slack.logicalChannelId, '111');
  assert.equal(config.slack.broadcastTodoAlerts, true);
});

test('loadConfig maps one Slack channel onto a logical Discord channel', () => {
  const config = loadConfig({
    SLACK_ENABLED: 'true',
    SLACK_APP_TOKEN: 'xapp-test',
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_TEAM_ID: 'T123',
    SLACK_CHANNEL_ID: 'C123',
    SLACK_ALLOWED_USER_IDS: 'U1,U2',
    SLACK_LOGICAL_CHANNEL_ID: '1000000000000000001',
    SLACK_CATCHUP_WINDOW_MS: '900000',
  });

  assert.equal(config.slack.enabled, true);
  assert.equal(config.slack.appToken, 'xapp-test');
  assert.equal(config.slack.botToken, 'xoxb-test');
  assert.equal(config.slack.teamId, 'T123');
  assert.equal(config.slack.channelId, 'C123');
  assert.deepEqual([...config.slack.allowedUserIds], ['U1', 'U2']);
  assert.equal(config.slack.logicalChannelId, '1000000000000000001');
  assert.equal(config.slack.catchupWindowMs, 900000);
});

test('loadConfig configures an opt-in isolated secondary Claude home', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    CLAUDE_HOME: '/tmp/claude-primary',
    CLAUDE_PRIMARY_LABEL: '개인',
    CLAUDE_SECONDARY_HOME: '/tmp/claude-work',
    CLAUDE_SECONDARY_LABEL: '업무',
  });

  assert.deepEqual(config.claude.accounts, [
    { id: 'primary', label: '개인', home: '/tmp/claude-primary' },
    { id: 'secondary', label: '업무', home: '/tmp/claude-work' },
  ]);
});

test('loadConfig supports completion marker delivery modes', () => {
  assert.equal(loadConfig({ JOB_COMPLETION_MARKER_MODE: 'inline' }).jobCompletionMarkerMode, 'inline');
  assert.equal(loadConfig({ JOB_COMPLETION_MARKER_MODE: 'separate' }).jobCompletionMarkerMode, 'separate');
  assert.equal(loadConfig({ JOB_COMPLETION_MARKER_MODE: 'off' }).jobCompletionMarkerMode, 'off');
  assert.equal(loadConfig({ JOB_COMPLETION_MARKER_MODE: 'invalid' }).jobCompletionMarkerMode, 'inline');
});

test('loadConfig supports maintenance worker chain override aliases', () => {
  const config = loadConfig({
    MAINTENANCE_WORKER_CHAIN: 'fable, opus-5, terra, gemini',
  });

  assert.deepEqual(config.workers.maintenanceChain, ['claude-fable', 'claude-opus', 'codex-terra']);
});

test('loadConfig supports daily maintenance chain rotation shorthand', () => {
  const config = loadConfig({
    MAINTENANCE_WORKER_CHAIN_ROTATION: 'fable-sol-opus-terra|sol-fable-terra-opus',
    MAINTENANCE_WORKER_CHAIN_ROTATION_START_DATE: '2026-07-11',
  });

  assert.deepEqual(config.workers.maintenanceChainRotation, [
    ['claude-fable', 'codex-sol', 'claude-opus', 'codex-terra'],
    ['codex-sol', 'claude-fable', 'codex-terra', 'claude-opus'],
  ]);
  assert.equal(config.workers.maintenanceChainRotationStartDate, '2026-07-11');
});

test('loadDotEnv treats empty inherited values as unset', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-dotenv-'));
  const envPath = path.join(temp, '.env');
  await fs.writeFile(envPath, [
    'GITHUB_TOKEN=from-dotenv',
    'DISCORD_BOT_TOKEN=from-dotenv',
    '',
  ].join('\n'));

  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousDiscordBotToken = process.env.DISCORD_BOT_TOKEN;
  process.env.GITHUB_TOKEN = '';
  process.env.DISCORD_BOT_TOKEN = 'from-parent';
  try {
    loadDotEnv(envPath);
    assert.equal(process.env.GITHUB_TOKEN, 'from-dotenv');
    assert.equal(process.env.DISCORD_BOT_TOKEN, 'from-parent');
  } finally {
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousDiscordBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previousDiscordBotToken;
  }
});

test('loadDotEnv lets .env win over a stale inherited worker chain', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-dotenv-authority-'));
  const envPath = path.join(temp, '.env');
  await fs.writeFile(envPath, [
    'DEFAULT_WORKER_CHAIN=claude,antigravity,codex-spark,codex-luna',
    'DAILY_MAINTENANCE_ENABLED=false',
    'DISCORD_BOT_TOKEN=from-dotenv',
    '',
  ].join('\n'));

  const previous = {
    chain: process.env.DEFAULT_WORKER_CHAIN,
    maintenance: process.env.DAILY_MAINTENANCE_ENABLED,
    token: process.env.DISCORD_BOT_TOKEN,
  };
  // A long-lived parent froze an older `.env` into the inherited env.
  process.env.DEFAULT_WORKER_CHAIN = 'codex-luna,claude,antigravity,codex-spark';
  process.env.DAILY_MAINTENANCE_ENABLED = 'true';
  process.env.DISCORD_BOT_TOKEN = 'from-parent';
  try {
    loadDotEnv(envPath);
    assert.equal(process.env.DEFAULT_WORKER_CHAIN, 'claude,antigravity,codex-spark,codex-luna');
    assert.equal(process.env.DAILY_MAINTENANCE_ENABLED, 'false');
    // Non-tunable keys keep the existing precedence.
    assert.equal(process.env.DISCORD_BOT_TOKEN, 'from-parent');
  } finally {
    for (const [key, value] of [
      ['DEFAULT_WORKER_CHAIN', previous.chain],
      ['DAILY_MAINTENANCE_ENABLED', previous.maintenance],
      ['DISCORD_BOT_TOKEN', previous.token],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('dotEnvAuthoritativeChildEnv restores .env authority for tunables only', () => {
  const dotenvEnv = {
    DEFAULT_WORKER_CHAIN: 'claude,antigravity,codex-spark,codex-luna',
    BRIDGE_STATE_ROOT: '/from/dotenv',
  };
  const inherited = {
    DEFAULT_WORKER_CHAIN: 'codex-luna,claude',
    COMPANY_WORKER_CHAIN: 'stale-and-removed-from-dotenv',
    BRIDGE_STATE_ROOT: '/host/explicit',
    PATH: '/host/path',
  };

  const env = dotEnvAuthoritativeChildEnv(dotenvEnv, inherited);
  assert.equal(env.DEFAULT_WORKER_CHAIN, 'claude,antigravity,codex-spark,codex-luna');
  // Host-launcher and canary overrides stay authoritative.
  assert.equal(env.BRIDGE_STATE_ROOT, '/host/explicit');
  assert.equal(env.PATH, '/host/path');
  // A tunable removed from `.env` falls back to the code default instead of
  // keeping the value a stale parent froze.
  assert.equal('COMPANY_WORKER_CHAIN' in env, false);
});

test('a raised maintenance effort survives a Watchdog that froze the old value', () => {
  const dotenvEnv = {
    CODEX_MAINTENANCE_SOL_REASONING_EFFORT: 'ultra',
    CODEX_SUBAGENT_MODEL: 'gpt-5.6-luna',
    CODEX_SUBAGENT_REASONING_EFFORT: 'max',
  };
  // The long-lived Watchdog booted before the raise and is not replaced by a
  // restart, so it hands every Supervisor generation the effort it started with.
  const inherited = { CODEX_MAINTENANCE_SOL_REASONING_EFFORT: 'max' };

  const env = dotEnvAuthoritativeChildEnv(dotenvEnv, inherited);
  assert.equal(env.CODEX_MAINTENANCE_SOL_REASONING_EFFORT, 'ultra');
  assert.equal(loadConfig(env).codex.maintenanceSolReasoningEffort, 'ultra');
  assert.equal(env.CODEX_SUBAGENT_MODEL, 'gpt-5.6-luna');
  assert.equal(env.CODEX_SUBAGENT_REASONING_EFFORT, 'max');
});

test('an explicitly pinned tunable stays authoritative over .env', () => {
  const dotenvEnv = {
    DEFAULT_WORKER_CHAIN: 'claude,antigravity',
    DAILY_MAINTENANCE_ENABLED: 'true',
  };
  // An isolated canary stack or test harness pins what it must not inherit.
  const inherited = {
    DAILY_MAINTENANCE_ENABLED: 'false',
    BRIDGE_EXPLICIT_ENV_KEYS: 'DAILY_MAINTENANCE_ENABLED',
  };

  const env = dotEnvAuthoritativeChildEnv(dotenvEnv, inherited);
  assert.equal(env.DAILY_MAINTENANCE_ENABLED, 'false');
  // Unpinned tunables still refresh from `.env`.
  assert.equal(env.DEFAULT_WORKER_CHAIN, 'claude,antigravity');
  // The pin propagates so deeper children keep honouring it.
  assert.equal(env.BRIDGE_EXPLICIT_ENV_KEYS, 'DAILY_MAINTENANCE_ENABLED');
});

test('channel env uses explicit channel.env and allowlisted keys only', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-channel-env-'));
  const stateRoot = path.join(temp, 'state');
  const config = loadConfig({
    PROJECT_ROOT: path.join(temp, 'projects'),
    BRIDGE_STATE_ROOT: stateRoot,
    CHANNEL_ENV_FILENAME: '../bad.env',
    CHANNEL_ENV_ALLOWLIST: 'GITHUB_TOKEN,HF_TOKEN,1BAD',
  });

  assert.equal(config.channelEnv.filename, 'channel.env');
  assert.deepEqual([...config.channelEnv.allowlist], ['GITHUB_TOKEN', 'HF_TOKEN']);
  assert.equal(channelEnvFilePath(config, 'channel-1'), path.join(stateRoot, 'channel-1_common', 'channel.env'));

  await fs.mkdir(path.join(stateRoot, 'channel-1_common'), { recursive: true });
  await fs.writeFile(path.join(stateRoot, 'channel-1_common', 'channel.env'), [
    'GITHUB_TOKEN=channel-token',
    'HF_TOKEN=hf-token',
    'UNLISTED=hidden',
    '',
  ].join('\n'));

  assert.deepEqual(channelEnvOverrides(config, 'channel-1'), {
    GITHUB_TOKEN: 'channel-token',
    HF_TOKEN: 'hf-token',
  });
});

test('loadConfig supports channel Python virtualenv settings', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    CHANNEL_PYTHON_VENV_ENABLED: 'false',
    CHANNEL_PYTHON_VENV_AUTO_CREATE: 'true',
    CHANNEL_PYTHON_VENV_REQUIRED: 'true',
    CHANNEL_PYTHON_VENV_AUTO_UPGRADE: 'false',
    CHANNEL_PYTHON_BOOTSTRAP_PIP: 'false',
    BRIDGE_PIP_BOOTSTRAP_URL: 'https://example.invalid/get-pip.py',
    CHANNEL_PYTHON_VENV_DIR: '../bad',
    BRIDGE_PYTHON_BIN: '/opt/python/bin/python3.13',
    BRIDGE_PYTHON_CANDIDATES: 'python3.13,python3.12',
  });

  assert.equal(config.python.channelVenvEnabled, false);
  assert.equal(config.python.autoCreateChannelVenv, true);
  assert.equal(config.python.requireChannelVenv, true);
  assert.equal(config.python.autoUpgradeChannelVenv, false);
  assert.equal(config.python.bootstrapPip, false);
  assert.equal(config.python.pipBootstrapUrl, 'https://example.invalid/get-pip.py');
  assert.equal(config.python.channelVenvDir, '.venv');
  assert.equal(config.python.bin, '/opt/python/bin/python3.13');
  assert.deepEqual(config.python.candidates, ['python3.13', 'python3.12']);
});

test('workerToolSearchPath includes runtime tool dirs and skips bare command dirname', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_STATE_ROOT: '/tmp/projects/.bridge_state',
  });
  const entries = workerToolSearchPath(config, 'codex', '/opt/tools/claude').split(path.delimiter);

  assert(entries.includes('/tmp/projects/.bridge_state/worker-tools/node_modules/.bin'));
  assert(entries.includes('/opt/tools'));
  assert(entries.includes(path.dirname(process.execPath)));
  assert.equal(entries.includes('.'), false);
});

test('workerToolSearchPath gives channel virtualenv precedence when present', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_STATE_ROOT: '/tmp/projects/.bridge_state',
  });
  config.python = {
    ...config.python,
    venvBinDir: '/tmp/projects/.bridge_state/channel-1_common/.venv/bin',
  };

  const entries = workerToolSearchPath(config, 'codex').split(path.delimiter);
  assert.equal(entries[0], '/tmp/projects/.bridge_state/channel-1_common/.venv/bin');
});

test('loadConfig keeps Antigravity home separate from Gemini home by default', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    GEMINI_HOME: '/tmp/custom-gemini-home',
  });

  assert.equal(config.gemini.home, '/tmp/custom-gemini-home');
  assert.equal(config.antigravity.home, '/tmp/projects/.bridge_state/antigravity-home');
});

test('loadConfig supports Codex sandbox mode override', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    CODEX_SANDBOX_MODE: 'workspace-write',
    CODEX_MAINTENANCE_SANDBOX_MODE: 'danger-full-access',
  });

  assert.equal(config.codex.sandboxMode, 'workspace-write');
  assert.equal(config.codex.maintenanceSandboxMode, 'danger-full-access');
});

test('max is a valid GPT-5.6 codex effort but is clamped for the 5.3 Spark worker', () => {
  const baseEnv = {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  };

  // Sol/Terra/Luna are GPT-5.6, so max must pass validation without a warning.
  const maxConfig = loadConfig({ ...baseEnv, CODEX_REASONING_EFFORT: 'max' });
  assert.equal(maxConfig.codex.reasoningEffort, 'max');
  assert.equal(maxConfig.codexSpark.reasoningEffort, 'xhigh');
  assert.deepEqual(
    validateConfig(maxConfig).filter((warning) => warning.includes('REASONING_EFFORT')),
    [],
  );

  // Spark rejects max with HTTP 400, so the request is clamped to its top tier and
  // surfaced as a startup warning instead of failing every Spark job.
  const sparkMaxConfig = loadConfig({ ...baseEnv, CODEX_SPARK_REASONING_EFFORT: 'max' });
  assert.equal(sparkMaxConfig.codexSpark.reasoningEffort, 'xhigh');
  assert.deepEqual(
    validateConfig(sparkMaxConfig).filter((warning) => warning.includes('CODEX_SPARK_REASONING_EFFORT')),
    ['CODEX_SPARK_REASONING_EFFORT is max, which gpt-5.3-codex-spark does not support; using xhigh instead.'],
  );

  // A supported Spark tier is kept verbatim and stays warning-free.
  const sparkHighConfig = loadConfig({ ...baseEnv, CODEX_SPARK_REASONING_EFFORT: 'high' });
  assert.equal(sparkHighConfig.codexSpark.reasoningEffort, 'high');
  assert.deepEqual(
    validateConfig(sparkHighConfig).filter((warning) => warning.includes('CODEX_SPARK_REASONING_EFFORT')),
    [],
  );

  // `ultra` is a real CLI tier on Sol/Terra, so it must pass validation; Luna's
  // clamp happens in thread-models, not as a startup warning.
  const ultraConfig = loadConfig({ ...baseEnv, CODEX_REASONING_EFFORT: 'ultra' });
  assert.equal(ultraConfig.codex.reasoningEffort, 'ultra');
  assert.deepEqual(
    validateConfig(ultraConfig).filter((warning) => warning.startsWith('CODEX_REASONING_EFFORT is')),
    [],
  );

  // An unusable value still warns rather than reaching the CLI.
  const bogusConfig = loadConfig({ ...baseEnv, CODEX_REASONING_EFFORT: 'hyper' });
  assert.equal(
    validateConfig(bogusConfig).some((warning) => warning.startsWith('CODEX_REASONING_EFFORT is hyper;')),
    true,
  );
});

test('delegated Codex subagents default to Luna at max and validate as a pair', () => {
  const baseEnv = {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  };

  const defaults = loadConfig(baseEnv);
  assert.equal(defaults.codex.subagentModel, 'gpt-5.6-luna');
  assert.equal(defaults.codex.subagentReasoningEffort, 'max');
  assert.deepEqual(
    validateConfig(defaults).filter((warning) => warning.includes('CODEX_SUBAGENT')),
    [],
  );

  // A typo has to warn at startup instead of failing at the first spawn_agent
  // call. Whether a real tier exists for the chosen model is clamped by the runner.
  const typoSubagent = loadConfig({ ...baseEnv, CODEX_SUBAGENT_REASONING_EFFORT: 'hyper' });
  assert.deepEqual(
    validateConfig(typoSubagent).filter((warning) => warning.includes('CODEX_SUBAGENT_REASONING_EFFORT')),
    ['CODEX_SUBAGENT_REASONING_EFFORT is hyper; expected one of none, low, medium, high, xhigh, max, ultra.'],
  );

  // An empty model means "inherit the root model", so an effort alone is inert.
  const modelless = loadConfig({ ...baseEnv, CODEX_SUBAGENT_MODEL: '' });
  assert.equal(modelless.codex.subagentModel, '');
  assert.deepEqual(
    validateConfig(modelless).filter((warning) => warning.includes('CODEX_SUBAGENT')),
    ['CODEX_SUBAGENT_REASONING_EFFORT is set but CODEX_SUBAGENT_MODEL is empty; delegated subagents keep the root model default.'],
  );
});

test('loadConfig keeps bridge state and bridge repo out of global worker allowed roots', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    CODEX_ALLOWED_ROOTS: '/tmp/projects,/tmp/projects/mobile-codex-bridge,/tmp/projects/.bridge_state',
  });

  assert.deepEqual(config.allowedRoots, []);
});

test('loadConfig can opt into single job mode', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    BRIDGE_SINGLE_JOB_MODE: 'true',
    CODEX_MAX_CONCURRENT_JOBS: '8',
  });

  assert.equal(config.queue.maxConcurrentJobs, 1);

  const parallelConfig = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    CODEX_MAX_CONCURRENT_JOBS: '8',
  });
  assert.equal(parallelConfig.queue.maxConcurrentJobs, 8);

  const unlimitedConfig = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    CODEX_MAX_CONCURRENT_JOBS: '0',
  });
  assert.equal(unlimitedConfig.queue.maxConcurrentJobs, 0);

  const highParallelConfig = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    CODEX_MAX_CONCURRENT_JOBS: '99',
  });
  assert.equal(highParallelConfig.queue.maxConcurrentJobs, 99);
});

test('loadConfig supports daily report channel settings', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111,222,333',
    DISCORD_ECONOMY_CHANNEL_ID: '222',
    DISCORD_AI_CHANNEL_ID: '333',
    DAILY_REPORTS_HOUR_KST: '8',
    DAILY_REPORTS_ENABLED: 'true',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  });

  assert.deepEqual(config.dailyReports, {
    enabled: true,
    hourKst: 8,
    economyChannelId: '222',
    aiChannelId: '333',
    xApiAvailable: false,
  });
});

test('loadConfig records X read availability without retaining the credential', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    X_BEARER_TOKEN: 'do-not-persist-this-token',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  });

  assert.equal(config.dailyReports.xApiAvailable, true);
  assert.equal(Object.hasOwn(config.dailyReports, 'xBearerToken'), false);
});

test('loadConfig supports daily maintenance input budget settings', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    DAILY_MAINTENANCE_INPUT_BUDGET_CHARS: '64000',
    DAILY_MAINTENANCE_INLINE_ITEMS: '12',
    BRIDGE_BUG_REPORT_REPOSITORY: 'owner/mobile-codex-bridge',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  });

  assert.equal(config.maintenance.inputBudgetChars, 64_000);
  assert.equal(config.maintenance.inlineItems, 12);
  assert.equal(config.maintenance.bugReportRepository, 'owner/mobile-codex-bridge');
});

test('loadConfig parses quota remaining env values', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_ALLOWED_CHANNEL_IDS: '111',
    CODEX_QUOTA_REMAINING: '180',
    CLAUDE_QUOTA_REMAINING: '90',
    GEMINI_QUOTA_REMAINING: '60',
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  });

  assert.equal(config.usage.codexRemainingQuota, 180);
  assert.equal(config.usage.claudeRemainingQuota, 90);
  assert.equal(config.usage.geminiRemainingQuota, 60);
});

test('thread state is stored below channel state', () => {
  const config = { stateRoot: '/tmp/bridge-state' };

  assert.equal(channelStateDir(config, '1000000000000000003'), path.join('/tmp/bridge-state', '1000000000000000003_common'));
  assert.equal(
    threadStateDir(config, '1000000000000000003', '1000000000000000004'),
    path.join('/tmp/bridge-state', '1000000000000000003', '1000000000000000004'),
  );
  assert.equal(statePathPart('weird/thread id'), 'weird_thread_id');
});

test('todo files are channel-scoped state files', () => {
  const config = { stateRoot: '/tmp/bridge-state' };

  assert.deepEqual(todoStateFiles(config, '1000000000000000003'), {
    items: path.join('/tmp/bridge-state', '1000000000000000003_common', 'todo.jsonl'),
    completed: path.join('/tmp/bridge-state', '1000000000000000003_common', 'todo-completed.jsonl'),
    alerts: path.join('/tmp/bridge-state', '1000000000000000003_common', 'alerts.jsonl'),
    alertsCompleted: path.join('/tmp/bridge-state', '1000000000000000003_common', 'alerts-completed.jsonl'),
  });
});

test('loadConfig resolves the host gh credential directory for redirected worker homes', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-gh-'));
  const ghConfigDir = path.join(temp, '.config', 'gh');
  const gitConfigGlobal = path.join(temp, '.gitconfig');
  const askPassPath = path.join(temp, 'github-gh-askpass.sh');
  await fs.mkdir(ghConfigDir, { recursive: true });
  await fs.writeFile(path.join(ghConfigDir, 'hosts.yml'), 'github.com:\n    user: tester\n');
  await fs.writeFile(gitConfigGlobal, '[credential "https://github.com"]\n    helper = !gh auth git-credential\n');
  await fs.writeFile(askPassPath, '#!/bin/sh\nexit 1\n');

  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    HOME: temp,
    BRIDGE_GH_ASKPASS: askPassPath,
    BRIDGE_PREFER_HOST_GH_CREDENTIAL: 'true',
  });

  assert.equal(config.github.hostHome, temp);
  assert.equal(config.github.configDir, ghConfigDir);
  assert.equal(config.github.gitConfigGlobal, gitConfigGlobal);
  assert.equal(config.github.askPassPath, askPassPath);
  assert.equal(config.github.credentialAvailable, true);
  assert.equal(config.github.gitConfigAvailable, true);
  assert.equal(config.github.askPassAvailable, true);
  assert.equal(config.github.preferHostCredential, true);
  assert.deepEqual(hostGitHubAuthEnv(config), {
    GH_CONFIG_DIR: ghConfigDir,
    GIT_CONFIG_GLOBAL: gitConfigGlobal,
    GIT_ASKPASS: askPassPath,
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
    GIT_TERMINAL_PROMPT: '0',
  });
});

test('hostGitHubAuthEnv leaves worker tokens untouched without a host gh login', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-gh-missing-'));
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    HOME: temp,
  });

  assert.equal(config.github.credentialAvailable, false);
  assert.equal(config.github.gitConfigAvailable, false);
  assert.equal(config.github.askPassAvailable, false);
  assert.deepEqual(hostGitHubAuthEnv(config), {});
});

test('hostGitHubAuthEnv can be disabled when a host token should win', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-gh-optout-'));
  const ghConfigDir = path.join(temp, 'gh-config');
  const gitConfigGlobal = path.join(temp, 'host.gitconfig');
  const askPassPath = path.join(temp, 'host-askpass.sh');
  await fs.mkdir(ghConfigDir, { recursive: true });
  await fs.writeFile(path.join(ghConfigDir, 'hosts.yml'), 'github.com:\n    user: tester\n');
  await fs.writeFile(gitConfigGlobal, '[user]\n    name = Tester\n');
  await fs.writeFile(askPassPath, '#!/bin/sh\nexit 1\n');

  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    HOME: temp,
    BRIDGE_GH_CONFIG_DIR: ghConfigDir,
    BRIDGE_GIT_CONFIG_GLOBAL: gitConfigGlobal,
    BRIDGE_GH_ASKPASS: askPassPath,
    BRIDGE_PREFER_HOST_GH_CREDENTIAL: 'false',
  });

  assert.equal(config.github.configDir, ghConfigDir);
  assert.equal(config.github.gitConfigGlobal, gitConfigGlobal);
  assert.equal(config.github.askPassPath, askPassPath);
  assert.equal(config.github.credentialAvailable, true);
  assert.equal(config.github.gitConfigAvailable, true);
  assert.equal(config.github.askPassAvailable, true);
  assert.equal(config.github.preferHostCredential, false);
  assert.deepEqual(hostGitHubAuthEnv(config), {});
});
