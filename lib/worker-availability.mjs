import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from './file-lock.mjs';
import { workerRetryAtMs } from './retry-policy.mjs';

const STATE_VERSION = 1;
const STATE_FILE = 'worker-availability.json';
const DEFAULT_QUOTA_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_CAPACITY_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 24 * 60 * 60_000;
const MIN_COOLDOWN_MS = 1_000;
let temporaryFileCounter = 0;

export function workerAvailabilityFile(config = {}) {
  return path.join(path.resolve(config.stateRoot || '.'), '_system', STATE_FILE);
}

export function workerAvailabilityIdentity(config = {}, workerProfile = {}) {
  const worker = String(workerProfile.worker || workerProfile.name || 'unknown').trim().toLowerCase();
  const provider = worker === 'codex-spark' ? 'codex' : worker;
  const accountId = provider === 'claude'
    ? String(
        workerProfile.claudeAccount?.id
          || config.claude?.accounts?.[0]?.id
          || 'primary',
      ).trim().toLowerCase()
    : 'primary';
  const model = resolvedWorkerModel(config, workerProfile, worker);
  const modelFamily = workerModelFamily(provider, model);
  return {
    key: [provider, accountId, modelFamily].map(availabilityKeyPart).join(':'),
    provider,
    accountId,
    modelFamily,
    model,
    worker: String(workerProfile.name || workerProfile.worker || worker || 'unknown'),
  };
}

export function classifyWorkerAvailabilityError(error) {
  if (!error || error.aborted || error.timedOut || error.noProgressKilled) return null;
  const text = workerErrorText(error);
  if (!text) return null;

  if (
    /\b429\b/.test(text)
    || /\bquota\b/.test(text)
    || /\brate[_ -]?limit(?:ed|ing)?\b/.test(text)
    || /\btoo many requests\b/.test(text)
    || /\bresource[_ -]?exhausted\b/.test(text)
    || /\b(?:usage|session|spending|billing)[_ -]?limit\b/.test(text)
    || /\b(?:insufficient|exhausted)\s+credits?\b/.test(text)
    || /\bcredit balance\b/.test(text)
    || /\bpayment required\b/.test(text)
    || /\b(?:you(?:'|’)ve|you have)\s+hit\s+(?:your|the)\s+limit\b/.test(text)
    || /\blimit (?:has been )?(?:reached|exhausted)\b/.test(text)
  ) {
    return { kind: 'quota' };
  }

  if (
    /\b503\b/.test(text)
    || /\bcapacity\b/.test(text)
    || /\boverloaded(?:_error)?\b/.test(text)
    || /\btemporarily unavailable\b/.test(text)
    || /\bservice unavailable\b/.test(text)
  ) {
    return { kind: 'capacity' };
  }

  return null;
}

export async function activeWorkerCooldown(config, workerProfile, {
  nowMs = Date.now(),
} = {}) {
  const identity = workerAvailabilityIdentity(config, workerProfile);
  const filePath = workerAvailabilityFile(config);
  return withAvailabilityLock(filePath, async () => {
    const state = await readAvailabilityState(filePath);
    const pruned = pruneExpiredEntries(state, nowMs);
    if (pruned.changed) await writeAvailabilityState(filePath, pruned.state);
    const entry = pruned.state.entries[identity.key];
    if (!entry || retryAtMs(entry) <= nowMs) return null;
    return { ...entry };
  });
}

export async function recordWorkerAvailabilityFailure(config, workerProfile, error, {
  nowMs = Date.now(),
} = {}) {
  const classification = classifyWorkerAvailabilityError(error);
  if (!classification) return null;

  const identity = workerAvailabilityIdentity(config, workerProfile);
  const filePath = workerAvailabilityFile(config);
  const maxCooldownMs = positiveMilliseconds(config.workers?.maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS);
  const defaultCooldownMs = classification.kind === 'capacity'
    ? positiveMilliseconds(config.workers?.capacityCooldownMs, DEFAULT_CAPACITY_COOLDOWN_MS)
    : positiveMilliseconds(config.workers?.quotaCooldownMs, DEFAULT_QUOTA_COOLDOWN_MS);
  const providerRetryAtMs = workerRetryAtMs(error, { nowMs });
  const requestedRetryAtMs = Number.isFinite(providerRetryAtMs)
    ? providerRetryAtMs
    : nowMs + defaultCooldownMs;
  const boundedRetryAtMs = Math.min(
    nowMs + maxCooldownMs,
    Math.max(nowMs + MIN_COOLDOWN_MS, requestedRetryAtMs),
  );

  return withAvailabilityLock(filePath, async () => {
    const current = pruneExpiredEntries(await readAvailabilityState(filePath), nowMs).state;
    const previous = current.entries[identity.key];
    const effectiveRetryAtMs = Math.max(boundedRetryAtMs, retryAtMs(previous));
    const entry = {
      ...identity,
      kind: classification.kind,
      failedAt: new Date(nowMs).toISOString(),
      retryAt: new Date(effectiveRetryAtMs).toISOString(),
    };
    current.entries[identity.key] = entry;
    current.updatedAt = new Date(nowMs).toISOString();
    await writeAvailabilityState(filePath, current);
    return { ...entry };
  });
}

export async function clearWorkerCooldown(config, workerProfile, {
  nowMs = Date.now(),
} = {}) {
  const identity = workerAvailabilityIdentity(config, workerProfile);
  const filePath = workerAvailabilityFile(config);
  return withAvailabilityLock(filePath, async () => {
    const current = pruneExpiredEntries(await readAvailabilityState(filePath), nowMs).state;
    if (!current.entries[identity.key]) return false;
    delete current.entries[identity.key];
    current.updatedAt = new Date(nowMs).toISOString();
    await writeAvailabilityState(filePath, current);
    return true;
  });
}

function resolvedWorkerModel(config, workerProfile, worker) {
  const selected = String(workerProfile.model || '').trim();
  if (selected) return selected;
  if (worker === 'codex') return String(config.codex?.model || 'default').trim();
  if (worker === 'codex-spark') return String(config.codexSpark?.model || 'default').trim();
  if (worker === 'claude') return String(config.claude?.model || 'default').trim();
  if (worker === 'gemini') return String(config.gemini?.model || 'default').trim();
  if (worker === 'antigravity') return String(config.antigravity?.model || 'default').trim();
  return 'default';
}

function workerModelFamily(provider, model) {
  const normalized = String(model || 'default').trim().toLowerCase();
  if (provider === 'claude') {
    const family = normalized.match(/\b(opus|fable|sonnet|haiku)\b/)?.[1];
    if (family) return family;
  }
  if (provider === 'antigravity' && normalized.includes('claude')) {
    const family = normalized.match(/\b(opus|fable|sonnet|haiku)\b/)?.[1];
    if (family) return `claude-${family}`;
  }
  return availabilityKeyPart(normalized);
}

function availabilityKeyPart(value) {
  return String(value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function workerErrorText(error) {
  return [
    error?.message,
    error?.stderr,
    error?.stdout,
    error?.code,
  ].filter(Boolean).join('\n').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function readAvailabilityState(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return normalizeAvailabilityState(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return emptyAvailabilityState();
    }
    throw error;
  }
}

function normalizeAvailabilityState(value) {
  const entries = {};
  for (const [key, entry] of Object.entries(value?.entries || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const retryAt = String(entry.retryAt || '');
    if (!Number.isFinite(Date.parse(retryAt))) continue;
    entries[String(key)] = { ...entry, retryAt };
  }
  return {
    version: STATE_VERSION,
    updatedAt: String(value?.updatedAt || ''),
    entries,
  };
}

function emptyAvailabilityState() {
  return {
    version: STATE_VERSION,
    updatedAt: '',
    entries: {},
  };
}

function pruneExpiredEntries(state, nowMs) {
  const entries = {};
  let changed = false;
  for (const [key, entry] of Object.entries(state.entries || {})) {
    if (retryAtMs(entry) <= nowMs) {
      changed = true;
      continue;
    }
    entries[key] = entry;
  }
  if (!changed) return { state, changed: false };
  return {
    changed: true,
    state: {
      ...state,
      updatedAt: new Date(nowMs).toISOString(),
      entries,
    },
  };
}

function retryAtMs(entry) {
  const parsed = Date.parse(String(entry?.retryAt || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function writeAvailabilityState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${temporaryFileCounter++}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function withAvailabilityLock(filePath, operation) {
  return withFileLock(filePath, operation, {
    retryMs: 25,
    hardStaleMs: 60_000,
    timeoutMs: 2_000,
  });
}

function positiveMilliseconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
