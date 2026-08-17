import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { statePathPart } from './config.mjs';
import { formatJobCheckpointMarkdown } from './job-checkpoint.mjs';
import { rootJobId } from './job-id.mjs';

const DEFAULT_HANDOFF_MAX_CHARS = 64_000;
const DEFAULT_CHECKPOINT_MAX_CHARS = 1_000_000;
const DEFAULT_HANDOFF_MAX_ITEMS = 3;
const FINAL_OUTPUT_EXCERPT_CHARS = 4_000;
const SAVED_FINAL_OUTPUT_CONTEXT_CHARS = 48_000;
const WORKER_OUTPUT_EXCERPT_CHARS = 2_500;
const UPDATE_EXCERPT_CHARS = 3_000;
const UPDATE_TEXT_CHARS = 900;
const MAX_VISIBLE_UPDATES_PER_WORKER = 8;
const INTERRUPTED_HANDOFF_STATUSES = new Set(['interrupted', 'superseded']);
const SUPERSEDED_REQUEST_NEXT_ACTION = 'Process the current user request; this checkpoint belongs to a superseded request and is context only.';
const SUPERSEDED_REQUEST_NOTICE = 'This handoff belongs to a superseded request. Use it only as background context; process the current user request and never return or replay the prior saved final output.';

export function jobTranscriptRoot(threadRoot, job = {}) {
  const attempt = Number(job.attempt || 1);
  const attemptSuffix = attempt > 1 ? `-attempt-${attempt}` : '';
  return path.join(threadRoot, 'jobs', 'transcripts', `${statePathPart(job.id)}${attemptSuffix}`);
}

export function buildJobHandoffMarkdown({
  job = {},
  result = {},
  status = 'succeeded',
  error = '',
  savedAt = new Date().toISOString(),
  transcriptRoot = '',
  threadRoot = '',
  promptPath = '',
  finalOutputPath = '',
  workerTranscripts = [],
  transcriptEntries = [],
  checkpoint = null,
  checkpointPath = '',
} = {}) {
  const relativeTranscriptRoot = transcriptRoot && threadRoot ? relativeStatePath(threadRoot, transcriptRoot) : '';
  const lines = [
    '# Previous Worker Handoff',
    '',
    `- jobId: ${job.id || '(unknown)'}`,
    `- status: ${status}`,
    `- savedAt: ${savedAt}`,
    `- worker: ${result.worker || '(none)'}`,
    `- transcriptRoot: ${relativeTranscriptRoot || '(unknown)'}`,
    `- promptPath: ${promptPath && threadRoot ? relativeStatePath(threadRoot, promptPath) : '(none)'}`,
    `- finalOutputPath: ${finalOutputPath && threadRoot ? relativeStatePath(threadRoot, finalOutputPath) : '(none)'}`,
  ];

  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  if (attempts.length > 0) {
    lines.push('', '## Worker Attempts');
    for (const attempt of attempts) {
      const detail = attempt.error ? ` error=${singleLine(attempt.error, 240)}` : '';
      lines.push(`- ${attempt.worker || '(unknown)'}: ${attempt.status || '(unknown)'}${detail}`);
    }
  }

  const errorText = String(error || result.error || '').trim();
  if (errorText) {
    lines.push('', '## Error', fenced(excerpt(errorText, 1_500)));
  }

  const finalOutput = String(result.output || '').trim();
  if (finalOutput) {
    lines.push('', '## Final Output', fenced(excerpt(finalOutput, FINAL_OUTPUT_EXCERPT_CHARS)));
  }

  const checkpointMarkdown = formatJobCheckpointMarkdown(checkpoint, {
    checkpointPath: checkpointPath && threadRoot
      ? relativeStatePath(threadRoot, checkpointPath)
      : checkpointPath,
  }).trim();
  if (checkpointMarkdown) lines.push('', checkpointMarkdown);

  const workerSections = workerTranscriptSections(workerTranscripts, transcriptEntries, {
    includeReasoning: INTERRUPTED_HANDOFF_STATUSES.has(String(status || '')) && !finalOutput,
  });
  if (workerSections.length > 0) lines.push('', '## Worker Visible Output', ...workerSections);

  return `${lines.join('\n').trimEnd()}\n`;
}

export async function previousJobHandoffContext({
  threadRoot,
  job = {},
  maxHandoffs = DEFAULT_HANDOFF_MAX_ITEMS,
  maxChars = DEFAULT_HANDOFF_MAX_CHARS,
  currentInputFingerprint = null,
} = {}) {
  if (!threadRoot) return '';

  const entries = await readJsonl(path.join(threadRoot, 'jobs', 'jobs.jsonl'));
  if (!shouldLoadPreviousHandoffs(job) && !hasSupersededJobHandoffs(entries, job)) return '';

  const candidates = previousTranscriptEntries(entries, job)
    .slice(-Math.max(1, maxHandoffs));
  if (candidates.length === 0) return '';

  const handoffs = [];
  const currentRequestRootId = requestRootJobId(job);
  for (const entry of candidates) {
    const handoff = await readHandoffEntry(threadRoot, entry, {
      currentInputFingerprint,
      requestMatchesCurrentJob: rootJobId(entry.id) === currentRequestRootId,
    });
    if (handoff) handoffs.push(handoff);
  }

  return limitMarkdownBlocks(handoffs, maxChars);
}

export async function previousJobWorkerDurationMs({
  threadRoot,
  job = {},
} = {}) {
  if (!threadRoot || !job.id) return 0;

  const entries = await readJsonl(path.join(threadRoot, 'jobs', 'jobs.jsonl'));
  const previousIds = previousDurationJobIds(entries, job);
  if (previousIds.size === 0) return 0;

  const currentTranscriptRoot = path.resolve(jobTranscriptRoot(threadRoot, job));
  const manifests = new Map();
  for (const entry of entries) {
    if (String(entry?.status || '') !== 'transcript-saved') continue;
    if (!previousIds.has(String(entry.id || ''))) continue;
    const manifestPath = resolveUnder(threadRoot, entry.manifestPath);
    if (!manifestPath || path.dirname(manifestPath) === currentTranscriptRoot) continue;
    manifests.set(manifestPath, manifestPath);
  }

  let durationMs = 0;
  for (const manifestPath of manifests.values()) {
    const manifest = await readJsonFile(manifestPath);
    durationMs += workerTranscriptsDurationMs(manifest?.workerTranscripts);
  }
  return durationMs;
}

export function shouldLoadPreviousHandoffs(job = {}) {
  if (job.recoveredFromJobId) return true;
  if (rootJobId(job.id) !== String(job.id || '')) return true;
  return Number(job.attempt || 1) > 1;
}

export function previousTranscriptEntries(entries = [], job = {}) {
  const targetRootId = requestRootJobId(job);
  const includeSameId = Boolean(job.recoveredFromJobId) || Number(job.attempt || 1) > 1;
  const supersededRootIds = supersededJobRootIdsFor(job, entries);
  const byPath = new Map();

  for (const entry of entries) {
    if (!isHandoffStateEntry(entry)) continue;
    const entryRootId = rootJobId(entry.id);
    const matchesContinuationRoot = entryRootId === targetRootId;
    const matchesSupersededRoot = supersededRootIds.has(entryRootId);
    if (!matchesContinuationRoot && !matchesSupersededRoot) continue;
    if (!includeSameId && String(entry.id || '') === String(job.id || '')) continue;
    const handoffPath = String(entry.handoffPath || '').trim();
    const manifestPath = String(entry.manifestPath || '').trim();
    const checkpointPath = String(entry.checkpointPath || '').trim();
    if (!handoffPath && !manifestPath && !checkpointPath) continue;
    const stateKey = String(entry.transcriptRoot || '').trim()
      || path.posix.dirname(handoffPath || manifestPath || checkpointPath);
    byPath.set(`${entry.id}:${entry.attempt || 1}:${stateKey}`, {
      ...(byPath.get(`${entry.id}:${entry.attempt || 1}:${stateKey}`) || {}),
      ...entry,
    });
  }

  return [...byPath.values()].sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
}

function hasSupersededJobHandoffs(entries = [], job = {}) {
  const supersededRootIds = supersededJobRootIdsFor(job, entries);
  if (supersededRootIds.size === 0) return false;
  return entries.some((entry) =>
    isHandoffStateEntry(entry)
      && supersededRootIds.has(rootJobId(entry.id)),
  );
}

function supersededJobRootIdsFor(job = {}, entries = []) {
  const jobId = String(job.id || '');
  if (!jobId) return new Set();
  return new Set((Array.isArray(entries) ? entries : [])
    .filter((entry) => String(entry?.supersededByJobId || '') === jobId)
    .map((entry) => rootJobId(entry.id))
    .filter(Boolean));
}

function previousDurationJobIds(entries = [], job = {}) {
  const currentId = String(job.id || '');
  if (!currentId) return new Set();

  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String(entry?.id || '');
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...entry });
  }
  byId.set(currentId, { ...(byId.get(currentId) || {}), ...job, id: currentId });

  const linkedIds = new Set([currentId]);
  const pending = [currentId];
  while (pending.length > 0) {
    const id = pending.shift();
    const record = byId.get(id) || {};
    const recoveredFromJobId = String(record.recoveredFromJobId || '');
    if (recoveredFromJobId) addLinkedJobId(recoveredFromJobId, linkedIds, pending);

    const rootId = rootJobId(id);
    for (const candidate of byId.values()) {
      const candidateId = String(candidate.id || '');
      if (!candidateId || candidateId === currentId) continue;
      if (String(candidate.supersededByJobId || '') === id || rootJobId(candidateId) === rootId) {
        addLinkedJobId(candidateId, linkedIds, pending);
      }
    }
  }

  linkedIds.delete(currentId);
  // Retries reuse the same job id, so keep the id as a transcript candidate;
  // the current attempt directory itself is excluded by path above.
  if (Number(job.attempt || 1) > 1) linkedIds.add(currentId);
  return linkedIds;
}

function addLinkedJobId(id, linkedIds, pending) {
  if (!id || linkedIds.has(id)) return;
  linkedIds.add(id);
  pending.push(id);
}

function workerTranscriptsDurationMs(workerTranscripts = []) {
  return (Array.isArray(workerTranscripts) ? workerTranscripts : []).reduce((total, transcript) => {
    const startedAt = Date.parse(String(transcript?.startedAt || ''));
    const finishedAt = Date.parse(String(transcript?.finishedAt || ''));
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return total;
    return total + (finishedAt - startedAt);
  }, 0);
}

function workerTranscriptSections(workerTranscripts = [], transcriptEntries = [], {
  includeReasoning = false,
} = {}) {
  const sections = [];
  const entriesByIndex = Array.isArray(transcriptEntries) ? transcriptEntries : [];
  for (const [index, transcript] of (Array.isArray(workerTranscripts) ? workerTranscripts : []).entries()) {
    const worker = transcript.worker || `worker-${index + 1}`;
    const metadata = entriesByIndex[index] || {};
    const workerLines = [
      '',
      `### ${worker}`,
      `- status: ${transcript.status || '(unknown)'}`,
    ];
    if (metadata.outputPath) workerLines.push(`- outputPath: ${metadata.outputPath}`);
    if (metadata.stdoutPath) workerLines.push(`- stdoutPath: ${metadata.stdoutPath}`);
    if (metadata.stderrPath) workerLines.push(`- stderrPath: ${metadata.stderrPath}`);
    if (transcript.error) workerLines.push(`- error: ${singleLine(transcript.error, 240)}`);

    const output = String(transcript.output || '').trim();
    if (output) workerLines.push('', 'Output:', fenced(excerpt(output, WORKER_OUTPUT_EXCERPT_CHARS)));

    const visibleUpdates = visibleWorkerUpdates(transcript.updates);
    if (visibleUpdates) workerLines.push('', 'Visible updates:', fenced(visibleUpdates));

    if (includeReasoning) {
      const reasoningSummaries = interruptedReasoningSummaries(transcript.updates);
      if (reasoningSummaries) {
        workerLines.push('', 'Interrupted reasoning summaries:', fenced(reasoningSummaries));
      }
    }

    if (workerLines.length > 3) sections.push(...workerLines);
  }
  return sections;
}

function visibleWorkerUpdates(updates = []) {
  const visible = (Array.isArray(updates) ? updates : [])
    .filter((update) => String(update?.type || '') === 'response_text')
    .map((update) => String(update.text || '').trim())
    .filter(Boolean)
    .slice(-MAX_VISIBLE_UPDATES_PER_WORKER)
    .map((text) => excerpt(text, UPDATE_TEXT_CHARS));
  return excerpt(visible.join('\n\n'), UPDATE_EXCERPT_CHARS);
}

function interruptedReasoningSummaries(updates = []) {
  const summaries = (Array.isArray(updates) ? updates : [])
    .filter((update) => String(update?.type || '') === 'reasoning')
    .map((update) => String(update.text || '').trim())
    .filter(Boolean)
    .slice(-MAX_VISIBLE_UPDATES_PER_WORKER)
    .map((text) => excerpt(text, UPDATE_TEXT_CHARS));
  return excerpt(summaries.join('\n\n'), UPDATE_EXCERPT_CHARS);
}

async function readHandoffEntry(threadRoot, entry = {}, {
  currentInputFingerprint = null,
  requestMatchesCurrentJob = true,
} = {}) {
  const checkpoint = await readRelativeJson(threadRoot, entry.checkpointPath);
  if (checkpoint) {
    return checkpointHandoffContext(threadRoot, entry, checkpoint, {
      currentInputFingerprint,
      requestMatchesCurrentJob,
    });
  }

  const direct = await readRelativeText(threadRoot, entry.handoffPath, DEFAULT_HANDOFF_MAX_CHARS);
  if (direct) {
    return requestMatchesCurrentJob ? direct : supersededRequestHandoffContext(direct);
  }

  const manifestText = await readRelativeText(threadRoot, entry.manifestPath, DEFAULT_HANDOFF_MAX_CHARS);
  if (!manifestText) return '';
  let manifest = null;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return '';
  }

  const fromManifest = await readRelativeText(threadRoot, manifest.handoffPath, DEFAULT_HANDOFF_MAX_CHARS);
  if (fromManifest) {
    return requestMatchesCurrentJob
      ? fromManifest
      : supersededRequestHandoffContext(fromManifest);
  }

  const output = requestMatchesCurrentJob
    ? await readRelativeText(threadRoot, manifest.finalOutputPath, FINAL_OUTPUT_EXCERPT_CHARS)
    : '';
  const lines = [
    '# Previous Worker Handoff',
    '',
    `- jobId: ${manifest.jobId || entry.id || '(unknown)'}`,
    `- status: ${manifest.status || entry.transcriptStatus || '(unknown)'}`,
    `- savedAt: ${manifest.savedAt || entry.updatedAt || '(unknown)'}`,
    `- worker: ${manifest.worker || entry.worker || '(none)'}`,
    `- manifestPath: ${entry.manifestPath || '(none)'}`,
  ];
  if (output.trim()) lines.push('', '## Final Output', fenced(excerpt(output, FINAL_OUTPUT_EXCERPT_CHARS)));
  if (!requestMatchesCurrentJob) appendSupersededRequestNotice(lines);
  return `${lines.join('\n').trimEnd()}\n`;
}

async function checkpointHandoffContext(
  threadRoot,
  entry,
  checkpoint,
  {
    currentInputFingerprint = null,
    requestMatchesCurrentJob = true,
  } = {},
) {
  const effectiveCheckpoint = structuredClone(checkpoint);
  let savedFinalOutput = '';
  let finalOutputProblem = '';
  if (!requestMatchesCurrentJob) {
    effectiveCheckpoint.final_answer_ready = false;
    effectiveCheckpoint.final_answer_path = null;
    effectiveCheckpoint.final_answer_sha256 = null;
    effectiveCheckpoint.next_action = SUPERSEDED_REQUEST_NEXT_ACTION;
  } else if (effectiveCheckpoint.final_answer_ready) {
    savedFinalOutput = await readRelativeTextExact(
      threadRoot,
      effectiveCheckpoint.final_answer_path,
    );
    const expectedHash = String(effectiveCheckpoint.final_answer_sha256 || '');
    const actualHash = savedFinalOutput !== null ? sha256(savedFinalOutput) : '';
    if (savedFinalOutput === null) {
      finalOutputProblem = 'The checkpoint claimed finalAnswerReady=true, but the saved final output file is missing.';
    } else if (!expectedHash || actualHash !== expectedHash) {
      finalOutputProblem = 'The saved final output failed its SHA-256 integrity check.';
    }
    if (finalOutputProblem) {
      effectiveCheckpoint.final_answer_ready = false;
      effectiveCheckpoint.next_action = 'Recover the missing or corrupt final output before reporting completion.';
    }
  }

  const rendered = formatJobCheckpointMarkdown(effectiveCheckpoint, {
    checkpointPath: entry.checkpointPath,
    currentInputFingerprint,
  }).trim();
  const lines = [
    '# Previous Worker Handoff',
    '',
    `- jobId: ${checkpoint.job_id || entry.id || '(unknown)'}`,
    `- savedAt: ${checkpoint.updated_at || entry.updatedAt || '(unknown)'}`,
    '',
    rendered,
  ];
  if (!requestMatchesCurrentJob) {
    appendSupersededRequestNotice(lines);
  } else if (finalOutputProblem) {
    lines.push('', '## Final Output Integrity Warning', finalOutputProblem);
  } else if (effectiveCheckpoint.final_answer_ready) {
    lines.push(
      '',
      '## Saved Final Output',
      fenced(excerpt(savedFinalOutput, SAVED_FINAL_OUTPUT_CONTEXT_CHARS)),
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function supersededRequestHandoffContext(markdown) {
  const sanitized = removeMarkdownSections(markdown, new Set(['Final Output', 'Saved Final Output']))
    .replace(/^- finalAnswerReady:\s*true\s*$/gmi, '- finalAnswerReady: false')
    .replace(/^- finalAnswerPath:.*$/gmi, '')
    .replace(/^- finalAnswerSha256:.*$/gmi, '')
    .replace(
      /^- The final answer is already prepared\..*$/gmi,
      `- ${SUPERSEDED_REQUEST_NEXT_ACTION}`,
    )
    .trimEnd();
  const lines = [sanitized];
  appendSupersededRequestNotice(lines);
  return `${lines.join('\n').trimEnd()}\n`;
}

function removeMarkdownSections(markdown, sectionTitles) {
  const kept = [];
  let skipping = false;
  let inFence = false;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (!skipping) kept.push(line);
      continue;
    }
    if (!inFence) {
      const heading = line.match(/^#{1,2}\s+(.+?)\s*$/);
      if (heading) {
        skipping = sectionTitles.has(heading[1]);
        if (skipping) continue;
      }
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n');
}

function appendSupersededRequestNotice(lines) {
  lines.push('', '## Request Boundary', SUPERSEDED_REQUEST_NOTICE);
}

function requestRootJobId(job = {}) {
  return rootJobId(job.recoveredFromJobId || job.id);
}

async function readRelativeJson(root, relativePath) {
  const text = await readRelativeText(root, relativePath, DEFAULT_CHECKPOINT_MAX_CHARS);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readRelativeTextExact(root, relativePath) {
  const target = resolveUnder(root, relativePath);
  if (!target) return null;
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readRelativeText(root, relativePath, maxChars) {
  const text = await readRelativeTextExact(root, relativePath);
  return text === null ? '' : excerpt(text, maxChars);
}

function resolveUnder(root, relativePath) {
  if (!root || !relativePath) return null;
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, String(relativePath));
  const relative = path.relative(resolvedRoot, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return target;
  return null;
}

function isHandoffStateEntry(entry = {}) {
  return ['transcript-saved', 'checkpoint-saved'].includes(String(entry.status || ''));
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function limitMarkdownBlocks(blocks, maxChars) {
  const limited = [];
  let remaining = Math.max(1, Number(maxChars) || DEFAULT_HANDOFF_MAX_CHARS);
  for (const block of [...blocks].reverse()) {
    if (remaining <= 0) break;
    const text = String(block || '').trim();
    if (!text) continue;
    const value = text.length > remaining ? excerpt(text, remaining) : text;
    limited.unshift(value);
    remaining -= value.length + 2;
  }
  return limited.join('\n\n').trim();
}

function entryTimeMs(entry = {}) {
  for (const key of ['updatedAt', 'finishedAt', 'savedAt', 'createdAt', 'timestamp', 'recoveredAt']) {
    const value = Date.parse(entry[key] || '');
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function excerpt(value, maxChars) {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  const limit = Math.max(1, Number(maxChars) || 1);
  if (text.length <= limit) return text;
  return `[truncated; showing last ${limit} chars]\n${text.slice(-limit)}`;
}

function singleLine(value, maxChars) {
  return excerpt(String(value || '').replace(/\s+/g, ' '), maxChars);
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function fenced(value) {
  const text = String(value || '').replace(/```/g, '` ` `');
  return `\`\`\`text\n${text}\n\`\`\``;
}

function relativeStatePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}
