import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  commitEligibleWorktreeChanges,
  getHeadSyncStatus,
  getWorktreeChangedPaths,
  nonInteractiveGitEnv,
  reconcileLocalHeadWithRemote,
  runGit,
  storedGitHubAuthEnv,
  syncLocalHeadToRemote,
} from '../lib/git-sync.mjs';

test('nonInteractiveGitEnv exposes gh and node tool paths', () => {
  const env = nonInteractiveGitEnv();
  const entries = env.PATH.split(path.delimiter);
  const hostHome = process.env.BRIDGE_HOST_HOME || process.env.HOME || os.homedir();
  assert(entries.includes(path.dirname(process.execPath)));
  assert(entries.includes(path.join(hostHome, '.local', 'bin')));
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('storedGitHubAuthEnv clears inherited token overrides for gh credential fallback', () => {
  assert.deepEqual(storedGitHubAuthEnv(), {
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  });
});

test('syncLocalHeadToRemote fast-forwards a clean local branch', async () => {
  const fixture = await createGitFixture();
  await commitFile(fixture.remoteWork, 'bridge.txt', 'v2\n', 'remote v2');
  await runGit(fixture.remoteWork, ['push', 'origin', 'main']);

  const result = await syncLocalHeadToRemote({ cwd: fixture.local, remote: 'origin', branch: 'main' });

  assert.equal(result.synced, true);
  assert.equal(result.action, 'fast-forward-merge');
  assert.equal(await fs.readFile(path.join(fixture.local, 'bridge.txt'), 'utf8'), 'v2\n');
  assert.equal((await runGit(fixture.local, ['status', '--porcelain'], {})).stdout.trim(), '');
});

test('syncLocalHeadToRemote fast-forwards a dirty branch when remote changes do not conflict', async () => {
  const fixture = await createGitFixture();
  await commitFile(fixture.remoteWork, 'remote.txt', 'remote\n', 'remote file');
  await runGit(fixture.remoteWork, ['push', 'origin', 'main']);
  await fs.writeFile(path.join(fixture.local, 'local.txt'), 'local dirty\n');

  const result = await syncLocalHeadToRemote({ cwd: fixture.local, remote: 'origin', branch: 'main' });

  assert.equal(result.synced, true);
  assert.equal(result.action, 'dirty-fast-forward');
  assert.deepEqual(result.updatedPaths, ['remote.txt']);
  assert.equal(await fs.readFile(path.join(fixture.local, 'remote.txt'), 'utf8'), 'remote\n');
  assert.equal(await fs.readFile(path.join(fixture.local, 'local.txt'), 'utf8'), 'local dirty\n');
  assert.match((await runGit(fixture.local, ['status', '--porcelain'], {})).stdout, /\?\? local\.txt/);
});

test('syncLocalHeadToRemote blocks when local dirty files differ from remote', async () => {
  const fixture = await createGitFixture();
  await commitFile(fixture.remoteWork, 'bridge.txt', 'remote\n', 'remote update');
  await runGit(fixture.remoteWork, ['push', 'origin', 'main']);
  await fs.writeFile(path.join(fixture.local, 'bridge.txt'), 'local dirty\n');

  const result = await syncLocalHeadToRemote({ cwd: fixture.local, remote: 'origin', branch: 'main' });

  assert.equal(result.synced, false);
  assert.equal(result.action, 'blocked-dirty-worktree');
  assert.deepEqual(result.worktree.conflicts, ['bridge.txt']);
  assert.equal(await fs.readFile(path.join(fixture.local, 'bridge.txt'), 'utf8'), 'local dirty\n');
});

test('syncLocalHeadToRemote reconciles when files already match remote but HEAD is stale', async () => {
  const fixture = await createGitFixture();
  await commitFile(fixture.remoteWork, 'bridge.txt', 'remote copied\n', 'remote copied');
  await runGit(fixture.remoteWork, ['push', 'origin', 'main']);
  await fs.writeFile(path.join(fixture.local, 'bridge.txt'), 'remote copied\n');

  const result = await syncLocalHeadToRemote({ cwd: fixture.local, remote: 'origin', branch: 'main' });

  assert.equal(result.synced, true);
  assert.equal(result.action, 'mixed-reset-worktree-matched-remote');
  assert.equal((await runGit(fixture.local, ['status', '--porcelain'], {})).stdout.trim(), '');
});

test('getHeadSyncStatus refreshes the remote ref before comparing HEADs', async () => {
  const fixture = await createGitFixture();
  await commitFile(fixture.remoteWork, 'bridge.txt', 'v2\n', 'remote v2');
  await runGit(fixture.remoteWork, ['push', 'origin', 'main']);

  const status = await getHeadSyncStatus({ cwd: fixture.local, remote: 'origin', branch: 'main' });

  assert.equal(status.remoteVerified, true);
  assert.equal(status.synced, false);
  assert.equal(status.relation, 'behind');
  assert.equal(status.remoteHead, await gitTrim(fixture.remoteWork, ['rev-parse', 'HEAD']));
});

test('reconcileLocalHeadWithRemote pushes a local-ahead branch and verifies remote', async () => {
  const fixture = await createGitFixture();
  await commitFile(fixture.local, 'bridge.txt', 'local v2\n', 'local v2');
  const localHead = await gitTrim(fixture.local, ['rev-parse', 'HEAD']);

  const result = await reconcileLocalHeadWithRemote({ cwd: fixture.local, remote: 'origin', branch: 'main' });

  assert.equal(result.synced, true);
  assert.equal(result.action, 'pushed-local-head');
  assert.equal(result.push.ok, true);
  assert.equal(result.statusAfter.remoteVerified, true);
  assert.equal(await gitTrim(fixture.bare, ['rev-parse', 'refs/heads/main']), localHead);
});

test('commitEligibleWorktreeChanges commits only paths outside the dirty baseline', async () => {
  const fixture = await createGitFixture();
  await fs.writeFile(path.join(fixture.local, 'preexisting.txt'), 'dirty before maintenance\n');
  await fs.writeFile(path.join(fixture.local, 'staged-before.txt'), 'staged before maintenance\n');
  await runGit(fixture.local, ['add', 'staged-before.txt']);
  const baseline = await getWorktreeChangedPaths({ cwd: fixture.local });
  await fs.writeFile(path.join(fixture.local, 'bridge.txt'), 'maintenance edit\n');
  await fs.writeFile(path.join(fixture.local, 'new-maintenance.txt'), 'maintenance new file\n');

  const result = await commitEligibleWorktreeChanges({
    cwd: fixture.local,
    baselinePaths: baseline,
    message: 'maintenance commit',
  });

  assert.equal(result.committed, true);
  assert.deepEqual(result.eligiblePaths, ['bridge.txt', 'new-maintenance.txt']);
  assert.deepEqual(
    result.skippedPaths.map((entry) => [entry.path, entry.reason]),
    [
      ['preexisting.txt', 'baseline-dirty'],
      ['staged-before.txt', 'baseline-dirty'],
    ],
  );
  assert.deepEqual(await committedFileNames(fixture.local, 'HEAD'), ['bridge.txt', 'new-maintenance.txt']);
  const status = (await runGit(fixture.local, ['status', '--porcelain'], {})).stdout;
  assert.match(status, /\?\? preexisting\.txt/);
  assert.match(status, /A  staged-before\.txt/);
});

test('commitEligibleWorktreeChanges skips protected runtime paths', async () => {
  const fixture = await createGitFixture();
  await fs.writeFile(path.join(fixture.local, 'NUL'), '');
  await fs.writeFile(path.join(fixture.local, 'safe.txt'), 'safe\n');

  const result = await commitEligibleWorktreeChanges({
    cwd: fixture.local,
    baselinePaths: [],
    message: 'maintenance commit',
  });

  assert.equal(result.committed, true);
  assert.deepEqual(result.eligiblePaths, ['safe.txt']);
  assert.deepEqual(result.skippedPaths, [{ path: 'NUL', reason: 'protected-path' }]);
  assert.deepEqual(await committedFileNames(fixture.local, 'HEAD'), ['safe.txt']);
  assert.match((await runGit(fixture.local, ['status', '--porcelain'], {})).stdout, /\?\? NUL/);
});

async function createGitFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-git-'));
  const remoteWork = path.join(root, 'remote-work');
  const bare = path.join(root, 'remote.git');
  const local = path.join(root, 'local');

  await fs.mkdir(remoteWork);
  await runGit(remoteWork, ['init']);
  await runGit(remoteWork, ['checkout', '-b', 'main']);
  await configureUser(remoteWork);
  await commitFile(remoteWork, 'bridge.txt', 'v1\n', 'initial');
  await runGit(root, ['clone', '--bare', remoteWork, bare]);
  await runGit(remoteWork, ['remote', 'add', 'origin', bare]);
  await runGit(root, ['clone', bare, local]);
  await runGit(local, ['checkout', 'main']);
  await configureUser(local);

  return { root, remoteWork, bare, local };
}

async function configureUser(cwd) {
  await runGit(cwd, ['config', 'user.email', 'bridge-test@example.invalid']);
  await runGit(cwd, ['config', 'user.name', 'Bridge Test']);
}

async function commitFile(cwd, fileName, content, message) {
  await fs.writeFile(path.join(cwd, fileName), content);
  await runGit(cwd, ['add', fileName]);
  await runGit(cwd, ['commit', '-m', message]);
}

async function gitTrim(cwd, args) {
  return (await runGit(cwd, args)).stdout.trim();
}

async function committedFileNames(cwd, ref) {
  return (await gitTrim(cwd, ['show', '--name-only', '--format=', ref]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}
