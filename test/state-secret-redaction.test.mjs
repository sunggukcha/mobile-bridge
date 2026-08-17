import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  redactPersistedStateSecrets,
  sweepPersistedStateSecrets,
} from '../lib/state-secret-redaction.mjs';

const TOKEN = ['xapp', '1', 'A0123456789', '12345678901234', 'abcdef0123456789abcdef0123456789'].join('-');
const THREAD_ID = 'slack-T1-C1-1785218400.123456';

test('startup redaction removes newly recognized tokens from events and transcripts', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'state-secret-redaction-'));
  const eventFile = threadFile(stateRoot, 'memory', 'events.jsonl');
  const promptFile = threadFile(stateRoot, 'jobs', 'transcripts', 'job-1', 'prompt.md');
  for (const file of [eventFile, promptFile]) {
    await writeFile(file, `credential=${TOKEN}\n`);
  }

  const changed = await redactPersistedStateSecrets(stateRoot);

  assert.deepEqual(changed.sort(), [eventFile, promptFile].sort());
  assert.equal((await fs.readFile(eventFile, 'utf8')).includes(TOKEN), false);
  assert.match(await fs.readFile(promptFile, 'utf8'), /xapp-\[REDACTED\]/);
  assert.deepEqual(await redactPersistedStateSecrets(stateRoot), []);
});

test('an unchanged pattern set makes the next sweep incremental', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'state-secret-redaction-'));
  await writeFile(threadFile(stateRoot, 'memory', 'events.jsonl'), 'clean\n');
  await writeFile(threadFile(stateRoot, 'jobs', 'jobs.jsonl'), 'clean\n');

  const first = await sweepPersistedStateSecrets(stateRoot);
  const second = await sweepPersistedStateSecrets(stateRoot);

  assert.equal(first.mode, 'full');
  assert.equal(second.mode, 'incremental');
  assert.equal(second.sweptThroughMs > 0, true);
});

test('a thread with no new job activity is skipped without reading its transcripts', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'state-secret-redaction-'));
  const eventFile = threadFile(stateRoot, 'memory', 'events.jsonl');
  const jobsFile = threadFile(stateRoot, 'jobs', 'jobs.jsonl');
  await writeFile(eventFile, 'clean\n');
  await writeFile(jobsFile, 'clean\n');
  await sweepPersistedStateSecrets(stateRoot);

  // A transcript that looks newly written, in a thread whose append-only logs
  // never moved. Only a job can write transcripts, and a job always appends a
  // status line, so this combination cannot happen in the bridge itself.
  const promptFile = threadFile(stateRoot, 'jobs', 'transcripts', 'job-1', 'prompt.md');
  await writeFile(promptFile, `credential=${TOKEN}\n`);
  await setMtime(eventFile, Date.now() - 60_000);
  await setMtime(jobsFile, Date.now() - 60_000);

  const skipped = await sweepPersistedStateSecrets(stateRoot);

  assert.equal(skipped.mode, 'incremental');
  assert.equal(skipped.skippedThreads, 1);
  assert.deepEqual(skipped.changed, []);
  assert.equal((await fs.readFile(promptFile, 'utf8')).includes(TOKEN), true);

  // Real job activity brings the thread back into scope, and the file the skip
  // passed over is still in scope because the skip kept the older watermark.
  await fs.appendFile(jobsFile, 'started\n');
  const resumed = await sweepPersistedStateSecrets(stateRoot);

  assert.equal(resumed.skippedThreads, 0);
  assert.deepEqual(resumed.changed, [promptFile]);
  assert.equal((await fs.readFile(promptFile, 'utf8')).includes(TOKEN), false);
});

test('an incremental sweep skips files older than the previous sweep', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'state-secret-redaction-'));
  const jobsFile = threadFile(stateRoot, 'jobs', 'jobs.jsonl');
  await writeFile(threadFile(stateRoot, 'memory', 'events.jsonl'), 'clean\n');
  await writeFile(jobsFile, 'clean\n');
  const oldFile = threadFile(stateRoot, 'jobs', 'transcripts', 'job-1', 'prompt.md');
  await writeFile(oldFile, 'clean\n');
  await sweepPersistedStateSecrets(stateRoot);

  // A file the previous sweep already read, planted with a token but left at its
  // old mtime: only a pattern change can make re-reading it worthwhile.
  await fs.writeFile(oldFile, `credential=${TOKEN}\n`);
  await setMtime(oldFile, Date.now() - 60_000);
  // A new job: a transcript plus the status append that always accompanies it.
  const newFile = threadFile(stateRoot, 'jobs', 'transcripts', 'job-2', 'prompt.md');
  await writeFile(newFile, `credential=${TOKEN}\n`);
  await fs.appendFile(jobsFile, 'started\n');

  const result = await sweepPersistedStateSecrets(stateRoot);

  assert.deepEqual(result.changed, [newFile]);
  assert.equal(result.skippedFiles > 0, true);
});

test('a changed pattern set forces a full rescan of untouched files', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'state-secret-redaction-'));
  const eventFile = threadFile(stateRoot, 'memory', 'events.jsonl');
  const jobsFile = threadFile(stateRoot, 'jobs', 'jobs.jsonl');
  const promptFile = threadFile(stateRoot, 'jobs', 'transcripts', 'job-1', 'prompt.md');
  await writeFile(eventFile, 'clean\n');
  await writeFile(jobsFile, 'clean\n');
  await writeFile(promptFile, `credential=${TOKEN}\n`);
  // Recorded under a pattern version that no longer matches the module, as after
  // a new token shape is added to secret-mask.mjs.
  await writeFile(
    path.join(stateRoot, '_system', 'state-secret-redaction.json'),
    `${JSON.stringify({ patternVersion: 'stale', sweptThroughMs: Date.now() })}\n`,
  );
  await setMtime(promptFile, Date.now() - 60_000);
  await setMtime(eventFile, Date.now() - 60_000);
  await setMtime(jobsFile, Date.now() - 60_000);

  const result = await sweepPersistedStateSecrets(stateRoot);

  assert.equal(result.mode, 'full');
  assert.equal(result.skippedThreads, 0);
  assert.deepEqual(result.changed, [promptFile]);
});

test('the sweep ignores advisory lock directories held by live writers', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'state-secret-redaction-'));
  await writeFile(threadFile(stateRoot, 'memory', 'events.jsonl'), 'clean\n');
  const lockOwner = threadFile(
    stateRoot,
    'jobs',
    'transcripts',
    'job-1',
    'checkpoint.json.lock',
    'owner.json',
  );
  await writeFile(lockOwner, `${JSON.stringify({ pid: process.pid, token: TOKEN })}\n`);

  const result = await sweepPersistedStateSecrets(stateRoot);

  assert.deepEqual(result.changed, []);
  assert.equal((await fs.readFile(lockOwner, 'utf8')).includes(TOKEN), true);
});

test('the ledger records what the sweep covered', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'state-secret-redaction-'));
  await writeFile(threadFile(stateRoot, 'memory', 'events.jsonl'), `credential=${TOKEN}\n`);

  await sweepPersistedStateSecrets(stateRoot);
  const ledger = JSON.parse(
    await fs.readFile(path.join(stateRoot, '_system', 'state-secret-redaction.json'), 'utf8'),
  );

  assert.equal(ledger.mode, 'full');
  assert.equal(ledger.changedFiles, 1);
  assert.match(String(ledger.patternVersion), /^[0-9a-f]{16}$/);
  assert.equal(Number.isFinite(ledger.sweptThroughMs), true);
});

function threadFile(stateRoot, ...segments) {
  return path.join(stateRoot, '100', THREAD_ID, ...segments);
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function setMtime(file, epochMs) {
  const when = new Date(epochMs);
  await fs.utimes(file, when, when);
}
