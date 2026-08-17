import fs from 'node:fs';
import path from 'node:path';
import { channelStateDir, threadStateDir } from './config.mjs';
import {
  defaultThreadModelFallbackChain,
  effortOptionsForModel,
  getModelFamily,
  isPendingModelSelectionActive,
  modelSelectionFromOption,
  normalizeModelSelection,
  pendingModelSelection,
} from './thread-models.mjs';
import {
  DEFAULT_RICH_STYLE_ID,
  normalizeRichStyleId,
  richStyleBySelector,
} from './rich-style-themes.mjs';

export const THREAD_STATUS_FILE = 'thread/status.json';
export const LEGACY_THREAD_REPO_CONTEXT_FILE = 'thread/repo-context.json';
export const GLOBAL_REPO_ACCESS_FILE = '_system/repo-access.json';

export function threadStatusPath(config, channelId, threadId) {
  return path.join(threadStateDir(config, channelId, threadId), THREAD_STATUS_FILE);
}

export function threadRepoContextPath(config, channelId, threadId) {
  return path.join(threadStateDir(config, channelId, threadId), LEGACY_THREAD_REPO_CONTEXT_FILE);
}

export function globalRepoAccessPath(config) {
  return path.join(config.stateRoot, GLOBAL_REPO_ACCESS_FILE);
}

export function readThreadStatusSync(config, channelId, threadId) {
  try {
    return normalizeThreadStatus(JSON.parse(fs.readFileSync(threadStatusPath(config, channelId, threadId), 'utf8')), {
      config,
      legacyRepoPathImpliesAccess: false,
    });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function readThreadRichStyleIdSync(config, channelId, threadId) {
  return readThreadStatusSync(config, channelId, threadId)?.richStyleId || DEFAULT_RICH_STYLE_ID;
}

export function resolveJobRichStyleIdSync(config, job = {}, {
  readStatusSync = readThreadStatusSync,
} = {}) {
  const snapshot = normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID);
  if (!job.channelId || !job.threadId) return snapshot;

  try {
    const stored = readStatusSync(config, job.channelId, job.threadId);
    return normalizeRichStyleId(stored?.richStyleId, snapshot);
  } catch {
    // Rendering must remain deliverable even when thread status is temporarily
    // unreadable. The immutable job snapshot is the durable fallback.
    return snapshot;
  }
}

export function readThreadRepoContextSync(config, channelId, threadId) {
  const status = readThreadStatusSync(config, channelId, threadId);
  if (status) return status;

  try {
    return normalizeThreadStatus(JSON.parse(fs.readFileSync(threadRepoContextPath(config, channelId, threadId), 'utf8')), {
      config,
      legacyRepoPathImpliesAccess: true,
    });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function readGlobalRepoAccessSync(config) {
  try {
    return normalizeGlobalRepoAccess(JSON.parse(fs.readFileSync(globalRepoAccessPath(config), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function resolveThreadRepoContextSync(config, job = {}) {
  const stored = job.channelId && job.threadId
    ? readThreadRepoContextSync(config, job.channelId, job.threadId)
    : null;
  const globalAccess = readGlobalRepoAccessSync(config);
  const storedRepoPath = stored?.repoPath || null;
  const storedRepoAccess = typeof stored?.repoAccess === 'boolean'
    ? stored.repoAccess
    : Boolean(storedRepoPath);
  const storedThreadRepoPath = storedRepoPath && isThreadScopedRepoAccess(stored)
    ? storedRepoPath
    : null;
  const storedStateAccess = Boolean(stored?.stateAccess);
  const directiveRepoAccess = typeof job.repoAccessDirective === 'boolean'
    ? job.repoAccessDirective
    : null;
  const directiveStateAccess = typeof job.stateAccessDirective === 'boolean'
    ? job.stateAccessDirective
    : null;
  const requestedRepoAccess = Boolean(job.maintenance || job.repoAccess);
  const requestedStateAccess = Boolean(job.stateAccess);
  const stateAccess = job.maintenance
    ? requestedStateAccess
    : Boolean(directiveStateAccess ?? requestedStateAccess);
  const repoAccess = job.maintenance
    ? true
    : Boolean(directiveRepoAccess ?? (requestedRepoAccess || stateAccess || storedThreadRepoPath || globalAccess?.repoAccess));
  const repoPath = normalizeRepoPath(job.repoPath)
    || (repoAccess ? storedThreadRepoPath || defaultThreadRepoPath(config, job) : null);
  const bridgeRepoAccess = Boolean(repoAccess && (
    job.bridgeRepoAccess === true
    || stored?.bridgeRepoAccess === true
    || globalAccess?.bridgeRepoAccess === true
  ));

  return {
    repoAccess,
    repoPath,
    bridgeRepoAccess,
    stateAccess,
    threadModelOverride: stored?.threadModelOverride || null,
    threadEffortOverride: normalizedThreadEffort(stored?.threadEffortOverride),
    pendingModelSelection: stored?.pendingModelSelection || null,
    storedRepoAccess,
    storedRepoPath,
    storedRepoAccessScope: stored?.repoAccessScope || null,
    storedStateAccess,
    globalRepoAccess: Boolean(globalAccess?.repoAccess),
    globalRepoAccessScope: globalAccess?.repoAccessScope || null,
    verboseProgress: Boolean(stored?.verboseProgress),
    codexFastMode: Boolean(stored?.codexFastMode),
    richStyleId: stored?.richStyleId || DEFAULT_RICH_STYLE_ID,
  };
}

export function mergeThreadRepoContextIntoJobSync(config, job = {}) {
  const context = resolveThreadRepoContextSync(config, {
    channelId: job.channelId,
    threadId: job.threadId,
    maintenance: Boolean(job.maintenance),
    repoAccess: Boolean(job.repoAccess),
    stateAccess: Boolean(job.stateAccess),
    bridgeRepoAccess: Boolean(job.bridgeRepoAccess),
    repoPath: job.repoPath || null,
  });
  return {
    ...job,
    repoAccess: context.repoAccess,
    repoPath: context.repoPath,
    bridgeRepoAccess: context.bridgeRepoAccess,
    stateAccess: context.stateAccess,
    threadModelOverride: context.threadModelOverride || job.threadModelOverride || null,
    verboseProgress: Boolean(job.verboseProgress || context.verboseProgress),
    codexFastMode: context.codexFastMode,
    richStyleId: context.richStyleId,
  };
}

export function writeThreadRichStyleSync(config, job = {}, styleId, {
  source = 'style-command',
} = {}) {
  if (!job.channelId || !job.threadId) return null;
  const selected = richStyleBySelector(styleId);
  if (!selected) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const now = new Date().toISOString();
  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    richStyleId: normalizeRichStyleId(selected.id),
    richStyleSelectedAt: now,
    richStyleSelectedByMessageId: job.id || null,
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

export function writeThreadVerboseProgressSync(config, job = {}, enabled = true, {
  source = 'verbose-command',
} = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const now = new Date().toISOString();
  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    verboseProgress: Boolean(enabled),
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

export function writeThreadCodexFastModeSync(config, job = {}, enabled = true, {
  source = enabled ? 'fast-command' : 'unfast-command',
} = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const now = new Date().toISOString();
  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    codexFastMode: Boolean(enabled),
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

export function requestThreadModelSelectionSync(config, job = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const now = new Date().toISOString();
  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    pendingModelSelection: pendingModelSelection({
      messageId: job.id || null,
      requestedAt: now,
    }),
    pendingEffortSelection: null,
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source: 'model-command',
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

export function writeThreadRepositoryRootSync(config, job = {}, {
  source = 'repo-command',
} = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const now = new Date().toISOString();
  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    repoAccess: true,
    repoAccessScope: 'thread',
    repoPath: defaultRepositoriesRoot(config),
    stateAccess: false,
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

export function writeThreadRepoAccessSync(config, job = {}, {
  source = 'yolo-command',
} = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const existingGlobalAccess = readGlobalRepoAccessSync(config);
  const now = new Date().toISOString();
  const defaultRepoPath = defaultThreadRepoPath(config, job);
  const existingThreadRepoPath = existing && isThreadScopedRepoAccess(existing) && !samePath(existing.repoPath, defaultRepoPath)
    ? existing.repoPath
    : null;
  const requestedRepoPath = normalizeRepoPath(job.repoPath);
  const repoPath = requestedRepoPath || existingThreadRepoPath || defaultRepoPath;
  writeGlobalRepoAccessAtomicSync(config, {
    repoAccess: true,
    repoAccessScope: 'global',
    repoPath: null,
    bridgeRepoAccess: true,
    stateAccess: false,
    firstJobId: existingGlobalAccess?.firstJobId || job.id || null,
    firstChannelId: existingGlobalAccess?.firstChannelId || String(job.channelId),
    firstThreadId: existingGlobalAccess?.firstThreadId || String(job.threadId),
    createdAt: existingGlobalAccess?.createdAt || now,
    updatedAt: now,
    source,
  });
  const repoAccessScope = existingThreadRepoPath || (requestedRepoPath && !samePath(requestedRepoPath, defaultRepoPath))
    ? 'thread'
    : 'global';
  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    repoAccess: true,
    repoAccessScope,
    repoPath,
    stateAccess: false,
    globalRepoAccess: true,
    bridgeRepoAccess: true,
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

export function writeInheritedThreadStatusSync(config, {
  sourceChannelId,
  sourceThreadId,
  targetChannelId,
  targetThreadId,
  sourceMessageId = null,
  repoPath = null,
  repoAccess = null,
  stateAccess = null,
} = {}, {
  source = 'thread-inherit',
} = {}) {
  if (!sourceChannelId || !sourceThreadId || !targetChannelId || !targetThreadId) return null;

  const existing = readThreadRepoContextSync(config, sourceChannelId, sourceThreadId);
  const now = new Date().toISOString();
  const normalizedRepoPath = normalizeRepoPath(repoPath) || existing?.repoPath || null;
  const inheritedRepoAccess = typeof repoAccess === 'boolean'
    ? repoAccess
    : Boolean(existing?.repoAccess || normalizedRepoPath);
  const inheritedStateAccess = typeof stateAccess === 'boolean'
    ? stateAccess
    : Boolean(existing?.stateAccess);
  const context = {
    ...(existing || {}),
    channelId: String(targetChannelId),
    threadId: String(targetThreadId),
    repoAccess: inheritedRepoAccess || inheritedStateAccess,
    repoAccessScope: normalizedRepoPath ? 'thread' : existing?.repoAccessScope || null,
    repoPath: normalizedRepoPath,
    stateAccess: inheritedStateAccess,
    pendingModelSelection: null,
    pendingEffortSelection: null,
    firstJobId: existing?.firstJobId || sourceMessageId || null,
    createdAt: now,
    updatedAt: now,
    inheritedFrom: {
      channelId: String(sourceChannelId),
      threadId: String(sourceThreadId),
      messageId: sourceMessageId ? String(sourceMessageId) : null,
    },
    source,
  };

  return writeThreadStatusAtomicSync(config, targetChannelId, targetThreadId, context);
}

// `option` may be a single menu option/selection or an array of them. An array (from a
// "3 4 1" reply) pins the thread to that exact fallback order; duplicates are collapsed,
// and a length-1 result behaves like a plain single-model pin.
export function writeThreadModelOverrideSync(config, job = {}, option, {
  source = 'model-command',
  effortOverrides = null,
} = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const selected = buildModelOverrideFromOptions(config, job, option);
  if (!selected) return null;
  const explicitEfforts = effortOverrides === null
    ? null
    : normalizedThreadEfforts(effortOverrides);
  if (effortOverrides !== null && !explicitEfforts) return null;
  const threadEffortOverride = explicitEfforts
    ? (explicitEfforts.length === 1 ? explicitEfforts[0] : null)
    : storedThreadEffortOverride(existing);
  const selectedWithEffort = explicitEfforts
    ? applyThreadEffortOverrides(selected, explicitEfforts)
    : applyThreadEffortOverride(selected, threadEffortOverride);
  if (!selectedWithEffort) return null;

  const now = new Date().toISOString();
  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    threadModelOverride: {
      ...selectedWithEffort,
      selectedAt: now,
      selectedByMessageId: job.id || selectedWithEffort.selectedByMessageId || null,
    },
    threadEffortOverride,
    pendingModelSelection: null,
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

function buildModelOverrideFromOptions(config, job, option) {
  const options = Array.isArray(option) ? option : [option];
  const selections = [];
  const seen = new Set();
  for (const candidate of options) {
    const selection = normalizeModelSelection(
      config,
      candidate?.id ? modelSelectionFromOption(candidate, { messageId: job.id || null }) : candidate,
    );
    if (!selection || seen.has(selection.id)) continue;
    seen.add(selection.id);
    selections.push(selection);
  }
  if (selections.length === 0) return null;
  if (selections.length === 1) return selections[0];
  return { ...selections[0], chain: selections };
}

export function requestThreadEffortSelectionSync(config, job = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const now = new Date().toISOString();
  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    pendingEffortSelection: {
      messageId: job.id || null,
      requestedAt: now,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
    pendingModelSelection: null,
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source: 'effort-command',
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

export function clearPendingEffortSelectionSync(config, job = {}, {
  source = 'effort-command',
} = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  if (!existing?.pendingEffortSelection) return existing || null;

  const now = new Date().toISOString();
  const context = {
    ...existing,
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    pendingEffortSelection: null,
    updatedAt: now,
    source,
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

export function writeThreadEffortOverrideSync(config, job = {}, effort, {
  source = 'effort-command',
} = {}) {
  if (!job.channelId || !job.threadId) return null;

  const existing = readThreadRepoContextSync(config, job.channelId, job.threadId);
  const currentOverride = existing?.threadModelOverride;
  const now = new Date().toISOString();
  const efforts = normalizedThreadEfforts(effort);
  if (!efforts) return null;

  let targetOption = currentOverride;
  if (!targetOption) {
    const isCompany = config.workers?.companyChannelIds?.has(String(job.channelId || ''));
    const defaultOption = defaultThreadModelFallbackChain(config, { company: isCompany })[0];
    const primaryWorker = defaultOption?.worker || 'codex';
    targetOption = defaultOption ? { ...defaultOption } : { worker: primaryWorker };
  }

  const selected = normalizeModelSelection(config, applyThreadEffortOverrides(targetOption, efforts));
  if (!selected) return null;

  const context = {
    ...(existing || {}),
    channelId: String(job.channelId),
    threadId: String(job.threadId),
    threadModelOverride: {
      ...(selected || {}),
      selectedAt: now,
      selectedByMessageId: job.id || null,
    },
    threadEffortOverride: efforts.length === 1 ? efforts[0] : null,
    pendingEffortSelection: null,
    firstJobId: existing?.firstJobId || job.id || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };
  return writeThreadStatusAtomicSync(config, job.channelId, job.threadId, context);
}

function writeThreadStatusAtomicSync(config, channelId, threadId, context) {
  const filePath = threadStatusPath(config, channelId, threadId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(context, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
  return context;
}

function writeGlobalRepoAccessAtomicSync(config, context) {
  const filePath = globalRepoAccessPath(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(context, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
  return context;
}

function normalizeThreadStatus(context, { config = {}, legacyRepoPathImpliesAccess = false } = {}) {
  if (!context || typeof context !== 'object') return null;
  const repoPath = normalizeRepoPath(context.repoPath);
  const hasStateAccess = Boolean(context.stateAccess);
  const hasRepoAccess = typeof context.repoAccess === 'boolean'
    ? context.repoAccess
    : Boolean(legacyRepoPathImpliesAccess && repoPath);
  const threadModelOverride = normalizeModelSelection(config, context.threadModelOverride);
  const threadEffortOverride = normalizedThreadEffort(context.threadEffortOverride);
  const pending = isPendingModelSelectionActive(context.pendingModelSelection)
    ? context.pendingModelSelection
    : null;
  const pendingEffort = isPendingModelSelectionActive(context.pendingEffortSelection)
    ? context.pendingEffortSelection
    : null;
  const verboseProgress = context.verboseProgress === true;
  const codexFastMode = context.codexFastMode === true;
  const richStyleId = richStyleBySelector(context.richStyleId)?.id || null;
  if (!repoPath && !hasRepoAccess && !hasStateAccess && !threadModelOverride && !threadEffortOverride && !pending && !pendingEffort && !verboseProgress && !codexFastMode && !richStyleId) {
    return null;
  }

  const normalized = {
    ...context,
    repoAccess: Boolean(hasRepoAccess || hasStateAccess),
    repoPath,
    stateAccess: hasStateAccess,
    verboseProgress,
    codexFastMode,
  };
  if (threadModelOverride) normalized.threadModelOverride = threadModelOverride;
  if (threadEffortOverride) normalized.threadEffortOverride = threadEffortOverride;
  if (pending) normalized.pendingModelSelection = pending;
  if (pendingEffort) normalized.pendingEffortSelection = pendingEffort;
  if (richStyleId) normalized.richStyleId = richStyleId;
  return normalized;
}

function applyThreadEffortOverride(selection, effort) {
  const normalizedEffort = normalizedThreadEffort(effort);
  if (!selection || !normalizedEffort) return selection;
  const apply = (entry = {}) => {
    const next = { ...entry };
    const worker = String(next.worker || '');
    if (!['codex', 'codex-spark', 'claude', 'antigravity'].includes(worker)) return next;
    const family = worker === 'antigravity' ? 'antigravity' : getModelFamily(worker, next.model);
    const supported = effortOptionsForModel(family, next.model);
    if (!supported.includes(normalizedEffort)) return next;
    next.reasoningEffort = normalizedEffort;
    next.effort = normalizedEffort;
    return next;
  };
  const selected = apply(selection);
  if (Array.isArray(selection.chain) && selection.chain.length > 0) {
    selected.chain = selection.chain.map(apply);
  }
  return selected;
}

function applyThreadEffortOverrides(selection, efforts) {
  if (!selection || !Array.isArray(efforts) || efforts.length === 0) return null;
  if (efforts.length === 1) return applyThreadEffortOverride(selection, efforts[0]);

  const entries = Array.isArray(selection.chain) && selection.chain.length > 0
    ? selection.chain
    : [selection];
  if (entries.length !== efforts.length) return null;

  const applied = entries.map((entry, index) => applyThreadEffortOverride(entry, efforts[index]));
  return applied.length > 1
    ? { ...applied[0], chain: applied }
    : applied[0];
}

function storedThreadEffortOverride(context = {}) {
  if (context && Object.hasOwn(context, 'threadEffortOverride')) {
    return normalizedThreadEffort(context.threadEffortOverride);
  }
  return normalizedThreadEffort(context?.threadEffortOverride)
    || normalizedThreadEffort(context?.threadModelOverride?.effort)
    || normalizedThreadEffort(context?.threadModelOverride?.reasoningEffort);
}

function normalizedThreadEfforts(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return null;
  const efforts = values.map(normalizedThreadEffort);
  return efforts.every(Boolean) ? efforts : null;
}

function normalizedThreadEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  // `ultra` is accepted here and filtered per model by applyThreadEffortOverride,
  // so a thread can pin it on Sol/Terra without changing Luna or Spark entries.
  return ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) ? effort : null;
}

function normalizeGlobalRepoAccess(context) {
  if (!context || typeof context !== 'object') return null;
  if (context.repoAccess === false) return null;
  const hasRepoAccess = context.repoAccess === true || context.repoAccessScope === 'global';
  if (!hasRepoAccess) return null;
  return {
    ...context,
    repoAccess: true,
    repoAccessScope: 'global',
    repoPath: normalizeRepoPath(context.repoPath),
    // Existing global `/yolo` state predates this field and represents the
    // same explicit grant, so migrate it to bridge-source access on read.
    bridgeRepoAccess: context.bridgeRepoAccess !== false,
    stateAccess: false,
  };
}

function normalizeRepoPath(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : null;
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function isThreadScopedRepoAccess(context = {}) {
  return context.repoAccessScope === 'thread' && context.repoAccess !== false;
}

function defaultRepositoriesRoot(config = {}) {
  return normalizeRepoPath(config.repositoriesRoot) || normalizeRepoPath(path.join(config.stateRoot, 'repositories'));
}

function defaultThreadRepoPath(config, job = {}) {
  if (job.maintenance) {
    return normalizeRepoPath(config?.bridgeRepoRoot) || normalizeRepoPath(config?.codex?.cwd);
  }
  if (job.channelId) {
    return normalizeRepoPath(path.join(channelStateDir(config, job.channelId), 'workspace'));
  }
  return normalizeRepoPath(path.join(config.stateRoot, '_workspace'));
}
