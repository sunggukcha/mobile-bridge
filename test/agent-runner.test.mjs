import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  terminateActiveProcessesGracefully,
} from '../lib/codex-runner.mjs';
import {
  antigravityRetryArgs,
  buildClaudeArgs,
  buildAntigravityArgs,
  buildGeminiArgs,
  createClaudeJsonStreamObserver,
  createJsonLineStreamObserver,
  executionWorkerChainForJob,
  extractAntigravityProgressUpdate,
  extractClaudeProgressUpdate,
  extractGeminiProgressUpdate,
  extractJsonStreamFinalText,
  isCompanyJob,
  isWorkerArgvLimitError,
  isWorkerFallbackError,
  isWorkerInputLimitError,
  plannedWorkerStartInfo,
  resolveAntigravityModelSelection,
  runAgentJob,
  workerChainSummaryForJob,
  workerChainForJob,
} from '../lib/agent-runner.mjs';
import { loadConfig } from '../lib/config.mjs';
import { modelOptionByNumber, modelOptionBySelector, modelSelectionFromOption } from '../lib/thread-models.mjs';

function chainLabels(chain) {
  return chain.map((entry) => typeof entry === 'string' ? entry : entry.label || entry.id);
}

test('workerChainForJob excludes manual-only Sol and Fable from default channel chains', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    COMPANY_WORKER_CHANNEL_IDS: 'company-channel',
    COMPANY_WORKER_KEYWORDS: '회사,업무,work',
  });

  assert.equal(isCompanyJob(config, { channelId: 'company-channel', event: { content: '배포' } }), true);
  assert.deepEqual(chainLabels(workerChainForJob(config, { channelId: 'company-channel' })), [
    'claude: Opus 5',
    'codex: gpt-5.6-terra',
    'antigravity: claude-opus-4.6',
    'antigravity: gemini-3.7-flash',
    'codex: gpt-5.3-codex-spark',
    'codex: gpt-5.6-luna',
  ]);
  assert.equal(isCompanyJob(config, {
    channelId: 'personal',
    id: 'company-keyword-id',
    event: { authorName: 'work-user', content: '회사 작업 이야기가 들어간 개인 채널 메시지' },
  }), false);
  assert.deepEqual(chainLabels(workerChainForJob(config, {
    channelId: 'personal',
    id: 'company-keyword-id',
    event: { authorName: 'work-user', content: '회사 작업 이야기가 들어간 개인 채널 메시지' },
  })), [
    'codex: gpt-5.6-terra',
    'claude: Opus 5',
    'antigravity: claude-opus-4.6',
    'antigravity: gemini-3.7-flash',
    'codex: gpt-5.3-codex-spark',
    'codex: gpt-5.6-luna',
  ]);
});

// The Workbench builds `<worker> working for N minutes.` from this when the worker
// has not reported `worker.started` yet — a queued detached launch, or a restart
// that reattached an already running worker. It must carry the same label/effort
// fields onWorkerStart reports, or the notice degrades to the raw job id.
test('plannedWorkerStartInfo names the chain head before the worker reports its start', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    COMPANY_WORKER_CHANNEL_IDS: 'company-channel',
  });

  assert.deepEqual(plannedWorkerStartInfo(config, { channelId: 'company-channel' }), {
    worker: 'claude-opus-primary',
    workerBase: 'claude',
    workerLabel: 'claude: Opus 5',
    workerModel: 'opus',
    workerEffort: 'xhigh',
    startedAt: null,
    planned: true,
  });

  const pinned = plannedWorkerStartInfo(config, {
    channelId: 'personal',
    threadModelOverride: modelSelectionFromOption(modelOptionByNumber(config, 1)),
  });
  assert.equal(pinned.workerLabel, workerChainSummaryForJob(config, {
    channelId: 'personal',
    threadModelOverride: modelSelectionFromOption(modelOptionByNumber(config, 1)),
  })[0].label);
});

test('workerChainForJob alternates daily maintenance chains by KST date', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex-spark,gemini,codex,claude',
    CODEX_MODEL: 'some-other-model',
    CODEX_MAINTENANCE_MODEL: 'gpt-5.6-terra',
    MAINTENANCE_WORKER_CHAIN: '',
    MAINTENANCE_WORKER_CHAIN_ROTATION: 'fable-sol-opus-terra|sol-fable-terra-opus',
    MAINTENANCE_WORKER_CHAIN_ROTATION_START_DATE: '2026-07-11',
  });

  assert.deepEqual(workerChainForJob(config, {
    maintenance: true,
    event: { timestamp: '2026-07-10T18:00:00.000Z' }, // 2026-07-11 03:00 KST
  }), ['claude-fable', 'codex-sol', 'claude-opus', 'codex-terra']);
  assert.deepEqual(workerChainForJob(config, {
    maintenance: true,
    event: { timestamp: '2026-07-11T18:00:00.000Z' }, // 2026-07-12 03:00 KST
  }), ['codex-sol', 'claude-fable', 'codex-terra', 'claude-opus']);
});

test('workerChainForJob defaults daily maintenance to Sol at ultra without fallback', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  });

  assert.deepEqual(workerChainForJob(config, { maintenance: true }), ['codex-sol']);
  assert.deepEqual(workerChainSummaryForJob(config, { maintenance: true }), [{
    name: 'codex-sol',
    label: 'codex: gpt-5.6-sol',
    worker: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  }]);
});

test('workerChainForJob lets env pin daily maintenance to Codex only', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    MAINTENANCE_WORKER_CHAIN: 'codex',
  });

  assert.deepEqual(workerChainForJob(config, { maintenance: true }), ['codex']);
});

test('workerChainForJob normalizes maintenance Fable, Sol, Opus, and Terra aliases', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    MAINTENANCE_WORKER_CHAIN: 'fable,sol,opus-5,terra',
  });

  assert.deepEqual(workerChainForJob(config, { maintenance: true }), ['claude-fable', 'codex-sol', 'claude-opus', 'codex-terra']);
});

test('workerChainForJob keeps daily maintenance on Sol even if the Terra setting is unsupported', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    CODEX_MAINTENANCE_MODEL: 'gpt-5.3-codex-spark',
    MAINTENANCE_WORKER_CHAIN_ROTATION: '',
  });

  assert.deepEqual(workerChainForJob(config, { maintenance: true }), ['codex-sol']);
});

test('workerChainForJob pins the thread to the selected model with no fallback', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex,claude,gemini,codex-spark',
  });
  const selected = modelSelectionFromOption(modelOptionByNumber(config, 1));
  const chain = workerChainForJob(config, {
    channelId: 'personal',
    threadModelOverride: selected,
  });

  assert.equal(chain.length, 1, 'a /model selection pins to exactly one model');
  assert.equal(chain[0].label, 'codex: gpt-5.6-terra');
});

test('workerChainForJob pins /model 3 to Fable with no fallback', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex,claude,gemini,codex-spark',
  });
  const selected = modelSelectionFromOption(modelOptionByNumber(config, 3));
  const chain = executionWorkerChainForJob(config, {
    channelId: 'personal',
    threadModelOverride: selected,
  });

  assert.equal(chain.length, 1, 'a /model 3 selection pins to exactly Fable');
  assert.equal(chain[0].label, 'claude: Fable 5');
  assert.equal(chain[0].worker, 'claude');
  assert.equal(chain[0].model, 'claude-fable-5');
  assert.equal(chain[0].effort, 'xhigh');
  assert.equal(chain[0].exactFallback, true);
});

test('runAgentJob uses the Claude account embedded in the selected /model profile', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const primaryHome = path.join(temp, 'claude-primary');
  const secondaryHome = path.join(temp, 'claude-secondary');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, '#!/usr/bin/env node\nconsole.log(process.env.HOME);\n');
  await fs.chmod(claudeBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'claude',
    CLAUDE_BIN: claudeBin,
    CLAUDE_HOME: primaryHome,
    CLAUDE_SECONDARY_HOME: secondaryHome,
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  });
  const result = await runAgentJob({
    config,
    job: {
      channelId: 'personal',
      threadId: 'thread-1',
      threadModelOverride: modelSelectionFromOption(modelOptionBySelector(config, 'opus:secondary')),
      event: { content: '작업' },
    },
    prompt: 'do it',
  });

  assert.equal(result.worker, 'claude-opus-secondary');
  assert.equal(result.output, secondaryHome);
  await assert.rejects(fs.access(primaryHome));
  await fs.access(secondaryHome);
});

test('runAgentJob gives isolated worker homes the host Git credential configuration', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-github-env-'));
  const projectRoot = path.join(temp, 'projects');
  const stateRoot = path.join(projectRoot, '.bridge_state');
  const hostHome = path.join(temp, 'host-home');
  const ghConfigDir = path.join(hostHome, '.config', 'gh');
  const gitConfigGlobal = path.join(hostHome, '.gitconfig');
  const askPassPath = path.join(temp, 'github-gh-askpass.sh');
  const claudeHome = path.join(stateRoot, 'claude-home');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  await fs.mkdir(ghConfigDir, { recursive: true });
  await fs.writeFile(path.join(ghConfigDir, 'hosts.yml'), 'github.com:\n    user: tester\n');
  await fs.writeFile(gitConfigGlobal, '[credential "https://github.com"]\n    helper = !gh auth git-credential\n');
  await fs.writeFile(askPassPath, '#!/bin/sh\nexit 1\n');
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    'console.log([',
    '  process.env.HOME,',
    '  process.env.GH_CONFIG_DIR,',
    '  process.env.GIT_CONFIG_GLOBAL,',
    '  process.env.GIT_ASKPASS,',
    '  process.env.GITHUB_TOKEN === "",',
    '  process.env.GH_TOKEN === "",',
    '  process.env.GIT_TERMINAL_PROMPT,',
    '].join("|"));',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_STATE_ROOT: stateRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    HOME: hostHome,
    BRIDGE_GH_ASKPASS: askPassPath,
    BRIDGE_PREFER_HOST_GH_CREDENTIAL: 'true',
    DEFAULT_WORKER_CHAIN: 'claude',
    CLAUDE_BIN: claudeBin,
    CLAUDE_HOME: claudeHome,
  });
  const result = await runAgentJob({
    config,
    job: {
      channelId: 'personal',
      threadId: 'thread-1',
      event: { content: '작업' },
    },
    prompt: 'env',
  });

  assert.equal(
    result.output,
    `${claudeHome}|${ghConfigDir}|${gitConfigGlobal}|${askPassPath}|true|true|0`,
  );
});

test('runAgentJob forwards the thread Fast mode only to regular Codex runs', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-fast-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const argsFile = path.join(temp, 'codex-args.json');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    'console.log("done");',
    '',
  ].join('\n'));
  await fs.chmod(codexBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex',
    CODEX_BIN: codexBin,
    CODEX_MODEL: 'gpt-5.6-terra',
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  });
  const baseJob = {
    channelId: 'personal',
    threadId: 'thread-1',
    event: { content: '작업' },
  };

  await runAgentJob({
    config,
    job: { ...baseJob, codexFastMode: true },
    prompt: 'do it fast',
  });
  const fastArgs = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  assert.equal(fastArgs.includes('service_tier="fast"'), true);

  await runAgentJob({
    config,
    job: { ...baseJob, codexFastMode: false },
    prompt: 'do it normally',
  });
  const standardArgs = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  assert.equal(standardArgs.some((arg) => arg.includes('service_tier')), false);
});

test('workerChainForJob pins a "5 6 1" reply to that exact fallback order', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex,claude,gemini,codex-spark',
  });
  const primary = modelSelectionFromOption(modelOptionByNumber(config, 5));
  const threadModelOverride = {
    ...primary,
    chain: [5, 6, 1].map((number) => modelSelectionFromOption(modelOptionByNumber(config, number))),
  };

  const chain = workerChainForJob(config, { channelId: 'personal', threadModelOverride });

  assert.deepEqual(chainLabels(chain), [
    'antigravity: claude-opus-4.6',
    'antigravity: gemini-3.7-flash',
    'codex: gpt-5.6-terra',
  ]);
  assert.ok(chain.every((entry) => entry.exactFallback), 'every pinned chain entry is exact (no expansion)');
});

test('executionWorkerChainForJob does not expand an explicitly pinned Gemini Pro sequence', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex,claude,gemini,codex-spark',
  });
  // Native Gemini is not shown in `/model`, but an explicitly stored legacy
  // selection stays pinned and must not auto-expand to Flash.
  const primary = {
    id: 'gemini-gemini-3.1-pro-preview',
    label: 'gemini: gemini-3.1-pro',
    worker: 'gemini',
    model: 'gemini-3.1-pro-preview',
  };
  const threadModelOverride = {
    ...primary,
    chain: [primary, modelSelectionFromOption(modelOptionByNumber(config, 1))],
  };

  const chain = executionWorkerChainForJob(config, { channelId: 'personal', threadModelOverride });

  assert.equal(chain.length, 2, 'pinned Gemini Pro stays a single entry, not Pro+Flash');
  assert.equal(chain[0].worker, 'gemini');
  assert.equal(chain[0].model, 'gemini-3.1-pro-preview');
  assert.equal(chain[1].label, 'codex: gpt-5.6-terra');
});

test('executionWorkerChainForJob expands default Gemini to Pro then Flash', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'gemini,codex-spark',
  });

  assert.deepEqual(executionWorkerChainForJob(config, { channelId: 'personal' }), [
    {
      id: 'gemini-gemini-3.1-pro-preview',
      label: 'gemini-gemini-3.1-pro-preview',
      name: 'gemini',
      worker: 'gemini',
      model: 'gemini-3.1-pro-preview',
    },
    {
      id: 'gemini-gemini-3-flash-preview',
      label: 'gemini-gemini-3-flash-preview',
      name: 'gemini',
      worker: 'gemini',
      model: 'gemini-3-flash-preview',
    },
    'codex-spark',
  ]);
});

test('executionWorkerChainForJob pins a legacy explicit Gemini Pro selection (no Flash fallback)', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex,gemini',
  });
  const selected = {
    id: 'gemini-gemini-3.1-pro-preview',
    label: 'gemini: gemini-3.1-pro',
    worker: 'gemini',
    model: 'gemini-3.1-pro-preview',
  };

  const chain = executionWorkerChainForJob(config, {
    channelId: 'personal',
    threadModelOverride: selected,
  });

  // Pinned: exactly the selected Gemini Pro, not expanded to Flash and no base chain.
  assert.equal(chain.length, 1);
  assert.equal(chain[0].id, 'gemini-gemini-3.1-pro-preview');
  assert.equal(chain[0].worker, 'gemini');
  assert.ok(chain[0].selectedAt);
});

test('runAgentJob pins the selected model and does not fall back when it fails', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const attemptsFile = path.join(temp, 'attempts.log');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    'const args = process.argv.slice(2);',
    'const model = args[args.indexOf("--model") + 1];',
    `await fs.appendFile(${JSON.stringify(attemptsFile)}, \`claude:\${model}\\n\`);`,
    'console.error("insufficient credits");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    'const model = process.argv[process.argv.indexOf("-m") + 1];',
    `await fs.appendFile(${JSON.stringify(attemptsFile)}, \`codex:\${model}\\n\`);`,
    'console.log("codex fallback");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex',
    CLAUDE_BIN: claudeBin,
    CODEX_BIN: codexBin,
    CLAUDE_MODEL: 'opus',
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  });
  await assert.rejects(
    runAgentJob({
      config,
      job: {
        channelId: 'personal',
        threadId: 'thread-1',
        threadModelOverride: modelSelectionFromOption(modelOptionByNumber(config, 4)),
        event: { content: '작업' },
      },
      prompt: 'do it',
    }),
    (error) => {
      assert.equal(error.worker, 'claude-opus-primary');
      return true;
    },
  );
  // Pinned to Claude: the configured `codex` fallback must NOT run.
  assert.equal(await fs.readFile(attemptsFile, 'utf8'), 'claude:opus\n');
});

test('runAgentJob falls back from Gemini Pro to Gemini Flash on rate limit', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const geminiBin = path.join(temp, 'fake-gemini.mjs');
  const attemptsFile = path.join(temp, 'gemini-attempts.log');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(geminiBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    'const args = process.argv.slice(2);',
    'const model = args[args.indexOf("--model") + 1];',
    `await fs.appendFile(${JSON.stringify(attemptsFile)}, \`\${model}\\n\`);`,
    'if (model === "gemini-3.1-pro-preview") {',
    '  console.error("429 rate limit exceeded");',
    '  process.exit(1);',
    '}',
    'console.log(`ok:${model}`);',
    '',
  ].join('\n'));
  await fs.chmod(geminiBin, 0o755);

  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'gemini',
      GEMINI_BIN: geminiBin,
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
  });

  assert.equal(result.output, 'ok:gemini-3-flash-preview');
  assert.equal(result.worker, 'gemini');
  assert.deepEqual(result.attempts.map((attempt) => attempt.worker), ['gemini', 'gemini']);
  assert.equal(await fs.readFile(attemptsFile, 'utf8'), [
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
  ].join('\n') + '\n');
});

test('runAgentJob falls back after a credit failure', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, '#!/usr/bin/env node\nconsole.error("insufficient credits");\nprocess.exit(1);\n');
  await fs.writeFile(codexBin, '#!/usr/bin/env node\nconsole.log("codex fallback");\n');
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  const workerStarts = [];
  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'claude,codex',
      CLAUDE_BIN: claudeBin,
      CODEX_BIN: codexBin,
      BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
    onWorkerStart: (workerInfo) => workerStarts.push(workerInfo),
  });

  assert.equal(result.output, 'codex fallback');
  assert.equal(result.worker, 'codex');
  assert.deepEqual(result.attempts.map((attempt) => attempt.worker), ['claude', 'codex']);
  assert.deepEqual(
    workerStarts.map((workerInfo) => [workerInfo.worker, workerInfo.workerBase, workerInfo.workerLabel]),
    [
      ['claude', 'claude', 'claude'],
      ['codex', 'codex', 'codex'],
    ],
  );
});

test('runAgentJob skips a quota-exhausted account before worker start on the next job', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-cooldown-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const attemptsFile = path.join(temp, 'attempts.log');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.appendFile(${JSON.stringify(attemptsFile)}, 'claude\\n');`,
    `console.error("You've hit your limit · resets in 2 hours");`,
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.appendFile(${JSON.stringify(attemptsFile)}, 'codex\\n');`,
    'console.log("codex fallback");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  const env = {
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'claude,codex',
    CLAUDE_BIN: claudeBin,
    CODEX_BIN: codexBin,
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  };
  const firstStarts = [];
  const first = await runAgentJob({
    config: loadConfig(env),
    job: { channelId: 'personal', threadId: 'thread-1', event: { content: '첫 작업' } },
    prompt: 'do it',
    onWorkerStart: (workerInfo) => firstStarts.push(workerInfo.worker),
  });

  assert.equal(first.output, 'codex fallback');
  assert.deepEqual(firstStarts, ['claude', 'codex']);
  assert.deepEqual(first.attempts.map((attempt) => attempt.status), ['failed', 'succeeded']);

  const secondStarts = [];
  const second = await runAgentJob({
    // Reloading config simulates a new bridge runtime reading durable state.
    config: loadConfig(env),
    job: { channelId: 'personal', threadId: 'thread-1', event: { content: '둘째 작업' } },
    prompt: 'do it again',
    onWorkerStart: (workerInfo) => secondStarts.push(workerInfo.worker),
  });

  assert.equal(second.output, 'codex fallback');
  assert.deepEqual(secondStarts, ['codex'], 'the cooled worker is skipped before its start notice');
  assert.deepEqual(
    second.attempts.map((attempt) => [attempt.worker, attempt.status]),
    [['claude', 'skipped'], ['codex', 'succeeded']],
  );
  assert.equal(await fs.readFile(attemptsFile, 'utf8'), 'claude\ncodex\ncodex\n');

  const pinnedConfig = loadConfig(env);
  const pinnedStarts = [];
  await assert.rejects(
    runAgentJob({
      config: pinnedConfig,
      job: {
        channelId: 'personal',
        threadId: 'thread-1',
        threadModelOverride: modelSelectionFromOption(modelOptionByNumber(pinnedConfig, 4)),
        event: { content: 'Opus만 사용' },
      },
      prompt: 'do it with opus',
      onWorkerStart: (workerInfo) => pinnedStarts.push(workerInfo.worker),
    }),
    (error) => {
      assert.equal(error.code, 'WORKER_COOLDOWN_ACTIVE');
      assert.equal(error.workerAvailabilityBlocked, true);
      assert.ok(error.workerAvailabilityRetryAtMs > Date.now());
      assert.deepEqual(error.workerAttempts.map((attempt) => attempt.status), ['skipped']);
      return true;
    },
  );
  assert.deepEqual(pinnedStarts, []);
  assert.equal(await fs.readFile(attemptsFile, 'utf8'), 'claude\ncodex\ncodex\n');
});

test('runAgentJob does not fall back when a worker exits clean with no final message', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const codexRan = path.join(temp, 'codex-ran');
  await fs.mkdir(cwd, { recursive: true });
  // exit 0 but emit only a JSON system event => extractJsonStreamFinalText() === '(no final message)'
  await fs.writeFile(claudeBin, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "system", subtype: "init" }));\n');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(codexRan)}, 'ran');`,
    'console.log("should not run");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  await assert.rejects(
    runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'claude,codex',
        CLAUDE_BIN: claudeBin,
        CODEX_BIN: codexBin,
        BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
      }),
      job: { channelId: 'personal', event: { content: '작업' } },
      prompt: 'do it',
    }),
    (error) => {
      assert.equal(error.worker, 'claude');
      assert.deepEqual(error.workerAttempts.map((attempt) => attempt.worker), ['claude']);
      assert.match(error.message, /produced no final message/);
      return true;
    },
  );
  await assert.rejects(fs.access(codexRan), { code: 'ENOENT' });
});

test('runAgentJob stops daily maintenance fallback after the rotating Terra Codex slot', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const geminiBin = path.join(temp, 'fake-gemini.mjs');
  const attemptsFile = path.join(temp, 'attempts.log');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    'const model = process.argv[process.argv.indexOf("-m") + 1];',
    `await fs.appendFile(${JSON.stringify(attemptsFile)}, \`codex:\${model}\\n\`);`,
    'if (model === "gpt-5.6-sol") {',
    '  console.error("service unavailable: 503");',
    '  process.exit(1);',
    '}',
    'console.error("Internal Server Error: 500");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    'const args = process.argv.slice(2);',
    'const model = args[args.indexOf("--model") + 1];',
    'const effort = args[args.indexOf("--effort") + 1];',
    `await fs.appendFile(${JSON.stringify(attemptsFile)}, \`claude:\${model}:\${effort}\\n\`);`,
    'console.error("insufficient credits");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.writeFile(geminiBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.appendFile(${JSON.stringify(attemptsFile)}, 'gemini\\n');`,
    'console.error("not logged in");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.chmod(codexBin, 0o755);
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(geminiBin, 0o755);

  await assert.rejects(
    runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        CODEX_BIN: codexBin,
        CODEX_MODEL: 'some-other-model',
        CODEX_MAINTENANCE_MODEL: 'gpt-5.6-terra',
        MAINTENANCE_WORKER_CHAIN: '',
        MAINTENANCE_WORKER_CHAIN_ROTATION: 'fable-sol-opus-terra|sol-fable-terra-opus',
        MAINTENANCE_WORKER_CHAIN_ROTATION_START_DATE: '2026-07-11',
        CLAUDE_BIN: claudeBin,
        GEMINI_BIN: geminiBin,
        BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
      }),
      job: { channelId: 'system', maintenance: true, event: { content: 'Daily bridge maintenance.', timestamp: '2026-07-10T18:00:00.000Z' } },
      prompt: 'do maintenance',
    }),
    (error) => {
      assert.equal(error.worker, 'codex-terra');
      assert.deepEqual(error.workerAttempts.map((attempt) => attempt.worker), ['claude-fable', 'codex-sol', 'claude-opus', 'codex-terra']);
      return true;
    },
  );

  assert.equal(await fs.readFile(attemptsFile, 'utf8'), [
    'claude:claude-fable-5:xhigh',
    'codex:gpt-5.6-sol',
    'claude:claude-opus-5:xhigh',
    'codex:gpt-5.6-terra',
  ].join('\n') + '\n');
});

test('runAgentJob forces danger-full-access for Codex daily maintenance', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const argsFile = path.join(temp, 'codex-args.json');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, '#!/usr/bin/env node\nconsole.error("insufficient credits");\nprocess.exit(1);\n');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    'console.log("maintenance done");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      CODEX_BIN: codexBin,
      CLAUDE_BIN: claudeBin,
      CODEX_MODEL: 'gpt-5.6-terra',
      MAINTENANCE_WORKER_CHAIN: 'codex',
      CODEX_SANDBOX_MODE: 'workspace-write',
      CODEX_MAINTENANCE_SANDBOX_MODE: 'danger-full-access',
      BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
    }),
    job: { channelId: 'system', maintenance: true, event: { content: 'Daily bridge maintenance.' } },
    prompt: 'do maintenance',
  });

  const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  assert.equal(result.worker, 'codex');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.6-terra');
  assert.equal(args[args.indexOf('-s') + 1], 'danger-full-access');
});

test('runAgentJob runs non-repo jobs from current channel common and thread state only', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const argsFile = path.join(temp, 'codex-args.json');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    'console.log("done");',
    '',
  ].join('\n'));
  await fs.chmod(codexBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex',
    CODEX_BIN: codexBin,
    CODEX_ALLOWED_ROOTS: `${cwd},${projectRoot}`,
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  });
  const result = await runAgentJob({
    config,
    job: { channelId: 'channel-1', threadId: 'thread-1', event: { content: '작업' } },
    prompt: 'do it',
  });

  const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  const addDirs = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
  assert.equal(result.worker, 'codex');
  assert.equal(args[args.indexOf('-C') + 1], path.join(projectRoot, '.bridge_state', 'channel-1_common'));
  assert.equal(args[args.indexOf('-s') + 1], 'workspace-write');
  assert.deepEqual(addDirs, [
    path.join(projectRoot, '.bridge_state', 'channel-1', 'thread-1'),
  ]);
  assert.equal(args.includes(cwd), false);
  assert.equal(addDirs.includes(path.join(projectRoot, '.bridge_state')), false);
});

test('runAgentJob keeps repository access for yolo jobs', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const argsFile = path.join(temp, 'codex-args.json');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    'console.log("done");',
    '',
  ].join('\n'));
  await fs.chmod(codexBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex',
    CODEX_BIN: codexBin,
    CODEX_SANDBOX_MODE: 'danger-full-access',
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  });
  const result = await runAgentJob({
    config,
    job: { channelId: 'channel-1', threadId: 'thread-1', event: { content: '/yolo lib 기능 구현해줘' } },
    prompt: 'do it',
  });

  const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  const addDirs = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
  assert.equal(result.worker, 'codex');
  assert.equal(args[args.indexOf('-C') + 1], path.join(projectRoot, '.bridge_state', 'channel-1_common', 'workspace'));
  assert.equal(args[args.indexOf('-s') + 1], 'danger-full-access');
  assert.deepEqual(addDirs, [
    path.join(projectRoot, 'mobile-codex-bridge'),
    path.join(projectRoot, '.bridge_state', 'channel-1_common'),
    path.join(projectRoot, '.bridge_state', 'channel-1', 'thread-1'),
  ]);
});

test('runAgentJob grants god jobs repository and full bridge state roots', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const argsFile = path.join(temp, 'codex-args.json');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    'console.log("done");',
    '',
  ].join('\n'));
  await fs.chmod(codexBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex',
    CODEX_BIN: codexBin,
    CODEX_SANDBOX_MODE: 'danger-full-access',
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  });
  const result = await runAgentJob({
    config,
    job: { channelId: 'channel-1', threadId: 'thread-1', stateAccess: true, event: { content: '/god 전체 state 확인해줘' } },
    prompt: 'do it',
  });

  const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  const addDirs = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
  assert.equal(result.worker, 'codex');
  assert.equal(args[args.indexOf('-C') + 1], path.join(projectRoot, '.bridge_state', 'channel-1_common', 'workspace'));
  assert.equal(args[args.indexOf('-s') + 1], 'danger-full-access');
  assert.deepEqual(addDirs, [
    path.join(projectRoot, 'mobile-codex-bridge'),
    path.join(projectRoot, '.bridge_state'),
  ]);
});

test('runAgentJob keeps Claude daily maintenance in the default permission mode', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const argsFile = path.join(temp, 'claude-args.json');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    'console.log("claude maintenance done");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);

  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      CLAUDE_BIN: claudeBin,
      MAINTENANCE_WORKER_CHAIN: 'claude-fable',
    }),
    job: { channelId: 'system', maintenance: true, event: { content: 'Daily bridge maintenance.' } },
    prompt: 'do maintenance',
  });

  const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  assert.equal(result.worker, 'claude-fable');
  assert.equal(result.workerBase, 'claude');
  assert.equal(result.workerLabel, 'claude: claude-fable-5');
  assert.equal(result.workerModel, 'claude-fable-5');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-fable-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
});

test('worker fallback ignores ambiguous worker execution failures', () => {
  assert.equal(isWorkerFallbackError(new Error('internal execution error')), false);
  assert.equal(isWorkerFallbackError(new Error('Internal Server Error: 500')), false);
  assert.equal(isWorkerFallbackError({ message: 'terminated', signal: 'SIGTERM', noProgressKilled: true }), false);
  assert.equal(isWorkerFallbackError(new Error('codex produced no final message')), false);
  assert.equal(isWorkerFallbackError(new Error('codex produced no output')), false);
  assert.equal(isWorkerFallbackError(new Error('')), false);
});

test('worker fallback handles unavailable account or provider states', () => {
  assert.equal(isWorkerFallbackError(new Error('429 rate limit exceeded')), true);
  assert.equal(isWorkerFallbackError(new Error('insufficient credits')), true);
  assert.equal(isWorkerFallbackError(new Error('quota exhausted')), true);
  assert.equal(isWorkerFallbackError(new Error('Not logged in · Please run /login')), true);
  assert.equal(isWorkerFallbackError(new Error('spawn ENOENT')), true);
  assert.equal(isWorkerFallbackError(new Error('503 service unavailable')), true);
});

test('worker fallback treats Claude session-limit exhaustion as a runtime failure', () => {
  // Claude Code emits this exact wording when the plan session budget is spent;
  // it is deterministic until the reset time, so the chain should fall back to the
  // next worker immediately instead of burning a job-level retry against the same worker.
  assert.equal(isWorkerFallbackError(new Error("You've hit your session limit · resets 7pm (Asia/Seoul) code=1")), true);
});

test('worker input limit errors are classified separately from fallback', () => {
  assert.equal(isWorkerInputLimitError(new Error('context_length_exceeded: maximum context length')), true);
  assert.equal(isWorkerInputLimitError({ stderr: 'Request too large: too many tokens' }), true);
  assert.equal(isWorkerFallbackError(new Error('context_length_exceeded: maximum context length')), false);
});

test('runAgentJob marks Claude subscription access disabled as non-retryable', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    'console.error("Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);

  await assert.rejects(
    runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'claude',
        CLAUDE_BIN: claudeBin,
      }),
      job: { channelId: 'personal', event: { content: '작업' } },
      prompt: 'do it',
    }),
    (error) => {
      assert.equal(error.worker, 'claude');
      assert.equal(error.nonRetryable, true);
      assert.equal(error.workerAttempts.length, 1);
      assert.match(error.workerAttempts[0].error, /disabled Claude subscription access/);
      return true;
    },
  );
});

test('runAgentJob stops worker fallback on input limit errors', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const codexRan = path.join(temp, 'codex-ran');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, '#!/usr/bin/env node\nconsole.error("context_length_exceeded: maximum context length");\nprocess.exit(1);\n');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    `await fs.writeFile(${JSON.stringify(codexRan)}, 'ran');`,
    'console.log("should not run");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  await assert.rejects(
    runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'claude,codex',
        CLAUDE_BIN: claudeBin,
        CODEX_BIN: codexBin,
        BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
      }),
      job: { channelId: 'personal', event: { content: '작업' } },
      prompt: 'do it',
    }),
    (error) => {
      assert.equal(error.inputLimit, true);
      assert.equal(error.worker, 'claude');
      assert.equal(error.workerAttempts.length, 1);
      return true;
    },
  );
  await assert.rejects(fs.access(codexRan), { code: 'ENOENT' });
});

test('runAgentJob records compact worker errors from JSON streams', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({ type: "system", subtype: "init", tools: ["Read", "Bash"] }));',
    'console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }));',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, '#!/usr/bin/env node\nconsole.log("codex fallback");\n');
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'claude,codex',
      CLAUDE_BIN: claudeBin,
      CODEX_BIN: codexBin,
      BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
  });

  assert.equal(result.worker, 'codex');
  assert.match(result.attempts[0].error, /Not logged in/);
  assert.doesNotMatch(result.attempts[0].error, /"type":"system"/);
});

test('runAgentJob stores visible worker updates in transcripts', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "checking files" }] } }));',
    'console.log(JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "bridge-service.mjs" } }));',
    'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }));',
    'console.log(JSON.stringify({ type: "result", result: "done" }));',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);

  const forwardedUpdates = [];
  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'claude',
      CLAUDE_BIN: claudeBin,
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
    onUpdate: (update) => forwardedUpdates.push(update),
  });

  assert.equal(result.output, 'done');
  assert.equal(result.workerTranscripts.length, 1);
  assert.equal(result.workerTranscripts[0].worker, 'claude');
  assert.match(result.workerTranscripts[0].stdout, /checking files/);
  assert.deepEqual(
    result.workerTranscripts[0].updates.map((update) => [update.worker, update.type, update.text]),
    [
      ['claude', 'response_text', 'checking files'],
      ['claude', 'tool_call', 'using tool: Read'],
    ],
  );
  assert.deepEqual(
    forwardedUpdates.map((update) => [update.worker, update.type, update.text]),
    [
      ['claude', 'response_text', 'checking files'],
      ['claude', 'tool_call', 'using tool: Read'],
    ],
  );
});

test('runAgentJob does not fall back for non-runtime worker failures', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, '#!/usr/bin/env node\nconsole.error("unexpected parser failure");\nprocess.exit(1);\n');
  await fs.writeFile(codexBin, '#!/usr/bin/env node\nconsole.log("should not run");\n');
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  await assert.rejects(
    runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'claude,codex',
        CLAUDE_BIN: claudeBin,
        CODEX_BIN: codexBin,
      }),
      job: { channelId: 'personal', event: { content: '작업' } },
      prompt: 'do it',
    }),
    (error) => {
      assert.equal(error.worker, 'claude');
      assert.equal(error.workerAttempts.length, 1);
      return true;
    },
  );
});

test('runAgentJob does not fall back after manual worker termination', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    "process.kill(process.pid, 'SIGTERM');",
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, '#!/usr/bin/env node\nconsole.log("should not run");\n');
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  await assert.rejects(
    runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'claude,codex',
        CLAUDE_BIN: claudeBin,
        CODEX_BIN: codexBin,
      }),
      job: { channelId: 'personal', event: { content: '작업' } },
      prompt: 'do it',
    }),
    (error) => {
      assert.equal(error.worker, 'claude');
      assert.equal(error.signal, 'SIGTERM');
      assert.equal(error.workerAttempts.length, 1);
      return true;
    },
  );
});

test('runAgentJob does not fall back after abort signal', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const ready = path.join(temp, 'claude-ready');
  const codexRan = path.join(temp, 'codex-ran');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(codexRan)}, 'ran');`,
    'console.log("should not run");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  const controller = new AbortController();
  const runPromise = runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'claude,codex',
      CLAUDE_BIN: claudeBin,
      CODEX_BIN: codexBin,
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
    signal: controller.signal,
  });
  await waitForFile(ready);
  controller.abort('superseded-by:message-2');

  await assert.rejects(
    runPromise,
    (error) => {
      assert.equal(error.worker, 'claude');
      assert.equal(error.aborted, true);
      assert.equal(error.abortReason, 'superseded-by:message-2');
      assert.equal(error.workerAttempts.length, 1);
      return true;
    },
  );
  await assert.rejects(fs.access(codexRan), { code: 'ENOENT' });
});

test('runAgentJob does not fall back when service shutdown interrupts a worker', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const ready = path.join(temp, 'claude-ready');
  const codexRan = path.join(temp, 'codex-ran');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "fs.writeSync(2, '503 service unavailable\\n');",
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    "process.on('SIGTERM', () => {",
    "  fs.writeSync(2, 'cleanup after restart failed\\n');",
    '  process.exit(1);',
    '});',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(codexRan)}, 'ran');`,
    'console.log("should not run");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  let shuttingDown = false;
  const runPromise = runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'claude,codex',
      CLAUDE_BIN: claudeBin,
      CODEX_BIN: codexBin,
      BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
    }),
    job: { channelId: 'personal', event: { content: '/yolo 작업' } },
    prompt: 'do it',
    isShuttingDown: () => shuttingDown,
  });

  await waitForFile(ready);
  shuttingDown = true;
  await terminateActiveProcessesGracefully({ graceMs: 100, forceGraceMs: 100 });

  await assert.rejects(
    runPromise,
    (error) => {
      assert.equal(error.worker, 'claude');
      assert.equal(error.serviceShutdownInterrupted, true);
      assert.equal(error.workerAttempts.length, 1);
      assert.equal(error.workerAttempts[0].status, 'interrupted');
      assert.match(error.workerAttempts[0].error, /503 service unavailable/);
      assert.match(error.workerAttempts[0].error, /code=1/);
      return true;
    },
  );
  await assert.rejects(fs.access(codexRan), { code: 'ENOENT' });
});

test('runAgentJob does not spawn a fallback worker when shutdown begins during its start notification', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const claudeBin = path.join(temp, 'fake-claude.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  const codexRan = path.join(temp, 'codex-ran');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(claudeBin, [
    '#!/usr/bin/env node',
    'console.error("insufficient credits");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(codexRan)}, 'ran');`,
    'console.log("should not run");',
    '',
  ].join('\n'));
  await fs.chmod(claudeBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  let shuttingDown = false;
  const workerStarts = [];
  await assert.rejects(
    runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'claude,codex',
        CLAUDE_BIN: claudeBin,
        CODEX_BIN: codexBin,
        BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
      }),
      job: { channelId: 'personal', event: { content: '/yolo 작업' } },
      prompt: 'do it',
      isShuttingDown: () => shuttingDown,
      onWorkerStart: ({ worker }) => {
        workerStarts.push(worker);
        if (worker === 'codex') shuttingDown = true;
      },
    }),
    (error) => {
      assert.equal(error.serviceShutdownInterrupted, true);
      assert.equal(error.worker, 'claude');
      assert.deepEqual(error.workerAttempts.map((attempt) => attempt.status), ['failed']);
      return true;
    },
  );
  assert.deepEqual(workerStarts, ['claude', 'codex']);
  await assert.rejects(fs.access(codexRan), { code: 'ENOENT' });
});

test('worker CLI args include bridge roots and Gemini sandbox is opt-in', () => {
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    CODEX_ALLOWED_ROOTS: '/tmp/projects/mobile-codex-bridge,/tmp/other',
  });

  const claudeArgs = buildClaudeArgs(config);
  assert.equal(claudeArgs[claudeArgs.indexOf('--permission-mode') + 1], 'default');
  assert.equal(claudeArgs[claudeArgs.indexOf('--model') + 1], 'opus');
  assert.equal(claudeArgs[claudeArgs.indexOf('--effort') + 1], 'xhigh');
  assert.equal(claudeArgs.includes('--verbose'), true);
  // Regression guard for E2BIG: prompt must travel on stdin, never in argv.
  // -p is a bare flag immediately followed by --output-format (no positional prompt).
  assert.equal(claudeArgs[claudeArgs.indexOf('-p') + 1], '--output-format');
  assert.deepEqual(claudeArgs.slice(claudeArgs.indexOf('--add-dir') + 1), [
    '/tmp/other',
  ]);

  const maintenanceClaudeArgs = buildClaudeArgs(config, {
    permissionMode: config.claude.maintenancePermissionMode,
    model: config.claude.maintenanceModel,
    effort: config.claude.maintenanceEffort,
  });
  assert.equal(maintenanceClaudeArgs[maintenanceClaudeArgs.indexOf('--permission-mode') + 1], 'default');
  assert.equal(maintenanceClaudeArgs[maintenanceClaudeArgs.indexOf('--model') + 1], 'claude-fable-5');
  assert.equal(maintenanceClaudeArgs[maintenanceClaudeArgs.indexOf('--effort') + 1], 'xhigh');

  const args = buildGeminiArgs(config, 'inspect');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.1-pro-preview');
  assert.equal(args.includes('--effort'), false);
  assert.equal(args.includes('--sandbox'), false);
  assert.equal(args.includes('--include-directories'), true);
  assert.equal(args[args.indexOf('--include-directories') + 1], '/tmp/other');

  const sandboxedArgs = buildGeminiArgs(loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    GEMINI_SANDBOX: 'true',
  }), 'inspect');
  assert.equal(sandboxedArgs.includes('--sandbox'), true);

  const agyArgs = buildAntigravityArgs(config, 'inspect');
  assert.equal(agyArgs[0], '-p');
  assert.equal(agyArgs[1], 'inspect');
  // A pinned-tier model id already names one concrete variant; `agy` rejects `--effort` with it.
  assert.equal(agyArgs[agyArgs.indexOf('--model') + 1], 'gemini-3.7-flash-high');
  assert.equal(agyArgs.includes('--effort'), false);
  const invalidEffortArgs = buildAntigravityArgs(config, 'inspect', {
    model: 'gemini-3.7-flash',
    effort: 'xhigh',
  });
  assert.equal(invalidEffortArgs[invalidEffortArgs.indexOf('--effort') + 1], 'high');
  assert.equal(agyArgs.includes('--dangerously-skip-permissions'), false);
  assert.deepEqual(agyArgs.slice(agyArgs.indexOf('--add-dir')), ['--add-dir', '/tmp/other']);

  const guardedAgyArgs = buildAntigravityArgs(loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    ANTIGRAVITY_APPROVAL_MODE: 'default',
    ANTIGRAVITY_SANDBOX: 'true',
  }), 'inspect');
  assert.equal(guardedAgyArgs.includes('--dangerously-skip-permissions'), false);
  assert.equal(guardedAgyArgs.includes('--sandbox'), true);
});

// Regression: `/model` row 5 (antigravity claude-opus-4.6) failed every run with
// `--effort is not supported for model "Claude Opus 4.6 (Thinking)"`, and row 6
// failed on any `/effort` other than the tier pinned in its model id.
test('antigravity model/effort pairs are resolved the way agy accepts them', () => {
  const modelOf = (args) => args[args.indexOf('--model') + 1];
  const effortOf = (args) => (args.includes('--effort') ? args[args.indexOf('--effort') + 1] : null);
  const config = loadConfig({
    PROJECT_ROOT: '/tmp/projects',
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
  });
  const build = (model, effort) => buildAntigravityArgs(config, 'inspect', { model, effort });

  // Claude ids and display names expose no effort variants: the flag must be dropped.
  for (const model of ['Claude Opus 4.6 (Thinking)', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6']) {
    for (const effort of ['high', 'low']) {
      const args = build(model, effort);
      assert.equal(modelOf(args), model);
      assert.equal(effortOf(args), null);
    }
  }

  // A pinned tier stays in the id; a different request repoints the id instead of conflicting.
  assert.equal(modelOf(build('gemini-3.7-flash-high', 'high')), 'gemini-3.7-flash-high');
  assert.equal(effortOf(build('gemini-3.7-flash-high', 'high')), null);
  assert.equal(modelOf(build('gemini-3.7-flash-high', 'low')), 'gemini-3.7-flash-low');
  assert.equal(effortOf(build('gemini-3.7-flash-high', 'low')), null);

  // A base family name still requires the flag.
  assert.equal(effortOf(build('gemini-3.7-flash', 'medium')), 'medium');
  assert.equal(modelOf(build('gemini-3.7-flash', 'medium')), 'gemini-3.7-flash');

  assert.deepEqual(resolveAntigravityModelSelection('', 'low'), { model: '', effort: 'low' });
});

test('antigravity retries once on agy model/effort validation errors', () => {
  const withEffort = ['-p', 'x', '--model', 'claude-opus-4-6-thinking', '--effort', 'high'];
  assert.deepEqual(
    antigravityRetryArgs(withEffort, 'Error: invalid model selection (...): --effort is not supported for model "claude-opus-4-6-thinking"'),
    ['-p', 'x', '--model', 'claude-opus-4-6-thinking'],
  );
  assert.deepEqual(
    antigravityRetryArgs(withEffort, 'Error: invalid model selection (...): --model x conflicts with --effort=high'),
    ['-p', 'x', '--model', 'claude-opus-4-6-thinking'],
  );

  const withoutEffort = ['-p', 'x', '--model', 'gemini-3.7-flash'];
  assert.deepEqual(
    antigravityRetryArgs(withoutEffort, 'Error: invalid model selection (...): --model gemini-3.7-flash requires --effort (available: low, medium, high)'),
    ['-p', 'x', '--model', 'gemini-3.7-flash', '--effort', 'high'],
  );
  assert.deepEqual(
    antigravityRetryArgs(withoutEffort, 'Error: invalid model selection (...): --model x requires --effort (available: low)'),
    ['-p', 'x', '--model', 'gemini-3.7-flash', '--effort', 'low'],
  );

  // Unrelated failures must not be retried.
  assert.equal(antigravityRetryArgs(withEffort, 'Error: rate limited'), null);
  assert.equal(antigravityRetryArgs(withoutEffort, 'Error: invalid model selection: unknown model'), null);
});

test('JSON stream observers capture worker progress and final text', () => {
  assert.deepEqual(
    extractClaudeProgressUpdate({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'reading repo' }] },
    }),
    { type: 'response_text', text: 'reading repo', append: false },
  );
  assert.deepEqual(
    extractGeminiProgressUpdate({
      type: 'message',
      role: 'assistant',
      content: 'checking tests',
      delta: true,
    }),
    { type: 'response_text', text: 'checking tests', append: true },
  );
  assert.deepEqual(
    extractAntigravityProgressUpdate({
      type: 'thought',
      content: 'checking antigravity',
    }),
    { type: 'response_text', text: 'checking antigravity', append: false },
  );

  const updates = [];
  const stream = createJsonLineStreamObserver(updates.push.bind(updates), extractGeminiProgressUpdate);
  stream.write('{"type":"message","role":"assistant","content":"check","delta":true}\n');
  stream.write('{"type":"message","role":"assistant","content":"ing","delta":true}');
  stream.flush();
  assert.deepEqual(updates, [
    { type: 'response_text', text: 'check', append: true },
    { type: 'response_text', text: 'ing', append: true },
  ]);

  assert.equal(
    extractJsonStreamFinalText([
      '{"type":"message","role":"assistant","content":"done","delta":true}',
      '{"type":"result","status":"success"}',
    ].join('\n')),
    'done',
  );
  assert.equal(
    extractJsonStreamFinalText('{"type":"result","status":"success","result":"claude done"}'),
    'claude done',
  );
});

test('Claude progress classifies command requests and outputs as tool updates', () => {
  assert.deepEqual(
    extractClaudeProgressUpdate({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: '/bin/bash -lc pwd' } }],
      },
    }),
    {
      type: 'tool_call',
      kind: 'command',
      actionId: null,
      command: '/bin/bash -lc pwd',
      tool: 'Bash',
      status: 'in_progress',
      text: 'running command: /bin/bash -lc pwd',
      append: false,
    },
  );
  assert.deepEqual(
    extractClaudeProgressUpdate({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: '/tmp/project\n' }],
      },
    }),
    {
      type: 'tool_output',
      kind: 'tool_result',
      actionId: null,
      status: 'completed',
      output: '/tmp/project',
      text: 'tool output:\n/tmp/project',
      append: false,
    },
  );
  assert.deepEqual(
    extractClaudeProgressUpdate({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Command line output: /tmp/project\n' }],
      },
    }),
    { type: 'tool_output', text: 'command output:\n/tmp/project', append: false },
  );
  assert.equal(
    extractClaudeProgressUpdate({
      type: 'user',
      message: { role: 'user', content: 'original user prompt' },
    }),
    null,
  );
});

test('Claude thinking blocks stay out of progress updates', () => {
  assert.equal(
    extractClaudeProgressUpdate({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'thinking',
          thinking: 'private reasoning must stay hidden',
          signature: 'encrypted-signature-must-stay-hidden',
        }],
      },
    }),
    null,
  );
});

test('Claude observer emits no synthetic liveness text across thinking and tool-only turns', () => {
  const updates = [];
  const stream = createClaudeJsonStreamObserver((update) => updates.push(update));

  for (const event of [
    {
      type: 'assistant',
      timestamp: '2026-07-31T09:41:53.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'encrypted-1' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-31T09:41:55.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'sensitive-command' } }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-31T09:42:04.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: 'secret-path' } }],
      },
    },
  ]) {
    stream.write(`${JSON.stringify(event)}\n`);
  }
  stream.flush();

  assert.deepEqual(updates, [
    {
      type: 'tool_call',
      kind: 'command',
      actionId: 'tu_1',
      command: 'sensitive-command',
      tool: 'Bash',
      status: 'in_progress',
      text: 'running command: sensitive-command',
      append: false,
    },
    {
      type: 'file_change',
      actionId: 'tu_2',
      tool: 'Edit',
      changes: [{ path: 'secret-path', kind: 'modified' }],
      text: 'modified file: secret-path',
      append: false,
    },
  ]);
});

test('createClaudeJsonStreamObserver keeps the newest assistant text as the final candidate', () => {
  const updates = [];
  const stream = createClaudeJsonStreamObserver((update) => updates.push(update));

  stream.write(`${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'checking files' }] },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'final answer' }] },
  })}\n`);
  stream.write(`${JSON.stringify({ type: 'result', status: 'success', result: 'final answer' })}\n`);
  stream.flush();

  assert.deepEqual(updates, [
    { type: 'response_text', text: 'checking files', append: false },
  ]);
});

test('createClaudeJsonStreamObserver keeps the terminal snapshot behind passive stream events', () => {
  const updates = [];
  const stream = createClaudeJsonStreamObserver((update) => updates.push(update));
  const terminalText = [
    'final answer',
    '<bridge_restart_service>{"reason":"runtime behavior changed","improvement":"loads the fix"}</bridge_restart_service>',
  ].join('\n');

  for (const event of [
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: terminalText }] },
    },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', status: 'success', result: terminalText },
  ]) {
    stream.write(`${JSON.stringify(event)}\n`);
  }
  stream.flush();

  assert.deepEqual(updates, []);
});

test('createClaudeJsonStreamObserver does not forward tool results as response text', () => {
  const updates = [];
  const stream = createClaudeJsonStreamObserver((update) => updates.push(update));

  stream.write(`${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'checking path' }] },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: '/tmp/project\n' }],
    },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  })}\n`);
  stream.write(`${JSON.stringify({ type: 'result', status: 'success', result: 'done' })}\n`);
  stream.flush();

  assert.deepEqual(updates, [
    { type: 'response_text', text: 'checking path', append: false },
    {
      type: 'tool_output',
      kind: 'tool_result',
      actionId: null,
      status: 'completed',
      output: '/tmp/project',
      text: 'tool output:\n/tmp/project',
      append: false,
    },
  ]);
});

test('createClaudeJsonStreamObserver releases assistant progress before non-terminal work', () => {
  const updates = [];
  const stream = createClaudeJsonStreamObserver((update) => updates.push(update));

  stream.write(`${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'read' }] },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'assistant_delta',
    delta: { text: 'ing repo' },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'tool_use',
    name: 'Read',
    input: { file_path: 'bridge-service.mjs' },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'done' }] },
  })}\n`);
  stream.write(`${JSON.stringify({ type: 'result', status: 'success', result: 'done' })}\n`);
  stream.flush();

  assert.deepEqual(updates, [
    { type: 'response_text', text: 'reading repo', append: false },
    {
      type: 'tool_call',
      kind: 'structured_tool',
      actionId: null,
      command: undefined,
      tool: 'Read',
      status: 'in_progress',
      text: 'using tool: Read',
      append: false,
    },
  ]);
});

test('extractJsonStreamFinalText preserves plain raw fallback output', () => {
  const stdout = 'raw '.repeat(2_000);

  assert.equal(extractJsonStreamFinalText(stdout), stdout.trim());
});

test('extractJsonStreamFinalText does not expose raw JSON stream fallback', () => {
  const stdout = [
    '{"type":"system","subtype":"init","tools":["Read","Bash"]}',
    '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}',
  ].join('\n');

  assert.equal(extractJsonStreamFinalText(stdout), 'Not logged in · Please run /login');
});

test('runAgentJob trusts the workspace for Gemini headless runs', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const geminiBin = path.join(temp, 'fake-gemini.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(geminiBin, [
    '#!/usr/bin/env node',
    'console.log(`${process.env.GEMINI_CLI_TRUST_WORKSPACE}:${process.env.GEMINI_SANDBOX}`);',
    '',
  ].join('\n'));
  await fs.chmod(geminiBin, 0o755);

  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'gemini',
      GEMINI_BIN: geminiBin,
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
  });

  assert.equal(result.output, 'true:false');
  assert.equal(result.worker, 'gemini');
});

test('runAgentJob injects only allowlisted channel.env values into workers', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const stateRoot = path.join(projectRoot, '.bridge_state');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const channelRoot = path.join(stateRoot, 'personal_common');
  const geminiBin = path.join(temp, 'fake-gemini.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(channelRoot, { recursive: true });
  await fs.writeFile(path.join(channelRoot, '.env'), [
    'GITHUB_TOKEN=wrong-file',
    'DOTENV_ONLY=must-not-load',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(channelRoot, 'channel.env'), [
    'GITHUB_TOKEN=channel-token',
    'UNLISTED=visible-because-allowlisted',
    'BLOCKED=hidden',
    '',
  ].join('\n'));
  await fs.writeFile(geminiBin, [
    '#!/usr/bin/env node',
    'console.log([',
    '  process.env.GITHUB_TOKEN || "",',
    '  process.env.UNLISTED || "",',
    '  process.env.BLOCKED || "",',
    '  process.env.DOTENV_ONLY || "",',
    '  process.env.HOME.endsWith("gemini-home") ? "home-ok" : process.env.HOME,',
    '].join(":"));',
    '',
  ].join('\n'));
  await fs.chmod(geminiBin, 0o755);

  const previousGithubToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'parent-token';
  try {
    const result = await runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'gemini',
        GEMINI_BIN: geminiBin,
        CHANNEL_ENV_ALLOWLIST: 'GITHUB_TOKEN,UNLISTED,DOTENV_ONLY',
      }),
      job: { channelId: 'personal', event: { content: '작업' } },
      prompt: 'do it',
    });

    assert.equal(result.output, 'channel-token:visible-because-allowlisted:::home-ok');
    assert.equal(result.worker, 'gemini');
  } finally {
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
  }
});

test('runAgentJob exposes channel Python virtualenv to workers', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const stateRoot = path.join(projectRoot, '.bridge_state');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const channelRoot = path.join(stateRoot, 'personal_common');
  const venvPath = path.join(channelRoot, '.venv');
  const venvBin = path.join(venvPath, 'bin');
  const geminiBin = path.join(temp, 'fake-gemini.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(venvBin, { recursive: true });
  await fs.writeFile(path.join(venvBin, 'python'), 'synthetic venv executable\n');
  await fs.chmod(path.join(venvBin, 'python'), 0o755);
  await fs.writeFile(geminiBin, [
    '#!/usr/bin/env node',
    'const firstPath = process.env.PATH.split(process.platform === "win32" ? ";" : ":")[0];',
    'console.log([',
    '  process.env.VIRTUAL_ENV || "",',
    '  process.env.PYTHON || "",',
    '  firstPath,',
    '  process.env.PYTHONNOUSERSITE || "",',
    '  process.env.PYTHONHOME || "",',
    '].join("|"));',
    '',
  ].join('\n'));
  await fs.chmod(geminiBin, 0o755);

  const previousPythonHome = process.env.PYTHONHOME;
  process.env.PYTHONHOME = '/bad/pythonhome';
  try {
    const result = await runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'gemini',
        GEMINI_BIN: geminiBin,
        CHANNEL_PYTHON_VENV_AUTO_CREATE: 'false',
      }),
      job: { channelId: 'personal', event: { content: '작업' } },
      prompt: 'do it',
    });

    assert.equal(result.output, [
      venvPath,
      path.join(venvBin, 'python'),
      venvBin,
      '1',
      '',
    ].join('|'));
    assert.equal(result.worker, 'gemini');
  } finally {
    if (previousPythonHome === undefined) delete process.env.PYTHONHOME;
    else process.env.PYTHONHOME = previousPythonHome;
  }
});

test('runAgentJob can use explicit Antigravity selection', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const otherRoot = path.join(temp, 'other');
  const agyBin = path.join(temp, 'fake-agy.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(otherRoot, { recursive: true });
  await fs.writeFile(agyBin, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args[0] === "models") process.exit(0);',
    'const model = args[args.indexOf("--model") + 1];',
    'const addDir = args[args.indexOf("--add-dir") + 1];',
    'const effort = args.includes("--effort") ? args[args.indexOf("--effort") + 1] : "none";',
    'console.log([process.env.ANTIGRAVITY_CLI_TRUST_WORKSPACE, process.env.ANTIGRAVITY_SANDBOX, args.includes("--dangerously-skip-permissions"), model, effort, addDir].join(":"));',
    '',
  ].join('\n'));
  await fs.chmod(agyBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'codex',
    ANTIGRAVITY_BIN: agyBin,
    CODEX_ALLOWED_ROOTS: `${cwd},${otherRoot}`,
  });
  const antigravityOption = modelOptionByNumber(config, 6);
  assert.equal(antigravityOption.worker, 'antigravity');
  assert.equal(antigravityOption.label, 'antigravity: gemini-3.7-flash');

  const result = await runAgentJob({
    config,
    job: {
      channelId: 'personal',
      repoAccess: true,
      threadModelOverride: modelSelectionFromOption(antigravityOption),
      event: { content: '작업' },
    },
    prompt: 'do it',
  });

  // The tier is pinned in the model id, so `agy` must not also receive `--effort`.
  assert.equal(result.output, `true:false:false:gemini-3.7-flash-high:none:${path.join(projectRoot, '.bridge_state', 'personal_common')}`);
  assert.equal(result.worker, 'antigravity-gemini-3.7-flash-high');
});

test('runAgentJob falls back quickly when Antigravity is not signed in', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const agyBin = path.join(temp, 'fake-agy.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(agyBin, [
    '#!/usr/bin/env node',
    'if (process.argv[2] === "models") {',
    '  console.error("Error: Please sign in to view available models.");',
    '  process.exit(1);',
    '}',
    'console.log("should not run prompt");',
    '',
  ].join('\n'));
  await fs.writeFile(codexBin, '#!/usr/bin/env node\nconsole.log("codex fallback");\n');
  await fs.chmod(agyBin, 0o755);
  await fs.chmod(codexBin, 0o755);

  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'antigravity,codex',
      ANTIGRAVITY_BIN: agyBin,
      CODEX_BIN: codexBin,
      BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
  });

  assert.equal(result.output, 'codex fallback');
  assert.deepEqual(result.attempts.map((attempt) => attempt.worker), ['antigravity', 'codex']);
});

test('runAgentJob can use Codex Spark as the final worker', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    'const model = process.argv[process.argv.indexOf("-m") + 1];',
    'console.log(model);',
    '',
  ].join('\n'));
  await fs.chmod(codexBin, 0o755);

  const result = await runAgentJob({
    config: loadConfig({
      PROJECT_ROOT: projectRoot,
      BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
      DEFAULT_WORKER_CHAIN: 'spark',
      CODEX_BIN: codexBin,
      CODEX_SPARK_MODEL: 'gpt-5.3-codex-spark',
      BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
    }),
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
  });

  assert.equal(result.output, 'gpt-5.3-codex-spark');
  assert.equal(result.worker, 'codex-spark');
});

test('Codex Spark runs at its own top effort instead of inheriting the GPT-5.6 max tier', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    'const effort = process.argv.find((arg) => arg.startsWith("model_reasoning_effort="));',
    'console.log(effort);',
    '',
  ].join('\n'));
  await fs.chmod(codexBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    DEFAULT_WORKER_CHAIN: 'spark',
    CODEX_BIN: codexBin,
    CODEX_SPARK_MODEL: 'gpt-5.3-codex-spark',
    // Both the shared GPT-5.6 effort and Spark's own key ask for max; Spark is
    // GPT-5.3 and would fail the API call with `unsupported_value`.
    CODEX_REASONING_EFFORT: 'max',
    CODEX_SPARK_REASONING_EFFORT: 'max',
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  });
  const result = await runAgentJob({
    config,
    job: { channelId: 'personal', event: { content: '작업' } },
    prompt: 'do it',
  });

  assert.equal(result.output, 'model_reasoning_effort="xhigh"');
  assert.equal(result.worker, 'codex-spark');
  // The completion marker has to report the effort that actually ran.
  assert.equal(result.workerEffort, 'xhigh');
  assert.equal(config.codex.reasoningEffort, 'max');
});

async function waitForFile(file, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fs.access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

test('isWorkerArgvLimitError matches only argv-size failures, not model context limits', () => {
  assert.equal(isWorkerArgvLimitError({ message: 'spawn E2BIG' }), true);
  assert.equal(isWorkerArgvLimitError({ stderr: 'Argument list too long' }), true);
  assert.equal(isWorkerArgvLimitError({ message: 'context_length_exceeded: maximum context length' }), false);
  assert.equal(isWorkerArgvLimitError(null), false);
});

test('runAgentJob continues the fallback chain when an argv-based worker hits E2BIG', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const geminiBin = path.join(temp, 'fake-gemini.mjs');
  const codexBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  // gemini passes the prompt as argv, so an oversized prompt fails with the OS
  // E2BIG limit even though stdin-based workers could run the same prompt.
  await fs.writeFile(geminiBin, '#!/usr/bin/env node\nconsole.error("spawn E2BIG: Argument list too long");\nprocess.exit(1);\n');
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
  const failed = result.attempts.filter((attempt) => attempt.status === 'failed');
  assert.ok(failed.length >= 1);
  assert.ok(failed.every((attempt) => attempt.worker === 'gemini'));
});

test('runAgentJob still fails as input-limit when E2BIG hits the last chain worker', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const geminiBin = path.join(temp, 'fake-gemini.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(geminiBin, '#!/usr/bin/env node\nconsole.error("spawn E2BIG: Argument list too long");\nprocess.exit(1);\n');
  await fs.chmod(geminiBin, 0o755);

  await assert.rejects(
    runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'gemini',
        GEMINI_BIN: geminiBin,
      }),
      job: { channelId: 'personal', event: { content: '작업' } },
      prompt: 'do it',
    }),
    (error) => {
      assert.equal(error.inputLimit, true);
      assert.equal(error.worker, 'gemini');
      return true;
    },
  );
});

test('Claude file-editing tools report file changes as job evidence', () => {
  // Claude edits through structured tools rather than shell commands, so
  // without this the checkpoint holds no per-job evidence and a runtime-source
  // restart is dropped as unattributed.
  assert.deepEqual(
    extractClaudeProgressUpdate({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_1',
          name: 'Edit',
          input: { file_path: '/repo/lib/config.mjs', old_string: 'a', new_string: 'b' },
        }],
      },
    }),
    {
      type: 'file_change',
      actionId: 'tu_1',
      tool: 'Edit',
      changes: [{ path: '/repo/lib/config.mjs', kind: 'modified' }],
      text: 'modified file: /repo/lib/config.mjs',
      append: false,
    },
  );

  assert.deepEqual(
    extractClaudeProgressUpdate({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_2',
          name: 'NotebookEdit',
          input: { notebook_path: '/repo/analysis.ipynb' },
        }],
      },
    }).changes,
    [{ path: '/repo/analysis.ipynb', kind: 'modified' }],
  );

  // Read-only tools must not register as workspace mutations.
  const readUpdate = extractClaudeProgressUpdate({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_3', name: 'Read', input: { file_path: '/repo/lib/state.mjs' } }],
    },
  });
  assert.equal(readUpdate.type, 'tool_call');
  assert.equal(readUpdate.changes, undefined);
});
