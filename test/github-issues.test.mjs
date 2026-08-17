import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGitHubIssueMaintenanceStartMessage,
  buildGitHubIssueMaintenanceTask,
  githubRepositoryFromRemoteUrl,
  githubIssueMaintenanceThreadTitle,
  listOpenGitHubIssues,
  resolveGitHubIssueWithCommit,
  verifiedMaintenanceCommitHead,
  verifiedMaintenanceResolutionHead,
} from '../lib/github-issues.mjs';

test('githubRepositoryFromRemoteUrl parses HTTPS, SSH, and scp GitHub remotes', () => {
  assert.equal(
    githubRepositoryFromRemoteUrl('https://github.com/example-owner/mobile-codex-bridge.git'),
    'example-owner/mobile-codex-bridge',
  );
  assert.equal(
    githubRepositoryFromRemoteUrl('git@github.com:example-owner/mobile-codex-bridge.git'),
    'example-owner/mobile-codex-bridge',
  );
  assert.equal(
    githubRepositoryFromRemoteUrl('ssh://git@github.com/example-owner/mobile-codex-bridge.git'),
    'example-owner/mobile-codex-bridge',
  );
  assert.equal(githubRepositoryFromRemoteUrl('https://gitlab.com/a/b.git'), '');
});

test('listOpenGitHubIssues uses the configured repository and compacts results', async () => {
  const calls = [];
  const issues = await listOpenGitHubIssues({
    cwd: '/repo',
    repository: 'owner/repo',
    run: async (request) => {
      calls.push(request);
      return {
        code: 0,
        stdout: JSON.stringify([{
          number: 7,
          title: 'Broken restart',
          body: 'details',
          url: 'https://github.com/owner/repo/issues/7',
          labels: [{ name: 'bug' }],
        }]),
        stderr: '',
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 6), ['issue', 'list', '--repo', 'owner/repo', '--state', 'open']);
  assert.deepEqual(issues, [{
    number: 7,
    title: 'Broken restart',
    body: 'details',
    url: 'https://github.com/owner/repo/issues/7',
    createdAt: '',
    updatedAt: '',
    labels: ['bug'],
  }]);
});

test('buildGitHubIssueMaintenanceTask requires verified work and a structured result', () => {
  const task = buildGitHubIssueMaintenanceTask({
    repository: 'owner/repo',
    issue: { number: 3, title: 'Lost job', body: 'steps', url: 'https://example.test/3' },
  });

  assert.match(task, /separately from the general daily bridge inspection/);
  assert.match(task, /Do not create a GitHub comment, close the issue, commit, or push manually/);
  assert.match(task, /bridge_maintenance_issue_result/);
  assert.match(task, /Do not list source file paths/);
});

test('GitHub issue maintenance creates a concise public start message and bounded thread title', () => {
  const issue = {
    number: 12,
    title: '최종 메시지가 스레드로 가는 문제'.repeat(10),
    url: 'https://github.com/owner/repo/issues/12',
  };
  assert.match(buildGitHubIssueMaintenanceStartMessage({ issue }), /^버그 이슈 #12 작업 시작/m);
  assert.match(buildGitHubIssueMaintenanceStartMessage({ issue }), /https:\/\/github\.com\/owner\/repo\/issues\/12/);
  assert.ok(githubIssueMaintenanceThreadTitle(issue, '2026-07-28').length <= 100);
});

test('verifiedMaintenanceCommitHead requires one newly committed and remotely verified HEAD', () => {
  const head = 'abcdef1234567890';
  assert.equal(verifiedMaintenanceCommitHead({
    synced: true,
    commit: { committed: true, commit: head },
    statusAfter: {
      synced: true,
      remoteVerified: true,
      localHead: head,
      remoteHead: head,
    },
  }), head);

  assert.equal(verifiedMaintenanceCommitHead({
    synced: false,
    commit: { committed: true, commit: head },
    statusAfter: {
      synced: false,
      remoteVerified: false,
      localHead: head,
      remoteHead: '1234567',
    },
  }), '');
  assert.equal(verifiedMaintenanceCommitHead({
    synced: true,
    commit: { committed: false },
    statusAfter: { synced: true, remoteVerified: true },
  }), '');
});

test('verifiedMaintenanceResolutionHead accepts an inspected existing commit in verified remote history', async () => {
  const fullHead = 'abcdef1234567890abcdef1234567890abcdef12';
  const remoteHead = '1234567890abcdef1234567890abcdef12345678';
  const calls = [];
  const run = async (_cwd, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${fullHead}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const head = await verifiedMaintenanceResolutionHead({
    cwd: '/repo',
    reportedHead: 'abcdef1',
    summary: {
      synced: true,
      commit: { committed: false, action: 'no-eligible-changes' },
      statusAfter: {
        synced: true,
        remoteVerified: true,
        localHead: remoteHead,
        remoteHead,
      },
    },
    run,
  });

  assert.equal(head, fullHead);
  assert.deepEqual(calls, [
    ['rev-parse', '--verify', 'abcdef1^{commit}'],
    ['merge-base', '--is-ancestor', fullHead, remoteHead],
  ]);
});

test('verifiedMaintenanceResolutionHead rejects an existing commit outside remote history', async () => {
  const fullHead = 'abcdef1234567890abcdef1234567890abcdef12';
  const remoteHead = '1234567890abcdef1234567890abcdef12345678';
  const head = await verifiedMaintenanceResolutionHead({
    cwd: '/repo',
    reportedHead: 'abcdef1',
    summary: {
      synced: true,
      commit: { committed: false, action: 'no-eligible-changes' },
      statusAfter: {
        synced: true,
        remoteVerified: true,
        localHead: remoteHead,
        remoteHead,
      },
    },
    run: async (_cwd, args) => (
      args[0] === 'rev-parse'
        ? { code: 0, stdout: `${fullHead}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' }
    ),
  });

  assert.equal(head, '');
});

test('resolveGitHubIssueWithCommit comments with HEAD and closes an open issue', async () => {
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    if (request.args[1] === 'view') {
      return {
        code: 0,
        stdout: JSON.stringify({
          state: 'OPEN',
          comments: [],
          url: 'https://github.com/owner/repo/issues/4',
        }),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const result = await resolveGitHubIssueWithCommit({
    cwd: '/repo',
    repository: 'owner/repo',
    issueNumber: 4,
    head: 'abcdef1234567890',
    summary: '작업 유실을 막음',
    run,
  });

  assert.equal(result.commented, true);
  assert.equal(result.closed, true);
  assert.equal(calls.length, 3);
  assert.match(calls[1].args.at(-1), /커밋 HEAD: `abcdef1234567890`/);
  assert.match(calls[1].args.at(-1), /bridge-maintenance-resolution:4:abcdef1234567890/);
  assert.deepEqual(calls[2].args.slice(0, 3), ['issue', 'close', '4']);
});

test('resolveGitHubIssueWithCommit is idempotent when its comment and closure already exist', async () => {
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    return {
      code: 0,
      stdout: JSON.stringify({
        state: 'CLOSED',
        comments: [{ body: '<!-- bridge-maintenance-resolution:9:abcdef1 -->' }],
      }),
      stderr: '',
    };
  };

  const result = await resolveGitHubIssueWithCommit({
    repository: 'owner/repo',
    issueNumber: 9,
    head: 'abcdef1',
    summary: '완료',
    run,
  });

  assert.equal(calls.length, 1);
  assert.equal(result.commentAlreadyPresent, true);
  assert.equal(result.alreadyClosed, true);
});
