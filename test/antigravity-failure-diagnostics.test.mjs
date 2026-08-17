import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractAntigravityFailureDiagnostics,
  runAgentJob,
} from '../lib/agent-runner.mjs';
import { loadConfig } from '../lib/config.mjs';

test('Antigravity diagnostics retain bounded terminal causes without raw tool output', () => {
  const diagnostics = extractAntigravityFailureDiagnostics([
    'ERROR: logging before google.Init: E0804 11:04:49.240724 87 errorreport.go:223] Failed to poll ListExperiments: You are not logged into Antigravity.',
    'ERROR: logging before google.Init: E0804 11:05:57.398316 1232 grep_handler.go:628] error running grep: private output hf_1234567890123456789012345678901234',
    'ERROR: logging before google.Init: E0804 11:05:57.524296 1232 errorreport.go:223] error executing cascade step: Grep command timed out: context deadline exceeded',
    'ERROR: logging before google.Init: E0804 11:06:01.673937 473 executor.go:525] error in generator: trajectory converted to zero chat messages',
    'ERROR: logging before google.Init: E0804 11:06:01.683879 473 errorreport.go:223] agent executor error: trajectory converted to zero chat messages hf_1234567890123456789012345678901234',
    'ERROR: logging before google.Init: E0804 11:06:01.826070 1 printmode.go:289] Print mode: run ended with error and no response: Agent execution terminated due to error.',
  ].join('\n'));

  assert.match(diagnostics, /trajectory converted to zero chat messages/);
  assert.match(diagnostics, /context deadline exceeded/);
  assert.doesNotMatch(diagnostics, /private output/);
  assert.doesNotMatch(diagnostics, /not logged into Antigravity/);
  assert.doesNotMatch(diagnostics, /Print mode: run ended/);
  assert.doesNotMatch(diagnostics, /hf_123456/);
  assert.match(diagnostics, /hf_\[REDACTED\]/);
});

test('runAgentJob enriches a generic Antigravity exit with its isolated diagnostic log', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-antigravity-diagnostics-'));
  const projectRoot = path.join(root, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const agyBin = path.join(root, 'fake-agy.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(agyBin, [
    '#!/usr/bin/env node',
    'const fs = await import("node:fs");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "models") process.exit(0);',
    'const logFile = args[args.indexOf("--log-file") + 1];',
    'if (!logFile) throw new Error("missing --log-file");',
    'fs.writeFileSync(logFile, [',
    '  "ERROR: logging before google.Init: E0804 11:05:57.524296 1232 errorreport.go:223] error executing cascade step: Grep command timed out: context deadline exceeded",',
    '  "ERROR: logging before google.Init: E0804 11:06:01.683879 473 errorreport.go:223] agent executor error: trajectory converted to zero chat messages",',
    '  "ERROR: logging before google.Init: E0804 11:06:01.826070 1 printmode.go:289] Print mode: run ended with error and no response: Agent execution terminated due to error.",',
    '].join("\\n"));',
    'console.error("Error: Agent execution terminated due to error.");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.chmod(agyBin, 0o755);

  try {
    await assert.rejects(runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'antigravity',
        WORKER_FALLBACK_ENABLED: 'false',
        ANTIGRAVITY_BIN: agyBin,
      }),
      job: {
        id: 'antigravity-generic-failure',
        attempt: 1,
        channelId: 'personal',
        event: { content: '작업' },
      },
      prompt: 'do it',
    }), (error) => {
      assert.match(error.message, /Antigravity diagnostics:/);
      assert.match(error.message, /trajectory converted to zero chat messages/);
      assert.match(error.stderr, /context deadline exceeded/);
      assert.match(error.antigravityDiagnosticLogPath, /bridge-antigravity-generic-failure-attempt-1/);
      assert.deepEqual(error.workerTranscripts.map((entry) => entry.stderr), [error.stderr]);
      return true;
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runAgentJob enriches the exact Antigravity timeout failure diagnostic', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-antigravity-timeout-diagnostics-'));
  const projectRoot = path.join(root, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const agyBin = path.join(root, 'fake-agy.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(agyBin, [
    '#!/usr/bin/env node',
    'const fs = await import("node:fs");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "models") process.exit(0);',
    'const logFile = args[args.indexOf("--log-file") + 1];',
    'if (!logFile) throw new Error("missing --log-file");',
    'fs.writeFileSync(logFile, "ERROR: logging before google.Init: E0804 11:06:01.683879 473 errorreport.go:223] agent executor error: upstream response exceeded its deadline");',
    'console.error("Error: timeout waiting for response");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.chmod(agyBin, 0o755);

  try {
    await assert.rejects(runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'antigravity',
        WORKER_FALLBACK_ENABLED: 'false',
        ANTIGRAVITY_BIN: agyBin,
      }),
      job: {
        id: 'antigravity-timeout-failure',
        attempt: 1,
        channelId: 'personal',
        event: { content: '작업' },
      },
      prompt: 'do it',
    }), (error) => {
      assert.match(error.message, /^Error: timeout waiting for response/m);
      assert.match(error.message, /Antigravity diagnostics:/);
      assert.match(error.stderr, /upstream response exceeded its deadline/);
      assert.match(error.antigravityDiagnosticLogPath, /bridge-antigravity-timeout-failure-attempt-1/);
      return true;
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
