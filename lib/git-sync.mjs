import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function syncLocalHeadToRemote({
  cwd,
  remote = 'origin',
  branch = 'main',
  timeoutMs = 30_000,
  allowStoredRemoteFallback = true,
} = {}) {
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const remoteRefresh = await refreshRemoteRef({
    cwd,
    remote,
    branch,
    remoteRef,
    timeoutMs,
    allowStoredRemoteFallback,
  });
  const remoteVerified = remoteRefresh.remoteVerified;

  if (!remoteVerified && !remoteRefresh.remoteHead) {
    return {
      synced: false,
      action: 'remote-unavailable',
      fetchError: remoteRefresh.fetchError,
      ghError: remoteRefresh.ghError,
      remoteVerified,
      remoteRefresh,
    };
  }

  const localHead = await gitOutput(cwd, ['rev-parse', 'HEAD'], { timeoutMs });
  const remoteHead = remoteRefresh.remoteHead ||
    await gitOutput(cwd, ['rev-parse', remoteRef], { timeoutMs });
  const remoteTarget = remoteRefresh.storedRemoteAvailable ? remoteRef : remoteHead;
  const dirty = await isDirty(cwd, timeoutMs);

  if (localHead === remoteHead) {
    return {
      synced: true,
      action: 'already-current',
      localHead,
      remoteHead,
      remoteVerified,
      remoteRefresh,
      dirty: Boolean(dirty),
    };
  }

  const relation = await headRelation(cwd, localHead, remoteHead, timeoutMs);
  if (dirty) {
    const worktree = await worktreeMatchesRef(cwd, remoteTarget, timeoutMs);
    if (worktree.matches) {
      await runGit(cwd, ['reset', '--mixed', remoteTarget], { timeoutMs });
      const nextHead = await gitOutput(cwd, ['rev-parse', 'HEAD'], { timeoutMs });
      const nextDirty = await isDirty(cwd, timeoutMs);
      return {
        synced: nextHead === remoteHead && !nextDirty,
        action: 'mixed-reset-worktree-matched-remote',
        localHead,
        remoteHead,
        nextHead,
        remoteVerified,
        remoteRefresh,
        dirty: nextDirty,
        relation,
      };
    }

    if (relation === 'behind') {
      const dirtyForward = await dirtyAwareFastForward(cwd, localHead, remoteHead, timeoutMs);
      if (dirtyForward.synced) {
        const nextDirty = await isDirty(cwd, timeoutMs);
        return {
          synced: dirtyForward.nextHead === remoteHead,
          action: 'dirty-fast-forward',
          localHead,
          remoteHead,
          nextHead: dirtyForward.nextHead,
          remoteVerified,
          remoteRefresh,
          dirty: nextDirty,
          relation,
          updatedPaths: dirtyForward.updatedPaths,
        };
      }

      return {
        synced: false,
        action: 'blocked-dirty-worktree',
        localHead,
        remoteHead,
        remoteVerified,
        remoteRefresh,
        dirty: true,
        relation,
        worktree: dirtyForward,
      };
    }

    return {
      synced: false,
      action: 'blocked-dirty-worktree',
      localHead,
      remoteHead,
      remoteVerified,
      remoteRefresh,
      dirty: true,
      relation,
      worktree,
    };
  }

  if (relation !== 'behind') {
    return {
      synced: false,
      action: relation === 'ahead' ? 'blocked-local-ahead' : 'blocked-diverged',
      localHead,
      remoteHead,
      remoteVerified,
      remoteRefresh,
      dirty: false,
      relation,
    };
  }

  await runGit(cwd, ['merge', '--ff-only', remoteTarget], { timeoutMs });
  const nextHead = await gitOutput(cwd, ['rev-parse', 'HEAD'], { timeoutMs });
  const nextDirty = await isDirty(cwd, timeoutMs);
  return {
    synced: nextHead === remoteHead && !nextDirty,
    action: 'fast-forward-merge',
    localHead,
    remoteHead,
    nextHead,
    remoteVerified,
    remoteRefresh,
    dirty: nextDirty,
  };
}

async function dirtyAwareFastForward(cwd, localHead, remoteHead, timeoutMs) {
  const changedPaths = await remoteChangedPaths(cwd, localHead, remoteHead, timeoutMs);
  const remoteContentByPath = new Map();
  const conflicts = [];

  for (const filePath of changedPaths) {
    const baseContent = await gitFileAtRefOrNull(cwd, localHead, filePath, timeoutMs);
    const remoteContent = await gitFileAtRefOrNull(cwd, remoteHead, filePath, timeoutMs);
    const localContent = await worktreeFileOrNull(cwd, filePath);
    remoteContentByPath.set(filePath, remoteContent);
    if (localContent !== baseContent && localContent !== remoteContent) conflicts.push(filePath);
  }

  if (conflicts.length > 0) {
    return {
      synced: false,
      changedPaths,
      conflicts,
    };
  }

  await runGit(cwd, ['update-ref', 'HEAD', remoteHead, localHead], { timeoutMs });
  for (const filePath of changedPaths) {
    const remoteContent = remoteContentByPath.get(filePath);
    if (remoteContent === null) {
      await runGit(cwd, ['rm', '--quiet', '--cached', '--ignore-unmatch', '--', filePath], {
        timeoutMs,
        reject: false,
      });
      await fs.rm(path.resolve(cwd, filePath), { force: true });
      continue;
    }
    await runGit(cwd, ['checkout', 'HEAD', '--', filePath], { timeoutMs });
  }

  return {
    synced: true,
    nextHead: await gitOutput(cwd, ['rev-parse', 'HEAD'], { timeoutMs }),
    updatedPaths: changedPaths,
    conflicts: [],
  };
}

async function remoteChangedPaths(cwd, localHead, remoteHead, timeoutMs) {
  const result = await runGit(cwd, ['diff', '--name-only', localHead, remoteHead, '--'], { timeoutMs });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function gitFileAtRefOrNull(cwd, ref, filePath, timeoutMs) {
  const result = await runGit(cwd, ['show', `${ref}:${filePath}`], {
    timeoutMs,
    reject: false,
  });
  return result.code === 0 ? result.stdout : null;
}

async function worktreeFileOrNull(cwd, filePath) {
  try {
    return await fs.readFile(path.resolve(cwd, filePath), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function pushLocalHeadToRemote({
  cwd,
  remote = 'origin',
  branch = 'main',
  timeoutMs = 30_000,
  allowGhFallback = true,
} = {}) {
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const localHead = await gitOutput(cwd, ['rev-parse', 'HEAD'], { timeoutMs });
  const push = await runGit(cwd, ['push', remote, `HEAD:refs/heads/${branch}`], { timeoutMs, reject: false });

  if (push.code === 0) {
    const remoteRefresh = await refreshRemoteRef({
      cwd,
      remote,
      branch,
      remoteRef,
      timeoutMs,
      allowStoredRemoteFallback: false,
    });
    const remoteHead = remoteRefresh.remoteHead ||
      (remoteRefresh.storedRemoteAvailable
        ? await gitOutput(cwd, ['rev-parse', remoteRef], { timeoutMs })
        : null);
    return {
      ok: remoteRefresh.remoteVerified && remoteHead === localHead,
      action: 'pushed',
      method: 'git-push',
      code: push.code,
      stdout: push.stdout.trim(),
      stderr: push.stderr.trim(),
      localHead,
      remoteHead,
      remoteVerified: remoteRefresh.remoteVerified,
      remoteRefresh,
    };
  }

  const storedAuthPush = hasGitHubEnvToken()
    ? await runGit(cwd, ['push', remote, `HEAD:refs/heads/${branch}`], {
      timeoutMs,
      reject: false,
      extraEnv: storedGitHubAuthEnv(),
    })
    : null;
  if (storedAuthPush?.code === 0) {
    const remoteRefresh = await refreshRemoteRef({
      cwd,
      remote,
      branch,
      remoteRef,
      timeoutMs,
      allowStoredRemoteFallback: false,
    });
    const remoteHead = remoteRefresh.remoteHead ||
      (remoteRefresh.storedRemoteAvailable
        ? await gitOutput(cwd, ['rev-parse', remoteRef], { timeoutMs })
        : null);
    return {
      ok: remoteRefresh.remoteVerified && remoteHead === localHead,
      action: 'pushed',
      method: 'git-push-stored-gh-auth',
      code: storedAuthPush.code,
      stdout: storedAuthPush.stdout.trim(),
      stderr: storedAuthPush.stderr.trim(),
      pushError: push.stderr.trim() || push.stdout.trim(),
      localHead,
      remoteHead,
      remoteVerified: remoteRefresh.remoteVerified,
      remoteRefresh,
    };
  }

  const ghTokenPush = await pushRemoteRefWithGhToken({ cwd, remote, branch, localHead, timeoutMs });
  if (ghTokenPush.ok) {
    const remoteRefresh = await refreshRemoteRef({
      cwd,
      remote,
      branch,
      remoteRef,
      timeoutMs,
      allowStoredRemoteFallback: false,
    });
    const remoteHead = remoteRefresh.remoteHead ||
      (remoteRefresh.storedRemoteAvailable
        ? await gitOutput(cwd, ['rev-parse', remoteRef], { timeoutMs })
        : null);
    return {
      ok: remoteRefresh.remoteVerified && remoteHead === localHead,
      action: 'pushed',
      method: ghTokenPush.method,
      code: ghTokenPush.code,
      stdout: ghTokenPush.stdout,
      stderr: ghTokenPush.stderr,
      pushError: push.stderr.trim() || push.stdout.trim(),
      localHead,
      remoteHead,
      remoteVerified: remoteRefresh.remoteVerified,
      remoteRefresh,
      ghTokenPush,
    };
  }

  let ghFallback = null;
  if (allowGhFallback) {
    ghFallback = await pushRemoteRefWithGh({ cwd, remote, branch, remoteRef, localHead, timeoutMs });
    if (ghFallback.ok) {
      return {
        ok: true,
        action: 'pushed',
        method: ghFallback.method,
        code: push.code,
        stdout: push.stdout.trim(),
        stderr: push.stderr.trim(),
        pushError: push.stderr.trim() || push.stdout.trim(),
        localHead,
        remoteHead: localHead,
        remoteVerified: true,
        ghFallback,
      };
    }
  }

  return {
    ok: false,
    action: 'push-failed',
    method: 'git-push',
    code: push.code,
    stdout: push.stdout.trim(),
    stderr: push.stderr.trim(),
    pushError: push.stderr.trim() || push.stdout.trim(),
    localHead,
    remoteVerified: false,
    storedAuthPushError: storedAuthPush
      ? storedAuthPush.stderr.trim() || storedAuthPush.stdout.trim()
      : null,
    ghFallback,
  };
}

async function pushRemoteRefWithGhToken({ cwd, remote, branch, localHead, timeoutMs }) {
  const repo = await githubRepoForRemote(cwd, remote, timeoutMs);
  if (!repo) {
    return {
      ok: false,
      method: 'git-push-gh-token',
      ghTokenPushError: 'remote is not a supported GitHub URL',
    };
  }

  const token = await runGh(cwd, ['auth', 'token'], { timeoutMs, reject: false });
  const value = token.stdout.trim();
  if (token.code !== 0 || !value) {
    return {
      ok: false,
      method: 'git-push-gh-token',
      ghTokenPushError: token.stderr.trim() || token.stdout.trim() || `gh auth token returned ${token.code}`,
    };
  }

  const push = await runGitWithExtraHeader(cwd, [
    'push',
    remote,
    `HEAD:refs/heads/${branch}`,
  ], {
    timeoutMs,
    reject: false,
    token: value,
  });

  return {
    ok: push.code === 0,
    method: 'git-push-gh-token',
    code: push.code,
    stdout: push.stdout.trim(),
    stderr: push.stderr.trim(),
    localHead,
    ghTokenPushError: push.code === 0 ? null : push.stderr.trim() || push.stdout.trim() || `git push returned ${push.code}`,
  };
}

export async function reconcileLocalHeadWithRemote({
  cwd,
  remote = 'origin',
  branch = 'main',
  timeoutMs = 30_000,
} = {}) {
  const statusBefore = await getHeadSyncStatus({
    cwd,
    remote,
    branch,
    timeoutMs,
    allowStoredRemoteFallback: false,
  });

  if (!statusBefore.remoteVerified) {
    return {
      synced: false,
      action: 'remote-unverified',
      statusBefore,
    };
  }

  if (statusBefore.synced) {
    return {
      synced: true,
      action: 'already-current',
      statusBefore,
      statusAfter: statusBefore,
    };
  }

  if (statusBefore.relation === 'behind') {
    const sync = await syncLocalHeadToRemote({
      cwd,
      remote,
      branch,
      timeoutMs,
      allowStoredRemoteFallback: false,
    });
    const statusAfter = await getHeadSyncStatus({
      cwd,
      remote,
      branch,
      timeoutMs,
      allowStoredRemoteFallback: false,
    });
    return {
      synced: Boolean(sync.synced && statusAfter.synced && statusAfter.remoteVerified),
      action: sync.action,
      statusBefore,
      sync,
      statusAfter,
    };
  }

  if (statusBefore.relation === 'ahead') {
    const push = await pushLocalHeadToRemote({ cwd, remote, branch, timeoutMs });
    const statusAfter = await getHeadSyncStatus({
      cwd,
      remote,
      branch,
      timeoutMs,
      allowStoredRemoteFallback: false,
    }).catch((error) => ({ error: error.message }));
    return {
      synced: Boolean(push.ok && statusAfter.synced && statusAfter.remoteVerified),
      action: push.ok ? 'pushed-local-head' : 'push-failed',
      statusBefore,
      push,
      statusAfter,
    };
  }

  return {
    synced: false,
    action: 'blocked-diverged',
    statusBefore,
  };
}

export async function getWorktreeChangedPaths({
  cwd,
  timeoutMs = 30_000,
} = {}) {
  const entries = await worktreeStatusEntries(cwd, timeoutMs);
  return [...new Set(entries.map((entry) => entry.path))].sort();
}

export async function commitEligibleWorktreeChanges({
  cwd,
  message = 'chore: apply daily maintenance changes',
  baselinePaths = [],
  timeoutMs = 30_000,
} = {}) {
  const baseline = new Set((baselinePaths || []).map(normalizeGitPath).filter(Boolean));
  const entries = await worktreeStatusEntries(cwd, timeoutMs);
  const changedPaths = [...new Set(entries.map((entry) => entry.path))].sort();
  const eligiblePaths = [];
  const skippedPaths = [];

  for (const filePath of changedPaths) {
    if (baseline.has(filePath)) {
      skippedPaths.push({ path: filePath, reason: 'baseline-dirty' });
      continue;
    }
    if (isProtectedMaintenancePath(filePath)) {
      skippedPaths.push({ path: filePath, reason: 'protected-path' });
      continue;
    }
    eligiblePaths.push(filePath);
  }

  if (eligiblePaths.length === 0) {
    return {
      committed: false,
      action: 'no-eligible-changes',
      changedPaths,
      eligiblePaths,
      skippedPaths,
    };
  }

  for (const chunk of chunks(eligiblePaths, 100)) {
    await runGit(cwd, ['add', '-A', '--', ...chunk], { timeoutMs });
  }

  const commit = await runGit(cwd, ['commit', '--only', '-m', message, '--', ...eligiblePaths], {
    timeoutMs,
    reject: false,
  });

  if (commit.code !== 0) {
    return {
      committed: false,
      action: 'commit-failed',
      code: commit.code,
      stdout: commit.stdout.trim(),
      stderr: commit.stderr.trim(),
      changedPaths,
      eligiblePaths,
      skippedPaths,
    };
  }

  return {
    committed: true,
    action: 'committed',
    commit: await gitOutput(cwd, ['rev-parse', 'HEAD'], { timeoutMs }),
    stdout: commit.stdout.trim(),
    stderr: commit.stderr.trim(),
    changedPaths,
    eligiblePaths,
    skippedPaths,
  };
}

export async function getHeadSyncStatus({
  cwd,
  remote = 'origin',
  branch = 'main',
  timeoutMs = 30_000,
  verifyRemote = true,
  allowStoredRemoteFallback = true,
} = {}) {
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const remoteRefresh = verifyRemote
    ? await refreshRemoteRef({ cwd, remote, branch, remoteRef, timeoutMs, allowStoredRemoteFallback })
    : { remoteVerified: false, storedRemoteAvailable: await refExists(cwd, remoteRef), method: 'stored-remote-ref' };
  const localHead = await gitOutput(cwd, ['rev-parse', 'HEAD'], { timeoutMs });
  const dirty = await isDirty(cwd, timeoutMs);

  const remoteHead = remoteRefresh.remoteHead ||
    (remoteRefresh.storedRemoteAvailable
      ? await gitOutput(cwd, ['rev-parse', remoteRef], { timeoutMs })
      : null);

  if (!remoteHead) {
    return {
      synced: false,
      localHead,
      remoteHead: null,
      dirty: Boolean(dirty),
      relation: 'unknown',
      remoteVerified: false,
      remoteRefresh,
    };
  }

  return {
    synced: localHead === remoteHead,
    localHead,
    remoteHead,
    dirty: Boolean(dirty),
    relation: localHead === remoteHead ? 'equal' : await headRelation(cwd, localHead, remoteHead, timeoutMs),
    remoteVerified: remoteRefresh.remoteVerified,
    remoteRefresh,
  };
}

async function isDirty(cwd, timeoutMs) {
  return Boolean((await gitOutput(cwd, ['status', '--porcelain', '-uall'], { timeoutMs })).trim());
}

async function worktreeStatusEntries(cwd, timeoutMs) {
  const result = await runGit(cwd, ['status', '--porcelain=v1', '-uall'], { timeoutMs });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => statusEntry(line))
    .filter(Boolean);
}

function statusEntry(line) {
  const text = String(line || '');
  if (!text.trim()) return null;
  const rawPath = text.slice(3).trim();
  const renamed = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
  const filePath = normalizeGitPath(renamed.replace(/^"|"$/g, ''));
  return filePath ? { code: text.slice(0, 2), path: filePath } : null;
}

function normalizeGitPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.includes('\0')) return null;
  if (normalized.split('/').some((part) => part === '..')) return null;
  return normalized;
}

function isProtectedMaintenancePath(filePath) {
  const normalized = normalizeGitPath(filePath);
  if (!normalized) return true;
  if (normalized === '.env' || normalized === 'NUL') return true;
  if (/\.(?:db|log|pid|sqlite|tmp)$/i.test(normalized)) return true;
  const [first] = normalized.split('/');
  return ['.agents', '.bridge-git', '.bridge_state', '.codex', '.codex-cli', '.state', 'data', 'node_modules'].includes(first);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function headRelation(cwd, localHead, remoteHead, timeoutMs) {
  const localAncestor = await runGit(cwd, ['merge-base', '--is-ancestor', localHead, remoteHead], {
    timeoutMs,
    reject: false,
  });
  if (localAncestor.code === 0) return 'behind';

  const remoteAncestor = await runGit(cwd, ['merge-base', '--is-ancestor', remoteHead, localHead], {
    timeoutMs,
    reject: false,
  });
  if (remoteAncestor.code === 0) return 'ahead';

  return 'diverged';
}

async function worktreeMatchesRef(cwd, ref, timeoutMs) {
  const diff = await runGit(cwd, ['diff', '--quiet', ref, '--'], { timeoutMs, reject: false });
  const extraUntracked = await untrackedPathsNotInRef(cwd, ref, timeoutMs);
  return {
    matches: diff.code === 0 && extraUntracked.length === 0,
    diffCode: diff.code,
    extraUntracked,
  };
}

async function untrackedPathsNotInRef(cwd, ref, timeoutMs) {
  const result = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs });
  const paths = result.stdout.split('\0').filter(Boolean);
  const extra = [];
  for (const filePath of paths) {
    const existsInRef = await runGit(cwd, ['cat-file', '-e', `${ref}:${filePath}`], {
      timeoutMs,
      reject: false,
    });
    if (existsInRef.code !== 0) extra.push(filePath);
  }
  return extra;
}

async function refExists(cwd, ref) {
  const result = await runGit(cwd, ['rev-parse', '--verify', ref], { reject: false });
  return result.code === 0;
}

async function refreshRemoteRef({
  cwd,
  remote,
  branch,
  remoteRef,
  timeoutMs,
  allowStoredRemoteFallback,
}) {
  const fetch = await runGit(cwd, ['fetch', remote, `refs/heads/${branch}:${remoteRef}`], {
    timeoutMs,
    reject: false,
  });
  if (fetch.code === 0) {
    return {
      remoteVerified: true,
      storedRemoteAvailable: true,
      method: 'git-fetch',
      stdout: fetch.stdout.trim(),
      stderr: fetch.stderr.trim(),
    };
  }

  // A stale inherited GITHUB_TOKEN/GH_TOKEN takes precedence over `gh`'s
  // persisted credential and can make git's gh credential helper repeat the
  // same invalid token. Retry once with only the stored gh login before
  // declaring the remote unverifiable.
  const storedAuthFetch = hasGitHubEnvToken()
    ? await runGit(cwd, ['fetch', remote, `refs/heads/${branch}:${remoteRef}`], {
      timeoutMs,
      reject: false,
      extraEnv: storedGitHubAuthEnv(),
    })
    : null;
  if (storedAuthFetch?.code === 0) {
    return {
      remoteVerified: true,
      storedRemoteAvailable: true,
      method: 'git-fetch-stored-gh-auth',
      stdout: storedAuthFetch.stdout.trim(),
      stderr: storedAuthFetch.stderr.trim(),
      fetchError: fetch.stderr.trim() || fetch.stdout.trim(),
    };
  }

  const ghTokenFetch = await fetchRemoteRefWithGhToken({ cwd, remote, branch, remoteRef, timeoutMs });
  if (ghTokenFetch.remoteVerified) {
    return {
      ...ghTokenFetch,
      fetchError: fetch.stderr.trim() || fetch.stdout.trim(),
      storedAuthFetchError: storedAuthFetch
        ? storedAuthFetch.stderr.trim() || storedAuthFetch.stdout.trim()
        : null,
    };
  }

  const ghRefresh = await refreshRemoteRefWithGh({ cwd, remote, branch, remoteRef, timeoutMs });
  if (ghRefresh.remoteVerified) {
    return {
      ...ghRefresh,
      fetchError: fetch.stderr.trim() || fetch.stdout.trim(),
      storedAuthFetchError: storedAuthFetch
        ? storedAuthFetch.stderr.trim() || storedAuthFetch.stdout.trim()
        : null,
      ghTokenFetchError: ghTokenFetch.ghTokenFetchError,
    };
  }

  const storedRemoteAvailable = await refExists(cwd, remoteRef);
  return {
    remoteVerified: false,
    storedRemoteAvailable: allowStoredRemoteFallback && storedRemoteAvailable,
    method: allowStoredRemoteFallback && storedRemoteAvailable ? 'stored-remote-ref' : 'unavailable',
    fetchError: fetch.stderr.trim() || fetch.stdout.trim(),
    storedAuthFetchError: storedAuthFetch
      ? storedAuthFetch.stderr.trim() || storedAuthFetch.stdout.trim()
      : null,
    ghError: ghRefresh.ghError,
    ghTokenFetchError: ghTokenFetch.ghTokenFetchError,
  };
}

export function storedGitHubAuthEnv() {
  return {
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  };
}

function hasGitHubEnvToken() {
  return Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
}

async function fetchRemoteRefWithGhToken({ cwd, remote, branch, remoteRef, timeoutMs }) {
  const repo = await githubRepoForRemote(cwd, remote, timeoutMs);
  if (!repo) {
    return {
      remoteVerified: false,
      storedRemoteAvailable: false,
      ghTokenFetchError: 'remote is not a supported GitHub URL',
    };
  }

  const token = await runGh(cwd, ['auth', 'token'], { timeoutMs, reject: false });
  const value = token.stdout.trim();
  if (token.code !== 0 || !value) {
    return {
      remoteVerified: false,
      storedRemoteAvailable: false,
      ghTokenFetchError: token.stderr.trim() || token.stdout.trim() || `gh auth token returned ${token.code}`,
    };
  }

  const fetch = await runGitWithExtraHeader(cwd, [
    'fetch',
    remote,
    `refs/heads/${branch}:${remoteRef}`,
  ], {
    timeoutMs,
    reject: false,
    token: value,
  });
  if (fetch.code !== 0) {
    return {
      remoteVerified: false,
      storedRemoteAvailable: false,
      ghTokenFetchError: fetch.stderr.trim() || fetch.stdout.trim() || `git fetch returned ${fetch.code}`,
    };
  }

  return {
    remoteVerified: true,
    storedRemoteAvailable: true,
    method: 'git-fetch-gh-token',
    stdout: fetch.stdout.trim(),
    stderr: fetch.stderr.trim(),
  };
}

function runGitWithExtraHeader(cwd, args, { token, timeoutMs = 30_000, reject = true } = {}) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return runCommand('git', cwd, [
    '-c',
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
    ...args,
  ], { timeoutMs, reject });
}

async function refreshRemoteRefWithGh({ cwd, remote, branch, remoteRef, timeoutMs }) {
  const repo = await githubRepoForRemote(cwd, remote, timeoutMs);
  if (!repo) {
    return {
      remoteVerified: false,
      storedRemoteAvailable: false,
      ghError: 'remote is not a supported GitHub URL',
    };
  }

  const result = await runGh(cwd, ['api', githubRefApiPath(repo, branch), '--jq', '.object.sha'], {
    timeoutMs,
    reject: false,
  });
  const remoteHead = result.stdout.trim();
  if (result.code !== 0 || !isSha(remoteHead)) {
    return {
      remoteVerified: false,
      storedRemoteAvailable: false,
      ghError: result.stderr.trim() || result.stdout.trim() || `gh api returned ${result.code}`,
    };
  }

  const update = await runGit(cwd, ['update-ref', remoteRef, remoteHead], { timeoutMs, reject: false });
  if (update.code !== 0) {
    return {
      remoteVerified: true,
      storedRemoteAvailable: false,
      method: 'gh-api-ref',
      remoteHead,
      updateRefError: update.stderr.trim() || update.stdout.trim(),
    };
  }

  return {
    remoteVerified: true,
    storedRemoteAvailable: true,
    method: 'gh-api-ref',
    remoteHead,
  };
}

async function pushRemoteRefWithGh({ cwd, remote, branch, remoteRef, localHead, timeoutMs }) {
  const repo = await githubRepoForRemote(cwd, remote, timeoutMs);
  if (!repo) return { ok: false, ghError: 'remote is not a supported GitHub URL' };

  const update = await runGh(cwd, [
    'api',
    '-X',
    'PATCH',
    githubRefApiPath(repo, branch),
    '-f',
    `sha=${localHead}`,
    '-F',
    'force=false',
    '--jq',
    '.object.sha',
  ], { timeoutMs, reject: false });
  if (update.code === 0 && update.stdout.trim() === localHead) {
    const updateLocal = await runGit(cwd, ['update-ref', remoteRef, localHead], { timeoutMs, reject: false });
    return {
      ok: true,
      method: 'gh-api-update-ref',
      updateRefError: updateLocal.code === 0 ? null : updateLocal.stderr.trim() || updateLocal.stdout.trim(),
    };
  }

  const updateError = update.stderr.trim() || update.stdout.trim();
  if (!isMissingRefError(updateError)) {
    return { ok: false, method: 'gh-api-update-ref', ghError: updateError || `gh api returned ${update.code}` };
  }

  const create = await runGh(cwd, [
    'api',
    '-X',
    'POST',
    `repos/${repo.owner}/${repo.name}/git/refs`,
    '-f',
    `ref=refs/heads/${branch}`,
    '-f',
    `sha=${localHead}`,
    '--jq',
    '.object.sha',
  ], { timeoutMs, reject: false });
  if (create.code === 0 && create.stdout.trim() === localHead) {
    const updateLocal = await runGit(cwd, ['update-ref', remoteRef, localHead], { timeoutMs, reject: false });
    return {
      ok: true,
      method: 'gh-api-create-ref',
      updateRefError: updateLocal.code === 0 ? null : updateLocal.stderr.trim() || updateLocal.stdout.trim(),
    };
  }

  return {
    ok: false,
    method: 'gh-api-create-ref',
    ghError: create.stderr.trim() || create.stdout.trim() || `gh api returned ${create.code}`,
  };
}

async function githubRepoForRemote(cwd, remote, timeoutMs) {
  const result = await runGit(cwd, ['remote', 'get-url', remote], { timeoutMs, reject: false });
  if (result.code !== 0) return null;
  return parseGitHubRemote(result.stdout.trim());
}

function parseGitHubRemote(url) {
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  if (https) return { owner: https[1], name: stripGitSuffix(https[2]) };

  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(url);
  if (scp) return { owner: scp[1], name: stripGitSuffix(scp[2]) };

  const ssh = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(url);
  if (ssh) return { owner: ssh[1], name: stripGitSuffix(ssh[2]) };

  return null;
}

function stripGitSuffix(value) {
  return String(value || '').replace(/\.git$/i, '');
}

function githubRefApiPath(repo, branch) {
  return `repos/${repo.owner}/${repo.name}/git/ref/heads/${branch}`;
}

function isSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || ''));
}

function isMissingRefError(value) {
  return /not found|reference does not exist|404/i.test(String(value || ''));
}

async function gitOutput(cwd, args, options = {}) {
  const result = await runGit(cwd, args, options);
  return result.stdout.trim();
}

export function nonInteractiveGitEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    GIT_ASKPASS: 'true',
    SSH_ASKPASS: 'true',
    PATH: gitToolPath(),
  };
}

export function runGit(cwd, args, { timeoutMs = 30_000, reject = true, extraEnv = {} } = {}) {
  return runCommand('git', cwd, args, { timeoutMs, reject, extraEnv });
}

function runGh(cwd, args, { timeoutMs = 30_000, reject = true } = {}) {
  return runCommand('gh', cwd, args, { timeoutMs, reject });
}

function runCommand(command, cwd, args, { timeoutMs = 30_000, reject = true, extraEnv = {} } = {}) {
  return new Promise((resolve, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...nonInteractiveGitEnv(),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    const timeout = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (reject) {
        rejectPromise(error);
        return;
      }
      resolve({
        code: 127,
        signal: null,
        stdout,
        stderr: error.message,
        timedOut: killed,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const result = { code, signal, stdout, stderr, timedOut: killed };
      if (reject && code !== 0) {
        const error = new Error(`${command} ${args.join(' ')} failed: ${stderr.trim() || stdout.trim()}`);
        Object.assign(error, result);
        rejectPromise(error);
        return;
      }
      resolve(result);
    });
  });
}

function gitToolPath() {
  const hostHome = process.env.BRIDGE_HOST_HOME || process.env.HOME || os.homedir();
  return [...new Set([
    path.dirname(process.execPath),
    path.join(hostHome, '.local', 'bin'),
    ...String(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean))].join(path.delimiter);
}
