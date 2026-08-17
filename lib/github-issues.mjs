import { spawn } from 'node:child_process';
import {
  MAINTENANCE_ISSUE_RESULT_MARKER_CLOSE,
  MAINTENANCE_ISSUE_RESULT_MARKER_OPEN,
} from './maintenance-issue-result.mjs';
import { runGit } from './git-sync.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const RESOLUTION_MARKER_PREFIX = 'bridge-maintenance-resolution';

export function githubRepositoryFromRemoteUrl(remoteUrl) {
  const text = String(remoteUrl || '').trim();
  if (!text) return '';

  let repositoryPath = '';
  try {
    const url = new URL(text);
    if (url.hostname.toLowerCase() !== 'github.com') return '';
    repositoryPath = url.pathname;
  } catch {
    const scpMatch = text.match(/^(?:[^@/\s]+@)?github\.com:\/?(.+)$/i);
    if (!scpMatch) return '';
    repositoryPath = scpMatch[1];
  }

  const parts = repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  if (parts.length !== 2) return '';
  return `${parts[0]}/${parts[1]}`;
}

export async function listOpenGitHubIssues({
  cwd,
  repository,
  limit = 100,
  env = {},
  run = runGitHubCli,
} = {}) {
  const repo = normalizeRepository(repository);
  const result = await run({
    cwd,
    env,
    args: [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      String(Math.max(1, Number.parseInt(limit, 10) || 100)),
      '--json',
      'number,title,body,url,labels,createdAt,updatedAt',
    ],
  });
  assertGitHubCliSuccess(result, 'list open issues');
  const parsed = parseJson(result.stdout, 'GitHub issue list');
  if (!Array.isArray(parsed)) throw new Error('GitHub issue list did not return an array');
  return parsed
    .map(compactGitHubIssue)
    .filter((issue) => issue.number > 0 && issue.title);
}

export function buildGitHubIssueMaintenanceTask({ repository, issue } = {}) {
  const repo = normalizeRepository(repository);
  const compact = compactGitHubIssue(issue);
  if (!compact.number) throw new Error('GitHub issue number is required');

  return [
    'GitHub issue maintenance task.',
    '',
    'This issue is handled separately from the general daily bridge inspection.',
    `Repository: ${repo}`,
    `Issue: #${compact.number} ${compact.title}`,
    `URL: ${compact.url || `https://github.com/${repo}/issues/${compact.number}`}`,
    '',
    'Issue body:',
    truncateText(compact.body, 16_000) || '(empty)',
    '',
    'Required work:',
    '- Reproduce or otherwise verify the reported defect from repository and runtime evidence.',
    '- Inspect the complete affected execution path, implement the smallest safe fix, and add regression coverage.',
    '- Run focused tests and then the full relevant verification. Do not claim success when verification failed.',
    '- Do not create a GitHub comment, close the issue, commit, or push manually. The bridge performs those steps only after it verifies the worker result and remote Git state.',
    '- Keep progress in this work thread. The final visible text is posted as a new general-channel message.',
    '- In the visible final text, report only behavior changed, verification, and any concrete blocker. Do not list source file paths, repeat old changes, or add generic follow-up/token instructions.',
    '',
    'Result protocol:',
    `- End with exactly one ${MAINTENANCE_ISSUE_RESULT_MARKER_OPEN} JSON block.`,
    `- Resolved: ${MAINTENANCE_ISSUE_RESULT_MARKER_OPEN}{"resolved":true,"summary":"one concise Korean description of the verified fix"}${MAINTENANCE_ISSUE_RESULT_MARKER_CLOSE}`,
    `- Existing fix already on the remote branch: ${MAINTENANCE_ISSUE_RESULT_MARKER_OPEN}{"resolved":true,"summary":"verified behavior and tests","head":"exact inspected fix commit SHA"}${MAINTENANCE_ISSUE_RESULT_MARKER_CLOSE}`,
    `- Unresolved: ${MAINTENANCE_ISSUE_RESULT_MARKER_OPEN}{"resolved":false,"reason":"specific blocker or failed verification"}${MAINTENANCE_ISSUE_RESULT_MARKER_CLOSE}`,
    '- Report `head` only after inspecting that commit and running the issue-specific regression test. The bridge independently verifies that the commit is in the remotely verified branch history.',
    '- The bridge removes this block before Discord delivery.',
  ].join('\n');
}

export function buildGitHubIssueMaintenanceStartMessage({ issue } = {}) {
  const compact = compactGitHubIssue(issue);
  if (!compact.number) throw new Error('GitHub issue number is required');
  return [
    `버그 이슈 #${compact.number} 작업 시작`,
    compact.title,
    compact.url || '',
  ].filter(Boolean).join('\n');
}

export function githubIssueMaintenanceThreadTitle(issue = {}, dateLabel = '') {
  const compact = compactGitHubIssue(issue);
  if (!compact.number) throw new Error('GitHub issue number is required');
  const suffix = String(dateLabel || '').trim();
  return truncateText(
    `버그 #${compact.number} ${compact.title}${suffix ? ` ${suffix}` : ''}`,
    100,
  );
}

export function verifiedMaintenanceCommitHead(summary = {}) {
  const head = String(summary?.commit?.commit || '').trim().toLowerCase();
  if (!summary?.commit?.committed || !/^[0-9a-f]{7,64}$/.test(head)) return '';
  const status = summary.statusAfter || summary.statusBefore || {};
  if (summary.synced !== true || status.synced !== true || status.remoteVerified !== true) return '';
  const localHead = String(status.localHead || '').trim().toLowerCase();
  const remoteHead = String(status.remoteHead || '').trim().toLowerCase();
  return localHead === head && remoteHead === head ? head : '';
}

export async function verifiedMaintenanceResolutionHead({
  cwd,
  summary = {},
  reportedHead = '',
  run = runGit,
} = {}) {
  const newlyCommittedHead = verifiedMaintenanceCommitHead(summary);
  if (newlyCommittedHead) return newlyCommittedHead;
  if (String(summary?.commit?.action || '') !== 'no-eligible-changes') return '';

  const candidate = String(reportedHead || '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(candidate)) return '';
  const status = summary.statusAfter || summary.statusBefore || {};
  const remoteHead = String(status.remoteHead || '').trim().toLowerCase();
  const localHead = String(status.localHead || '').trim().toLowerCase();
  if (
    summary.synced !== true
    || status.synced !== true
    || status.remoteVerified !== true
    || !/^[0-9a-f]{7,64}$/.test(remoteHead)
    || localHead !== remoteHead
  ) {
    return '';
  }

  const resolved = await run(cwd, ['rev-parse', '--verify', `${candidate}^{commit}`], {
    reject: false,
  }).catch(() => null);
  const fullHead = String(resolved?.stdout || '').trim().toLowerCase();
  if (Number(resolved?.code) !== 0 || !/^[0-9a-f]{40,64}$/.test(fullHead)) return '';

  const ancestor = await run(cwd, ['merge-base', '--is-ancestor', fullHead, remoteHead], {
    reject: false,
  }).catch(() => null);
  return Number(ancestor?.code) === 0 ? fullHead : '';
}

export async function resolveGitHubIssueWithCommit({
  cwd,
  repository,
  issueNumber,
  head,
  summary,
  env = {},
  run = runGitHubCli,
} = {}) {
  const repo = normalizeRepository(repository);
  const number = normalizeIssueNumber(issueNumber);
  const commitHead = normalizeCommitHead(head);
  const marker = `<!-- ${RESOLUTION_MARKER_PREFIX}:${number}:${commitHead} -->`;
  const view = await run({
    cwd,
    env,
    args: [
      'issue',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'state,comments,url',
    ],
  });
  assertGitHubCliSuccess(view, `inspect issue #${number}`);
  const issue = parseJson(view.stdout, `GitHub issue #${number}`);
  const comments = Array.isArray(issue?.comments) ? issue.comments : [];
  const alreadyCommented = comments.some((comment) => String(comment?.body || '').includes(marker));

  let commented = alreadyCommented;
  if (!alreadyCommented) {
    const body = [
      '새벽 유지보수에서 해결하고 원격 반영까지 검증했습니다.',
      '',
      `- 개선: ${normalizeSummary(summary)}`,
      `- 커밋 HEAD: \`${commitHead}\``,
      '',
      marker,
    ].join('\n');
    const comment = await run({
      cwd,
      env,
      args: ['issue', 'comment', String(number), '--repo', repo, '--body', body],
    });
    assertGitHubCliSuccess(comment, `comment on issue #${number}`);
    commented = true;
  }

  const alreadyClosed = String(issue?.state || '').toUpperCase() === 'CLOSED';
  let closed = alreadyClosed;
  if (!alreadyClosed) {
    const close = await run({
      cwd,
      env,
      args: ['issue', 'close', String(number), '--repo', repo, '--reason', 'completed'],
    });
    assertGitHubCliSuccess(close, `close issue #${number}`);
    closed = true;
  }

  return {
    repository: repo,
    issueNumber: number,
    head: commitHead,
    url: String(issue?.url || `https://github.com/${repo}/issues/${number}`),
    commented,
    commentAlreadyPresent: alreadyCommented,
    closed,
    alreadyClosed,
  };
}

export function compactGitHubIssue(issue = {}) {
  return {
    number: normalizeIssueNumber(issue.number, { required: false }),
    title: truncateText(issue.title, 300),
    body: truncateText(issue.body, 50_000),
    url: truncateText(issue.url, 2_000),
    createdAt: truncateText(issue.createdAt, 100),
    updatedAt: truncateText(issue.updatedAt, 100),
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((label) => truncateText(label?.name ?? label, 100)).filter(Boolean).slice(0, 20)
      : [],
  };
}

export async function runGitHubCli({
  cwd,
  args = [],
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      reject(new Error(`gh timed out after ${timeoutMs}ms`));
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal: signal || null, stdout, stderr });
    });
  });
}

function normalizeRepository(repository) {
  const text = String(repository || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(text)) throw new Error(`invalid GitHub repository: ${text || '(empty)'}`);
  return text;
}

function normalizeIssueNumber(value, { required = true } = {}) {
  const number = Number.parseInt(value, 10);
  if (Number.isInteger(number) && number > 0) return number;
  if (!required) return 0;
  throw new Error(`invalid GitHub issue number: ${value}`);
}

function normalizeCommitHead(value) {
  const text = String(value || '').trim();
  if (!/^[0-9a-f]{7,64}$/i.test(text)) throw new Error(`invalid commit HEAD: ${text || '(empty)'}`);
  return text.toLowerCase();
}

function normalizeSummary(value) {
  return truncateText(String(value || '').replace(/\s+/g, ' ').trim(), 2_000) || '검증된 수정 적용';
}

function assertGitHubCliSuccess(result, action) {
  if (Number(result?.code) === 0) return;
  const detail = String(result?.stderr || result?.stdout || '').trim();
  throw new Error(`failed to ${action}: ${detail || `gh exited ${result?.code ?? 'unknown'}`}`);
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value || ''));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function truncateText(value, maxChars) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}
