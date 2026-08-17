import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildJobHandoffMarkdown,
  jobTranscriptRoot,
  previousJobHandoffContext,
  previousJobWorkerDurationMs,
  previousTranscriptEntries,
  shouldLoadPreviousHandoffs,
} from '../lib/job-transcript.mjs';

test('buildJobHandoffMarkdown keeps visible worker output without raw reasoning updates', () => {
  const threadRoot = '/tmp/state/channel/thread';
  const transcriptRoot = path.join(threadRoot, 'jobs', 'transcripts', 'job-a');
  const handoff = buildJobHandoffMarkdown({
    job: { id: 'job-a' },
    result: {
      worker: 'codex',
      output: 'final answer',
      attempts: [{ worker: 'codex', status: 'succeeded' }],
    },
    status: 'succeeded',
    savedAt: '2026-06-10T01:00:00.000Z',
    threadRoot,
    transcriptRoot,
    promptPath: path.join(transcriptRoot, 'prompt.md'),
    finalOutputPath: path.join(transcriptRoot, 'final.md'),
    workerTranscripts: [{
      worker: 'codex',
      status: 'succeeded',
      output: 'worker output',
      updates: [
        { type: 'reasoning', text: 'internal-looking summary' },
        { type: 'response_text', text: 'checking files' },
      ],
    }],
    transcriptEntries: [{
      outputPath: 'jobs/transcripts/job-a/01-codex/output.md',
      stdoutPath: 'jobs/transcripts/job-a/01-codex/stdout.log',
      stderrPath: 'jobs/transcripts/job-a/01-codex/stderr.log',
    }],
  });

  assert.match(handoff, /jobId: job-a/);
  assert.match(handoff, /final answer/);
  assert.match(handoff, /checking files/);
  assert.match(handoff, /stdout\.log/);
  assert.doesNotMatch(handoff, /internal-looking summary/);
});

test('buildJobHandoffMarkdown includes reasoning summaries only for an interrupted unanswered job', () => {
  const threadRoot = '/tmp/state/channel/thread';
  const transcriptRoot = path.join(threadRoot, 'jobs', 'transcripts', 'job-a');
  const interrupted = buildJobHandoffMarkdown({
    job: { id: 'job-a' },
    result: {
      worker: 'codex',
      output: '',
      attempts: [{ worker: 'codex', status: 'failed' }],
    },
    status: 'superseded',
    savedAt: '2026-06-10T01:00:00.000Z',
    threadRoot,
    transcriptRoot,
    workerTranscripts: [{
      worker: 'codex',
      status: 'failed',
      output: '',
      updates: [
        { type: 'reasoning', text: 'traced the duplicate work to the context filter' },
        { type: 'response_text', text: 'inspecting the transcript path' },
      ],
    }],
  });

  assert.match(interrupted, /Interrupted reasoning summaries:/);
  assert.match(interrupted, /traced the duplicate work to the context filter/);
  assert.match(interrupted, /inspecting the transcript path/);

  const interruptedButAnswered = buildJobHandoffMarkdown({
    job: { id: 'job-answered-before-interrupt' },
    result: { worker: 'codex', output: 'answer already emitted' },
    status: 'superseded',
    savedAt: '2026-06-10T01:00:30.000Z',
    threadRoot,
    transcriptRoot: path.join(threadRoot, 'jobs', 'transcripts', 'job-answered-before-interrupt'),
    workerTranscripts: [{
      worker: 'codex',
      status: 'succeeded',
      output: 'answer already emitted',
      updates: [{ type: 'reasoning', text: 'must stay out when an answer exists' }],
    }],
  });

  assert.doesNotMatch(interruptedButAnswered, /Interrupted reasoning summaries:/);
  assert.doesNotMatch(interruptedButAnswered, /must stay out when an answer exists/);

  const answered = buildJobHandoffMarkdown({
    job: { id: 'job-b' },
    result: { worker: 'codex', output: 'done' },
    status: 'succeeded',
    savedAt: '2026-06-10T01:01:00.000Z',
    threadRoot,
    transcriptRoot: path.join(threadRoot, 'jobs', 'transcripts', 'job-b'),
    workerTranscripts: [{
      worker: 'codex',
      status: 'succeeded',
      output: 'done',
      updates: [{ type: 'reasoning', text: 'must stay out after an answer' }],
    }],
  });

  assert.doesNotMatch(answered, /Interrupted reasoning summaries:/);
  assert.doesNotMatch(answered, /must stay out after an answer/);
});

test('jobTranscriptRoot preserves retry attempts without overwriting the first transcript', () => {
  const threadRoot = '/tmp/state/channel/thread';

  assert.equal(
    jobTranscriptRoot(threadRoot, { id: 'job-a', attempt: 1 }),
    path.join(threadRoot, 'jobs', 'transcripts', 'job-a'),
  );
  assert.equal(
    jobTranscriptRoot(threadRoot, { id: 'job-a', attempt: 2 }),
    path.join(threadRoot, 'jobs', 'transcripts', 'job-a-attempt-2'),
  );
});

test('previousJobHandoffContext loads matching root job handoffs only for continuation jobs', async () => {
  const threadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-job-transcript-'));
  const transcriptDir = path.join(threadRoot, 'jobs', 'transcripts', 'job-a');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'handoff.md'), '# Previous Worker Handoff\n\nchecking files\n');
  await fs.mkdir(path.join(threadRoot, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(threadRoot, 'jobs', 'jobs.jsonl'), [
    JSON.stringify({
      id: 'job-a',
      status: 'transcript-saved',
      updatedAt: '2026-06-10T01:00:00.000Z',
      handoffPath: 'jobs/transcripts/job-a/handoff.md',
    }),
    JSON.stringify({
      id: 'job-b',
      status: 'transcript-saved',
      updatedAt: '2026-06-10T01:01:00.000Z',
      handoffPath: 'jobs/transcripts/job-b/handoff.md',
    }),
  ].join('\n') + '\n');

  assert.equal(shouldLoadPreviousHandoffs({ id: 'job-a' }), false);
  assert.equal(shouldLoadPreviousHandoffs({ id: 'job-a_continue_20260610100000' }), true);
  assert.deepEqual(
    previousTranscriptEntries([
      { id: 'job-a', status: 'transcript-saved', handoffPath: 'a', updatedAt: '2026-06-10T01:00:00.000Z' },
      { id: 'job-b', status: 'transcript-saved', handoffPath: 'b', updatedAt: '2026-06-10T01:01:00.000Z' },
    ], { id: 'job-a_continue_20260610100000' }).map((entry) => entry.id),
    ['job-a'],
  );

  const normalContext = await previousJobHandoffContext({
    threadRoot,
    job: { id: 'job-a' },
  });
  assert.equal(normalContext, '');

  const continuationContext = await previousJobHandoffContext({
    threadRoot,
    job: { id: 'job-a_continue_20260610100000', recoveredFromJobId: 'job-a' },
  });
  assert.match(continuationContext, /checking files/);
});

test('previousJobHandoffContext prefers the structured checkpoint and exposes fingerprint validity', async () => {
  const threadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-job-checkpoint-context-'));
  const transcriptDir = path.join(threadRoot, 'jobs', 'transcripts', 'job-a');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'handoff.md'), 'stale legacy handoff that must not win\n');
  await fs.writeFile(path.join(transcriptDir, 'checkpoint.json'), `${JSON.stringify({
    schema_version: 2,
    job_id: 'job-a',
    status: 'interrupted',
    updated_at: '2026-07-28T01:00:00.000Z',
    input_fingerprint: 'fingerprint-a',
    workspace: { current: { available: true } },
    plan: [
      { step: 'inspect repository', status: 'completed' },
      { step: 'run targeted tests', status: 'in_progress' },
    ],
    completed_actions: [
      { kind: 'plan_step', status: 'completed', summary: 'inspect repository' },
    ],
    pending_actions: [
      { kind: 'plan_step', status: 'in_progress', summary: 'run targeted tests' },
    ],
    next_action: 'run targeted tests',
    commands: [{
      status: 'completed',
      exit_code: 0,
      cwd: '/tmp/project',
      command: 'rg -n checkpoint lib',
      evidence_fingerprint: 'fingerprint-a',
    }],
    changed_files: [],
    test_results: [],
    external_side_effects: [],
    final_answer_ready: false,
  }, null, 2)}\n`);
  await fs.mkdir(path.join(threadRoot, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(threadRoot, 'jobs', 'jobs.jsonl'), [
    JSON.stringify({
      id: 'job-a',
      status: 'checkpoint-saved',
      updatedAt: '2026-07-28T01:00:00.000Z',
      attempt: 1,
      transcriptRoot: 'jobs/transcripts/job-a',
      checkpointPath: 'jobs/transcripts/job-a/checkpoint.json',
    }),
    JSON.stringify({
      id: 'job-a',
      status: 'transcript-saved',
      updatedAt: '2026-07-28T01:00:01.000Z',
      attempt: 1,
      transcriptRoot: 'jobs/transcripts/job-a',
      handoffPath: 'jobs/transcripts/job-a/handoff.md',
      checkpointPath: 'jobs/transcripts/job-a/checkpoint.json',
    }),
  ].join('\n') + '\n');

  const context = await previousJobHandoffContext({
    threadRoot,
    job: { id: 'job-a_continue_20260728110000', recoveredFromJobId: 'job-a' },
    currentInputFingerprint: 'fingerprint-a',
  });

  assert.match(context, /Structured Execution Checkpoint/);
  assert.match(context, /inputFingerprintMatches: true/);
  assert.match(context, /nextAction: run targeted tests/);
  assert.match(context, /inspect repository/);
  assert.match(context, /rg -n checkpoint lib/);
  assert.doesNotMatch(context, /stale legacy handoff that must not win/);
});

test('previousJobHandoffContext returns an integrity-checked saved final without replaying work', async () => {
  const threadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-job-final-context-'));
  const transcriptDir = path.join(threadRoot, 'jobs', 'transcripts', 'job-final');
  const finalOutput = '적용과 검증을 완료했습니다.\n';
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'final.md'), finalOutput);
  await fs.writeFile(path.join(transcriptDir, 'checkpoint.json'), `${JSON.stringify({
    schema_version: 2,
    job_id: 'job-final',
    status: 'succeeded',
    updated_at: '2026-07-28T01:00:00.000Z',
    input_fingerprint: 'fingerprint-final',
    workspace: { current: { available: true } },
    plan: [{ step: 'implement and verify', status: 'completed' }],
    completed_actions: [],
    pending_actions: [],
    next_action: null,
    commands: [],
    changed_files: [],
    test_results: [],
    external_side_effects: [],
    final_answer_ready: true,
    final_answer_path: 'jobs/transcripts/job-final/final.md',
    final_answer_sha256: sha256(finalOutput),
  }, null, 2)}\n`);
  await fs.mkdir(path.join(threadRoot, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(threadRoot, 'jobs', 'jobs.jsonl'), `${JSON.stringify({
    id: 'job-final',
    status: 'checkpoint-saved',
    updatedAt: '2026-07-28T01:00:00.000Z',
    checkpointPath: 'jobs/transcripts/job-final/checkpoint.json',
  })}\n`);

  const continuationJob = {
    id: 'job-final_continue_20260728110000',
    recoveredFromJobId: 'job-final',
  };
  const validContext = await previousJobHandoffContext({
    threadRoot,
    job: continuationJob,
    currentInputFingerprint: 'fingerprint-final',
  });

  assert.match(validContext, /finalAnswerReady: true/);
  assert.match(validContext, /inputFingerprintMatches: true/);
  assert.match(validContext, /Saved Final Output/);
  assert.match(validContext, /적용과 검증을 완료했습니다/);
  assert.match(validContext, /Return the saved final output without rerunning/);

  await fs.writeFile(path.join(transcriptDir, 'final.md'), 'tampered output\n');
  const corruptContext = await previousJobHandoffContext({
    threadRoot,
    job: continuationJob,
    currentInputFingerprint: 'fingerprint-final',
  });

  assert.match(corruptContext, /finalAnswerReady: false/);
  assert.match(corruptContext, /Final Output Integrity Warning/);
  assert.match(corruptContext, /failed its SHA-256 integrity check/);
  assert.doesNotMatch(corruptContext, /## Saved Final Output/);
});

test('a fresh request cannot inherit a saved final from the runtime-restart continuation it superseded', async () => {
  const threadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-job-request-boundary-'));
  const originalJobId = 'job-runtime-restart';
  const continuationJobId = `${originalJobId}_continue_20260728170050235002`;
  const currentJobId = 'job-new-request';
  const originalTranscriptDir = path.join(threadRoot, 'jobs', 'transcripts', originalJobId);
  const continuationTranscriptDir = path.join(threadRoot, 'jobs', 'transcripts', continuationJobId);
  const staleFinalOutput = '이전 요청의 완료 답변입니다.\n';
  await fs.mkdir(originalTranscriptDir, { recursive: true });
  await fs.mkdir(continuationTranscriptDir, { recursive: true });
  await fs.writeFile(path.join(originalTranscriptDir, 'final.md'), staleFinalOutput);
  await fs.writeFile(path.join(originalTranscriptDir, 'checkpoint.json'), `${JSON.stringify({
    schema_version: 2,
    job_id: originalJobId,
    root_job_id: originalJobId,
    status: 'succeeded',
    updated_at: '2026-07-28T08:00:00.000Z',
    input_fingerprint: 'unchanged-workspace',
    workspace: { current: { available: true } },
    plan: [{ step: 'finish the earlier request', status: 'completed' }],
    completed_actions: [],
    pending_actions: [],
    next_action: null,
    commands: [],
    changed_files: [],
    test_results: [],
    external_side_effects: [],
    final_answer_ready: true,
    final_answer_path: `jobs/transcripts/${originalJobId}/final.md`,
    final_answer_sha256: sha256(staleFinalOutput),
  }, null, 2)}\n`);
  await fs.writeFile(path.join(continuationTranscriptDir, 'checkpoint.json'), `${JSON.stringify({
    schema_version: 2,
    job_id: continuationJobId,
    root_job_id: originalJobId,
    status: 'interrupted',
    updated_at: '2026-07-28T08:01:00.000Z',
    input_fingerprint: 'unchanged-workspace',
    workspace: { current: { available: true } },
    plan: [],
    completed_actions: [],
    pending_actions: [],
    next_action: 'Continue the earlier request.',
    commands: [],
    changed_files: [],
    test_results: [],
    external_side_effects: [],
    final_answer_ready: false,
  }, null, 2)}\n`);

  await fs.mkdir(path.join(threadRoot, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(threadRoot, 'jobs', 'jobs.jsonl'), [
    {
      id: originalJobId,
      status: 'checkpoint-saved',
      updatedAt: '2026-07-28T08:00:00.000Z',
      transcriptRoot: `jobs/transcripts/${originalJobId}`,
      checkpointPath: `jobs/transcripts/${originalJobId}/checkpoint.json`,
    },
    {
      id: originalJobId,
      status: 'needs-runtime-restart',
      updatedAt: '2026-07-28T08:00:01.000Z',
      runtimeChangedPaths: ['bridge-service.mjs'],
    },
    {
      id: originalJobId,
      status: 'interrupted-recovered',
      recoveredAt: '2026-07-28T08:00:50.000Z',
      continuationJobId,
    },
    {
      id: continuationJobId,
      status: 'checkpoint-saved',
      updatedAt: '2026-07-28T08:00:51.000Z',
      transcriptRoot: `jobs/transcripts/${continuationJobId}`,
      checkpointPath: `jobs/transcripts/${continuationJobId}/checkpoint.json`,
    },
    {
      id: continuationJobId,
      status: 'superseding',
      updatedAt: '2026-07-28T08:00:56.000Z',
      supersededByJobId: currentJobId,
    },
    {
      id: continuationJobId,
      status: 'superseded',
      updatedAt: '2026-07-28T08:01:01.000Z',
      supersededByJobId: currentJobId,
    },
    {
      id: currentJobId,
      status: 'started',
      createdAt: '2026-07-28T08:01:02.000Z',
    },
  ].map(JSON.stringify).join('\n') + '\n');

  const context = await previousJobHandoffContext({
    threadRoot,
    job: { id: currentJobId },
    currentInputFingerprint: 'unchanged-workspace',
  });

  assert.match(context, /finalAnswerReady: false/);
  assert.match(context, /superseded request/i);
  assert.doesNotMatch(context, /## Saved Final Output/);
  assert.doesNotMatch(context, /이전 요청의 완료 답변입니다/);
  assert.doesNotMatch(context, /Return the saved final output without rerunning/);
});

test('previousJobHandoffContext falls back to legacy manifest final output', async () => {
  const threadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-job-transcript-'));
  const transcriptDir = path.join(threadRoot, 'jobs', 'transcripts', 'job-a');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'final.md'), 'legacy final output\n');
  await fs.writeFile(path.join(transcriptDir, 'manifest.json'), `${JSON.stringify({
    jobId: 'job-a',
    status: 'succeeded',
    savedAt: '2026-06-10T01:00:00.000Z',
    worker: 'codex',
    finalOutputPath: 'jobs/transcripts/job-a/final.md',
  })}\n`);
  await fs.mkdir(path.join(threadRoot, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(threadRoot, 'jobs', 'jobs.jsonl'), `${JSON.stringify({
    id: 'job-a',
    status: 'transcript-saved',
    updatedAt: '2026-06-10T01:00:00.000Z',
    manifestPath: 'jobs/transcripts/job-a/manifest.json',
  })}\n`);

  const context = await previousJobHandoffContext({
    threadRoot,
    job: { id: 'job-a_continue_20260610100000', recoveredFromJobId: 'job-a' },
  });

  assert.match(context, /legacy final output/);
  assert.match(context, /manifestPath: jobs\/transcripts\/job-a\/manifest\.json/);
});

test('previousJobHandoffContext loads handoff from job superseded by current user message', async () => {
  const threadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-job-transcript-'));
  const transcriptDir = path.join(threadRoot, 'jobs', 'transcripts', 'job-a');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'handoff.md'), [
    '# Previous Worker Handoff',
    '',
    'old job had inspected scheduler',
    '',
    '## Final Output',
    '```text',
    'stale legacy final',
    '```',
    '',
    '## Worker Visible Output',
    'background work remains available',
    '',
  ].join('\n'));
  await fs.mkdir(path.join(threadRoot, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(threadRoot, 'jobs', 'jobs.jsonl'), [
    JSON.stringify({
      id: 'job-a',
      status: 'superseding',
      updatedAt: '2026-06-10T01:00:00.000Z',
      supersededByJobId: 'job-b',
    }),
    JSON.stringify({
      id: 'job-a',
      status: 'transcript-saved',
      updatedAt: '2026-06-10T01:00:01.000Z',
      transcriptStatus: 'superseded',
      handoffPath: 'jobs/transcripts/job-a/handoff.md',
    }),
    JSON.stringify({
      id: 'job-b',
      status: 'started',
      createdAt: '2026-06-10T01:00:02.000Z',
    }),
  ].join('\n') + '\n');

  assert.deepEqual(
    previousTranscriptEntries(await readJsonlForTest(path.join(threadRoot, 'jobs', 'jobs.jsonl')), { id: 'job-b' })
      .map((entry) => entry.id),
    ['job-a'],
  );

  const context = await previousJobHandoffContext({
    threadRoot,
    job: { id: 'job-b' },
  });

  assert.match(context, /old job had inspected scheduler/);
  assert.match(context, /background work remains available/);
  assert.match(context, /Request Boundary/);
  assert.doesNotMatch(context, /stale legacy final/);
});

test('previousJobWorkerDurationMs sums transitive user supersedes and service continuations', async () => {
  const threadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-job-duration-'));
  const jobsDir = path.join(threadRoot, 'jobs');
  await fs.mkdir(jobsDir, { recursive: true });

  const manifests = [
    ['job-a', [['2026-06-10T01:00:00.000Z', '2026-06-10T01:01:00.000Z']]],
    ['job-b', [
      ['2026-06-10T01:01:10.000Z', '2026-06-10T01:01:40.000Z'],
      ['2026-06-10T01:01:45.000Z', '2026-06-10T01:02:00.000Z'],
    ]],
    ['unrelated', [['2026-06-10T01:00:00.000Z', '2026-06-10T02:00:00.000Z']]],
  ];
  const entries = [
    { id: 'job-a', status: 'superseding', supersededByJobId: 'job-b', updatedAt: '2026-06-10T01:01:00.000Z' },
    { id: 'job-b', status: 'superseding', supersededByJobId: 'job-c', updatedAt: '2026-06-10T01:02:00.000Z' },
    { id: 'unrelated', status: 'done', finishedAt: '2026-06-10T02:00:00.000Z' },
  ];
  for (const [jobId, windows] of manifests) {
    const transcriptDir = path.join(jobsDir, 'transcripts', jobId);
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(path.join(transcriptDir, 'manifest.json'), `${JSON.stringify({
      jobId,
      workerTranscripts: windows.map(([startedAt, finishedAt]) => ({ startedAt, finishedAt })),
    })}\n`);
    entries.push({
      id: jobId,
      status: 'transcript-saved',
      updatedAt: windows.at(-1)[1],
      manifestPath: `jobs/transcripts/${jobId}/manifest.json`,
    });
  }
  await fs.writeFile(path.join(jobsDir, 'jobs.jsonl'), `${entries.map(JSON.stringify).join('\n')}\n`);

  assert.equal(await previousJobWorkerDurationMs({
    threadRoot,
    job: { id: 'job-c' },
  }), 105_000);

  const firstContinuationId = 'root-job_continue_20260610101000000001';
  const currentContinuationId = 'root-job_continue_20260610102000000002';
  const continuationEntries = [];
  for (const [jobId, startedAt, finishedAt] of [
    ['root-job', '2026-06-10T02:00:00.000Z', '2026-06-10T02:00:40.000Z'],
    [firstContinuationId, '2026-06-10T02:01:00.000Z', '2026-06-10T02:01:20.000Z'],
  ]) {
    const transcriptDir = path.join(jobsDir, 'transcripts', jobId);
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(path.join(transcriptDir, 'manifest.json'), `${JSON.stringify({
      jobId,
      workerTranscripts: [{ startedAt, finishedAt }],
    })}\n`);
    continuationEntries.push({
      id: jobId,
      status: 'transcript-saved',
      updatedAt: finishedAt,
      manifestPath: `jobs/transcripts/${jobId}/manifest.json`,
    });
  }
  continuationEntries.push({
    id: currentContinuationId,
    status: 'queued',
    recoveredFromJobId: firstContinuationId,
    createdAt: '2026-06-10T02:02:00.000Z',
  });
  await fs.writeFile(path.join(jobsDir, 'jobs.jsonl'), `${continuationEntries.map(JSON.stringify).join('\n')}\n`);

  assert.equal(await previousJobWorkerDurationMs({
    threadRoot,
    job: { id: currentContinuationId, recoveredFromJobId: firstContinuationId },
  }), 60_000);
});

async function readJsonlForTest(file) {
  return (await fs.readFile(file, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}
