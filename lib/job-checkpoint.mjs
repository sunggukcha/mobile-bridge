import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './git-sync.mjs';
import { rootJobId } from './job-id.mjs';
import { maskSecrets } from './secret-mask.mjs';

const CHECKPOINT_SCHEMA_VERSION = 2;
const DEFAULT_WRITE_DEBOUNCE_MS = 75;
const DEFAULT_WORKSPACE_REFRESH_MS = 250;
const MAX_ACTIONS = 160;
const MAX_COMMANDS = 160;
const MAX_TEST_RESULTS = 80;
const MAX_SIDE_EFFECTS = 80;
const MAX_CHANGED_FILES = 500;
const MAX_OUTPUT_EXCERPT_CHARS = 1_200;

export async function createJobCheckpointRecorder({
  job = {},
  checkpointPath,
  workingDir,
  workspaceRoots = [],
  prompt = '',
  baselineSnapshot = null,
  now = () => new Date(),
  writeDebounceMs = DEFAULT_WRITE_DEBOUNCE_MS,
  workspaceRefreshMs = DEFAULT_WORKSPACE_REFRESH_MS,
} = {}) {
  if (!checkpointPath) throw new Error('checkpointPath is required');
  if (!workingDir) throw new Error('workingDir is required');

  const trackedRoots = uniqueWorkspaceRoots([workingDir, ...workspaceRoots]);
  const baseline = baselineSnapshot?.fingerprint
    ? structuredClone(baselineSnapshot)
    : await captureWorkspaceState({ roots: trackedRoots });
  const createdAt = now().toISOString();
  const checkpoint = createInitialJobCheckpoint({
    job,
    workingDir,
    prompt,
    baseline,
    createdAt,
  });
  const writer = createAtomicCheckpointWriter(checkpointPath, { writeDebounceMs });
  let refreshTimer = null;
  let refreshChain = Promise.resolve();
  let finished = false;

  const persist = async ({ immediate = false } = {}) => {
    if (immediate) return writer.flush(checkpoint);
    writer.schedule(checkpoint);
    return undefined;
  };

  const refreshWorkspace = async () => {
    const current = await captureWorkspaceState({ roots: trackedRoots });
    checkpoint.workspace.current = current;
    checkpoint.input_fingerprint = current.fingerprint;
    checkpoint.workspace.refresh_pending = false;
    checkpoint.changed_files = await changedFilesFromWorkspace({
      cwd: workingDir,
      baseline: checkpoint.workspace.baseline,
      current,
      eventChanges: checkpoint.observed_file_changes,
    });
    refreshEvidenceValidity(checkpoint);
    touchCheckpoint(checkpoint, now);
    await persist({ immediate: true });
  };

  const queueWorkspaceRefresh = () => {
    if (finished || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshChain = refreshChain
        .then(refreshWorkspace)
        .catch((error) => {
          checkpoint.workspace.last_error = compactText(error?.message || error, 500);
          touchCheckpoint(checkpoint, now);
          return persist({ immediate: true });
        });
    }, Math.max(0, Number(workspaceRefreshMs) || 0));
    refreshTimer.unref?.();
  };

  await persist({ immediate: true });

  return {
    path: checkpointPath,
    record(update = {}) {
      if (finished) return;
      const effect = applyJobCheckpointUpdate(checkpoint, update, { now });
      persist();
      if (effect.workspaceMayHaveChanged || effect.testCompleted) queueWorkspaceRefresh();
    },
    workerStarted(workerInfo = {}) {
      if (finished) return;
      checkpoint.worker = workerInfo.worker || checkpoint.worker;
      checkpoint.worker_label = workerInfo.workerLabel || checkpoint.worker_label;
      checkpoint.worker_model = workerInfo.workerModel || checkpoint.worker_model;
      checkpoint.worker_effort = workerInfo.workerEffort || checkpoint.worker_effort;
      checkpoint.worker_started_at = workerInfo.startedAt || now().toISOString();
      touchCheckpoint(checkpoint, now);
      persist();
    },
    async finish({
      status,
      output = '',
      error = '',
      worker = '',
      finalAnswerReady = Boolean(String(output || '').trim()),
      nextAction = undefined,
      finalAnswerPath = '',
    } = {}) {
      if (finished) return structuredClone(checkpoint);
      finished = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      await refreshChain;

      checkpoint.status = normalizeCheckpointStatus(status);
      checkpoint.worker = worker || checkpoint.worker;
      checkpoint.error = compactText(error, 2_000) || null;
      const persistedOutput = maskSecrets(String(output || ''));
      checkpoint.final_answer_ready = Boolean(finalAnswerReady && persistedOutput.trim());
      checkpoint.final_answer_sha256 = checkpoint.final_answer_ready
        ? sha256(persistedOutput)
        : null;
      checkpoint.final_answer_path = finalAnswerPath || null;
      checkpoint.finished_at = now().toISOString();

      const current = await captureWorkspaceState({ roots: trackedRoots });
      checkpoint.workspace.current = current;
      checkpoint.input_fingerprint = current.fingerprint;
      checkpoint.workspace.refresh_pending = false;
      checkpoint.changed_files = await changedFilesFromWorkspace({
        cwd: workingDir,
        baseline: checkpoint.workspace.baseline,
        current,
        eventChanges: checkpoint.observed_file_changes,
      });
      reconcileUnobservedWorkspaceChanges(checkpoint);
      refreshEvidenceValidity(checkpoint);
      recomputeDerivedCheckpointState(checkpoint);
      if (nextAction !== undefined) checkpoint.next_action = compactText(nextAction, 1_000) || null;
      if (checkpoint.final_answer_ready) checkpoint.next_action = null;
      touchCheckpoint(checkpoint, now);
      await persist({ immediate: true });
      return structuredClone(checkpoint);
    },
    async flush() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
        refreshChain = refreshChain.then(refreshWorkspace);
      }
      await refreshChain;
      await persist({ immediate: true });
      return structuredClone(checkpoint);
    },
    snapshot() {
      return structuredClone(checkpoint);
    },
  };
}

export function createInitialJobCheckpoint({
  job = {},
  workingDir = '',
  prompt = '',
  baseline = emptyWorkspaceSnapshot(workingDir),
  createdAt = new Date().toISOString(),
} = {}) {
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    job_id: job.id || null,
    root_job_id: rootJobId(job.id || '') || null,
    attempt: Number(job.attempt || 1),
    status: 'running',
    created_at: createdAt,
    updated_at: createdAt,
    finished_at: null,
    worker: null,
    worker_label: null,
    worker_model: null,
    worker_effort: null,
    worker_started_at: null,
    cwd: path.resolve(workingDir || '.'),
    prompt_sha256: sha256(String(prompt || '')),
    input_fingerprint: baseline.fingerprint,
    workspace: {
      baseline,
      current: baseline,
      revision: 0,
      last_mutation_sequence: 0,
      refresh_pending: false,
      unobserved_changes: false,
      last_error: null,
    },
    plan: [],
    plan_explanation: null,
    completed_actions: [],
    pending_actions: [],
    next_action: null,
    changed_files: [],
    observed_file_changes: [],
    commands: [],
    test_results: [],
    tool_actions: [],
    external_side_effects: [],
    final_answer_ready: false,
    final_answer_sha256: null,
    final_answer_path: null,
    error: null,
    last_progress: null,
    event_sequence: 0,
    omitted: {
      completed_actions: 0,
      commands: 0,
      test_results: 0,
      tool_actions: 0,
      external_side_effects: 0,
    },
  };
}

export function applyJobCheckpointUpdate(checkpoint, update = {}, { now = () => new Date() } = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    throw new TypeError('checkpoint must be an object');
  }

  checkpoint.event_sequence = Number(checkpoint.event_sequence || 0) + 1;
  const sequence = checkpoint.event_sequence;
  const timestamp = update.timestamp || now().toISOString();
  if (update.worker) checkpoint.worker = update.worker;
  const type = String(update.type || '');
  let workspaceMayHaveChanged = false;
  let testCompleted = false;

  if (type === 'plan') {
    const plan = normalizePlan(update.plan, checkpoint.plan);
    if (plan.length > 0) checkpoint.plan = plan;
    checkpoint.plan_explanation = compactText(update.explanation, 1_000) || checkpoint.plan_explanation;
  } else if (isCommandUpdate(update, checkpoint)) {
    const result = applyCommandUpdate(checkpoint, update, { sequence, timestamp });
    workspaceMayHaveChanged = result.workspaceMayHaveChanged;
    testCompleted = result.testCompleted;
  } else if (type === 'file_change') {
    workspaceMayHaveChanged = applyFileChangeUpdate(checkpoint, update, { sequence, timestamp });
  } else if (type === 'tool_call' || type === 'tool_output') {
    applyToolUpdate(checkpoint, update, { sequence, timestamp });
  } else if (type === 'response_text') {
    checkpoint.last_progress = compactText(update.text, 1_000) || checkpoint.last_progress;
  }

  if (workspaceMayHaveChanged) {
    checkpoint.workspace.revision = Number(checkpoint.workspace.revision || 0) + 1;
    checkpoint.workspace.last_mutation_sequence = sequence;
  }
  if (workspaceMayHaveChanged || testCompleted) checkpoint.workspace.refresh_pending = true;
  // Persist mutations and test completions with stale evidence invalidated.
  // If the process exits before the debounced workspace scan completes, the
  // continuation must not trust evidence for an unknown workspace state.
  refreshEvidenceValidity(checkpoint);
  recomputeDerivedCheckpointState(checkpoint);
  touchCheckpoint(checkpoint, now);
  return { workspaceMayHaveChanged, testCompleted };
}

export async function captureWorkspaceSnapshot({ cwd } = {}) {
  const resolvedCwd = path.resolve(cwd || '.');
  const topLevelResult = await runGit(resolvedCwd, ['rev-parse', '--show-toplevel'], {
    timeoutMs: 10_000,
    reject: false,
  }).catch((error) => ({ code: 127, stdout: '', stderr: error?.message || String(error) }));

  if (topLevelResult.code !== 0 || !String(topLevelResult.stdout || '').trim()) {
    return emptyWorkspaceSnapshot(resolvedCwd, {
      error: compactText(topLevelResult.stderr, 500) || 'not a git worktree',
    });
  }

  const gitRoot = path.resolve(String(topLevelResult.stdout).trim());
  const [headResult, statusResult] = await Promise.all([
    runGit(gitRoot, ['rev-parse', 'HEAD'], { timeoutMs: 10_000, reject: false }),
    runGit(gitRoot, ['status', '--porcelain=v1', '-z', '-uall'], { timeoutMs: 15_000, reject: false }),
  ]);
  const gitHead = headResult.code === 0 ? String(headResult.stdout || '').trim() || null : null;
  const statusEntries = statusResult.code === 0 ? parsePorcelainZ(statusResult.stdout) : [];
  const limitedEntries = statusEntries.slice(0, MAX_CHANGED_FILES);
  const files = [];
  for (const entry of limitedEntries) {
    const hashed = await hashWorkspacePath(gitRoot, entry.path);
    files.push({
      path: entry.path,
      status: entry.status,
      sha256: hashed.sha256,
      size: hashed.size,
      deleted: hashed.deleted,
    });
  }
  const fingerprint = workspaceFingerprint({
    cwd: resolvedCwd,
    git_root: gitRoot,
    git_head: gitHead,
    dirty_files: files,
    truncated: statusEntries.length > limitedEntries.length,
  });

  return {
    available: true,
    cwd: resolvedCwd,
    git_root: gitRoot,
    git_head: gitHead,
    dirty: statusEntries.length > 0,
    dirty_files: files,
    truncated: statusEntries.length > limitedEntries.length,
    fingerprint,
    captured_at: new Date().toISOString(),
    error: statusResult.code === 0 ? null : compactText(statusResult.stderr, 500),
  };
}

export async function captureWorkspaceState({ roots = [] } = {}) {
  const trackedRoots = uniqueWorkspaceRoots(roots);
  const snapshots = await Promise.all(
    trackedRoots.map((cwd) => captureWorkspaceSnapshot({ cwd })),
  );
  const availableSnapshots = snapshots.filter((snapshot) => snapshot.available);
  return {
    available: availableSnapshots.length > 0,
    fully_available: snapshots.length > 0 && availableSnapshots.length === snapshots.length,
    cwd: snapshots[0]?.cwd || path.resolve('.'),
    git_root: snapshots.length === 1 ? snapshots[0]?.git_root || null : null,
    git_head: snapshots.length === 1 ? snapshots[0]?.git_head || null : null,
    dirty: snapshots.some((snapshot) => snapshot.dirty),
    dirty_files: snapshots.length === 1 ? snapshots[0]?.dirty_files || [] : [],
    truncated: snapshots.some((snapshot) => snapshot.truncated),
    roots: snapshots,
    fingerprint: workspaceFingerprint({
      roots: snapshots.map((snapshot) => ({
        cwd: snapshot.cwd,
        available: snapshot.available,
        fingerprint: snapshot.fingerprint,
      })),
    }),
    captured_at: new Date().toISOString(),
    error: snapshots
      .filter((snapshot) => snapshot.error)
      .map((snapshot) => `${snapshot.cwd}: ${snapshot.error}`)
      .join('\n') || null,
  };
}

export function formatJobCheckpointMarkdown(checkpoint = {}, {
  checkpointPath = '',
  currentInputFingerprint = null,
} = {}) {
  if (!checkpoint || typeof checkpoint !== 'object' || !checkpoint.schema_version) return '';
  const checkpointFingerprint = checkpoint.input_fingerprint || null;
  const currentFingerprint = String(currentInputFingerprint || '').trim() || null;
  const fingerprintComparable = Boolean(
    checkpointFingerprint
      && currentFingerprint
      && checkpoint.workspace?.current?.available !== false,
  );
  const fingerprintMatches = fingerprintComparable
    ? checkpointFingerprint === currentFingerprint
    : null;
  const lines = [
    '## Structured Execution Checkpoint',
    '',
    `- schemaVersion: ${checkpoint.schema_version}`,
    `- checkpointStatus: ${checkpoint.status || '(unknown)'}`,
    `- finalAnswerReady: ${Boolean(checkpoint.final_answer_ready)}`,
    `- checkpointInputFingerprint: ${checkpointFingerprint || '(unavailable)'}`,
    `- currentInputFingerprint: ${currentFingerprint || '(unavailable)'}`,
    `- inputFingerprintMatches: ${fingerprintMatches === null ? 'unavailable' : fingerprintMatches}`,
    `- nextAction: ${checkpoint.next_action || '(none)'}`,
  ];
  if (checkpointPath) lines.push(`- checkpointPath: ${checkpointPath}`);
  if (checkpoint.final_answer_path) lines.push(`- finalAnswerPath: ${checkpoint.final_answer_path}`);
  if (checkpoint.final_answer_sha256) lines.push(`- finalAnswerSha256: ${checkpoint.final_answer_sha256}`);

  const plan = Array.isArray(checkpoint.plan) ? checkpoint.plan : [];
  if (plan.length > 0) {
    lines.push('', '### Plan');
    for (const item of plan.slice(0, 64)) {
      const marker = item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' ';
      lines.push(`- [${marker}] ${singleLine(item.step, 300)}`);
    }
  }

  appendActionSection(lines, 'Completed Actions', checkpoint.completed_actions, 30);
  appendActionSection(lines, 'Pending Actions', checkpoint.pending_actions, 30);

  const commands = Array.isArray(checkpoint.commands) ? checkpoint.commands : [];
  if (commands.length > 0) {
    lines.push('', '### Commands');
    for (const command of commands.slice(-20)) {
      lines.push(
        `- ${command.status || 'unknown'} exit=${command.exit_code ?? '?'}`
        + ` cwd=${singleLine(command.cwd || checkpoint.cwd || '(unknown)', 220)}`
        + ` fingerprint=${command.evidence_fingerprint || 'stale/unknown'}`
        + `: ${singleLine(command.command, 300)}`,
      );
    }
  }

  const changedFiles = Array.isArray(checkpoint.changed_files) ? checkpoint.changed_files : [];
  if (changedFiles.length > 0) {
    lines.push('', '### Changed Files');
    for (const file of changedFiles.slice(0, 40)) {
      const rootPrefix = file.workspace_root
        ? `${singleLine(file.workspace_root, 180)}:`
        : '';
      lines.push(`- ${rootPrefix}${singleLine(file.path, 240)}: ${file.deleted ? 'deleted' : `sha256=${file.sha256 || '(unavailable)'}`}`);
    }
  }

  const tests = Array.isArray(checkpoint.test_results) ? checkpoint.test_results : [];
  if (tests.length > 0) {
    lines.push('', '### Test Results');
    for (const test of tests.slice(-20)) {
      lines.push(
        `- ${test.status || 'unknown'}: ${singleLine(test.command, 260)}`
        + ` (cwd=${singleLine(test.cwd || checkpoint.cwd || '(unknown)', 180)},`
        + ` exit=${test.exit_code ?? '?'}, fingerprint=${test.input_fingerprint || 'stale/unknown'})`,
      );
    }
  }

  const effects = Array.isArray(checkpoint.external_side_effects) ? checkpoint.external_side_effects : [];
  if (effects.length > 0) {
    lines.push('', '### External Side Effects');
    for (const effect of effects.slice(-20)) {
      lines.push(
        `- ${effect.status || 'unknown'} ${effect.effect_type || effect.kind || 'effect'}`
        + ` evidence=${effect.evidence_ref || '(none)'}`
        + ` retry=${effect.retry_policy || 'reconcile_before_retry'}`
        + `: ${singleLine(effect.summary, 300)}`,
      );
    }
  }

  lines.push(
    '',
    '### Resume Rules',
    checkpoint.final_answer_ready && fingerprintMatches !== false
      ? '- The final answer is already prepared. Return the saved final output without rerunning commands, tests, repository discovery, or external actions.'
      : checkpoint.final_answer_ready && fingerprintMatches === false
        ? '- A saved final answer exists, but the workspace fingerprint changed. Re-validate only evidence affected by that change before returning it.'
      : fingerprintMatches === false
        ? '- The workspace fingerprint changed after this checkpoint. Start at nextAction and re-validate only evidence affected by that change.'
        : '- Start from nextAction. Do not repeat completed actions whose evidence fingerprint still matches.',
    '- Never retry an in-progress or unknown external side effect until its remote outcome has been reconciled.',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function applyCommandUpdate(checkpoint, update, { sequence, timestamp }) {
  const phase = commandPhase(update);
  const command = compactText(update.command || commandFromText(update.text), 2_000);
  let commandEntry = findCommandEntry(checkpoint.commands, update.actionId, command, phase);
  if (!commandEntry) {
    commandEntry = {
      id: update.actionId || `command-${sequence}`,
      command: command || '(unknown command)',
      cwd: compactText(update.cwd, 1_000) || checkpoint.cwd,
      status: 'in_progress',
      started_at: timestamp,
      completed_at: null,
      exit_code: null,
      duration_ms: null,
      output_excerpt: null,
      sequence_started: sequence,
      sequence_completed: null,
      input_fingerprint: checkpoint.input_fingerprint || null,
      evidence_fingerprint: null,
      valid_for_current_workspace: false,
      mutates_workspace: commandMayMutateWorkspace(command),
      external_effect: externalCommandEffect(command),
    };
    pushLimited(checkpoint.commands, commandEntry, MAX_COMMANDS, checkpoint.omitted, 'commands');
  }

  if (command) commandEntry.command = command;
  if (update.cwd) commandEntry.cwd = compactText(update.cwd, 1_000);
  if (phase !== 'in_progress') {
    commandEntry.status = phase === 'failed' ? 'failed' : 'completed';
    commandEntry.completed_at = timestamp;
    commandEntry.exit_code = numericOrNull(update.exitCode);
    if (commandEntry.exit_code === null && phase === 'completed') commandEntry.exit_code = 0;
    commandEntry.duration_ms = numericOrNull(update.durationMs);
    commandEntry.output_excerpt = compactText(update.output || outputFromText(update.text), MAX_OUTPUT_EXCERPT_CHARS) || null;
    commandEntry.sequence_completed = sequence;
  }

  updateExternalEffectForCommand(checkpoint, commandEntry, { sequence, timestamp });
  const testCompleted = phase !== 'in_progress' && isTestCommand(commandEntry.command);
  if (testCompleted) upsertTestResult(checkpoint, commandEntry);
  return {
    workspaceMayHaveChanged: phase !== 'in_progress' && Boolean(commandEntry.mutates_workspace),
    testCompleted,
  };
}

function applyFileChangeUpdate(checkpoint, update, { sequence, timestamp }) {
  const phase = normalizeActionPhase(update.status || (update.type === 'file_change' ? 'completed' : 'updated'));
  const changes = normalizeFileChanges(update.changes);
  for (const change of changes) {
    const current = checkpoint.observed_file_changes.find((item) => item.path === change.path);
    const value = {
      ...current,
      ...change,
      status: phase,
      observed_at: timestamp,
      sequence,
    };
    if (current) Object.assign(current, value);
    else checkpoint.observed_file_changes.push(value);
  }
  checkpoint.observed_file_changes = checkpoint.observed_file_changes.slice(-MAX_CHANGED_FILES);
  return changes.length > 0 && phase !== 'in_progress';
}

function applyToolUpdate(checkpoint, update, { sequence, timestamp }) {
  const isOutput = update.type === 'tool_output';
  const tool = compactText(update.tool || update.name || toolFromText(update.text), 300) || 'tool';
  const actionId = update.actionId || null;
  let entry = actionId
    ? checkpoint.tool_actions.find((item) => item.id === actionId)
    : [...checkpoint.tool_actions].reverse().find((item) => item.status === 'in_progress' && item.tool === tool);
  if (!entry) {
    entry = {
      id: actionId || `tool-${sequence}`,
      tool,
      server: compactText(update.server, 300) || null,
      summary: compactText(update.text, 1_000) || tool,
      status: 'in_progress',
      started_at: timestamp,
      completed_at: null,
      sequence_started: sequence,
      sequence_completed: null,
      external_effect: toolMayHaveExternalEffect(tool),
    };
    pushLimited(checkpoint.tool_actions, entry, MAX_ACTIONS, checkpoint.omitted, 'tool_actions');
  }
  const normalizedStatus = normalizeActionPhase(update.status);
  if (isOutput || (normalizedStatus !== 'in_progress' && normalizedStatus !== 'updated')) {
    entry.status = normalizedStatus === 'failed' ? 'failed' : 'completed';
    entry.completed_at = timestamp;
    entry.sequence_completed = sequence;
    entry.summary = compactText(update.text, 1_000) || entry.summary;
  }
  updateExternalEffectForTool(checkpoint, entry, { timestamp });
}

function recomputeDerivedCheckpointState(checkpoint) {
  const completed = [];
  const pending = [];

  for (const item of checkpoint.plan || []) {
    const action = { kind: 'plan_step', status: item.status, summary: item.step };
    if (item.status === 'completed') completed.push(action);
    else pending.push(action);
  }
  for (const command of checkpoint.commands || []) {
    const action = {
      kind: 'command',
      status: command.status,
      summary: command.command,
      evidence_ref: command.id,
    };
    if (command.status === 'in_progress') pending.push(action);
    else completed.push(action);
  }
  for (const change of checkpoint.observed_file_changes || []) {
    const action = {
      kind: 'file_change',
      status: change.status,
      summary: `${change.kind || 'modified'} ${change.path}`,
    };
    if (change.status === 'in_progress') pending.push(action);
    else completed.push(action);
  }
  for (const tool of checkpoint.tool_actions || []) {
    const action = {
      kind: 'tool',
      status: tool.status,
      summary: tool.summary || tool.tool,
      evidence_ref: tool.id,
    };
    if (tool.status === 'in_progress') pending.push(action);
    else completed.push(action);
  }

  checkpoint.completed_actions = tailWithOmitted(
    completed,
    MAX_ACTIONS,
    checkpoint.omitted,
    'completed_actions',
  );
  checkpoint.pending_actions = pending.slice(0, MAX_ACTIONS);
  checkpoint.next_action = deriveNextAction(checkpoint);
}

function deriveNextAction(checkpoint) {
  if (checkpoint.final_answer_ready) return null;
  const uncertainEffect = (checkpoint.external_side_effects || []).find((effect) =>
    effect.status === 'in_progress' || effect.status === 'unknown',
  );
  if (uncertainEffect) {
    return `Reconcile the remote outcome before any retry: ${uncertainEffect.summary}`;
  }
  const active = (checkpoint.pending_actions || []).find((action) => action.status === 'in_progress');
  if (active) return active.summary;
  const pendingPlan = (checkpoint.plan || []).find((item) => item.status !== 'completed');
  if (pendingPlan) return pendingPlan.step;
  if (checkpoint.last_progress) return checkpoint.last_progress;
  if (checkpoint.status === 'running' || checkpoint.status === 'interrupted') {
    return 'Continue from the latest durable checkpoint without repeating completed actions.';
  }
  return null;
}

function refreshEvidenceValidity(checkpoint) {
  const fingerprint = checkpoint.input_fingerprint || null;
  const lastMutationSequence = Number(checkpoint.workspace?.last_mutation_sequence || 0);
  const workspaceRefreshPending = Boolean(checkpoint.workspace?.refresh_pending);
  for (const command of checkpoint.commands || []) {
    const valid = command.status === 'completed'
      && Number(command.sequence_completed || 0) >= lastMutationSequence
      && !workspaceRefreshPending
      && !checkpoint.workspace?.unobserved_changes;
    command.valid_for_current_workspace = valid;
    command.evidence_fingerprint = valid ? fingerprint : null;
  }
  for (const test of checkpoint.test_results || []) {
    const valid = test.status === 'passed'
      && Number(test.sequence_completed || 0) >= lastMutationSequence
      && !workspaceRefreshPending
      && !checkpoint.workspace?.unobserved_changes;
    test.valid_for_current_workspace = valid;
    test.input_fingerprint = valid ? fingerprint : null;
  }
}

function reconcileUnobservedWorkspaceChanges(checkpoint) {
  const baseline = checkpoint.workspace?.baseline;
  const current = checkpoint.workspace?.current;
  if (!baseline?.fingerprint || !current?.fingerprint || baseline.fingerprint === current.fingerprint) return;
  if (Number(checkpoint.workspace.last_mutation_sequence || 0) > 0) return;
  checkpoint.workspace.unobserved_changes = true;
  checkpoint.workspace.revision = Math.max(1, Number(checkpoint.workspace.revision || 0));
  checkpoint.workspace.last_mutation_sequence = Number(checkpoint.event_sequence || 0) + 1;
}

async function changedFilesFromWorkspace({ cwd, baseline, current, eventChanges = [] }) {
  if (Array.isArray(baseline?.roots) || Array.isArray(current?.roots)) {
    const baselineByRoot = new Map(
      (baseline?.roots || []).map((snapshot) => [path.resolve(snapshot.cwd), snapshot]),
    );
    const changed = [];
    for (const currentSnapshot of current?.roots || []) {
      const workspaceRoot = path.resolve(currentSnapshot.cwd);
      const baselineSnapshot = baselineByRoot.get(workspaceRoot);
      if (!baselineSnapshot) continue;
      const workspaceChanges = await changedFilesFromSingleWorkspace({
        cwd: workspaceRoot,
        baseline: baselineSnapshot,
        current: currentSnapshot,
        eventChanges,
      });
      changed.push(...workspaceChanges.map((change) => ({
        ...change,
        workspace_root: workspaceRoot,
      })));
    }
    return changed
      .slice(0, MAX_CHANGED_FILES)
      .sort((left, right) =>
        left.workspace_root.localeCompare(right.workspace_root)
          || left.path.localeCompare(right.path),
      );
  }
  return changedFilesFromSingleWorkspace({ cwd, baseline, current, eventChanges });
}

async function changedFilesFromSingleWorkspace({ cwd, baseline, current, eventChanges = [] }) {
  if (!baseline?.available || !current?.available) return [];
  const baselineFiles = new Map((baseline.dirty_files || []).map((file) => [file.path, file]));
  const currentFiles = new Map((current.dirty_files || []).map((file) => [file.path, file]));
  const candidates = new Map();

  for (const filePath of new Set([...baselineFiles.keys(), ...currentFiles.keys()])) {
    const before = baselineFiles.get(filePath);
    const after = currentFiles.get(filePath);
    if (sameWorkspaceFile(before, after)) continue;
    candidates.set(filePath, {
      path: filePath,
      kind: workspaceFileChangeKind(before, after),
      source: 'worktree',
      baseline_sha256: before?.sha256 || null,
      preexisting_dirty: Boolean(before),
    });
  }

  if (baseline.git_head && current.git_head && baseline.git_head !== current.git_head) {
    const committed = await committedChangedPaths(current.git_root || cwd, baseline.git_head, current.git_head);
    for (const change of committed) {
      const existing = candidates.get(change.path) || {};
      candidates.set(change.path, {
        ...existing,
        ...change,
        source: existing.source ? `${existing.source}+git-head` : 'git-head',
        baseline_sha256: existing.baseline_sha256 || baselineFiles.get(change.path)?.sha256 || null,
        preexisting_dirty: existing.preexisting_dirty || baselineFiles.has(change.path),
      });
    }
  }

  for (const observed of normalizeFileChanges(eventChanges)) {
    const filePath = normalizeWorkspacePath(observed.path, current.git_root || cwd);
    if (!filePath) continue;
    const before = baselineFiles.get(filePath);
    const after = currentFiles.get(filePath);
    if (sameWorkspaceFile(before, after) && baseline.git_head === current.git_head) continue;
    const existing = candidates.get(filePath) || {};
    candidates.set(filePath, {
      path: filePath,
      kind: observed.kind || existing.kind || (after?.deleted ? 'deleted' : before ? 'modified' : 'added'),
      source: existing.source ? `${existing.source}+worker-event` : 'worker-event',
      baseline_sha256: existing.baseline_sha256 || before?.sha256 || null,
      preexisting_dirty: existing.preexisting_dirty || Boolean(before),
    });
  }

  const changed = [];
  for (const candidate of [...candidates.values()].slice(0, MAX_CHANGED_FILES)) {
    const currentFile = currentFiles.get(candidate.path);
    const hashed = currentFile || await hashWorkspacePath(current.git_root || cwd, candidate.path);
    changed.push({
      ...candidate,
      sha256: hashed?.sha256 || null,
      size: hashed?.size ?? null,
      deleted: Boolean(hashed?.deleted),
    });
  }
  return changed.sort((left, right) => left.path.localeCompare(right.path));
}

async function committedChangedPaths(cwd, beforeHead, afterHead) {
  const result = await runGit(cwd, ['diff', '--name-status', '-z', `${beforeHead}..${afterHead}`], {
    timeoutMs: 15_000,
    reject: false,
  });
  if (result.code !== 0) return [];
  const fields = String(result.stdout || '').split('\0');
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      index += 1;
      const nextPath = normalizeWorkspacePath(fields[index++], cwd);
      if (nextPath) changes.push({ path: nextPath, kind: code === 'R' ? 'renamed' : 'copied' });
      continue;
    }
    const filePath = normalizeWorkspacePath(fields[index++], cwd);
    if (filePath) changes.push({ path: filePath, kind: gitChangeKind(code) });
  }
  return changes;
}

function createAtomicCheckpointWriter(checkpointPath, { writeDebounceMs }) {
  let timer = null;
  let latest = null;
  let chain = Promise.resolve();
  let generation = 0;
  let newestGeneration = 0;
  const debounceMs = Math.max(0, Number(writeDebounceMs) || 0);
  const initialRetryMs = Math.max(250, debounceMs);
  let retryMs = initialRetryMs;

  const retain = (checkpoint) => {
    const pending = {
      generation: ++generation,
      value: structuredClone(checkpoint),
    };
    newestGeneration = pending.generation;
    latest = pending;
    return pending;
  };

  const scheduleTimer = (delayMs) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const pending = latest;
      if (pending) queue(pending, { retryOnFailure: true }).catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
    timer.unref?.();
  };

  const queue = (pending, { retryOnFailure = false } = {}) => {
    if (latest?.generation === pending.generation) latest = null;
    // A transient write failure must reject the caller that requested this
    // flush, but it must not poison the internal queue tail forever. Recover
    // the tail before every new operation and retain a resolved tail after it.
    const write = chain
      .catch(() => undefined)
      .then(() => writeCheckpointAtomic(checkpointPath, pending.value));
    const operation = write.then(
      (result) => {
        retryMs = initialRetryMs;
        return result;
      },
      (error) => {
        if (retryOnFailure && pending.generation === newestGeneration) {
          latest = pending;
          scheduleTimer(retryMs);
          retryMs = Math.min(5_000, retryMs * 2);
        }
        throw error;
      },
    );
    chain = operation.catch(() => undefined);
    return operation;
  };

  return {
    schedule(checkpoint) {
      retain(checkpoint);
      scheduleTimer(debounceMs);
    },
    async flush(checkpoint) {
      if (timer) clearTimeout(timer);
      timer = null;
      const pending = retain(checkpoint);
      await queue(pending, { retryOnFailure: true });
      await chain;
    },
  };
}

async function writeCheckpointAtomic(checkpointPath, checkpoint) {
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  const tempPath = `${checkpointPath}.${process.pid}.${Date.now()}.tmp`;
  const content = maskSecrets(`${JSON.stringify(checkpoint, null, 2)}\n`);
  try {
    await fs.writeFile(tempPath, content, { mode: 0o600 });
    await fs.rename(tempPath, checkpointPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function updateExternalEffectForCommand(checkpoint, command, { timestamp }) {
  if (!command.external_effect) return;
  let effect = checkpoint.external_side_effects.find((item) => item.evidence_ref === command.id);
  if (!effect) {
    effect = {
      kind: 'command',
      effect_type: command.external_effect,
      summary: command.command,
      status: 'in_progress',
      evidence_ref: command.id,
      started_at: command.started_at || timestamp,
      completed_at: null,
      retry_policy: 'reconcile_before_retry',
    };
    pushLimited(
      checkpoint.external_side_effects,
      effect,
      MAX_SIDE_EFFECTS,
      checkpoint.omitted,
      'external_side_effects',
    );
  }
  effect.reported_status = command.status;
  effect.status = command.status === 'completed'
    ? 'succeeded'
    : command.status === 'failed'
      ? 'unknown'
      : 'in_progress';
  effect.completed_at = command.completed_at;
}

function updateExternalEffectForTool(checkpoint, tool, { timestamp }) {
  if (!tool.external_effect) return;
  let effect = checkpoint.external_side_effects.find((item) => item.evidence_ref === tool.id);
  if (!effect) {
    effect = {
      kind: 'tool',
      effect_type: `${tool.server ? `${tool.server}/` : ''}${tool.tool}`,
      summary: `${tool.server ? `${tool.server}/` : ''}${tool.tool}`,
      status: 'in_progress',
      evidence_ref: tool.id,
      started_at: tool.started_at || timestamp,
      completed_at: null,
      retry_policy: 'reconcile_before_retry',
    };
    pushLimited(
      checkpoint.external_side_effects,
      effect,
      MAX_SIDE_EFFECTS,
      checkpoint.omitted,
      'external_side_effects',
    );
  }
  effect.reported_status = tool.status;
  effect.status = tool.status === 'completed'
    ? 'succeeded'
    : tool.status === 'failed'
      ? 'unknown'
      : 'in_progress';
  effect.completed_at = tool.completed_at;
}

function upsertTestResult(checkpoint, command) {
  let result = checkpoint.test_results.find((item) => item.evidence_ref === command.id);
  if (!result) {
    result = {
      command: command.command,
      cwd: command.cwd,
      status: 'unknown',
      exit_code: command.exit_code,
      completed_at: command.completed_at,
      duration_ms: command.duration_ms,
      output_excerpt: command.output_excerpt,
      evidence_ref: command.id,
      sequence_completed: command.sequence_completed,
      input_fingerprint: null,
      valid_for_current_workspace: false,
    };
    pushLimited(checkpoint.test_results, result, MAX_TEST_RESULTS, checkpoint.omitted, 'test_results');
  }
  result.status = command.status === 'completed' && command.exit_code === 0 ? 'passed' : 'failed';
  result.exit_code = command.exit_code;
  result.completed_at = command.completed_at;
  result.duration_ms = command.duration_ms;
  result.output_excerpt = command.output_excerpt;
  result.sequence_completed = command.sequence_completed;
}

function normalizePlan(plan, previousPlan = []) {
  if (!Array.isArray(plan)) return [];
  const normalized = plan
    .map((item) => {
      if (typeof item === 'string') return { step: compactText(item, 500), status: 'pending' };
      const step = compactText(item?.step || item?.text || item?.title, 500);
      if (!step) return null;
      return { step, status: normalizePlanStatus(item?.status, item?.completed) };
    })
    .filter(Boolean)
    .slice(0, 64);
  if (normalized.some((item) => item.status === 'in_progress')) return normalized;

  const previousActiveStep = (Array.isArray(previousPlan) ? previousPlan : [])
    .find((item) => item?.status === 'in_progress')?.step;
  const inferredActive = normalized.find((item) =>
    item.status === 'pending' && previousActiveStep && item.step === previousActiveStep,
  ) || normalized.find((item) => item.status === 'pending');
  if (inferredActive) inferredActive.status = 'in_progress';
  return normalized;
}

function normalizePlanStatus(status, completed = false) {
  if (completed === true) return 'completed';
  const text = String(status || '').toLowerCase().replace(/[-\s]/g, '_');
  if (['completed', 'complete', 'done', 'succeeded', 'success'].includes(text)) return 'completed';
  if (['in_progress', 'inprogress', 'active', 'started', 'running'].includes(text)) return 'in_progress';
  return 'pending';
}

function normalizeFileChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => {
      if (typeof change === 'string') {
        const filePath = normalizeObservedFilePath(change);
        return filePath ? { path: filePath, kind: 'modified' } : null;
      }
      const filePath = normalizeObservedFilePath(change?.path || change?.file || change?.filePath);
      if (!filePath) return null;
      return {
        path: filePath,
        kind: compactText(change?.kind || change?.type || change?.status, 80) || 'modified',
      };
    })
    .filter(Boolean);
}

function normalizeObservedFilePath(value) {
  const text = String(value || '').replace(/\\/g, '/').trim();
  if (!text || text.includes('\0')) return null;
  if (path.isAbsolute(text)) {
    return path.resolve(text).split(path.sep).join('/');
  }
  return normalizeWorkspacePath(text);
}

function parsePorcelainZ(value) {
  const fields = String(value || '').split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const filePath = normalizeWorkspacePath(field.slice(3));
    if (filePath) entries.push({ status, path: filePath });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return entries;
}

async function hashWorkspacePath(root, relativePath) {
  const normalized = normalizeWorkspacePath(relativePath, root);
  if (!normalized) return { sha256: null, size: null, deleted: true };
  const target = path.resolve(root, normalized);
  if (!isUnderRoot(root, target)) return { sha256: null, size: null, deleted: true };
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(target);
      return { sha256: sha256(`symlink:${link}`), size: Buffer.byteLength(link), deleted: false };
    }
    if (!stat.isFile()) {
      return { sha256: sha256(`non-file:${stat.mode}:${stat.size}`), size: stat.size, deleted: false };
    }
    const data = await fs.readFile(target);
    return { sha256: createHash('sha256').update(data).digest('hex'), size: stat.size, deleted: false };
  } catch (error) {
    if (error.code === 'ENOENT') return { sha256: null, size: null, deleted: true };
    return { sha256: null, size: null, deleted: false };
  }
}

function emptyWorkspaceSnapshot(cwd, { error = null } = {}) {
  const resolvedCwd = path.resolve(cwd || '.');
  return {
    available: false,
    cwd: resolvedCwd,
    git_root: null,
    git_head: null,
    dirty: false,
    dirty_files: [],
    truncated: false,
    fingerprint: sha256(JSON.stringify({ cwd: resolvedCwd, git: false })),
    captured_at: new Date().toISOString(),
    error,
  };
}

function uniqueWorkspaceRoots(roots = []) {
  return [...new Set(
    roots
      .filter(Boolean)
      .map((root) => path.resolve(String(root))),
  )];
}

function workspaceFingerprint(value) {
  return sha256(JSON.stringify(value));
}

function isCommandUpdate(update, checkpoint = {}) {
  if (update.kind === 'command') return true;
  if (update.actionId && (checkpoint.commands || []).some((command) => command.id === update.actionId)) return true;
  const text = String(update.text || '');
  return (update.type === 'tool_call' && /^(?:running|command \w+):?\s+command\b|^running command:/i.test(text))
    || (update.type === 'tool_output' && /^command (?:completed|failed|output):/i.test(text));
}

function commandPhase(update) {
  const explicit = normalizeActionPhase(update.status);
  if (explicit !== 'updated') return explicit;
  if (update.type === 'tool_call') return 'in_progress';
  if (/^command failed:/i.test(String(update.text || ''))) return 'failed';
  return 'completed';
}

function normalizeActionPhase(status) {
  const text = String(status || '').toLowerCase().replace(/[-\s]/g, '_');
  if (['in_progress', 'running', 'started', 'pending'].includes(text)) return 'in_progress';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'timed_out'].includes(text)) return 'failed';
  if (['completed', 'complete', 'done', 'success', 'succeeded', 'finished'].includes(text)) return 'completed';
  return 'updated';
}

function normalizeCheckpointStatus(status) {
  const text = String(status || '').trim();
  if (['interrupted', 'superseded'].includes(text)) return 'interrupted';
  if (['failed', 'input-limit-failed'].includes(text)) return 'failed';
  if (text === 'waiting_for_user') return 'waiting_for_user';
  if (text === 'service_restart_requested') return 'succeeded';
  return text || 'succeeded';
}

function findCommandEntry(commands, actionId, command, phase) {
  if (actionId) {
    const exact = commands.find((entry) => entry.id === actionId);
    if (exact) return exact;
  }
  if (phase === 'in_progress') return null;
  const pending = [...commands].reverse().find((entry) =>
    entry.status === 'in_progress' && (!command || entry.command === command),
  );
  return pending || null;
}

function commandFromText(text) {
  return String(text || '')
    .replace(/^running command:\s*/i, '')
    .replace(/^command (?:completed|failed):\s*/i, '')
    .split('\n')[0]
    .trim();
}

function outputFromText(text) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.slice(1).join('\n').trim();
}

function toolFromText(text) {
  const match = String(text || '').match(/^(?:using tool|tool output):\s*([^\s:]+)/i);
  return match?.[1] || '';
}

function commandMayMutateWorkspace(command) {
  const text = String(command || '');
  if (!text) return false;
  return [
    /\bapply_patch\b/i,
    /\b(?:sed|perl)\b[^\n]*(?:\s-i\b|--in-place)/i,
    /\b(?:rm|mv|cp|install|mkdir|rmdir|touch|truncate)\b/i,
    /\b(?:git)\s+(?:apply|checkout|switch|reset|merge|rebase|pull|commit|cherry-pick|revert|clean|stash)\b/i,
    /\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update)\b/i,
    /(?:^|[\s;&|])(?:>|>>)\s*\S+/,
    /\btee\b/i,
  ].some((pattern) => pattern.test(text));
}

function externalCommandEffect(command) {
  const text = String(command || '');
  if (!text) return null;
  const patterns = [
    ['git-push', /\bgit\s+push\b/i],
    ['github-mutation', /\bgh\s+(?:pr|issue|release|repo|workflow|run|api)\b[^\n]*(?:create|merge|close|comment|edit|delete|dispatch|rerun|cancel|-X\s+(?:POST|PUT|PATCH|DELETE)|--method\s+(?:POST|PUT|PATCH|DELETE))/i],
    ['http-mutation', /\b(?:curl|http)\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i],
    ['http-data', /\bcurl\b[^\n]*(?:--data|-d)\s/i],
    ['publish', /\b(?:npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b/i],
    ['deployment', /\b(?:kubectl\s+(?:apply|delete|rollout|patch)|terraform\s+(?:apply|destroy)|vercel\s+(?:deploy|--prod)|fly\s+deploy|railway\s+up)\b/i],
    ['cloud-mutation', /\b(?:aws|gcloud|az)\b[^\n]*(?:create|update|delete|deploy|put|start|stop|run|invoke)\b/i],
  ];
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function toolMayHaveExternalEffect(tool) {
  const leaf = String(tool || '').split(/[/.]/).at(-1)?.toLowerCase() || '';
  if ([
    'apply_patch',
    'update_plan',
    'request_user_input',
    'read_mcp_resource',
    'list_mcp_resources',
    'list_mcp_resource_templates',
    'view_image',
  ].includes(leaf)) return false;
  return /(?:create|update|edit|delete|remove|send|post|push|merge|close|deploy|publish|write|execute|command)/i
    .test(String(tool || ''));
}

function isTestCommand(command) {
  const text = String(command || '').trim();
  return [
    /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/i,
    /(?:^|[;&|]\s*|\s)(?:node\s+--test|pytest|python(?:3)?\s+-m\s+pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|gradlew(?:\.bat)?\s+test)(?:\s|$)/i,
  ].some((pattern) => pattern.test(text));
}

function normalizeWorkspacePath(value, root = '') {
  const text = String(value || '').replace(/\\/g, '/').trim();
  if (!text || text.includes('\0')) return null;
  let normalized = text;
  if (path.isAbsolute(text) && root) {
    normalized = path.relative(path.resolve(root), path.resolve(text)).split(path.sep).join('/');
  }
  normalized = normalized.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.split('/').some((part) => part === '..')) return null;
  return normalized;
}

function isUnderRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameWorkspaceFile(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.status === right.status
    && left.sha256 === right.sha256
    && Boolean(left.deleted) === Boolean(right.deleted);
}

function workspaceFileChangeKind(before, after) {
  if (after?.deleted || String(after?.status || '').includes('D')) return 'deleted';
  const status = String(after?.status || '');
  if (status.includes('R')) return 'renamed';
  if (status.includes('C')) return 'copied';
  if (!before && (status.includes('A') || status === '??')) return 'added';
  return 'modified';
}

function gitChangeKind(code) {
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  return 'modified';
}

function appendActionSection(lines, title, actions, maxItems) {
  const values = Array.isArray(actions) ? actions : [];
  if (values.length === 0) return;
  lines.push('', `### ${title}`);
  for (const action of values.slice(-maxItems)) {
    lines.push(`- ${action.status || 'unknown'} ${action.kind || 'action'}: ${singleLine(action.summary, 300)}`);
  }
}

function pushLimited(array, value, maxItems, omitted, omittedKey) {
  array.push(value);
  if (array.length <= maxItems) return;
  const removeCount = array.length - maxItems;
  array.splice(0, removeCount);
  omitted[omittedKey] = Number(omitted[omittedKey] || 0) + removeCount;
}

function tailWithOmitted(values, maxItems, omitted, omittedKey) {
  if (values.length <= maxItems) return values;
  omitted[omittedKey] = Math.max(Number(omitted[omittedKey] || 0), values.length - maxItems);
  return values.slice(-maxItems);
}

function touchCheckpoint(checkpoint, now) {
  checkpoint.updated_at = now().toISOString();
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactText(value, maxChars = 1_000) {
  const text = maskSecrets(String(value || ''))
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function singleLine(value, maxChars) {
  return compactText(value, maxChars).replace(/\s+/g, ' ');
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}
