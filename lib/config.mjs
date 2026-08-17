import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMaintenanceMode } from './maintenance-adaptive.mjs';

const DEFAULT_BRIDGE_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// Daily maintenance is intentionally pinned to the one fully-authorized Sol
// worker.  A maintenance job changes shared runtime/state, so a provider
// rotation can repeat non-idempotent work after a partial failure.
const DEFAULT_MAINTENANCE_WORKER_CHAIN = 'sol';

// Routing and scheduling switches an operator edits in `.env` to change how the
// running bridge behaves.  For every other key an already-resolved process env
// wins, because the host launcher, canary, and promotion launcher set
// infrastructure keys (state root, runtime version, ignore-before, internal
// token) that `.env` must not override.
//
// These keys need the opposite precedence.  `loadDotEnv` copies `.env` into
// `process.env` at process start, so a long-lived parent freezes the values it
// booted with and passes them down to every child it spawns afterwards.  The v3
// watchdog is exactly that parent and is not replaced by a restart, so editing
// `.env` and restarting left every supervisor/workbench generation running the
// chain from whenever the watchdog last booted.
export const DOTENV_AUTHORITATIVE_KEYS = new Set([
  'DEFAULT_WORKER_CHAIN',
  'COMPANY_WORKER_CHAIN',
  'MAINTENANCE_WORKER_CHAIN',
  'MAINTENANCE_WORKER_CHAIN_ROTATION',
  'MAINTENANCE_WORKER_CHAIN_ROTATION_START_DATE',
  'WORKER_FALLBACK_ENABLED',
  'DAILY_MAINTENANCE_ENABLED',
  // Same class of routing tunable as the chain above: which model/effort the
  // pinned maintenance worker runs at, and where the subagents it delegates to
  // run. Without authoritative reloads, a long-lived Watchdog can freeze old
  // values across every later Supervisor generation.
  'CODEX_MAINTENANCE_SOL_REASONING_EFFORT',
  'CODEX_SUBAGENT_MODEL',
  'CODEX_SUBAGENT_REASONING_EFFORT',
]);

// Opt-out for a caller that pins a tunable on purpose — an isolated canary
// stack or a test harness that must not inherit the operator's live routing.
// Listing a key here keeps the inherited value authoritative over `.env`.
export const EXPLICIT_ENV_KEYS_VAR = 'BRIDGE_EXPLICIT_ENV_KEYS';

export function explicitEnvKeys(env = process.env) {
  return new Set(
    String(env?.[EXPLICIT_ENV_KEYS_VAR] || '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

function dotEnvIsAuthoritativeFor(key, env) {
  return DOTENV_AUTHORITATIVE_KEYS.has(key) && !explicitEnvKeys(env).has(key);
}

export function loadDotEnv(filePath = '.env') {
  if (!fs.existsSync(filePath)) return;

  for (const [key, value] of Object.entries(parseDotEnvContent(fs.readFileSync(filePath, 'utf8')))) {
    if (dotEnvIsAuthoritativeFor(key, process.env)) process.env[key] = value;
    else if (!(key in process.env) || process.env[key] === '') process.env[key] = value;
  }
}

// Env for a child process, with `.env` restored as authority over the inherited
// values for the operational tunables above.
export function dotEnvAuthoritativeChildEnv(dotenvEnv = {}, inheritedEnv = process.env) {
  const env = { ...dotenvEnv, ...inheritedEnv };
  for (const key of DOTENV_AUTHORITATIVE_KEYS) {
    if (!dotEnvIsAuthoritativeFor(key, inheritedEnv)) continue;
    if (Object.prototype.hasOwnProperty.call(dotenvEnv, key)) env[key] = dotenvEnv[key];
    // Dropped from `.env` entirely: fall back to the code default rather than
    // keeping the value a stale parent froze.
    else delete env[key];
  }
  return env;
}

export function parseDotEnvContent(content = '') {
  const values = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    if (!isEnvKeyName(key)) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readDotEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return parseDotEnvContent(fs.readFileSync(filePath, 'utf8'));
}

export function loadConfig(env = process.env) {
  const configuredProjectRoot = String(env.PROJECT_ROOT || '').trim();
  const configuredBridgeProject = String(env.BRIDGE_CODEX_PROJECT || '').trim();
  const configuredBridgeRepoRoot = String(env.BRIDGE_REPO_ROOT || '').trim();
  const bridgeCodexProject = configuredBridgeProject || path.basename(DEFAULT_BRIDGE_REPO_ROOT);
  const bridgeRepoRoot = path.resolve(
    configuredBridgeRepoRoot
      || (configuredProjectRoot || configuredBridgeProject
        ? path.join(configuredProjectRoot || path.dirname(DEFAULT_BRIDGE_REPO_ROOT), bridgeCodexProject)
        : DEFAULT_BRIDGE_REPO_ROOT),
  );
  const projectRoot = path.resolve(configuredProjectRoot || path.dirname(bridgeRepoRoot));
  const defaultStateRoot = path.join(projectRoot, '.bridge_state');
  const stateRoot = path.resolve(env.DATA_DIR || env.BRIDGE_STATE_ROOT || defaultStateRoot);
  const repositoriesRoot = path.join(stateRoot, 'repositories');
  const defaultCodexWorkspace = path.join(stateRoot, 'workspace');
  const defaultCodexHome = path.join(stateRoot, 'codex-home');
  const defaultGeminiHome = path.join(stateRoot, 'gemini-home');
  const defaultAntigravityHome = path.join(stateRoot, 'antigravity-home');
  const claudeHome = path.resolve(env.CLAUDE_HOME || path.join(stateRoot, 'claude-home'));
  const claudeSecondaryHome = String(env.CLAUDE_SECONDARY_HOME || '').trim();
  const geminiHome = path.resolve(env.GEMINI_HOME || defaultGeminiHome);
  const antigravityHome = path.resolve(env.ANTIGRAVITY_HOME || defaultAntigravityHome);
  const workerToolBinDir = path.join(stateRoot, 'worker-tools', 'node_modules', '.bin');
  const hostHome = path.resolve(env.BRIDGE_HOST_HOME || env.HOME || os.homedir());
  const ghConfigDir = path.resolve(env.BRIDGE_GH_CONFIG_DIR || path.join(hostHome, '.config', 'gh'));
  const gitConfigGlobal = path.resolve(env.BRIDGE_GIT_CONFIG_GLOBAL || path.join(hostHome, '.gitconfig'));
  const ghAskPassPath = path.resolve(
    env.BRIDGE_GH_ASKPASS || path.join(bridgeRepoRoot, 'scripts', 'github-gh-askpass.sh'),
  );
  const channelPythonVenvDir = normalizeChannelPythonVenvDir(env.CHANNEL_PYTHON_VENV_DIR || '.venv');
  const channelIds = splitList(env.DISCORD_ALLOWED_CHANNEL_IDS || env.DISCORD_CHANNEL_IDS);
  const allowedRoots = safeAllowedRoots(splitList(env.CODEX_ALLOWED_ROOTS || ''), {
    stateRoot,
    excludedRoots: [bridgeRepoRoot],
  });
  const requestedMaxConcurrentJobs = toInt(env.CODEX_MAX_CONCURRENT_JOBS || env.MAX_CONCURRENT_JOBS, 1);
  const singleJobMode = toBool(env.BRIDGE_SINGLE_JOB_MODE, false);
  const maxConcurrentJobs = singleJobMode ? 1 : Math.max(0, requestedMaxConcurrentJobs);

  return {
    stateRoot,
    repositoriesRoot,
    projectRoot,
    bridgeCodexProject,
    bridgeRepoRoot,
    allowedRoots,
    workerEnvAllowlist: new Set(splitList(env.WORKER_ENV_ALLOWLIST).filter(isEnvKeyName)),
    channelEnv: {
      filename: normalizeChannelEnvFilename(env.CHANNEL_ENV_FILENAME || 'channel.env'),
      allowlist: new Set(splitList(env.CHANNEL_ENV_ALLOWLIST).filter(isEnvKeyName)),
    },
    github: {
      hostHome,
      configDir: ghConfigDir,
      gitConfigGlobal,
      askPassPath: ghAskPassPath,
      // Every worker runs with a redirected HOME, so gh's persisted login is
      // only reachable when both the gh login and git's gh credential helper
      // configuration are passed through explicitly. Git 2.25 ignores
      // GIT_CONFIG_GLOBAL, so the askpass helper is the compatibility path.
      credentialAvailable: fs.existsSync(path.join(ghConfigDir, 'hosts.yml')),
      gitConfigAvailable: fs.existsSync(gitConfigGlobal),
      askPassAvailable: fs.existsSync(ghAskPassPath),
      preferHostCredential: toBool(env.BRIDGE_PREFER_HOST_GH_CREDENTIAL, false),
    },
    python: {
      channelVenvEnabled: toBool(env.CHANNEL_PYTHON_VENV_ENABLED, true),
      autoCreateChannelVenv: toBool(env.CHANNEL_PYTHON_VENV_AUTO_CREATE, false),
      requireChannelVenv: toBool(env.CHANNEL_PYTHON_VENV_REQUIRED, false),
      autoUpgradeChannelVenv: toBool(env.CHANNEL_PYTHON_VENV_AUTO_UPGRADE, true),
      bootstrapPip: toBool(env.CHANNEL_PYTHON_BOOTSTRAP_PIP, false),
      pipBootstrapUrl: env.BRIDGE_PIP_BOOTSTRAP_URL || 'https://bootstrap.pypa.io/get-pip.py',
      channelVenvDir: channelPythonVenvDir,
      bin: env.BRIDGE_PYTHON_BIN || env.PYTHON_BIN || '',
      candidates: splitList(env.BRIDGE_PYTHON_CANDIDATES || DEFAULT_PYTHON_CANDIDATES.join(',')),
    },
    codex: {
      bin: env.CODEX_BIN || 'codex',
      home: path.resolve(env.BRIDGE_CODEX_HOME || defaultCodexHome),
      homeSource: path.resolve(env.BRIDGE_CODEX_HOME_SOURCE || path.join(hostHome, '.codex')),
      solModel: env.CODEX_SOL_MODEL || 'gpt-5.6-sol',
      model: env.CODEX_MODEL || 'gpt-5.6-terra',
      lunaModel: env.CODEX_LUNA_MODEL || 'gpt-5.6-luna',
      maintenanceModel: env.CODEX_MAINTENANCE_MODEL || 'gpt-5.6-terra',
      maintenanceSolModel: env.CODEX_MAINTENANCE_SOL_MODEL || 'gpt-5.6-sol',
      // Sol supports `ultra` (max reasoning plus proactive subagent delegation),
      // so daily maintenance runs there and delegates to `codex.subagentModel`
      // below instead of fanning out at Sol cost.
      maintenanceSolReasoningEffort: env.CODEX_MAINTENANCE_SOL_REASONING_EFFORT || 'ultra',
      reasoningEffort: env.CODEX_REASONING_EFFORT || 'xhigh',
      reasoningSummary: env.CODEX_REASONING_SUMMARY || 'auto',
      // The `ultra` effort tier delegates work to Codex-spawned subagents. Those
      // threads inherit the root model unless `agents.default_subagent_*` names
      // another one, so point them at Luna (max) to keep delegated work off the
      // more expensive Sol/Terra budget. Applies to every Codex run, not just
      // `ultra` — an explicit `spawn_agent` at any effort uses the same default.
      subagentModel: (env.CODEX_SUBAGENT_MODEL ?? 'gpt-5.6-luna').trim(),
      subagentReasoningEffort: (env.CODEX_SUBAGENT_REASONING_EFFORT ?? 'max').trim().toLowerCase(),
      sandboxMode: normalizeCodexSandboxMode(env.CODEX_SANDBOX_MODE || 'workspace-write'),
      maintenanceSandboxMode: normalizeCodexSandboxMode(env.CODEX_MAINTENANCE_SANDBOX_MODE || 'workspace-write'),
      cwd: path.resolve(env.CODEX_WORKING_DIR || defaultCodexWorkspace),
      maxConcurrentJobs,
    },
    codexSpark: {
      model: env.CODEX_SPARK_MODEL || 'gpt-5.3-codex-spark',
      // The configured gpt-5.3-codex-spark catalog rejects `max` with
      // `unsupported_value` and reports low, medium,
      // high, xhigh as its supported reasoning efforts. xhigh is therefore Spark's
      // maximum tier, so a higher configured value is clamped down to it instead of
      // failing every Spark job at the first API call.
      reasoningEffort: normalizeCodexSparkReasoningEffort(env.CODEX_SPARK_REASONING_EFFORT),
      requestedReasoningEffort: String(env.CODEX_SPARK_REASONING_EFFORT || '').trim().toLowerCase() || null,
      reasoningSummary: env.CODEX_SPARK_REASONING_SUMMARY || env.CODEX_REASONING_SUMMARY || 'auto',
    },
    workers: {
      fallbackEnabled: toBool(env.WORKER_FALLBACK_ENABLED, true),
      quotaCooldownMs: toInt(env.WORKER_QUOTA_COOLDOWN_MS, 30 * 60_000),
      capacityCooldownMs: toInt(env.WORKER_CAPACITY_COOLDOWN_MS, 5 * 60_000),
      maxCooldownMs: toInt(env.WORKER_COOLDOWN_MAX_MS, 24 * 60 * 60_000),
      defaultChain: normalizeWorkerChain(env.DEFAULT_WORKER_CHAIN || 'codex,claude,antigravity,codex-spark,codex-luna'),
      companyChain: normalizeWorkerChain(env.COMPANY_WORKER_CHAIN || 'claude,codex,antigravity,codex-spark,codex-luna'),
      maintenanceChain: normalizeMaintenanceWorkerChain(
        env.MAINTENANCE_WORKER_CHAIN === undefined
          ? DEFAULT_MAINTENANCE_WORKER_CHAIN
          : env.MAINTENANCE_WORKER_CHAIN,
      ),
      maintenanceChainRotation: normalizeMaintenanceWorkerChainRotation(
        env.MAINTENANCE_WORKER_CHAIN_ROTATION || '',
      ),
      maintenanceChainRotationStartDate: normalizeKstDate(env.MAINTENANCE_WORKER_CHAIN_ROTATION_START_DATE || ''),
      companyChannelIds: new Set(splitList(env.COMPANY_WORKER_CHANNEL_IDS)),
      toolBinDir: workerToolBinDir,
    },
    claude: {
      bin: env.CLAUDE_BIN || 'claude',
      home: claudeHome,
      // The primary account remains backwards-compatible with CLAUDE_HOME.
      // A second HOME is opt-in so existing installations retain one account.
      accounts: [
        {
          id: 'primary',
          label: env.CLAUDE_PRIMARY_LABEL || '기본',
          home: claudeHome,
        },
        ...(claudeSecondaryHome && path.resolve(claudeSecondaryHome) !== claudeHome
          ? [{
              id: 'secondary',
              label: env.CLAUDE_SECONDARY_LABEL || '보조',
              home: path.resolve(claudeSecondaryHome),
            }]
          : []),
      ],
      model: env.CLAUDE_MODEL || 'opus',
      effort: env.CLAUDE_EFFORT || 'xhigh',
      maintenanceModel: env.CLAUDE_MAINTENANCE_MODEL || 'claude-fable-5',
      maintenanceEffort: env.CLAUDE_MAINTENANCE_EFFORT || 'xhigh',
      maintenanceFallbackModel: env.CLAUDE_MAINTENANCE_FALLBACK_MODEL || 'claude-opus-5',
      maintenanceFallbackEffort: env.CLAUDE_MAINTENANCE_FALLBACK_EFFORT || 'xhigh',
      permissionMode: env.CLAUDE_PERMISSION_MODE || 'default',
      maintenancePermissionMode: env.CLAUDE_MAINTENANCE_PERMISSION_MODE || 'default',
    },
    gemini: {
      bin: env.GEMINI_BIN || 'gemini',
      home: geminiHome,
      model: env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
      fallbackModel: env.GEMINI_FALLBACK_MODEL || 'gemini-3-flash-preview',
      approvalMode: env.GEMINI_APPROVAL_MODE || 'default',
      sandbox: env.GEMINI_SANDBOX || 'false',
    },
    antigravity: {
      bin: env.ANTIGRAVITY_BIN || 'agy',
      home: antigravityHome,
      model: env.ANTIGRAVITY_MODEL || 'gemini-3.7-flash-high',
      fallbackModel: env.ANTIGRAVITY_FALLBACK_MODEL || '',
      // Model strings the `/model` menu hands to the `agy` CLI for the two Antigravity
      // callings. Keep them overridable because the CLI's model catalog is version-sensitive.
      opusModel: env.ANTIGRAVITY_OPUS_MODEL || 'Claude Opus 4.6 (Thinking)',
      proModel: env.ANTIGRAVITY_PRO_MODEL || 'gemini-3.7-flash-high',
      effort: normalizeAntigravityEffort(env.ANTIGRAVITY_EFFORT || 'high'),
      approvalMode: env.ANTIGRAVITY_APPROVAL_MODE || 'default',
      sandbox: env.ANTIGRAVITY_SANDBOX || 'false',
      preflightTimeoutMs: toInt(env.ANTIGRAVITY_PREFLIGHT_TIMEOUT_MS, 20_000),
    },
    discord: {
      enabled: toBool(env.DISCORD_ENABLED, Boolean(env.DISCORD_BOT_TOKEN)),
      token: env.DISCORD_BOT_TOKEN || '',
      apiBaseUrl: env.DISCORD_API_BASE_URL || 'https://discord.com/api/v10',
      channelIds,
      allowedChannelIds: new Set(channelIds),
      generalChannelId: env.DISCORD_GENERAL_CHANNEL_ID || channelIds[0] || '',
      allowedUserIds: new Set(splitList(env.DISCORD_ALLOWED_USER_IDS)),
      allowAllUsers: toBool(env.DISCORD_ALLOW_ALL_USERS, false),
      threadMode: env.DISCORD_THREAD_MODE || 'per_message',
      threadFeedMode: env.DISCORD_THREAD_FEED_MODE || 'final',
      gatewayIntents: toInt(env.DISCORD_GATEWAY_INTENTS, 37377),
      autoArchiveDuration: toInt(env.DISCORD_THREAD_AUTO_ARCHIVE_DURATION, 1440),
    },
    slack: {
      enabled: toBool(
        env.SLACK_ENABLED,
        Boolean(env.SLACK_APP_TOKEN && env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID),
      ),
      appToken: env.SLACK_APP_TOKEN || '',
      botToken: env.SLACK_BOT_TOKEN || '',
      apiBaseUrl: env.SLACK_API_BASE_URL || 'https://slack.com/api',
      teamId: env.SLACK_TEAM_ID || '',
      channelId: env.SLACK_CHANNEL_ID || '',
      logicalChannelId: env.SLACK_LOGICAL_CHANNEL_ID || env.DISCORD_GENERAL_CHANNEL_ID || channelIds[0] || '',
      allowedUserIds: new Set(splitList(env.SLACK_ALLOWED_USER_IDS)),
      allowAllUsers: toBool(env.SLACK_ALLOW_ALL_USERS, false),
      reconnectIntervalMs: toInt(env.SLACK_RECONNECT_INTERVAL_MS, 5_000),
      catchupWindowMs: toInt(env.SLACK_CATCHUP_WINDOW_MS || env.BRIDGE_CATCHUP_WINDOW_MS, 30 * 60_000),
      acknowledgementReaction: env.SLACK_ACK_REACTION || 'thumbsup',
      broadcastTodoAlerts: toBool(env.SLACK_BROADCAST_TODO_ALERTS, true),
    },
    queue: {
      maxConcurrentJobs,
      singleJobMode,
      backgroundStartOnlyBelowRunning: toInt(env.BACKGROUND_START_ONLY_BELOW_RUNNING, 4),
    },
    jobProgressIntervalMs: toInt(env.JOB_PROGRESS_INTERVAL_MS, 60_000),
    jobProgressMinSilenceMs: toInt(env.JOB_PROGRESS_MIN_SILENCE_MS, 60_000),
    jobProgressForwardDelayMs: toInt(env.JOB_PROGRESS_FORWARD_DELAY_MS, 1_000),
    jobNoProgressKillMs: toInt(env.JOB_NO_PROGRESS_KILL_MS, 10 * 60_000),
    workerProgressUpdatesEnabled: toBool(env.WORKER_PROGRESS_UPDATES_ENABLED, true),
    jobCompletionMarkerMode: normalizeCompletionMarkerMode(env.JOB_COMPLETION_MARKER_MODE || 'inline'),
    jobThreadLockRetryMs: toInt(env.JOB_THREAD_LOCK_RETRY_MS, 5_000),
    activeAsks: {
      enabled: toBool(env.ACTIVE_ASKS_ENABLED, true),
      timeoutMs: toInt(env.ACTIVE_ASKS_TIMEOUT_MS, 7 * 24 * 60 * 60_000),
    },
    todoAlerts: {
      enabled: toBool(env.TODO_ALERTS_ENABLED, true),
      intervalMs: toInt(env.TODO_ALERTS_INTERVAL_MS || env.LIFECYCLE_ALERTS_INTERVAL_MS, 15_000),
    },
    maintenance: {
      // `on` | `off` | `adaptive`. `adaptive` defers the nightly run whenever the
      // maintenance worker's weekly budget is behind the reset clock — see
      // lib/maintenance-adaptive.mjs. DAILY_MAINTENANCE_ENABLED stays the
      // fallback so existing deployments keep their current behaviour.
      mode: normalizeMaintenanceMode(env.DAILY_MAINTENANCE_MODE, {
        enabledFallback: toBool(env.DAILY_MAINTENANCE_ENABLED, false),
      }),
      // Scheduling only asks "is maintenance switched on at all"; `adaptive`
      // decides per run, so it must schedule like `on`.
      enabled: normalizeMaintenanceMode(env.DAILY_MAINTENANCE_MODE, {
        enabledFallback: toBool(env.DAILY_MAINTENANCE_ENABLED, false),
      }) !== 'off',
      gitRemote: env.DAILY_MAINTENANCE_GIT_REMOTE || 'origin',
      gitBranch: env.DAILY_MAINTENANCE_GIT_BRANCH || 'main',
      bugReportRepository: String(
        env.BRIDGE_BUG_REPORT_REPOSITORY
          || env.DAILY_MAINTENANCE_GITHUB_REPOSITORY
          || '',
      ).trim(),
      inputBudgetChars: toInt(env.DAILY_MAINTENANCE_INPUT_BUDGET_CHARS, 120_000),
      inlineItems: toInt(env.DAILY_MAINTENANCE_INLINE_ITEMS, 40),
    },
    usage: {
      codexRemainingQuota: toNullableInt(env.CODEX_QUOTA_REMAINING),
      claudeRemainingQuota: toNullableInt(env.CLAUDE_QUOTA_REMAINING),
      geminiRemainingQuota: toNullableInt(env.GEMINI_QUOTA_REMAINING),
    },
    dailyReports: {
      enabled: toBool(env.DAILY_REPORTS_ENABLED, false),
      hourKst: toInt(env.DAILY_REPORTS_HOUR_KST, 9),
      economyChannelId: env.DISCORD_ECONOMY_CHANNEL_ID || '',
      aiChannelId: env.DISCORD_AI_CHANNEL_ID || '',
      // Keep only an availability flag in runtime config.  The credential
      // itself remains in process.env and is never written to state/prompts.
      xApiAvailable: Boolean(env.X_BEARER_TOKEN || env.X_API_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN),
    },
  };
}

export function validateConfig(config) {
  const warnings = [];
  if (!config.discord.token) warnings.push('DISCORD_BOT_TOKEN is empty; Discord bridge cannot start.');
  if (config.discord.allowedChannelIds.size === 0) {
    warnings.push('DISCORD_ALLOWED_CHANNEL_IDS is empty; Discord messages will be ignored.');
  }
  if (config.discord.enabled && !config.discord.allowAllUsers && config.discord.allowedUserIds.size === 0) {
    warnings.push('DISCORD_ALLOWED_USER_IDS is empty; Discord messages will be ignored unless DISCORD_ALLOW_ALL_USERS=true.');
  }
  if (config.queue.maxConcurrentJobs < 0) {
    warnings.push(`CODEX_MAX_CONCURRENT_JOBS is ${config.queue.maxConcurrentJobs}; expected 0 for unlimited or a positive number.`);
  }
  // Sol/Terra/Luna are GPT-5.6 workers, so `max` is a valid (and currently the
  // configured) effort for them. Only warn when the value is not a tier the CLI
  // accepts at all.
  if (!CODEX_REASONING_EFFORTS.has(config.codex.reasoningEffort)) {
    warnings.push(`CODEX_REASONING_EFFORT is ${config.codex.reasoningEffort}; expected one of ${[...CODEX_REASONING_EFFORTS].join(', ')}.`);
  }
  // Delegated subagent threads are a separate Codex model/effort pair. A typo has
  // to surface at startup, because it would otherwise only fail once some job
  // actually spawned an agent. Whether the tier exists *for that model* is clamped
  // at the point of use (clampEffortForModel in lib/codex-runner.mjs), keeping this
  // module free of the per-model catalog and of the reload scope that comes with it.
  const subagentEffort = config.codex.subagentReasoningEffort;
  if (subagentEffort && !config.codex.subagentModel) {
    warnings.push('CODEX_SUBAGENT_REASONING_EFFORT is set but CODEX_SUBAGENT_MODEL is empty; delegated subagents keep the root model default.');
  } else if (subagentEffort && !CODEX_REASONING_EFFORTS.has(subagentEffort)) {
    warnings.push(`CODEX_SUBAGENT_REASONING_EFFORT is ${subagentEffort}; expected one of ${[...CODEX_REASONING_EFFORTS].join(', ')}.`);
  }
  // Spark tops out at xhigh, so a higher request is clamped rather than sent to an
  // API call that would fail with `unsupported_value`.
  const requestedSparkEffort = config.codexSpark?.requestedReasoningEffort;
  if (requestedSparkEffort && requestedSparkEffort !== config.codexSpark.reasoningEffort) {
    warnings.push(`CODEX_SPARK_REASONING_EFFORT is ${requestedSparkEffort}, which gpt-5.3-codex-spark does not support; using ${config.codexSpark.reasoningEffort} instead.`);
  }
  if (!CODEX_SANDBOX_MODES.has(config.codex.sandboxMode)) {
    warnings.push(`CODEX_SANDBOX_MODE is ${config.codex.sandboxMode}; expected one of ${[...CODEX_SANDBOX_MODES].join(', ')}.`);
  }
  if (config.dailyReports.enabled && !config.dailyReports.economyChannelId) {
    warnings.push('DISCORD_ECONOMY_CHANNEL_ID is empty; the economy daily report cannot be scheduled.');
  }
  if (config.dailyReports.enabled && !config.dailyReports.aiChannelId) {
    warnings.push('DISCORD_AI_CHANNEL_ID is empty; the AI daily report cannot be scheduled.');
  }
  if (config.slack?.enabled && !config.slack.appToken) {
    warnings.push('SLACK_APP_TOKEN is empty; Slack Socket Mode cannot start.');
  }
  if (config.slack?.enabled && !config.slack.botToken) {
    warnings.push('SLACK_BOT_TOKEN is empty; Slack Web API calls cannot start.');
  }
  if (config.slack?.enabled && !config.slack.channelId) {
    warnings.push('SLACK_CHANNEL_ID is empty; Slack messages cannot be scoped.');
  }
  if (config.slack?.enabled && !config.slack.logicalChannelId) {
    warnings.push('SLACK_LOGICAL_CHANNEL_ID is empty; Slack state cannot be mapped to a channel.');
  }
  if (config.slack?.enabled && !config.slack.allowAllUsers && config.slack.allowedUserIds.size === 0) {
    warnings.push('SLACK_ALLOWED_USER_IDS is empty; Slack messages will be ignored unless SLACK_ALLOW_ALL_USERS=true.');
  }
  return warnings;
}

export function channelStateDir(config, channelId) {
  return path.join(config.stateRoot, `${statePathPart(channelId)}_common`);
}

export function channelEnvFilePath(config, channelId) {
  return path.join(channelStateDir(config, channelId), config.channelEnv?.filename || 'channel.env');
}

export function channelEnvOverrides(config, channelId) {
  const allowlist = config.channelEnv?.allowlist || new Set();
  if (!channelId || allowlist.size === 0) return {};

  const values = readDotEnvFile(channelEnvFilePath(config, channelId));
  const selected = {};
  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(values, key)) selected[key] = values[key];
  }
  return selected;
}

export function threadStateDir(config, channelId, threadId = 'channel') {
  return path.join(config.stateRoot, statePathPart(channelId), statePathPart(threadId || 'channel'));
}

export function todoStateFiles(config, channelId) {
  const root = channelStateDir(config, channelId);
  return {
    items: path.join(root, 'todo.jsonl'),
    completed: path.join(root, 'todo-completed.jsonl'),
    alerts: path.join(root, 'alerts.jsonl'),
    alertsCompleted: path.join(root, 'alerts-completed.jsonl'),
  };
}

export function workerToolSearchPath(config = {}, ...commands) {
  const hostHome = config?.github?.hostHome || process.env.HOME || os.homedir();
  return uniqueSearchPathEntries([
    config?.python?.venvBinDir,
    config?.workers?.toolBinDir,
    ...commands.map(commandBinDir),
    process.env.NVM_BIN,
    path.dirname(process.execPath),
    path.join(hostHome, '.local', 'bin'),
    process.env.PATH,
  ]).join(path.delimiter);
}

export function hostGitHubAuthEnv(config = {}) {
  const github = config?.github || {};
  if (!github.preferHostCredential || !github.credentialAvailable || !github.configDir) return {};

  // Workers inherit the bridge process environment, and a stale GITHUB_TOKEN or
  // GH_TOKEN outranks gh's persisted login in both gh and the gh credential
  // helper. Redirected worker HOMEs also hide the host .gitconfig that registers
  // that helper. GIT_ASKPASS keeps this working on the installed Git 2.25,
  // which predates GIT_CONFIG_GLOBAL support. Disable terminal prompts so a
  // genuine auth failure returns immediately instead of stalling a job.
  return {
    GH_CONFIG_DIR: github.configDir,
    ...(github.gitConfigAvailable && github.gitConfigGlobal
      ? { GIT_CONFIG_GLOBAL: github.gitConfigGlobal }
      : {}),
    ...(github.askPassAvailable && github.askPassPath
      ? { GIT_ASKPASS: github.askPassPath }
      : {}),
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function statePathPart(value) {
  const normalized = String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return normalized || 'unknown';
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeWorkerChain(value) {
  const supported = new Set(['codex', 'claude', 'gemini', 'antigravity', 'codex-spark', 'codex-luna']);
  const chain = splitList(value)
    .map((item) => item.toLowerCase())
    .map((item) => {
      if (['spark', 'codex_spark', 'codexspark'].includes(item)) return 'codex-spark';
      if (['luna', 'codex_luna', 'codexluna'].includes(item)) return 'codex-luna';
      return item;
    })
    .filter((item) => supported.has(item));
  return chain.length ? chain : ['codex'];
}

function normalizeMaintenanceWorkerChain(value) {
  const supported = new Set(['claude-fable', 'claude-opus', 'codex', 'codex-sol', 'codex-terra']);
  const aliases = new Map([
    ['fable', 'claude-fable'],
    ['fable-5', 'claude-fable'],
    ['claude-fable-5', 'claude-fable'],
    ['opus', 'claude-opus'],
    ['opus-5', 'claude-opus'],
    ['claude-opus-5', 'claude-opus'],
    ['sol', 'codex-sol'],
    ['gpt-5.6-sol', 'codex-sol'],
    ['terra', 'codex-terra'],
    ['gpt-5.6-terra', 'codex-terra'],
  ]);
  return splitMaintenanceChain(value)
    .map((item) => item.toLowerCase())
    .map((item) => aliases.get(item) || item)
    .filter((item) => supported.has(item));
}

function normalizeMaintenanceWorkerChainRotation(value) {
  return String(value || '')
    .split(/[|;]/)
    .map((chain) => normalizeMaintenanceWorkerChain(chain))
    .filter((chain) => chain.length > 0);
}

function splitMaintenanceChain(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (/^(?:fable|sol|opus|terra)(?:-(?:fable|sol|opus|terra))*$/i.test(text)) {
    return text.split('-');
  }
  return splitList(text);
}

function normalizeKstDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function normalizeCompletionMarkerMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return new Set(['inline', 'separate', 'off']).has(mode) ? mode : 'inline';
}

function normalizeChannelEnvFilename(value) {
  const name = String(value || '').trim() || 'channel.env';
  if (name === '.' || name === '..' || path.basename(name) !== name) return 'channel.env';
  return name;
}

function normalizeChannelPythonVenvDir(value) {
  const name = String(value || '').trim() || '.venv';
  if (name === '.' || name === '..' || path.basename(name) !== name) return '.venv';
  return name;
}

function isEnvKeyName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || ''));
}

function commandBinDir(command) {
  if (!command) return '';
  const dir = path.dirname(String(command));
  return dir && dir !== '.' ? dir : '';
}

function uniqueSearchPathEntries(values) {
  const entries = [];
  const seen = new Set();
  for (const value of values) {
    for (const entry of String(value || '').split(path.delimiter)) {
      if (!entry || entry === '.' || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
  }
  return entries;
}

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const DEFAULT_PYTHON_CANDIDATES = [
  'python3.14',
  'python3.13',
  'python3.12',
  'python3.11',
  'python3.10',
  'python3.9',
  'python3.8',
  'python3',
  'python',
];

function normalizeCodexSandboxMode(value) {
  const mode = String(value || '').trim();
  return CODEX_SANDBOX_MODES.has(mode) ? mode : 'workspace-write';
}

// GPT-5.6 Codex models accept the quality-first `max` tier; the 5.3 Spark worker
// does not (see the codexSpark comment in loadConfig for the API evidence).
// `ultra` is the CLI's top tier on gpt-5.6-sol/terra only, so it passes validation
// here and is clamped per model by clampEffortForModel in lib/thread-models.mjs.
const CODEX_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CODEX_SPARK_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
export const CODEX_SPARK_MAX_REASONING_EFFORT = 'xhigh';

function normalizeCodexSparkReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return CODEX_SPARK_MAX_REASONING_EFFORT;
  return CODEX_SPARK_REASONING_EFFORTS.has(effort) ? effort : CODEX_SPARK_MAX_REASONING_EFFORT;
}

const ANTIGRAVITY_EFFORTS = new Set(['low', 'medium', 'high']);

function normalizeAntigravityEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  return ANTIGRAVITY_EFFORTS.has(effort) ? effort : 'high';
}

function uniqueResolvedRoots(roots) {
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function safeAllowedRoots(roots, { stateRoot, excludedRoots = [], fallbackRoot = null }) {
  const resolvedStateRoot = path.resolve(stateRoot);
  const excluded = new Set(excludedRoots.filter(Boolean).map((root) => path.resolve(root)));
  const safe = uniqueResolvedRoots(roots)
    .filter((root) => !excluded.has(path.resolve(root)))
    .filter((root) => !containsPath(root, resolvedStateRoot));
  if (safe.length) return safe;
  return fallbackRoot ? [path.resolve(fallbackRoot)] : [];
}

function containsPath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
