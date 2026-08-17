import fs from 'node:fs/promises';
import path from 'node:path';
import { runCodexJob, runProcess } from './codex-runner.mjs';
import {
  CODEX_SPARK_MAX_REASONING_EFFORT,
  channelEnvOverrides,
  hostGitHubAuthEnv,
  workerToolSearchPath,
} from './config.mjs';
import { formatErrorDetail } from './error-detail.mjs';
import {
  jobAllowedRoots,
  jobArtifactRoot,
  jobNeedsRepoAccess,
  jobWorkingDirectory,
} from './job-state-roots.mjs';
import { applyPythonEnv, prepareChannelPythonEnv } from './python-env.mjs';
import {
  isGeminiUnsupportedClientError,
  isNonRetryableJobError,
  isOperatorTerminatedError,
  shouldRecoverJobInterruptedByServiceShutdown,
} from './retry-policy.mjs';
import { defaultThreadModelFallbackChain, normalizeModelSelection, workerProfileForChainEntry } from './thread-models.mjs';
import { defaultClaudeAccount, normalizeClaudeAccountSelection } from './claude-accounts.mjs';
import {
  activeWorkerCooldown,
  clearWorkerCooldown,
  recordWorkerAvailabilityFailure,
} from './worker-availability.mjs';
import { maskSecrets } from './secret-mask.mjs';
import { safeWorkerProcessEnv } from './worker-env.mjs';

const CLAUDE_MAINTENANCE_PRIMARY_WORKER = 'claude-fable';
const CLAUDE_MAINTENANCE_FALLBACK_WORKER = 'claude-opus';
const CODEX_MAINTENANCE_TERRA_WORKER = 'codex-terra';
const ANTIGRAVITY_EFFORTS = new Set(['low', 'medium', 'high']);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runAgentJob({
  config,
  job,
  prompt,
  timeoutMs = 0,
  search = false,
  onUpdate = null,
  onWorkerStart = null,
  signal = null,
  isShuttingDown = () => false,
}) {
  const chain = executionWorkerChainForJob(config, job);
  const workingDirectory = jobWorkingDirectory(config, job);
  const workerConfig = {
    ...config,
    allowedRoots: jobAllowedRoots(config, job),
    workerEnvOverrides: channelEnvOverrides(config, job.channelId),
    codex: {
      ...config.codex,
      cwd: workingDirectory,
    },
  };
  await ensureJobRoots(workerConfig, job);
  workerConfig.python = await prepareChannelPythonEnv(workerConfig, job);
  const attempts = [];
  const workerTranscripts = [];

  for (const chainEntry of chain) {
    throwIfServiceShuttingDown(isShuttingDown, attempts, workerTranscripts);
    const workerProfile = workerProfileForChainEntry(config, chainEntry);
    const worker = workerProfile.name;
    throwIfAborted(signal);
    const activeCooldown = await readActiveWorkerCooldown(config, workerProfile);
    throwIfAborted(signal);
    throwIfServiceShuttingDown(isShuttingDown, attempts, workerTranscripts);
    if (activeCooldown) {
      const skippedAt = new Date().toISOString();
      attempts.push({
        worker,
        status: 'skipped',
        reason: 'cooldown-active',
        availabilityKind: activeCooldown.kind,
        availabilityKey: activeCooldown.key,
        retryAt: activeCooldown.retryAt,
      });
      workerTranscripts.push(workerTranscriptFromProcessResult(worker, 'skipped', {}, {
        startedAt: skippedAt,
        finishedAt: skippedAt,
        error: `worker cooldown active until ${activeCooldown.retryAt}`,
      }));
      if (!config.workers?.fallbackEnabled) break;
      continue;
    }
    const startedAt = new Date().toISOString();
    const updates = [];
    if (onWorkerStart) {
      await onWorkerStart(workerStartInfo(config, job, workerProfile, { startedAt }));
    }
    // onWorkerStart can await a network delivery. A restart may begin while it
    // is pending, so re-check before spawning the next fallback worker.
    throwIfAborted(signal);
    throwIfServiceShuttingDown(isShuttingDown, attempts, workerTranscripts);
    try {
      const workerResult = await runWorkerJob(workerProfile, {
        config: workerConfig,
        job,
        prompt,
        timeoutMs,
        noProgressKillMs: config.jobNoProgressKillMs || 0,
        search,
        onUpdate: captureWorkerUpdate(onUpdate, worker, updates),
        signal,
      });
      const finishedAt = new Date().toISOString();
      const output = workerResult.output;
      workerTranscripts.push(workerTranscriptFromProcessResult(worker, 'succeeded', workerResult.processResult, {
        startedAt,
        finishedAt,
        output,
        updates,
      }));
      await clearSavedWorkerCooldown(config, workerProfile);
      return {
        output,
        worker,
        // Display info for notices/markers. workerBase is the provider
        // (codex/claude/gemini/antigravity/codex-spark); workerLabel is the menu label;
        // workerEffort is the CLI reasoning effort (codex/claude only) for the completion marker.
        workerBase: workerProfile.worker,
        workerLabel: workerProfile.label || worker,
        workerModel: workerProfile.model || '',
        workerEffort: workerEffortForProfile(config, job, workerProfile),
        attempts: [...attempts, { worker, status: 'succeeded' }],
        workerTranscripts,
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const detail = formatErrorDetail(error);
      const serviceShutdownInterrupted = shouldStopForServiceShutdown(error, isShuttingDown);
      workerTranscripts.push(workerTranscriptFromError(worker, error, {
        startedAt,
        finishedAt,
        error: detail,
        updates,
      }, serviceShutdownInterrupted ? 'interrupted' : 'failed'));
      const attempt = {
        worker,
        status: serviceShutdownInterrupted ? 'interrupted' : 'failed',
        error: detail,
      };
      attempts.push(attempt);
      if (serviceShutdownInterrupted) {
        error.worker = worker;
        error.workerAttempts = attempts;
        error.workerTranscripts = workerTranscripts;
        error.serviceShutdownInterrupted = true;
        throw error;
      }
      const inputLimitError = isWorkerInputLimitError(error);
      const availability = inputLimitError
        ? null
        : await saveWorkerAvailabilityFailure(config, workerProfile, error);
      if (availability) {
        attempt.availabilityKind = availability.kind;
        attempt.availabilityKey = availability.key;
        attempt.retryAt = availability.retryAt;
        error.workerAvailabilityKind = availability.kind;
        error.workerAvailabilityKey = availability.key;
        error.workerAvailabilityRetryAtMs = Date.parse(availability.retryAt);
      }
      if (inputLimitError) {
        // E2BIG is an OS argv-size limit specific to workers that pass the prompt as
        // an argument (gemini/antigravity); stdin-based workers (codex/claude) can
        // still take the same prompt, so keep walking the chain instead of failing
        // the whole job as a permanent input-limit error.
        const argvLimitOnly = isWorkerArgvLimitError(error)
          && config.workers?.fallbackEnabled
          && attempts.length < chain.length;
        if (!argvLimitOnly) {
          error.inputLimit = true;
          error.worker = worker;
          error.workerAttempts = attempts;
          error.workerTranscripts = workerTranscripts;
          throw error;
        }
      } else if (
        !config.workers?.fallbackEnabled
        || (!availability && !isWorkerFallbackError(error))
        || attempts.length >= chain.length
      ) {
        error.worker = worker;
        error.workerAttempts = attempts;
        error.workerTranscripts = workerTranscripts;
        throw error;
      }
    }
  }

  if (attempts.some((attempt) => attempt.status === 'skipped')) {
    throw noAvailableWorkerError(attempts, workerTranscripts);
  }
  throw new Error('no worker configured');
}

async function readActiveWorkerCooldown(config, workerProfile) {
  try {
    return await activeWorkerCooldown(config, workerProfile);
  } catch {
    // Availability state is an optimization around provider failures. A
    // transient state/lock error must never make the bridge queue unusable.
    return null;
  }
}

async function saveWorkerAvailabilityFailure(config, workerProfile, error) {
  try {
    return await recordWorkerAvailabilityFailure(config, workerProfile, error);
  } catch {
    // Preserve the existing in-job fallback path even if durable state cannot
    // be updated. The original worker error remains authoritative.
    return null;
  }
}

async function clearSavedWorkerCooldown(config, workerProfile) {
  try {
    await clearWorkerCooldown(config, workerProfile);
  } catch {
    // A completed worker result remains successful even if stale availability
    // metadata cannot be cleared immediately; expiry still bounds the state.
  }
}

function noAvailableWorkerError(attempts, workerTranscripts) {
  const retryTimes = attempts
    .map((attempt) => Date.parse(String(attempt.retryAt || '')))
    .filter(Number.isFinite);
  const retryAtMs = retryTimes.length > 0 ? Math.min(...retryTimes) : null;
  const retryAt = Number.isFinite(retryAtMs) ? new Date(retryAtMs).toISOString() : null;
  const error = new Error(
    retryAt
      ? `no configured worker is currently available; next cooldown expires at ${retryAt}`
      : 'no configured worker is currently available',
  );
  error.code = 'WORKER_COOLDOWN_ACTIVE';
  error.worker = attempts.at(-1)?.worker || null;
  error.workerAttempts = [...attempts];
  error.workerTranscripts = [...workerTranscripts];
  error.workerAvailabilityBlocked = true;
  if (Number.isFinite(retryAtMs)) error.workerAvailabilityRetryAtMs = retryAtMs;
  return error;
}

function shouldStopForServiceShutdown(error, isShuttingDown) {
  const shuttingDown = typeof isShuttingDown === 'function'
    ? Boolean(isShuttingDown())
    : Boolean(isShuttingDown);
  return shouldRecoverJobInterruptedByServiceShutdown(error, shuttingDown);
}

function throwIfServiceShuttingDown(isShuttingDown, attempts = [], workerTranscripts = []) {
  if (!shouldStopForServiceShutdown(null, isShuttingDown)) return;
  const error = new Error('worker interrupted by service shutdown');
  error.serviceShutdownInterrupted = true;
  error.worker = attempts.at(-1)?.worker || null;
  error.workerAttempts = [...attempts];
  error.workerTranscripts = [...workerTranscripts];
  throw error;
}

function workerStartInfo(config, job = {}, workerProfile = {}, { startedAt = new Date().toISOString() } = {}) {
  const worker = workerProfile.name || workerProfile.worker || '';
  return {
    worker,
    workerBase: workerProfile.worker || worker,
    workerLabel: workerProfile.label || worker,
    workerModel: workerProfile.model || '',
    workerEffort: workerEffortForProfile(config, job, workerProfile),
    startedAt,
  };
}

// The worker that onWorkerStart will report, derived from config alone. Callers
// need a worker identity before the worker process reports `worker.started` —
// a detached worker can sit queued for a while, and a restart that reattaches a
// running one never sees that message again. Only the chain head is knowable up
// front, so this is wrong once a fallback worker takes over; prefer the reported
// worker whenever it is available.
export function plannedWorkerStartInfo(config, job = {}) {
  const [chainEntry] = executionWorkerChainForJob(config, job);
  if (!chainEntry) return null;
  return {
    ...workerStartInfo(config, job, workerProfileForChainEntry(config, chainEntry), { startedAt: null }),
    planned: true,
  };
}

export function workerChainForJob(config, job = {}) {
  if (job.maintenance) return maintenanceWorkerChain(config, job);

  const company = isCompanyJob(config, job);
  const configuredBaseChain = company ? config.workers.companyChain : config.workers.defaultChain;
  const baseChain = shouldUseDefaultModelFallbackChain(configuredBaseChain, { company })
    ? defaultThreadModelFallbackChain(config, { company })
    : configuredBaseChain;
  const modelOverride = normalizeModelSelection(config, job.threadModelOverride);
  // A /model selection PINS the thread to the chosen model(s). A single number pins to
  // exactly one model (no fallback); a sequence ("3 4 1") pins to that exact fallback
  // order. exactFallback marks every entry so executionWorkerChainForJob won't expand it
  // (e.g. Gemini Pro -> Flash) — only the user's explicit models run, in order.
  if (modelOverride) {
    const chain = Array.isArray(modelOverride.chain) && modelOverride.chain.length > 0
      ? modelOverride.chain
      : [modelOverride];
    return chain.map((entry) => ({ ...entry, exactFallback: true }));
  }
  return baseChain;
}

// Display-only view of the chain a job would run, resolved exactly the way the
// runner resolves it but without launching anything. Used by `/status`.
export function workerChainSummaryForJob(config, job = {}) {
  return workerChainForJob(config, job).map((entry) => {
    const profile = workerProfileForChainEntry(config, entry);
    return {
      name: profile.name,
      label: profile.label || profile.name,
      worker: profile.worker,
      model: profile.model || '',
      effort: workerEffortForProfile(config, job, profile) || null,
    };
  });
}

export function executionWorkerChainForJob(config, job = {}) {
  let chain = expandGeminiFallbacks(config, workerChainForJob(config, job));
  chain = expandAntigravityFallbacks(config, chain);
  return chain;
}

function expandGeminiFallbacks(config, chain) {
  const expanded = [];
  const primaryModel = String(config.gemini?.model || '').trim();

  for (const entry of chain) {
    if (entry === 'gemini') {
      expanded.push(...configuredGeminiModelEntries(config));
    } else if (
      entry &&
      typeof entry === 'object' &&
      !entry.exactFallback &&
      entry.worker === 'gemini' &&
      primaryModel &&
      entry.model === primaryModel
    ) {
      const entries = configuredGeminiModelEntries(config);
      if (entries.length > 0) {
        entries[0] = { ...entry, ...entries[0] };
        expanded.push(...entries);
      } else {
        expanded.push(entry);
      }
    } else {
      expanded.push(entry);
    }
  }
  return expanded;
}

function expandAntigravityFallbacks(config, chain) {
  const expanded = [];
  const primaryModel = String(config.antigravity?.model || '').trim();

  for (const entry of chain) {
    if (entry === 'antigravity') {
      expanded.push(...configuredAntigravityModelEntries(config));
    } else if (
      entry &&
      typeof entry === 'object' &&
      !entry.exactFallback &&
      entry.worker === 'antigravity' &&
      primaryModel &&
      entry.model === primaryModel
    ) {
      const entries = configuredAntigravityModelEntries(config);
      if (entries.length > 0) {
        entries[0] = { ...entry, ...entries[0] };
        expanded.push(...entries);
      } else {
        expanded.push(entry);
      }
    } else {
      expanded.push(entry);
    }
  }
  return expanded;
}

function shouldUseDefaultModelFallbackChain(chain, { company = false } = {}) {
  const key = (chain || []).map((entry) => String(typeof entry === 'string' ? entry : entry?.id || '')).join(',');
  const defaults = company
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
  return defaults.has(key);
}

function configuredGeminiModelEntries(config) {
  const primaryModel = String(config.gemini?.model || '').trim();
  const fallbackModel = String(config.gemini?.fallbackModel || '').trim();
  if (!primaryModel) return ['gemini'];

  const entries = [geminiModelEntry(primaryModel)];
  if (fallbackModel && fallbackModel !== primaryModel) entries.push(geminiModelEntry(fallbackModel));
  return entries;
}

function configuredAntigravityModelEntries(config) {
  const primaryModel = String(config.antigravity?.model || '').trim();
  const fallbackModel = String(config.antigravity?.fallbackModel || '').trim();
  if (!primaryModel) return ['antigravity'];

  const effort = normalizeAntigravityEffort(config.antigravity?.effort || 'high');
  const entries = [antigravityModelEntry(primaryModel, effort)];
  if (fallbackModel && fallbackModel !== primaryModel) {
    entries.push(antigravityModelEntry(fallbackModel, effort));
  }
  return entries;
}

function geminiModelEntry(model) {
  return {
    id: `gemini-${slugModelId(model)}`,
    label: `gemini-${model}`,
    name: 'gemini',
    worker: 'gemini',
    model,
  };
}

function antigravityModelEntry(model, effort = null) {
  return {
    id: `antigravity-${slugModelId(model)}`,
    label: `antigravity-${model}`,
    name: 'antigravity',
    worker: 'antigravity',
    model,
    effort,
  };
}

function slugModelId(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

export function maintenanceWorkerChain(config = {}, job = {}) {
  const configured = Array.isArray(config.workers?.maintenanceChain)
    ? config.workers.maintenanceChain
    : [];
  if (configured.length > 0) return configured;

  const rotation = Array.isArray(config.workers?.maintenanceChainRotation)
    ? config.workers.maintenanceChainRotation
    : [];
  if (rotation.length > 0) {
    return rotation[maintenanceRotationIndex(config, job, rotation.length)] || rotation[0];
  }

  const chain = [
    CLAUDE_MAINTENANCE_PRIMARY_WORKER,
    CLAUDE_MAINTENANCE_FALLBACK_WORKER,
  ];
  const model = String(config.codex?.maintenanceModel || '').trim().toLowerCase();
  if (isSupportedMaintenanceCodexModel(model)) chain.push(CODEX_MAINTENANCE_TERRA_WORKER);
  return chain;
}

function maintenanceRotationIndex(config = {}, job = {}, rotationLength = 1) {
  const length = Math.max(1, Number.parseInt(rotationLength, 10) || 1);
  const runDay = kstDayIndex(maintenanceRunDate(job));
  const startDay = kstDateDayIndex(config.workers?.maintenanceChainRotationStartDate);
  const offset = Number.isFinite(startDay) ? runDay - startDay : runDay;
  return positiveModulo(offset, length);
}

function maintenanceRunDate(job = {}) {
  const value = job.event?.timestamp || job.timestamp || job.createdAt || null;
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function kstDateDayIndex(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NaN;
  return kstDayIndex(new Date(`${text}T00:00:00+09:00`));
}

function kstDayIndex(date) {
  return Math.floor((date.getTime() + KST_OFFSET_MS) / DAY_MS);
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function isSupportedMaintenanceCodexModel(model) {
  return model === 'gpt-5.6-terra' ||
    model.startsWith('gpt-5.6-terra-') ||
    model === 'gpt-5.6-sol' ||
    model.startsWith('gpt-5.6-sol-');
}

export function isCompanyJob(config, job = {}) {
  const channelId = String(job.channelId || '');
  return Boolean(config.workers?.companyChannelIds?.has(channelId));
}

export function isWorkerFallbackError(error) {
  if (isGeminiUnsupportedClientError(error)) return true;
  if (error?.nonRetryable) return false;
  if (isOperatorTerminatedError(error)) return false;
  if (isWorkerInputLimitError(error)) return false;
  if (error?.noProgressKilled) return false;

  const text = [
    error?.message,
    error?.stderr,
    error?.stdout,
    error?.code,
  ].filter(Boolean).join('\n').toLowerCase();

  if (!text) return false;
  return [
    'credit',
    'credits',
    'quota',
    'rate limit',
    '429',
    'too many requests',
    'resource_exhausted',
    'billing',
    'payment',
    'insufficient credit',
    'insufficient credits',
    'usage limit',
    'session limit',
    'hit your limit',
    'limit reached',
    'quota exhausted',
    'subscription',
    'not logged in',
    'login',
    'sign in',
    'authentication required',
    'auth',
    'unauthorized',
    'permission_denied',
    'permission denied',
    'api key',
    'enoent',
    'spawn',
    'command not found',
    'unsupported_client',
    'temporarily unavailable',
    'overloaded',
    'capacity',
    'service unavailable',
    '503',
  ].some((pattern) => text.includes(pattern));
}

// argv-size failures (E2BIG) are a per-worker delivery limit, not a model context
// limit — isWorkerInputLimitError still matches them, but runWorkerChain uses this
// to keep the fallback chain alive for stdin-based workers.
export function isWorkerArgvLimitError(error) {
  if (!error) return false;
  const text = [
    error?.message,
    error?.stderr,
    error?.stdout,
    error?.code,
  ].filter(Boolean).join('\n').toLowerCase();
  return text.includes('e2big') || text.includes('argument list too long');
}

export function isWorkerInputLimitError(error) {
  if (!error) return false;
  const text = [
    error?.message,
    error?.stderr,
    error?.stdout,
    error?.code,
  ].filter(Boolean).join('\n').toLowerCase();
  if (!text.trim()) return false;
  return [
    'context_length_exceeded',
    'maximum context length',
    'max context length',
    'context length exceeded',
    'input is too long',
    'input too long',
    'too many tokens',
    'input limit',
    'prompt tokens',
    'request too large',
    'payload too large',
    'e2big',
    'argument list too long',
  ].some((pattern) => text.includes(pattern));
}

async function runWorkerJob(workerProfile, options) {
  const worker = workerProfile.worker;
  if (worker === 'codex') {
    return runCodexWorkerJob(workerProfile.name, {
      ...options,
      model: workerProfile.model || codexModelForJob(options.config, options.job),
      reasoningEffort: workerProfile.reasoningEffort || workerProfile.effort || null,
      reasoningSummary: workerProfile.reasoningSummary || null,
      serviceTier: options.job?.codexFastMode ? 'fast' : null,
      sandboxMode: codexSandboxModeForJob(options.config, options.job),
    });
  }
  if (worker === 'codex-spark') return runCodexSparkJob({ ...options, workerProfile });
  if (isClaudeWorker(worker)) return runClaudeJob({ ...options, worker: workerProfile.name, workerProfile });
  if (worker === 'gemini') return runGeminiJob({ ...options, worker: workerProfile.name, workerProfile });
  if (worker === 'antigravity') return runAntigravityJob({ ...options, worker: workerProfile.name, workerProfile });
  throw new Error(`unsupported worker: ${workerProfile.name || worker}`);
}

function codexModelForJob(config, job = {}) {
  if (job.maintenance) return config.codex?.maintenanceModel || 'gpt-5.6-terra';
  return null;
}

function codexSandboxModeForJob(config, job = {}) {
  if (job.maintenance) return config.codex?.maintenanceSandboxMode || 'workspace-write';
  if (!jobNeedsRepoAccess(job)) return 'workspace-write';
  return config.codex?.sandboxMode || 'workspace-write';
}

// The CLI reasoning effort that actually ran, surfaced for the completion marker
// (e.g. "codex gpt-5.6-terra (xhigh)"). Prefer the pinned profile effort, then fall back
// to the same per-worker resolution the runners use. Native Gemini has no effort
// flag; Antigravity uses its own low/medium/high effort setting.
function workerEffortForProfile(config, job = {}, workerProfile = {}) {
  const profileEffort = workerProfile.reasoningEffort || workerProfile.effort || null;
  if (workerProfile.worker === 'antigravity') {
    return normalizeAntigravityEffort(profileEffort || config.antigravity?.effort || 'high');
  }
  if (profileEffort) return profileEffort;

  const worker = workerProfile.worker;
  if (worker === 'codex') return config.codex?.reasoningEffort || 'xhigh';
  if (worker === 'codex-spark') {
    return config.codexSpark?.reasoningEffort || CODEX_SPARK_MAX_REASONING_EFFORT;
  }
  if (isClaudeWorker(worker)) return claudeEffortForWorker(config, job, workerProfile.name || worker);
  return null;
}

async function runCodexSparkJob({ config, job = {}, prompt, timeoutMs = 0, search = false, onUpdate = null, signal = null, workerProfile = null }) {
  return runCodexWorkerJob(workerProfile?.name || 'codex-spark', {
    config,
    job,
    prompt,
    timeoutMs,
    noProgressKillMs: config.jobNoProgressKillMs || 0,
    search,
    model: workerProfile?.model || config.codexSpark?.model || 'gpt-5.3-codex-spark',
    // Never inherit the GPT-5.6 effort here: Spark is GPT-5.3 and answers `max`
    // with HTTP 400 `unsupported_value`, which would fail the job outright.
    reasoningEffort: workerProfile?.reasoningEffort || config.codexSpark?.reasoningEffort || CODEX_SPARK_MAX_REASONING_EFFORT,
    reasoningSummary: workerProfile?.reasoningSummary || config.codexSpark?.reasoningSummary || config.codex.reasoningSummary,
    sandboxMode: codexSandboxModeForJob(config, job),
    onUpdate,
    signal,
  });
}

async function runCodexWorkerJob(_worker, options) {
  let processResult = null;
  const output = await runCodexJob({
    ...options,
    onProcessResult: (result) => {
      processResult = result;
    },
  });
  return { output, processResult };
}

async function runClaudeJob({ config, job = {}, worker = 'claude', workerProfile = null, prompt, timeoutMs = 0, noProgressKillMs = 0, onUpdate = null, signal = null }) {
  // The account is selected per Discord thread.  Each account has a separate
  // HOME, which is where Claude Code persists both its OAuth token and any
  // rotated refresh token.
  const claudeAccount = normalizeClaudeAccountSelection(config, workerProfile?.claudeAccount)
    || defaultClaudeAccount(config);
  const claudeHome = claudeAccount?.home || config.claude.home;
  await fs.mkdir(claudeHome, { recursive: true, mode: 0o700 });
  const args = buildClaudeArgs(config, {
    permissionMode: claudePermissionModeForJob(config, job),
    model: workerProfile?.model || claudeModelForWorker(config, job, worker),
    effort: workerProfile?.effort || claudeEffortForWorker(config, job, worker),
  });
  const stream = createClaudeJsonStreamObserver(onUpdate);
  const result = await runProcess(config.claude.bin, args, prompt, {
    cwd: config.codex.cwd,
    env: workerEnv(config, 'claude', { home: claudeHome }),
    timeoutMs,
    noProgressKillMs: noProgressKillMs || config.jobNoProgressKillMs || 0,
    signal,
    onStdout: (chunk) => stream.write(chunk),
  });
  stream.flush();
  if (result.aborted || result.code !== 0) throw processError(worker, result);
  const output = extractJsonStreamFinalText(result.stdout);
  if (isMissingFinalOutput(output)) throw missingFinalOutputError(worker, output, result);
  return { output, processResult: result };
}

async function runGeminiJob({ config, prompt, timeoutMs = 0, noProgressKillMs = 0, onUpdate = null, signal = null, worker = 'gemini', workerProfile = null }) {
  await fs.mkdir(config.gemini.home, { recursive: true, mode: 0o700 });
  const args = buildGeminiArgs(config, prompt, {
    model: workerProfile?.model || null,
    effort: workerProfile?.effort || workerProfile?.reasoningEffort || null,
  });
  const stream = createJsonLineStreamObserver(onUpdate, extractGeminiProgressUpdate);
  const result = await runProcess(config.gemini.bin, args, '', {
    cwd: config.codex.cwd,
    env: workerEnv(config, 'gemini'),
    timeoutMs,
    noProgressKillMs: noProgressKillMs || config.jobNoProgressKillMs || 0,
    signal,
    onStdout: (chunk) => stream.write(chunk),
  });
  stream.flush();
  if (result.aborted || result.code !== 0) throw processError(worker, result);
  const output = extractJsonStreamFinalText(result.stdout);
  if (isMissingFinalOutput(output)) throw missingFinalOutputError(worker, output, result);
  return { output, processResult: result };
}

async function runAntigravityJob({ config, job = {}, prompt, timeoutMs = 0, noProgressKillMs = 0, onUpdate = null, signal = null, worker = 'antigravity', workerProfile = null }) {
  await fs.mkdir(config.antigravity.home, { recursive: true, mode: 0o700 });
  await ensureAntigravityReady(config, { worker, signal });
  const diagnosticLogPath = antigravityDiagnosticLogPath(config, job, worker);
  await fs.mkdir(path.dirname(diagnosticLogPath), { recursive: true, mode: 0o700 });
  // agy 1.1.9 exposes low/medium/high effort; pass the selected profile effort
  // so the default and explicit `/effort high` path use the highest supported tier.
  const args = buildAntigravityArgs(config, prompt, {
    model: workerProfile?.model || null,
    effort: workerProfile?.effort || workerProfile?.reasoningEffort || null,
    logFile: diagnosticLogPath,
  });
  const stream = createAntigravityStreamObserver(onUpdate);
  const runArgs = async (attemptArgs) => runProcess(config.antigravity.bin, attemptArgs, '', {
    cwd: config.codex.cwd,
    env: workerEnv(config, 'antigravity'),
    timeoutMs,
    noProgressKillMs: noProgressKillMs || config.jobNoProgressKillMs || 0,
    signal,
    onStdout: (chunk) => stream.write(chunk),
  });

  let result = await runArgs(args);
  if (!result.aborted && result.code !== 0) {
    const retry = antigravityRetryArgs(args, result.stderr);
    if (retry) result = await runArgs(retry);
  }
  stream.flush();
  if (result.aborted || result.code !== 0) {
    if (!result.aborted && isGenericAntigravityFailure(result.stderr)) {
      const diagnostics = await readAntigravityFailureDiagnostics(diagnosticLogPath);
      if (diagnostics) {
        result = {
          ...result,
          stderr: [
            String(result.stderr || '').trim(),
            'Antigravity diagnostics:',
            diagnostics,
          ].filter(Boolean).join('\n') + '\n',
        };
      }
    }
    // agy frequently dies while streaming the tail of an answer it has already
    // written to stdout. Throwing here discarded minutes of finished work and
    // showed the user nothing but a generic retry notice, so deliver whatever
    // was streamed, flagged as incomplete (issue #23).
    const salvaged = salvagePartialWorkerOutput(result);
    if (salvaged) {
      return { output: salvaged, processResult: { ...result, salvagedPartialOutput: true } };
    }
    const error = processError(worker, result);
    error.antigravityDiagnosticLogPath = diagnosticLogPath;
    throw error;
  }
  // agy v1.0.8+ in print mode might not emit JSON stream yet; the extractor
  // itself falls back to raw stdout when the output isn't JSON lines.
  const output = extractJsonStreamFinalText(result.stdout);
  if (isMissingFinalOutput(output)) throw missingFinalOutputError(worker, output, result);
  return { output, processResult: result };
}

async function ensureAntigravityReady(config, { worker = 'antigravity', signal = null } = {}) {
  const result = await runProcess(config.antigravity.bin, ['models'], '', {
    cwd: config.codex.cwd,
    env: workerEnv(config, 'antigravity'),
    timeoutMs: config.antigravity.preflightTimeoutMs || 20_000,
    noProgressKillMs: config.antigravity.preflightTimeoutMs || 20_000,
    signal,
  });
  if (result.aborted || result.code !== 0) throw processError(worker, result);
}

function claudePermissionModeForJob(config, job = {}) {
  if (job.maintenance) return config.claude?.maintenancePermissionMode || 'default';
  return config.claude?.permissionMode || 'default';
}

function claudeModelForWorker(config, job = {}, worker = 'claude') {
  if (!job.maintenance) return config.claude?.model || 'opus';
  if (worker === CLAUDE_MAINTENANCE_FALLBACK_WORKER) {
    return config.claude?.maintenanceFallbackModel || 'claude-opus-5';
  }
  return config.claude?.maintenanceModel || 'claude-fable-5';
}

function claudeEffortForWorker(config, job = {}, worker = 'claude') {
  if (!job.maintenance) return config.claude?.effort || 'xhigh';
  if (worker === CLAUDE_MAINTENANCE_FALLBACK_WORKER) {
    return config.claude?.maintenanceFallbackEffort || 'xhigh';
  }
  return config.claude?.maintenanceEffort || 'xhigh';
}

// The prompt is delivered on stdin (see runClaudeJob), NOT as an argv element.
// claude.exe runs through the Windows process layer, whose command line is capped
// at ~32KB; passing a large maintenance/report prompt as argv overflows that and
// the spawn fails with E2BIG. stdin has no such limit (mirrors buildCodexArgs).
export function buildClaudeArgs(config, { permissionMode = null, model = null, effort = null } = {}) {
  const extraRoots = extraAllowedRoots(config).slice(0, 5);
  const selectedModel = model ?? config.claude.model;
  const selectedEffort = effort ?? config.claude.effort;
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    permissionMode || config.claude.permissionMode || 'auto',
    '--no-session-persistence',
    ...(selectedModel ? ['--model', selectedModel] : []),
    ...(selectedEffort ? ['--effort', selectedEffort] : []),
    ...(extraRoots.length ? ['--add-dir', ...extraRoots] : []),
  ];
}

export function buildGeminiArgs(config, prompt, { model = null } = {}) {
  const extraRoots = extraAllowedRoots(config).slice(0, 5);
  const selectedModel = model ?? config.gemini.model;
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--approval-mode',
    config.gemini.approvalMode || 'yolo',
    ...(selectedModel ? ['--model', selectedModel] : []),
    ...(isBooleanEnabled(config.gemini.sandbox) ? ['--sandbox'] : []),
    ...(extraRoots.length ? ['--include-directories', extraRoots.join(',')] : []),
  ];
}

// `agy` 1.1.9 supports `--effort low|medium|high`; normalize stale or unsupported
// values to high so a saved selection can never make the worker fail at argument parsing.
export function buildAntigravityArgs(config, prompt, { model = null, effort = null, logFile = null } = {}) {
  const extraRoots = extraAllowedRoots(config).slice(0, 5);
  const selection = resolveAntigravityModelSelection(
    model ?? config.antigravity.model,
    effort ?? config.antigravity.effort ?? 'high',
  );
  return [
    ...(logFile ? ['--log-file', logFile] : []),
    '-p',
    prompt,
    ...(antigravitySkipPermissions(config) ? ['--dangerously-skip-permissions'] : []),
    ...(selection.model ? ['--model', selection.model] : []),
    ...(selection.effort ? ['--effort', selection.effort] : []),
    ...(isBooleanEnabled(config.antigravity.sandbox) ? ['--sandbox'] : []),
    ...(extraRoots.length ? extraRoots.flatMap((root) => ['--add-dir', root]) : []),
  ];
}

// `agy` carries the effort tier inside the model id and validates the
// `--model`/`--effort` pair strictly, so the flag is only sometimes legal:
//   gemini-3.7-flash             -> `--effort` REQUIRED (base family with variants)
//   gemini-3.7-flash-high        -> tier already pinned; a different `--effort` conflicts
//   claude-opus-4-6-thinking     -> family has no effort variants; `--effort` rejected
//   "Claude Opus 4.6 (Thinking)" -> display-name form; `--effort` rejected
// Passing it unconditionally made every Claude-family antigravity profile
// (the `/model` agy-opus row) die at argument validation, and pinned Gemini ids
// die on any non-matching `/effort`. Resolve the pair instead: repoint a pinned
// suffix to the requested tier, and drop the flag wherever `agy` won't take it.
export function resolveAntigravityModelSelection(model, effort) {
  const selectedModel = String(model || '').trim();
  const selectedEffort = normalizeAntigravityEffort(effort);
  if (!selectedModel) return { model: '', effort: selectedEffort };
  // Display names ("Gemini 3.7 Flash (High)") already name one concrete variant.
  if (/[\s()]/.test(selectedModel)) return { model: selectedModel, effort: null };

  const pinned = selectedModel.match(/^(.*)[-_](low|medium|high)$/i);
  if (pinned) {
    const repointed = selectedEffort && selectedEffort !== pinned[2].toLowerCase()
      ? `${pinned[1]}-${selectedEffort}`
      : selectedModel;
    return { model: repointed, effort: null };
  }

  // Claude ids in the `agy` catalog expose no effort variants.
  if (/^claude[-_]/i.test(selectedModel)) return { model: selectedModel, effort: null };
  return { model: selectedModel, effort: selectedEffort };
}

// `agy`'s catalog is CLI-version sensitive, so the resolution above can go stale.
// Its rejection messages name the fix precisely; use them for one corrective retry
// instead of failing the job. Argument validation happens before any model call,
// so the retry costs nothing but a process spawn.
export function antigravityRetryArgs(args, stderr) {
  const message = String(stderr || '');
  if (!/invalid model selection/i.test(message)) return null;

  const effortIndex = args.indexOf('--effort');
  if (effortIndex >= 0) {
    if (!/(is not supported|conflicts with)/i.test(message)) return null;
    const retry = [...args];
    retry.splice(effortIndex, 2);
    return retry;
  }

  if (!/requires --effort/i.test(message)) return null;
  const available = new Set(
    (message.match(/available:\s*([^)]*)/i)?.[1] || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const effort = available.has('high') ? 'high' : ([...available][0] || null);
  return effort ? [...args, '--effort', effort] : null;
}

function normalizeAntigravityEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ANTIGRAVITY_EFFORTS.has(normalized) ? normalized : 'high';
}

function antigravitySkipPermissions(config) {
  return ['yolo', 'skip', 'skip-permissions', 'dangerously-skip-permissions']
    .includes(String(config.antigravity?.approvalMode || '').trim().toLowerCase());
}

function antigravityDiagnosticLogPath(config, job, worker) {
  const jobId = safeDiagnosticFilePart(job?.id || 'job');
  const attempt = Math.max(1, Number.parseInt(job?.attempt, 10) || 1);
  const workerId = safeDiagnosticFilePart(worker || 'antigravity');
  return path.join(
    config.antigravity.home,
    '.gemini',
    'antigravity-cli',
    'log',
    `bridge-${jobId}-attempt-${attempt}-${workerId}-${process.pid}-${Date.now()}.log`,
  );
}

function safeDiagnosticFilePart(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

// Below this an "answer" is a banner, a prompt echo or a single narration line;
// posting it as the final response would be worse than the retry notice.
const MIN_SALVAGEABLE_OUTPUT_CHARS = 200;
const PARTIAL_OUTPUT_NOTICE = '⚠️ 워커가 답변을 끝내기 전에 종료되어, 여기까지 전달된 내용만 보여줍니다. 뒷부분이 잘려 있을 수 있습니다.';

// Recovers an already-streamed answer from a worker that exited non-zero.
// Returns null when stdout holds nothing worth showing.
export function salvagePartialWorkerOutput(result) {
  // An abort is a supersede or an explicit cancel: the user asked for this run
  // to stop, so its half-written answer must not be posted.
  if (!result || result.aborted) return null;
  const text = salvageableAntigravityOutput(result.stdout);
  if (text.length < MIN_SALVAGEABLE_OUTPUT_CHARS) return null;
  return `${text}\n\n${PARTIAL_OUTPUT_NOTICE}`;
}

function salvageableAntigravityOutput(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return '';

  const output = extractJsonStreamFinalText(raw);
  if (isMissingFinalOutput(output)) return '';
  if (hasStructuredAntigravityFinalOutput(raw)) return String(output).trim();

  // In print mode, narration and the terminal answer share stdout. Length alone
  // cannot distinguish twelve status lines from a real response, so require a
  // Markdown answer boundary and discard the preceding narration block.
  const lines = raw.split(/\r?\n/);
  const structureIndex = lines.findIndex((line) => isAntigravityFinalAnswerStructure(line));
  if (structureIndex < 0) return '';

  let startIndex = structureIndex;
  // agy commonly introduces the answer with a one-paragraph summary followed by
  // a heading. Include that paragraph when a blank line separates it from the
  // earlier narration (the exact shape of the issue #23 transcript).
  if (structureIndex > 0 && !lines[structureIndex - 1].trim()) {
    let cursor = structureIndex - 1;
    while (cursor >= 0 && !lines[cursor].trim()) cursor -= 1;
    while (cursor >= 0 && lines[cursor].trim()) cursor -= 1;
    startIndex = cursor + 1;
  }
  return lines.slice(startIndex).join('\n').trim();
}

function hasStructuredAntigravityFinalOutput(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const event = parseJsonLine(line);
    if (!event) continue;
    if (event.type === 'result' && event.is_error !== true && event.status !== 'error') {
      if (extractAnyText(event.result) || extractAnyText(event.output) || extractAnyText(event.content)) return true;
    }
    const assistantContent = event.type === 'assistant'
      ? event.message?.content
      : (event.type === 'message' && event.role === 'assistant' ? event.content : null);
    if (extractAnyText(assistantContent)) return true;
  }
  return false;
}

function isAntigravityFinalAnswerStructure(value) {
  const line = String(value || '').trim();
  if (/^#{1,6}\s+\S/.test(line)) return true;
  return /^\|?(?:\s*:?-{3,}:?\s*\|){2,}\s*$/.test(line);
}

// agy reports several distinct crashes through the same opaque one-liner; each
// of these leaves the real cause only in the diagnostic log, so all of them
// have to opt into the enrichment pass below (issues #17, #23).
function isGenericAntigravityFailure(stderr) {
  return /agent execution terminated due to error|timeout waiting for response|context deadline exceeded/i
    .test(String(stderr || ''));
}

async function readAntigravityFailureDiagnostics(logPath) {
  let handle;
  try {
    handle = await fs.open(logPath, 'r');
    const stat = await handle.stat();
    const maxBytes = 256 * 1024;
    const length = Math.min(stat.size, maxBytes);
    if (length <= 0) return '';
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    return extractAntigravityFailureDiagnostics(text);
  } catch {
    // The original process error stays authoritative when agy's optional
    // diagnostic log is missing or unreadable.
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function extractAntigravityFailureDiagnostics(logText, {
  maxLines = 6,
  maxLineChars = 1_200,
} = {}) {
  const records = [];
  const seen = new Set();
  for (const rawLine of String(logText || '').split(/\r?\n/)) {
    const match = rawLine.match(/\b([EF])\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+([^\]]+)\]\s*(.*)$/);
    if (!match) continue;
    const source = String(match[2] || '').trim();
    const message = String(match[3] || '').replace(/\u0000/g, '').trim();
    if (!message) continue;
    if (/print mode: run ended with error and no response/i.test(message)) continue;
    if (/^error running grep:/i.test(message)) continue;
    if (/failed to poll listexperiments:.*not logged into antigravity/i.test(message)) continue;
    if (/^(?:app root path missing|admin controls not applicable)$/i.test(message)) continue;
    if (seen.has(message)) continue;
    seen.add(message);
    const masked = maskSecrets(`${source}: ${message}`);
    records.push(masked.length <= maxLineChars
      ? masked
      : `${masked.slice(0, maxLineChars)} [truncated]`);
  }
  return records
    .slice(-Math.max(1, Number(maxLines) || 6))
    .reverse()
    .map((record) => `- ${record}`)
    .join('\n');
}

function extraAllowedRoots(config) {
  return config.allowedRoots.filter((root) => root !== config.codex.cwd);
}

async function ensureJobRoots(config, job = {}) {
  await fs.mkdir(config.codex.cwd, { recursive: true });
  await fs.mkdir(jobArtifactRoot(config, job), { recursive: true });
  for (const root of config.allowedRoots || []) {
    await fs.mkdir(root, { recursive: true });
  }
}

function isBooleanEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isClaudeWorker(worker) {
  return worker === 'claude' ||
    worker === CLAUDE_MAINTENANCE_PRIMARY_WORKER ||
    worker === CLAUDE_MAINTENANCE_FALLBACK_WORKER;
}

function workerEnv(config, worker, { home: requestedHome = null } = {}) {
  const isClaude = isClaudeWorker(worker);
  const isAntigravity = worker === 'antigravity';
  const bin = isClaude ? config.claude.bin : (isAntigravity ? config.antigravity.bin : config.gemini.bin);
  const home = requestedHome || (isClaude ? config.claude.home : (isAntigravity ? config.antigravity.home : config.gemini.home));
  return applyPythonEnv({
    ...safeWorkerProcessEnv(process.env, config.workerEnvAllowlist),
    ...hostGitHubAuthEnv(config),
    // Preserve explicit allowlisted channel credentials while replacing stale
    // values inherited from the bridge process by default.
    ...(config.workerEnvOverrides || {}),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PATH: workerToolSearchPath(config, bin),
    ...(worker === 'gemini' ? {
      GEMINI_SANDBOX: config.gemini.sandbox || 'false',
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    } : {}),
    ...(isAntigravity ? {
      ANTIGRAVITY_SANDBOX: config.antigravity.sandbox || 'false',
      ANTIGRAVITY_CLI_TRUST_WORKSPACE: 'true',
    } : {}),
  }, config);
}

function processError(worker, result) {
  if (result.aborted) {
    const error = new Error(`${worker} aborted${result.abortReason ? `: ${result.abortReason}` : ''}`);
    error.worker = worker;
    error.code = result.code;
    error.signal = result.signal;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.timedOut = result.timedOut;
    error.aborted = result.aborted;
    error.abortReason = result.abortReason;
    error.noProgressKilled = result.noProgressKilled;
    error.noProgressKillMs = result.noProgressKillMs;
    return error;
  }
  if (result.noProgressKilled) {
    const error = new Error(`${worker} produced no intermediate output for ${Math.round(result.noProgressKillMs / 1000)} seconds; terminated process tree`);
    error.worker = worker;
    error.code = result.code;
    error.signal = result.signal;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.timedOut = result.timedOut;
    error.aborted = result.aborted;
    error.abortReason = result.abortReason;
    error.noProgressKilled = result.noProgressKilled;
    error.noProgressKillMs = result.noProgressKillMs;
    return error;
  }
  const compactStdout = extractJsonStreamFinalText(result.stdout);
  const rawStdout = result.stdout.trim();
  const detail = result.stderr.trim()
    || extractJsonStreamError(result.stdout)
    || (!['(no final message)', '(no output)'].includes(compactStdout) ? compactStdout : '')
    || (!isJsonOnlyStream(rawStdout) ? rawStdout : '')
    || `${worker} exited with ${result.code}`;
  const error = new Error(detail);
  error.worker = worker;
  error.code = result.code;
  error.signal = result.signal;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  error.timedOut = result.timedOut;
  error.aborted = result.aborted;
  error.abortReason = result.abortReason;
  error.noProgressKilled = result.noProgressKilled;
  error.noProgressKillMs = result.noProgressKillMs;
  if (isNonRetryableJobError(error)) error.nonRetryable = true;
  return error;
}

function isMissingFinalOutput(output) {
  const text = String(output ?? '').trim();
  return text === '' || text === '(no final message)' || text === '(no output)';
}

// A worker that exits 0 but emits no usable final text must NOT be posted verbatim
// (the user would see a blank "(no final message)"). Treat it as this worker's
// failure; fallback is reserved for unavailable account/provider states.
function missingFinalOutputError(worker, output, result) {
  const message = String(output ?? '').trim() === '(no output)'
    ? `${worker} produced no output`
    : `${worker} produced no final message`;
  const error = new Error(message);
  error.worker = worker;
  error.code = result?.code;
  error.signal = result?.signal;
  error.stdout = result?.stdout;
  error.stderr = result?.stderr;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = formatAbortReason(signal.reason);
  const error = new Error(`worker aborted${reason ? `: ${reason}` : ''}`);
  error.aborted = true;
  error.abortReason = reason;
  throw error;
}

function formatAbortReason(reason) {
  if (reason === undefined || reason === null) return '';
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function isJsonOnlyStream(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith('{'));
}

function captureWorkerUpdate(onUpdate, worker, updates) {
  if (!onUpdate && !updates) return null;
  return (update) => {
    const enriched = { ...update, worker, timestamp: new Date().toISOString() };
    const compact = compactWorkerUpdate(enriched);
    if (compact && Array.isArray(updates)) {
      appendCompactWorkerUpdate(updates, compact);
    }
    if (onUpdate) onUpdate(enriched);
  };
}

function appendCompactWorkerUpdate(updates, update) {
  const previous = updates.at(-1);
  if (update.append && previous?.worker === update.worker && previous?.type === update.type) {
    previous.text = truncateWorkerUpdateText(`${previous.text}${update.text}`);
    previous.timestamp = update.timestamp;
    return;
  }
  updates.push(update);
  if (updates.length > 80) updates.splice(0, updates.length - 80);
}

function compactWorkerUpdate(update = {}) {
  const text = truncateWorkerUpdateText(update.text);
  if (!text && update.type !== 'plan' && update.type !== 'file_change') return null;
  return {
    worker: update.worker || null,
    type: update.type || 'response_text',
    text,
    append: Boolean(update.append),
    timestamp: update.timestamp || null,
    ...compactStructuredWorkerUpdate(update),
  };
}

function compactStructuredWorkerUpdate(update = {}) {
  const structured = {};
  if (update.kind) structured.kind = String(update.kind).slice(0, 80);
  if (update.actionId) structured.actionId = String(update.actionId).slice(0, 200);
  if (update.status) structured.status = String(update.status).slice(0, 80);
  if (update.command) structured.command = truncateWorkerUpdateText(update.command, 2_000);
  if (update.cwd) structured.cwd = truncateWorkerUpdateText(update.cwd, 1_000);
  if (update.exitCode !== undefined) structured.exitCode = finiteNumberOrNull(update.exitCode);
  if (update.durationMs !== undefined) structured.durationMs = finiteNumberOrNull(update.durationMs);
  if (update.output) structured.output = truncateWorkerUpdateText(update.output, 1_200);
  if (update.tool) structured.tool = String(update.tool).slice(0, 300);
  if (update.server) structured.server = String(update.server).slice(0, 300);
  if (update.explanation) structured.explanation = truncateWorkerUpdateText(update.explanation, 1_000);
  if (Array.isArray(update.plan)) {
    structured.plan = update.plan.slice(0, 64).map((item) => ({
      step: truncateWorkerUpdateText(item?.step || item?.text, 500),
      status: String(item?.status || '').slice(0, 40),
    })).filter((item) => item.step);
  }
  if (Array.isArray(update.changes)) {
    structured.changes = update.changes.slice(0, 500).map((change) => ({
      path: truncateWorkerUpdateText(change?.path || change?.file, 1_000),
      kind: String(change?.kind || change?.type || '').slice(0, 80),
    })).filter((change) => change.path);
  }
  return structured;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function truncateWorkerUpdateText(value, maxChars = 4_000) {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `[truncated; showing last ${maxChars} chars]\n${text.slice(-maxChars)}`;
}

function workerTranscriptFromProcessResult(worker, status, result = {}, { startedAt, finishedAt, output = '', error = '', updates = [] } = {}) {
  return {
    worker,
    status,
    startedAt,
    finishedAt,
    code: result?.code ?? null,
    signal: result?.signal ?? null,
    timedOut: Boolean(result?.timedOut),
    aborted: Boolean(result?.aborted),
    abortReason: result?.abortReason || '',
    noProgressKilled: Boolean(result?.noProgressKilled),
    noProgressKillMs: result?.noProgressKillMs ?? null,
    stdout: result?.stdout || '',
    stderr: result?.stderr || '',
    output,
    error,
    updates,
  };
}

function workerTranscriptFromError(worker, error, { startedAt, finishedAt, error: detail = '', updates = [] } = {}, status = 'failed') {
  return workerTranscriptFromProcessResult(worker, status, error || {}, {
    startedAt,
    finishedAt,
    output: '',
    error: detail,
    updates,
  });
}

export function createJsonLineStreamObserver(onUpdate, extractUpdate) {
  let buffer = '';

  return {
    write(chunk) {
      if (!onUpdate) return;
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) emitJsonUpdateFromLine(line, onUpdate, extractUpdate);
    },
    flush() {
      if (!onUpdate || !buffer.trim()) return;
      emitJsonUpdateFromLine(buffer, onUpdate, extractUpdate);
      buffer = '';
    },
  };
}

// agy print mode narrates in plain text, so the JSON-line observer extracted
// nothing and a 5-minute run reached the user as pure silence (issue #23).
// JSON lines still take the structured path, in case a future agy emits them;
// everything else is throttled so a long answer streaming out at the end
// cannot turn into a burst of progress messages.
const ANTIGRAVITY_PROGRESS_INTERVAL_MS = 45_000;
const ANTIGRAVITY_PROGRESS_MAX_CHARS = 400;

export function createAntigravityStreamObserver(onUpdate, {
  intervalMs = ANTIGRAVITY_PROGRESS_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  let buffer = '';
  let pending = [];
  let deferredSection = [];
  let afterBlank = false;
  let finalAnswerStarted = false;
  // The first narration line goes out immediately, so a slow run stops looking
  // like a hang the moment the worker says anything at all.
  let lastEmittedAt = null;

  const emitPending = () => {
    const text = pending.join('\n').trim().slice(0, ANTIGRAVITY_PROGRESS_MAX_CHARS);
    pending = [];
    if (!text) return;
    lastEmittedAt = now();
    onUpdate({ type: 'response_text', text, append: false });
  };
  const consume = (line) => {
    if (finalAnswerStarted) return;
    if (!line.trim()) {
      afterBlank = true;
      return;
    }
    const event = parseJsonLine(line);
    if (event) {
      if (deferredSection.length > 0) {
        pending.push(...deferredSection);
        deferredSection = [];
      }
      afterBlank = false;
      const update = extractAntigravityProgressUpdate(event);
      if (update) {
        lastEmittedAt = now();
        onUpdate(update);
      }
      return;
    }
    const text = line.trim();
    if (isAntigravityFinalAnswerStructure(text)) {
      finalAnswerStarted = true;
      pending = [];
      deferredSection = [];
      return;
    }
    // Hold the first text after a blank line until the next line establishes
    // whether it is another narration paragraph or the lead-in to the final
    // answer. A following heading discards it with the terminal response.
    if (afterBlank) {
      if (deferredSection.length > 0) pending.push(...deferredSection);
      deferredSection = [text];
      afterBlank = false;
      return;
    }
    if (deferredSection.length > 0) {
      pending.push(...deferredSection);
      deferredSection = [];
    }
    pending.push(text);
    if (lastEmittedAt === null || now() - lastEmittedAt >= intervalMs) emitPending();
  };

  return {
    write(chunk) {
      if (!onUpdate) return;
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) consume(line);
    },
    // The tail of the stream is the final answer, which the job delivers on its
    // own. Parse it for structured events but never re-post it as progress.
    flush() {
      if (!onUpdate) return;
      if (!finalAnswerStarted && buffer.trim()) {
        const event = parseJsonLine(buffer);
        if (event) {
          const update = extractAntigravityProgressUpdate(event);
          if (update) onUpdate(update);
        }
      }
      buffer = '';
      pending = [];
      deferredSection = [];
    },
  };
}

// Emits progress updates ONLY for real Claude stream content (assistant text and
// tool calls). Thinking-only and tool-only turns intentionally emit nothing: a
// synthetic "still working" update here would be delivered as a Discord message,
// and each delivered message resets the progress silence timer, which suppresses
// the `<worker> working for N minutes.` message the user relies on. This was tried
// once and reverted; `test/agent-runner.test.mjs` pins the exact update list so a
// re-added synthetic update fails the suite.
export function createClaudeJsonStreamObserver(onUpdate) {
  let buffer = '';
  let pendingResponseUpdate = null;

  const emitPendingResponseUpdate = () => {
    if (!pendingResponseUpdate) return;
    onUpdate(pendingResponseUpdate);
    pendingResponseUpdate = null;
  };

  const keepAsFinalCandidate = (update) => {
    if (!pendingResponseUpdate) {
      pendingResponseUpdate = { ...update, append: false };
      return;
    }
    if (update.append && pendingResponseUpdate.type === update.type) {
      pendingResponseUpdate.text = `${pendingResponseUpdate.text}${update.text}`;
      return;
    }
    emitPendingResponseUpdate();
    pendingResponseUpdate = { ...update, append: false };
  };

  const handleEvent = (event) => {
    const update = extractClaudeProgressUpdate(event);
    if (!update) {
      if (isClaudeTerminalEvent(event)) pendingResponseUpdate = null;
      else if (shouldReleasePendingClaudeUpdate(event)) emitPendingResponseUpdate();
      return;
    }

    if (update.type === 'response_text') {
      keepAsFinalCandidate(update);
      return;
    }

    emitPendingResponseUpdate();
    onUpdate(update);
  };

  return {
    write(chunk) {
      if (!onUpdate) return;
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const event = parseJsonLine(line);
        if (event) handleEvent(event);
      }
    },
    flush() {
      if (!onUpdate) return;
      if (buffer.trim()) {
        const event = parseJsonLine(buffer);
        if (event) handleEvent(event);
      }
      buffer = '';
      pendingResponseUpdate = null;
    },
  };
}

// Claude's file-editing tools and the change kind each one reports. Read-only
// tools stay out so they do not register as workspace mutations.
const CLAUDE_FILE_TOOL_CHANGE_KINDS = new Map([
  ['Write', 'modified'],
  ['Edit', 'modified'],
  ['MultiEdit', 'modified'],
  ['NotebookEdit', 'modified'],
]);

export function extractClaudeProgressUpdate(event) {
  const type = String(event?.type || '');
  if (type === 'result' || type === 'system') return null;

  const text = extractClaudeAssistantText(event);
  if (text) {
    const textToolUpdate = classifyClaudeCommandText(text, type);
    if (textToolUpdate) return textToolUpdate;
    return {
      type: type.includes('reasoning') ? 'reasoning' : 'response_text',
      text,
      append: type.includes('delta') || type.includes('partial'),
    };
  }

  const toolUpdate = extractClaudeToolProgressUpdate(event);
  if (toolUpdate) return toolUpdate;

  return null;
}

function extractClaudeAssistantText(event) {
  const type = String(event?.type || '');
  const role = String(event?.message?.role || event?.role || '');
  if (type === 'assistant' || role === 'assistant') {
    return extractClaudeTextBlocks(event?.message?.content ?? event?.content);
  }
  if (type.includes('delta') || type.includes('partial')) {
    return extractClaudeTextDelta(event?.delta);
  }
  return '';
}

function extractClaudeTextBlocks(value) {
  if (typeof value === 'string') return value.trim();
  if (!value) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (!item || typeof item !== 'object') return '';
        if (String(item.type || '') !== 'text') return '';
        return extractAnyText(item.text ?? item.content);
      })
      .filter(Boolean)
      .join('');
  }
  if (typeof value !== 'object') return '';
  if (value.type && String(value.type) !== 'text') return '';
  return extractAnyText(value.text ?? value.content);
}

function extractClaudeTextDelta(delta) {
  if (typeof delta === 'string') return delta.trim();
  if (!delta || typeof delta !== 'object') return '';
  const type = String(delta.type || '');
  if (type && !type.includes('text')) return '';
  return extractAnyText(delta.text ?? delta.content);
}

function extractClaudeToolProgressUpdate(event) {
  const toolResult = extractClaudeToolResult(event);
  if (toolResult?.text) {
    return {
      type: 'tool_output',
      kind: 'tool_result',
      actionId: toolResult.actionId,
      status: toolResult.failed ? 'failed' : 'completed',
      output: toolResult.text,
      text: `tool output:\n${toolResult.text}`,
      append: false,
    };
  }

  const toolCall = extractClaudeToolCall(event);
  if (toolCall?.filePath) {
    // Claude edits files through structured tools instead of shell commands, so
    // without this the job checkpoint holds no per-job evidence that the job
    // touched a file. Runtime-source restarts require that evidence, so a
    // Claude job that edited bridge source had its restart dropped as
    // unattributed. The edited path is a claim; the workbench still confirms it
    // against the on-disk snapshot before attributing a restart.
    return {
      type: 'file_change',
      actionId: toolCall.actionId,
      tool: toolCall.name,
      changes: [{ path: toolCall.filePath, kind: toolCall.fileChangeKind }],
      text: `${toolCall.fileChangeKind} file: ${toolCall.filePath}`,
      append: false,
    };
  }
  if (toolCall) {
    return {
      type: 'tool_call',
      kind: toolCall.command ? 'command' : 'structured_tool',
      actionId: toolCall.actionId,
      command: toolCall.command || undefined,
      ...(toolCall.cwd ? { cwd: toolCall.cwd } : {}),
      tool: toolCall.name,
      status: 'in_progress',
      text: toolCall.command ? `running command: ${toolCall.command}` : `using tool: ${toolCall.name}`,
      append: false,
    };
  }

  return null;
}

function extractClaudeToolResult(event) {
  const type = String(event?.type || '');
  if (type === 'tool_result') {
    const text = extractAnyText(event?.content ?? event?.result ?? event?.output);
    return text ? {
      text,
      actionId: event?.tool_use_id || event?.toolUseId || event?.id || null,
      failed: Boolean(event?.is_error || event?.isError),
    } : null;
  }

  const blocks = claudeContentBlocks(event);
  const block = blocks.find((candidate) => String(candidate?.type || '') === 'tool_result');
  if (!block) return null;
  const text = extractAnyText(block.content ?? block.result ?? block.output ?? block.text);
  return text ? {
    text,
    actionId: block?.tool_use_id || block?.toolUseId || block?.id || null,
    failed: Boolean(block?.is_error || block?.isError),
  } : null;
}

function extractClaudeToolCall(event) {
  const type = String(event?.type || '');
  const directTool = type === 'tool_use' ? event : null;
  const blockTool = claudeContentBlocks(event).find((block) => String(block?.type || '') === 'tool_use');
  const tool = directTool || blockTool;
  if (!tool) return null;

  const name = String(tool.name || tool.tool_name || tool.tool || 'tool').trim() || 'tool';
  const input = tool.input || tool.args || {};
  const command = compactProgressLine(input?.command || input?.cmd || input?.shell_command || input?.code);
  const cwd = input?.workdir || input?.cwd || input?.working_directory || input?.workingDirectory || null;
  const fileChangeKind = CLAUDE_FILE_TOOL_CHANGE_KINDS.get(name);
  const filePath = fileChangeKind
    ? String(input?.file_path || input?.notebook_path || input?.filePath || input?.path || '').trim()
    : '';
  return {
    actionId: tool.id || tool.tool_use_id || tool.toolUseId || null,
    name,
    command: command || null,
    cwd: cwd ? String(cwd) : null,
    filePath: filePath || null,
    fileChangeKind: filePath ? fileChangeKind : null,
  };
}

function claudeContentBlocks(event) {
  const content = event?.message?.content ?? event?.content;
  if (Array.isArray(content)) return content.filter((item) => item && typeof item === 'object');
  if (content && typeof content === 'object') return [content];
  return [];
}

function classifyClaudeCommandText(text, eventType) {
  const normalized = String(text || '').trim();
  if (!normalized) return null;
  if (/^command line request\b\s*:?\s*/i.test(normalized)) {
    return {
      type: 'tool_call',
      text: normalized.replace(/^command line request\b\s*:?\s*/i, 'running command: '),
      append: eventType.includes('delta') || eventType.includes('partial'),
    };
  }
  if (/^command line output\b\s*:?\s*/i.test(normalized)) {
    return {
      type: 'tool_output',
      text: normalized.replace(/^command line output\b\s*:?\s*/i, 'command output:\n'),
      append: eventType.includes('delta') || eventType.includes('partial'),
    };
  }
  return null;
}

function compactProgressLine(value, maxChars = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}...`;
}

function isClaudeTerminalEvent(event) {
  const type = String(event?.type || '');
  return type === 'result';
}

function shouldReleasePendingClaudeUpdate(event) {
  const type = String(event?.type || '');
  // Claude emits passive stream lifecycle events (content_block_stop,
  // message_delta, message_stop) after the complete assistant snapshot. They
  // do not prove that more work follows, so releasing on them exposes the
  // terminal answer as progress immediately before the result event.
  return type !== ''
    && type !== 'system'
    && type !== 'stream_event'
    && !isClaudeTerminalEvent(event);
}

export function extractGeminiProgressUpdate(event) {
  if (event?.type !== 'message' || event?.role !== 'assistant') return null;
  const text = extractAnyText(event.content);
  if (!text) return null;
  return { type: 'response_text', text, append: Boolean(event.delta) };
}

export function extractAntigravityProgressUpdate(event) {
  const thought = event?.type === 'thought' ? extractAnyText(event.content) : '';
  if (thought) {
    return { type: 'response_text', text: thought, append: Boolean(event.delta) };
  }
  if (event?.type === 'call' && event.tool) {
    const args = event.args ? ` ${JSON.stringify(event.args)}` : '';
    return { type: 'response_text', text: `[${event.tool}${args}]`, append: false };
  }
  return extractGeminiProgressUpdate(event);
}

export function extractJsonStreamFinalText(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return '(no output)';

  let finalText = '';
  let assistantText = '';
  let errorText = '';
  let sawJson = false;
  let sawNonJson = false;
  for (const line of raw.split(/\r?\n/)) {
    const event = parseJsonLine(line);
    if (!event) {
      if (line.trim()) sawNonJson = true;
      continue;
    }
    sawJson = true;

    const eventError = extractEventErrorText(event);
    if (eventError) errorText = eventError;

    if (event.type === 'result') {
      const resultText = extractAnyText(event.result)
        || extractAnyText(event.output)
        || extractAnyText(event.content);
      if (event.is_error === true || event.status === 'error') {
        if (resultText) errorText = resultText;
        continue;
      }
      finalText = resultText || finalText;
      continue;
    }

    const assistantMessage = event.type === 'assistant' ? event.message : null;
    const assistantContent = assistantMessage?.content
      || (event.type === 'message' && event.role === 'assistant' ? event.content : null);
    const text = extractAnyText(assistantContent);
    if (!text) continue;
    assistantText = event.delta ? `${assistantText}${text}` : text;
  }

  if (finalText || assistantText || errorText) return (finalText || assistantText || errorText).trim();
  if (sawJson && !sawNonJson) return '(no final message)';
  return raw;
}

function extractJsonStreamError(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const event = parseJsonLine(line);
    const message = extractEventErrorText(event);
    if (message) return message;
  }
  return '';
}

function extractEventErrorText(event) {
  if (!event || typeof event !== 'object') return '';
  const hasError = event.error
    || event.is_error === true
    || event.status === 'error'
    || event.subtype === 'error'
    || event.error_code;
  if (!hasError) return '';
  return extractAnyText(event.result)
    || extractAnyText(event.output)
    || extractAnyText(event.message?.content)
    || extractAnyText(event.content)
    || extractAnyText(event.error?.message)
    || extractAnyText(event.error)
    || extractAnyText(event.message);
}

function emitJsonUpdateFromLine(line, onUpdate, extractUpdate) {
  const event = parseJsonLine(line);
  if (!event) return;
  const update = extractUpdate(event);
  if (update) onUpdate(update);
}

function parseJsonLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractAnyText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => extractAnyText(item))
      .filter(Boolean)
      .join('');
  }
  if (typeof value !== 'object') return '';
  return extractAnyText(value.text)
    || extractAnyText(value.content)
    || extractAnyText(value.message)
    || extractAnyText(value.result)
    || extractAnyText(value.delta);
}
