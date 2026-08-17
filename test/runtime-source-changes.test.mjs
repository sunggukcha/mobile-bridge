import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  attributeRuntimeSourceChanges,
  captureRuntimeSourceSnapshot,
  changedRuntimeSourcePaths,
  isRuntimeSourcePath,
} from '../lib/runtime-source-changes.mjs';

test('isRuntimeSourcePath scopes bridge runtime files', () => {
  assert.equal(isRuntimeSourcePath('bridge-service.mjs'), true);
  assert.equal(isRuntimeSourcePath('bridge-supervisor.mjs'), true);
  assert.equal(isRuntimeSourcePath('v3/watchdog.mjs'), true);
  assert.equal(isRuntimeSourcePath('v3/workbench.mjs'), true);
  assert.equal(isRuntimeSourcePath('v3/lib/durable-bus.mjs'), true);
  assert.equal(isRuntimeSourcePath('lib/agent-runner.mjs'), true);
  assert.equal(isRuntimeSourcePath('lib/nested/source.mjs'), true);
  assert.equal(isRuntimeSourcePath('.env'), true);
  assert.equal(isRuntimeSourcePath('.env.example'), false);
  assert.equal(isRuntimeSourcePath('test/agent-runner.test.mjs'), false);
  assert.equal(isRuntimeSourcePath('README.md'), false);
});

test('changedRuntimeSourcePaths detects lib and entrypoint changes only', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-runtime-source-'));
  await fs.mkdir(path.join(cwd, 'lib'), { recursive: true });
  await fs.mkdir(path.join(cwd, 'test'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'bridge-service.mjs'), 'service v1\n');
  await fs.writeFile(path.join(cwd, 'lib', 'agent-runner.mjs'), 'runner v1\n');
  await fs.writeFile(path.join(cwd, 'README.md'), 'docs v1\n');
  await fs.writeFile(path.join(cwd, 'test', 'agent-runner.test.mjs'), 'test v1\n');

  const before = await captureRuntimeSourceSnapshot({ cwd });
  await fs.writeFile(path.join(cwd, 'README.md'), 'docs v2\n');
  await fs.writeFile(path.join(cwd, 'test', 'agent-runner.test.mjs'), 'test v2\n');
  assert.deepEqual(await changedRuntimeSourcePaths({ cwd, before }), []);

  await fs.writeFile(path.join(cwd, 'lib', 'agent-runner.mjs'), 'runner v2\n');
  await fs.writeFile(path.join(cwd, 'lib', 'new-runtime.mjs'), 'new runtime\n');
  await fs.writeFile(path.join(cwd, 'bridge-service.mjs'), 'service v2\n');
  assert.deepEqual(await changedRuntimeSourcePaths({ cwd, before }), [
    'bridge-service.mjs',
    'lib/agent-runner.mjs',
    'lib/new-runtime.mjs',
  ]);
});

test('runtime changes made by another concurrent job are not attributed to an unrelated worker', () => {
  const repoRoot = '/tmp/mobile-codex-bridge';
  const result = attributeRuntimeSourceChanges({
    changedPaths: ['lib/daily-maintenance.mjs'],
    repoRoot,
    checkpoint: {
      cwd: '/tmp/channel-workspace/explicit-learning',
      observed_file_changes: [],
      changed_files: [{
        workspace_root: repoRoot,
        path: 'lib/daily-maintenance.mjs',
        source: 'worktree',
      }],
      commands: [{
        cwd: '/tmp/channel-workspace/explicit-learning',
        status: 'completed',
        mutates_workspace: true,
      }],
    },
  });

  assert.deepEqual(result, {
    attributedPaths: [],
    ignoredPaths: ['lib/daily-maintenance.mjs'],
  });
});

test('runtime changes with worker file evidence remain attributed to that job', () => {
  const repoRoot = '/tmp/mobile-codex-bridge';
  const result = attributeRuntimeSourceChanges({
    changedPaths: ['bridge-service.mjs', 'lib/bridge-prompt.mjs', 'README.md'],
    repoRoot,
    checkpoint: {
      cwd: '/tmp/channel-workspace',
      changed_files: [{
        workspace_root: repoRoot,
        path: 'bridge-service.mjs',
        source: 'worktree+worker-event',
      }],
      observed_file_changes: [{
        path: `${repoRoot}/lib/bridge-prompt.mjs`,
        kind: 'update',
        status: 'completed',
      }],
    },
  });

  assert.deepEqual(result, {
    attributedPaths: ['bridge-service.mjs', 'lib/bridge-prompt.mjs'],
    ignoredPaths: [],
  });
});

test('maintenance and completed mutation commands in the bridge repository retain detected changes', () => {
  const changedPaths = ['bridge-service.mjs', 'lib/bridge-prompt.mjs'];
  assert.deepEqual(attributeRuntimeSourceChanges({
    changedPaths,
    repoRoot: '/tmp/mobile-codex-bridge',
    trustAll: true,
  }), {
    attributedPaths: changedPaths,
    ignoredPaths: [],
  });
  assert.deepEqual(attributeRuntimeSourceChanges({
    changedPaths,
    repoRoot: '/tmp/mobile-codex-bridge',
    checkpoint: {
      commands: [{
        cwd: '/tmp/mobile-codex-bridge',
        status: 'completed',
        mutates_workspace: true,
      }],
    },
  }), {
    attributedPaths: changedPaths,
    ignoredPaths: [],
  });
});

test('a Claude worker file edit attributes its own runtime source change', () => {
  const repoRoot = path.resolve('/repo');
  const checkpoint = {
    // Claude tool calls carry no repo cwd, so the command-based evidence path
    // never fires for them; the observed file change is the only evidence.
    cwd: '/channel/workspace',
    commands: [],
    changed_files: [],
    observed_file_changes: [
      { path: '/repo/lib/config.mjs', status: 'completed' },
      { path: '/repo/lib/state.mjs', status: 'in_progress' },
    ],
  };

  const result = attributeRuntimeSourceChanges({
    changedPaths: ['lib/config.mjs', 'lib/state.mjs', 'lib/untouched.mjs'],
    checkpoint,
    repoRoot,
  });
  assert.deepEqual(result.attributedPaths, ['lib/config.mjs']);
  // A concurrent job's change stays unattributed.
  assert.deepEqual(result.ignoredPaths, ['lib/state.mjs', 'lib/untouched.mjs']);
});
