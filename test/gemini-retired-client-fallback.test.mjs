import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentJob } from '../lib/agent-runner.mjs';
import { loadConfig } from '../lib/config.mjs';

test('runAgentJob falls back from retired Gemini free-tier client to next worker', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const geminiBin = path.join(temp, 'fake-gemini.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(geminiBin, [
    '#!/usr/bin/env node',
    'console.error("IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. reasonCode=UNSUPPORTED_CLIENT tierId=free-tier");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, '#!/usr/bin/env node\nconsole.log("codex fallback");\n');
  await fs.chmod(geminiBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'gemini,codex',
      GEMINI_BIN: geminiBin,
      CODEX_BIN: codexBin,
      BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
  });

  assert.equal(result.output, 'codex fallback');
  assert.equal(result.worker, 'codex');
  assert.deepEqual(result.attempts.map((attempt) => attempt.worker), ['gemini', 'gemini', 'codex']);
  assert.match(result.attempts[0].error, /UNSUPPORTED_CLIENT/);
});
