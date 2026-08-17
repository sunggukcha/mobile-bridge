import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  applyJobCheckpointUpdate,
  captureWorkspaceState,
  createInitialJobCheckpoint,
  createJobCheckpointRecorder,
  formatJobCheckpointMarkdown,
} from '../lib/job-checkpoint.mjs';

const execFileAsync = promisify(execFile);

test('job checkpoint infers the active plan step and guards ambiguous external effects', () => {
  const checkpoint = createInitialJobCheckpoint({
    job: { id: 'job-a' },
    workingDir: '/tmp/project',
    baseline: workspaceSnapshot('fingerprint-a'),
    createdAt: '2026-07-28T00:00:00.000Z',
  });

  applyJobCheckpointUpdate(checkpoint, {
    type: 'plan',
    plan: [
      { step: 'inspect repository', status: 'completed' },
      { step: 'push branch', status: 'pending' },
      { step: 'report result', status: 'pending' },
    ],
  });
  assert.deepEqual(checkpoint.plan.map((item) => item.status), [
    'completed',
    'in_progress',
    'pending',
  ]);

  applyJobCheckpointUpdate(checkpoint, {
    type: 'tool_call',
    kind: 'command',
    actionId: 'push-1',
    command: 'git push origin feature/checkpoint',
    cwd: '/tmp/project',
    status: 'in_progress',
  });
  applyJobCheckpointUpdate(checkpoint, {
    type: 'tool_output',
    kind: 'command',
    actionId: 'push-1',
    command: 'git push origin feature/checkpoint',
    cwd: '/tmp/project',
    status: 'failed',
    exitCode: 1,
    output: 'connection reset after sending objects',
  });

  assert.equal(checkpoint.external_side_effects.length, 1);
  assert.equal(checkpoint.external_side_effects[0].effect_type, 'git-push');
  assert.equal(checkpoint.external_side_effects[0].reported_status, 'failed');
  assert.equal(checkpoint.external_side_effects[0].status, 'unknown');
  assert.match(checkpoint.next_action, /Reconcile the remote outcome before any retry/);
});

test('job checkpoint recorder persists plan, hashes, commands, tests, and multi-root fingerprints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-checkpoint-'));
  const workspace = path.join(root, 'workspace');
  const repository = path.join(root, 'bridge-repo');
  const checkpointPath = path.join(root, 'state', 'checkpoint.json');
  await fs.mkdir(workspace, { recursive: true });
  await initializeGitRepository(repository, 'before\n');

  const baseline = await captureWorkspaceState({ roots: [workspace, repository] });
  assert.equal(baseline.available, true);
  assert.equal(baseline.fully_available, false);
  assert.equal(baseline.roots.length, 2);

  const recorder = await createJobCheckpointRecorder({
    job: { id: 'job-a_continue_20260728150000000001' },
    checkpointPath,
    workingDir: workspace,
    workspaceRoots: [repository],
    baselineSnapshot: baseline,
    prompt: 'implement the checkpoint',
    writeDebounceMs: 0,
    workspaceRefreshMs: 0,
  });
  recorder.record({
    type: 'plan',
    plan: [
      { step: 'edit source', status: 'completed' },
      { step: 'run tests', status: 'pending' },
      { step: 'report', status: 'pending' },
    ],
  });

  const changedPath = path.join(repository, 'tracked.txt');
  await fs.writeFile(changedPath, 'after\n');
  recorder.record({
    type: 'file_change',
    status: 'completed',
    changes: [{ path: changedPath, kind: 'modified' }],
  });
  recorder.record({
    type: 'tool_call',
    kind: 'command',
    actionId: 'test-1',
    command: 'node --test test/job-checkpoint.test.mjs',
    cwd: repository,
    status: 'in_progress',
  });
  recorder.record({
    type: 'tool_output',
    kind: 'command',
    actionId: 'test-1',
    command: 'node --test test/job-checkpoint.test.mjs',
    cwd: repository,
    status: 'completed',
    exitCode: 0,
    durationMs: 123,
    output: 'tests passed',
  });

  const snapshot = await recorder.finish({
    status: 'interrupted',
    finalAnswerReady: false,
  });
  const persisted = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
  const changedFile = snapshot.changed_files.find((file) =>
    file.workspace_root === repository && file.path === 'tracked.txt',
  );

  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.status, 'interrupted');
  assert.equal(snapshot.root_job_id, 'job-a');
  assert.equal(snapshot.plan[1].status, 'in_progress');
  assert.equal(snapshot.next_action, 'run tests');
  assert.equal(snapshot.workspace.current.roots.length, 2);
  assert.notEqual(snapshot.input_fingerprint, baseline.fingerprint);
  assert.equal(changedFile.sha256, sha256('after\n'));
  assert.equal(snapshot.commands[0].cwd, repository);
  assert.equal(snapshot.commands[0].exit_code, 0);
  assert.equal(snapshot.commands[0].valid_for_current_workspace, true);
  assert.equal(snapshot.commands[0].evidence_fingerprint, snapshot.input_fingerprint);
  assert.equal(snapshot.test_results[0].status, 'passed');
  assert.equal(snapshot.test_results[0].input_fingerprint, snapshot.input_fingerprint);
  assert.deepEqual(persisted, snapshot);

  const rendered = formatJobCheckpointMarkdown(snapshot, {
    checkpointPath: 'jobs/transcripts/job-a/checkpoint.json',
    currentInputFingerprint: snapshot.input_fingerprint,
  });
  assert.match(rendered, /inputFingerprintMatches: true/);
  assert.match(rendered, new RegExp(`cwd=${escapeRegExp(repository)}`));
  assert.match(rendered, /exit=0/);
  assert.match(rendered, /tracked\.txt: sha256=/);
});

test('final answer readiness hashes the masked durable representation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-checkpoint-final-'));
  const recorder = await createJobCheckpointRecorder({
    job: { id: 'job-final' },
    checkpointPath: path.join(root, 'checkpoint.json'),
    workingDir: root,
    prompt: 'finish',
    writeDebounceMs: 0,
  });
  const output = 'final answer';
  const checkpoint = await recorder.finish({
    status: 'succeeded',
    output,
    finalAnswerReady: true,
    finalAnswerPath: 'jobs/transcripts/job-final/final.md',
  });

  assert.equal(checkpoint.final_answer_ready, true);
  assert.equal(checkpoint.final_answer_sha256, sha256(output));
  assert.equal(checkpoint.next_action, null);
});

test('checkpoint writer recovers after one transient filesystem failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-checkpoint-recovery-'));
  const stateDirectory = path.join(root, 'state');
  const savedDirectory = path.join(root, 'state-saved');
  const checkpointPath = path.join(stateDirectory, 'checkpoint.json');
  try {
    const recorder = await createJobCheckpointRecorder({
      job: { id: 'job-writer-recovery' },
      checkpointPath,
      workingDir: root,
      prompt: 'recover the writer',
      writeDebounceMs: 60_000,
    });

    await fs.rename(stateDirectory, savedDirectory);
    await fs.writeFile(stateDirectory, 'temporarily blocks the checkpoint directory');
    await assert.rejects(recorder.flush(), { code: 'EEXIST' });

    await fs.rm(stateDirectory, { force: true });
    await fs.rename(savedDirectory, stateDirectory);
    recorder.record({
      type: 'plan',
      plan: [{ step: 'writer recovered', status: 'completed' }],
    });
    await recorder.flush();

    const persisted = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    assert.equal(persisted.plan[0].step, 'writer recovered');
    assert.equal(persisted.plan[0].status, 'completed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('checkpoint debounce retries its latest snapshot after filesystem recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-checkpoint-debounce-retry-'));
  const stateDirectory = path.join(root, 'state');
  const savedDirectory = path.join(root, 'state-saved');
  const checkpointPath = path.join(stateDirectory, 'checkpoint.json');
  try {
    const recorder = await createJobCheckpointRecorder({
      job: { id: 'job-debounce-retry' },
      checkpointPath,
      workingDir: root,
      prompt: 'retry a debounced write',
      writeDebounceMs: 10,
    });
    await fs.rename(stateDirectory, savedDirectory);
    await fs.writeFile(stateDirectory, 'temporarily blocks the checkpoint directory');
    recorder.record({
      type: 'plan',
      plan: [{ step: 'persist without another event', status: 'completed' }],
    });
    // Let the debounce write fail before repairing the directory. The writer
    // must retain the dirty generation and retry it on its own.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fs.rm(stateDirectory, { force: true });
    await fs.rename(savedDirectory, stateDirectory);

    const deadline = Date.now() + 2_000;
    let persisted = null;
    while (Date.now() < deadline) {
      persisted = await fs.readFile(checkpointPath, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (persisted?.plan?.[0]?.step === 'persist without another event') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(persisted?.plan?.[0]?.status, 'completed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a recorded workspace mutation invalidates prior test evidence before the refresh finishes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-checkpoint-stale-test-'));
  const repository = path.join(root, 'repository');
  await initializeGitRepository(repository, 'before\n');
  const baseline = await captureWorkspaceState({ roots: [repository] });
  const recorder = await createJobCheckpointRecorder({
    job: { id: 'job-stale-test' },
    checkpointPath: path.join(root, 'checkpoint.json'),
    workingDir: repository,
    baselineSnapshot: baseline,
    writeDebounceMs: 60_000,
    workspaceRefreshMs: 60_000,
  });

  recorder.record({
    type: 'tool_call',
    kind: 'command',
    actionId: 'test-before-edit',
    command: 'node --test test/unit.test.mjs',
    cwd: repository,
    status: 'in_progress',
  });
  recorder.record({
    type: 'tool_output',
    kind: 'command',
    actionId: 'test-before-edit',
    command: 'node --test test/unit.test.mjs',
    cwd: repository,
    status: 'completed',
    exitCode: 0,
  });
  const tested = await recorder.flush();
  assert.equal(tested.test_results[0].valid_for_current_workspace, true);
  assert.equal(tested.workspace.refresh_pending, false);

  await fs.writeFile(path.join(repository, 'tracked.txt'), 'after\n');
  recorder.record({
    type: 'file_change',
    status: 'completed',
    changes: [{ path: path.join(repository, 'tracked.txt'), kind: 'modified' }],
  });
  const invalidated = recorder.snapshot();

  assert.equal(invalidated.workspace.refresh_pending, true);
  assert.equal(invalidated.test_results[0].valid_for_current_workspace, false);
  assert.equal(invalidated.test_results[0].input_fingerprint, null);
  assert.equal(invalidated.commands[0].valid_for_current_workspace, false);
  assert.equal(invalidated.commands[0].evidence_fingerprint, null);

  const finished = await recorder.finish({ status: 'interrupted' });
  assert.equal(finished.workspace.refresh_pending, false);
  assert.equal(finished.test_results[0].valid_for_current_workspace, false);
});

test('an unobserved workspace change at finish invalidates otherwise passed tests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-checkpoint-unobserved-'));
  const repository = path.join(root, 'repository');
  await initializeGitRepository(repository, 'before\n');
  const baseline = await captureWorkspaceState({ roots: [repository] });
  const recorder = await createJobCheckpointRecorder({
    job: { id: 'job-unobserved-change' },
    checkpointPath: path.join(root, 'checkpoint.json'),
    workingDir: repository,
    baselineSnapshot: baseline,
    writeDebounceMs: 0,
    workspaceRefreshMs: 0,
  });

  recorder.record({
    type: 'tool_output',
    kind: 'command',
    actionId: 'test-without-observed-edit',
    command: 'npm test',
    cwd: repository,
    status: 'completed',
    exitCode: 0,
  });
  await recorder.flush();
  await fs.writeFile(path.join(repository, 'tracked.txt'), 'changed outside worker events\n');

  const checkpoint = await recorder.finish({ status: 'interrupted' });

  assert.equal(checkpoint.workspace.unobserved_changes, true);
  assert.equal(checkpoint.test_results[0].valid_for_current_workspace, false);
  assert.equal(checkpoint.test_results[0].input_fingerprint, null);
});

test('a prepared final answer is not blindly reused after the workspace fingerprint changes', () => {
  const checkpoint = createInitialJobCheckpoint({
    job: { id: 'job-final-stale' },
    workingDir: '/tmp/project',
    baseline: workspaceSnapshot('fingerprint-a'),
  });
  checkpoint.final_answer_ready = true;
  checkpoint.final_answer_path = 'jobs/transcripts/job-final-stale/final.md';
  checkpoint.final_answer_sha256 = sha256('answer');
  const rendered = formatJobCheckpointMarkdown(checkpoint, {
    currentInputFingerprint: 'fingerprint-b',
  });

  assert.match(rendered, /inputFingerprintMatches: false/);
  assert.match(rendered, /saved final answer exists, but the workspace fingerprint changed/i);
  assert.doesNotMatch(rendered, /Return the saved final output without rerunning/);
});

function workspaceSnapshot(fingerprint) {
  return {
    available: true,
    cwd: '/tmp/project',
    git_root: '/tmp/project',
    git_head: 'abc123',
    dirty: false,
    dirty_files: [],
    truncated: false,
    fingerprint,
    captured_at: '2026-07-28T00:00:00.000Z',
    error: null,
  };
}

async function initializeGitRepository(repository, content) {
  await fs.mkdir(repository, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.email', 'checkpoint@example.com'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.name', 'Checkpoint Test'], { cwd: repository });
  await fs.writeFile(path.join(repository, 'tracked.txt'), content);
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
  await execFileAsync('git', ['commit', '-qm', 'baseline'], { cwd: repository });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
