import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCodexArgs,
  createCodexJsonStreamObserver,
  extractCodexErrorText,
  extractCodexFinalText,
  extractCodexProgressUpdate,
  runProcess,
  runCodexJob,
  terminateActiveProcessesGracefully,
} from '../lib/codex-runner.mjs';
import { loadConfig } from '../lib/config.mjs';

test('buildCodexArgs enables live web search only when requested', () => {
  const config = {
    projectRoot: '/tmp/projects',
    allowedRoots: ['/tmp/projects/mobile-codex-bridge'],
    codex: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      reasoningSummary: 'auto',
      sandboxMode: 'danger-full-access',
      cwd: '/tmp/projects/mobile-codex-bridge',
    },
  };

  assert.equal(buildCodexArgs(config).includes('--search'), false);
  assert.equal(buildCodexArgs(config).some((arg) => arg.includes('service_tier')), false);

  const searchArgs = buildCodexArgs(config, { search: true });
  assert.equal(searchArgs.includes('--search'), true);
  assert(searchArgs.indexOf('--search') < searchArgs.indexOf('exec'));
  assert.equal(searchArgs.includes('--json'), true);
  assert.equal(searchArgs.includes('--verbose'), false);
  assert(searchArgs.indexOf('--json') > searchArgs.indexOf('exec'));
  assert.equal(searchArgs[searchArgs.indexOf('-s') + 1], 'danger-full-access');
  assert.deepEqual(searchArgs.slice(4, 8), [
    '-c',
    'model_reasoning_effort="xhigh"',
    '-c',
    'model_reasoning_summary="auto"',
  ]);
  assert.equal(searchArgs[searchArgs.indexOf('-C') + 1], '/tmp/projects/mobile-codex-bridge');
  assert.equal(searchArgs.includes('/tmp/projects'), false);

  const sparkArgs = buildCodexArgs(config, { model: 'gpt-5.3-codex-spark', reasoningEffort: 'xhigh' });
  assert.equal(sparkArgs[sparkArgs.indexOf('-m') + 1], 'gpt-5.3-codex-spark');

  const fastArgs = buildCodexArgs(config, { serviceTier: 'fast' });
  assert.equal(fastArgs.includes('service_tier="fast"'), true);
  assert(fastArgs.indexOf('service_tier="fast"') < fastArgs.indexOf('exec'));
});

test('buildCodexArgs points Codex-spawned subagents at the configured model', () => {
  const config = {
    projectRoot: '/tmp/projects',
    allowedRoots: ['/tmp/projects/mobile-codex-bridge'],
    codex: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'ultra',
      reasoningSummary: 'auto',
      sandboxMode: 'danger-full-access',
      cwd: '/tmp/projects/mobile-codex-bridge',
      subagentModel: 'gpt-5.6-luna',
      subagentReasoningEffort: 'max',
    },
  };

  const args = buildCodexArgs(config);
  assert.equal(args.includes('agents.default_subagent_model="gpt-5.6-luna"'), true);
  assert.equal(args.includes('agents.default_subagent_reasoning_effort="max"'), true);
  // Every `-c` override has to precede the `exec` subcommand to be applied.
  assert(args.indexOf('agents.default_subagent_model="gpt-5.6-luna"') < args.indexOf('exec'));
  assert(args.indexOf('agents.default_subagent_reasoning_effort="max"') < args.indexOf('exec'));
  assert.equal(args.includes('model_reasoning_effort="ultra"'), true);

  // No configured model means Codex keeps its own default, so the bridge must not
  // emit a half-configured `[agents]` override.
  const inherited = buildCodexArgs({
    ...config,
    codex: { ...config.codex, subagentModel: '' },
  });
  assert.equal(inherited.some((arg) => arg.startsWith('agents.default_subagent')), false);

  // Luna has no `ultra` tier, so an ultra subagent request lands on its top tier
  // instead of a value the CLI would refuse for that model.
  const clamped = buildCodexArgs({
    ...config,
    codex: { ...config.codex, subagentReasoningEffort: 'ultra' },
  });
  assert.equal(clamped.includes('agents.default_subagent_reasoning_effort="max"'), true);
});

test('runCodexJob starts the child process in the bridge project directory', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexHome = path.join(cwd, '.state', 'codex-home');
  const fakeBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(fakeBin, '#!/usr/bin/env node\nconsole.log(process.cwd());\n');
  await fs.chmod(fakeBin, 0o755);

  const output = await runCodexJob({
    config: {
      projectRoot,
      allowedRoots: [projectRoot],
      codex: {
        bin: fakeBin,
        home: codexHome,
        homeSource: path.join(temp, 'missing-codex-home'),
        model: 'gpt-5.6-terra',
        reasoningEffort: 'xhigh',
        reasoningSummary: 'auto',
        cwd,
      },
    },
    prompt: 'pwd',
  });

  assert.equal(output, cwd);
});

test('runCodexJob forwards worker env overrides without replacing Codex runtime env', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexHome = path.join(cwd, '.state', 'codex-home');
  const fakeBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(fakeBin, [
    '#!/usr/bin/env node',
    'console.log(`${process.env.GITHUB_TOKEN}:${process.env.CODEX_HOME}`);',
    '',
  ].join('\n'));
  await fs.chmod(fakeBin, 0o755);

  const output = await runCodexJob({
    config: {
      projectRoot,
      allowedRoots: [projectRoot],
      workerEnvOverrides: {
        GITHUB_TOKEN: 'channel-token',
        CODEX_HOME: '/bad/channel-home',
      },
      codex: {
        bin: fakeBin,
        home: codexHome,
        homeSource: path.join(temp, 'missing-codex-home'),
        model: 'gpt-5.6-terra',
        reasoningEffort: 'xhigh',
        reasoningSummary: 'auto',
        cwd,
      },
    },
    prompt: 'env',
  });

  assert.equal(output, `channel-token:${codexHome}`);
});

test('runCodexJob exposes host gh auth to the worker process', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-github-env-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const hostHome = path.join(temp, 'host-home');
  const ghConfigDir = path.join(hostHome, '.config', 'gh');
  const gitConfigGlobal = path.join(hostHome, '.gitconfig');
  const askPassPath = path.join(temp, 'github-gh-askpass.sh');
  const codexHome = path.join(temp, 'codex-home');
  const fakeBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(ghConfigDir, { recursive: true });
  await fs.writeFile(path.join(ghConfigDir, 'hosts.yml'), 'github.com:\n    user: tester\n');
  await fs.writeFile(gitConfigGlobal, '[credential "https://github.com"]\n    helper = !gh auth git-credential\n');
  await fs.writeFile(askPassPath, '#!/bin/sh\nexit 1\n');
  await fs.writeFile(fakeBin, [
    '#!/usr/bin/env node',
    'console.log([',
    '  process.env.GH_CONFIG_DIR,',
    '  process.env.GIT_CONFIG_GLOBAL,',
    '  process.env.GIT_ASKPASS,',
    '  process.env.GITHUB_TOKEN === "",',
    '  process.env.GH_TOKEN === "",',
    '  process.env.GIT_TERMINAL_PROMPT,',
    '].join("|"));',
    '',
  ].join('\n'));
  await fs.chmod(fakeBin, 0o755);

  const config = loadConfig({
    PROJECT_ROOT: projectRoot,
    BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
    HOME: hostHome,
    BRIDGE_GH_ASKPASS: askPassPath,
    BRIDGE_PREFER_HOST_GH_CREDENTIAL: 'true',
    CODEX_BIN: fakeBin,
    BRIDGE_CODEX_HOME: codexHome,
    BRIDGE_CODEX_HOME_SOURCE: path.join(temp, 'missing-codex-home'),
  });
  config.codex.cwd = cwd;

  const output = await runCodexJob({ config, prompt: 'env' });

  assert.equal(output, `${ghConfigDir}|${gitConfigGlobal}|${askPassPath}|true|true|0`);
});

test('runCodexJob does not expose raw JSON stdout on process failure', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexHome = path.join(cwd, '.state', 'codex-home');
  const fakeBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(fakeBin, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));',
    'console.log(JSON.stringify({ type: "turn.completed" }));',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.chmod(fakeBin, 0o755);

  await assert.rejects(
    runCodexJob({
      config: {
        projectRoot,
      allowedRoots: [projectRoot],
        codex: {
          bin: fakeBin,
          home: codexHome,
          homeSource: path.join(temp, 'missing-codex-home'),
          model: 'gpt-5.6-terra',
          reasoningEffort: 'xhigh',
          reasoningSummary: 'auto',
          cwd,
        },
      },
      prompt: 'fail',
    }),
    (error) => {
      assert.equal(error.message, 'codex exited with 1');
      return true;
    },
  );
});

test('extractCodexErrorText reads JSONL-only failures without dumping raw events', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'upstream connection reset' } }),
  ].join('\n');

  assert.equal(extractCodexErrorText(stdout), 'upstream connection reset');
});

test('runCodexJob reports JSONL-only Codex failures', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-json-error-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexHome = path.join(cwd, '.state', 'codex-home');
  const fakeBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(fakeBin, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));',
    'console.log(JSON.stringify({ type: "turn.failed", error: { message: "upstream connection reset" } }));',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.chmod(fakeBin, 0o755);

  await assert.rejects(
    runCodexJob({
      config: {
        projectRoot,
        allowedRoots: [projectRoot],
        codex: {
          bin: fakeBin,
          home: codexHome,
          homeSource: path.join(temp, 'missing-codex-home'),
          model: 'gpt-5.6-terra',
          reasoningEffort: 'xhigh',
          reasoningSummary: 'auto',
          cwd,
        },
      },
      prompt: 'fail',
    }),
    (error) => {
      assert.equal(error.message, 'upstream connection reset');
      return true;
    },
  );
});

test('runCodexJob rejects successful JSON streams without a final message', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexHome = path.join(cwd, '.state', 'codex-home');
  const fakeBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(fakeBin, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));',
    'console.log(JSON.stringify({ type: "turn.started" }));',
    'process.exit(0);',
    '',
  ].join('\n'));
  await fs.chmod(fakeBin, 0o755);

  await assert.rejects(
    runCodexJob({
      config: {
        projectRoot,
        allowedRoots: [projectRoot],
        codex: {
          bin: fakeBin,
          home: codexHome,
          homeSource: path.join(temp, 'missing-codex-home'),
          model: 'gpt-5.6-terra',
          reasoningEffort: 'xhigh',
          reasoningSummary: 'auto',
          cwd,
        },
      },
      prompt: 'fail',
    }),
    (error) => {
      assert.equal(error.message, 'codex produced no final message');
      assert.equal(error.code, 0);
      return true;
    },
  );
});

test('runCodexJob does not promote progress when the terminal assistant message is empty', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-empty-final-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexHome = path.join(cwd, '.state', 'codex-home');
  const fakeBin = path.join(temp, 'fake-codex.mjs');
  const updates = [];
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(fakeBin, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));',
    'console.log(JSON.stringify({ type: "turn.started" }));',
    'console.log(JSON.stringify({',
    '  type: "item.completed",',
    '  item: { id: "item_0", type: "agent_message", text: "PNG 렌더링이 진행 중입니다." },',
    '}));',
    'console.log(JSON.stringify({',
    '  type: "item.completed",',
    '  item: { id: "item_1", type: "reasoning", text: "waiting for image generation" },',
    '}));',
    'console.log(JSON.stringify({',
    '  type: "item.completed",',
    '  item: { id: "item_2", type: "agent_message", text: "" },',
    '}));',
    'console.log(JSON.stringify({ type: "turn.completed" }));',
    'process.exit(0);',
    '',
  ].join('\n'));
  await fs.chmod(fakeBin, 0o755);

  await assert.rejects(
    runCodexJob({
      config: {
        projectRoot,
        allowedRoots: [projectRoot],
        codex: {
          bin: fakeBin,
          home: codexHome,
          homeSource: path.join(temp, 'missing-codex-home'),
          model: 'gpt-5.6-terra',
          reasoningEffort: 'xhigh',
          reasoningSummary: 'auto',
          cwd,
        },
      },
      prompt: 'generate a PNG',
      onUpdate: (update) => updates.push(update),
    }),
    (error) => {
      assert.equal(error.message, 'codex produced no final message');
      assert.equal(error.code, 0);
      return true;
    },
  );
  assert.deepEqual(
    updates.filter((update) => update.type === 'response_text'),
    [{ type: 'response_text', text: 'PNG 렌더링이 진행 중입니다.' }],
  );
});

test('runCodexJob preserves child termination signal on failure', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-'));
  const projectRoot = path.join(temp, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const codexHome = path.join(cwd, '.state', 'codex-home');
  const fakeBin = path.join(temp, 'fake-codex.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(fakeBin, [
    '#!/usr/bin/env node',
    "process.kill(process.pid, 'SIGTERM');",
    '',
  ].join('\n'));
  await fs.chmod(fakeBin, 0o755);

  await assert.rejects(
    runCodexJob({
      config: {
        projectRoot,
        allowedRoots: [projectRoot],
        codex: {
          bin: fakeBin,
          home: codexHome,
          homeSource: path.join(temp, 'missing-codex-home'),
          model: 'gpt-5.6-terra',
          reasoningEffort: 'xhigh',
          reasoningSummary: 'auto',
          cwd,
        },
      },
      prompt: 'terminate',
    }),
    (error) => {
      assert.equal(error.signal, 'SIGTERM');
      assert.equal(error.timedOut, false);
      assert.equal(error.message, 'codex terminated by SIGTERM');
      return true;
    },
  );
});

test('terminateActiveProcessesGracefully force kills children that ignore SIGTERM', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-'));
  const script = path.join(temp, 'ignore-term.mjs');
  const ready = path.join(temp, 'ready');
  const term = path.join(temp, 'term');
  await fs.writeFile(script, [
    "import fs from 'node:fs';",
    `const ready = ${JSON.stringify(ready)};`,
    `const term = ${JSON.stringify(term)};`,
    "process.on('SIGTERM', () => fs.writeFileSync(term, 'term'));",
    "fs.writeFileSync(ready, 'ready');",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  const resultPromise = runProcess(process.execPath, [script], '', { cwd: temp });
  await waitForFile(ready);

  const summary = await terminateActiveProcessesGracefully({ graceMs: 100, forceGraceMs: 1000 });
  const result = await resultPromise;

  assert.equal(summary.signaled, 1);
  assert.equal(summary.forced, 1);
  assert.equal(summary.remaining, 0);
  assert.equal(result.signal, 'SIGKILL');
  await fs.access(term);
});

test('runProcess kills silent children that produce no intermediate output', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-'));
  const script = path.join(temp, 'silent-ignore-term.mjs');
  const ready = path.join(temp, 'ready');
  await fs.writeFile(script, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  const resultPromise = runProcess(process.execPath, [script], '', {
    cwd: temp,
    noProgressKillMs: 100,
    noProgressKillGraceMs: 100,
  });
  await waitForFile(ready);
  const result = await resultPromise;

  assert.equal(result.noProgressKilled, true);
  assert.equal(result.noProgressKillMs, 100);
  assert.equal(result.signal, 'SIGKILL');
});

test('runProcess abort signal terminates child process tree', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-runner-'));
  const script = path.join(temp, 'abortable-child.mjs');
  const ready = path.join(temp, 'ready');
  await fs.writeFile(script, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  const controller = new AbortController();
  const resultPromise = runProcess(process.execPath, [script], '', {
    cwd: temp,
    signal: controller.signal,
  });
  await waitForFile(ready);
  controller.abort('superseded-by:message-2');
  const result = await resultPromise;

  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, 'superseded-by:message-2');
  assert.equal(result.timedOut, false);
  assert.equal(result.noProgressKilled, false);
  assert.equal(result.signal, 'SIGTERM');
});

test('extractCodexFinalText reads the final assistant payload from JSONL output', () => {
  const stdout = [
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'still working' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: 'done' }],
      },
    }),
  ].join('\n');

  assert.equal(extractCodexFinalText(stdout), 'done');
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

test('extractCodexFinalText reads Codex 0.133 item completed assistant text', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'checking files' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: 'done' },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');

  assert.equal(extractCodexFinalText(stdout), 'done');
});

test('extractCodexFinalText rejects incomplete Codex 0.133 turns with only progress text', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'checking path' },
    }),
    JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: '/bin/bash -lc find .',
        aggregated_output: '',
        status: 'in_progress',
      },
    }),
  ].join('\n');

  assert.equal(extractCodexFinalText(stdout), '(no final message)');
});

test('extractCodexFinalText preserves full raw fallback output', () => {
  const stdout = 'raw '.repeat(2_000);

  assert.equal(extractCodexFinalText(stdout), stdout.trim());
});

test('extractCodexFinalText does not expose raw JSON when no final message exists', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');

  assert.equal(extractCodexFinalText(stdout), '(no final message)');
});

test('extractCodexProgressUpdate captures visible response text and reasoning summaries', () => {
  assert.deepEqual(
    extractCodexProgressUpdate({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'reading files' },
    }),
    { type: 'response_text', text: 'reading files' },
  );
  assert.deepEqual(
    extractCodexProgressUpdate({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: 'narrowed the failing path' }] },
    }),
    { type: 'reasoning', text: 'narrowed the failing path' },
  );
  assert.deepEqual(
    extractCodexProgressUpdate({
      type: 'reasoning_summary_text_delta',
      delta: 'checking config',
    }),
    { type: 'reasoning', text: 'checking config', append: true },
  );
  assert.equal(
    extractCodexProgressUpdate({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: 'final answer' }],
      },
    }),
    null,
  );
});

test('extractCodexProgressUpdate captures Codex 0.133 agent text and command progress', () => {
  assert.deepEqual(
    extractCodexProgressUpdate({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'reading files' },
    }),
    { type: 'response_text', text: 'reading files' },
  );
  assert.deepEqual(
    extractCodexProgressUpdate({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '',
        status: 'in_progress',
      },
    }),
    {
      type: 'tool_call',
      kind: 'command',
      actionId: 'item_1',
      command: '/bin/bash -lc pwd',
      cwd: null,
      status: 'in_progress',
      text: 'running command: /bin/bash -lc pwd',
    },
  );
  assert.deepEqual(
    extractCodexProgressUpdate({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '/tmp/project\n',
        status: 'completed',
      },
    }),
    {
      type: 'tool_output',
      kind: 'command',
      actionId: 'item_1',
      command: '/bin/bash -lc pwd',
      cwd: null,
      status: 'completed',
      exitCode: 0,
      durationMs: null,
      output: '/tmp/project',
      text: 'command completed: /bin/bash -lc pwd\n/tmp/project',
    },
  );
});

test('extractCodexProgressUpdate captures plan and file changes for durable checkpoints', () => {
  assert.deepEqual(
    extractCodexProgressUpdate({
      type: 'item.completed',
      item: {
        id: 'plan-1',
        type: 'todo_list',
        explanation: 'continue from the first unfinished step',
        items: [
          { text: 'inspect repository', completed: true },
          { text: 'run tests', status: 'in_progress' },
          { text: 'report result', status: 'pending' },
        ],
      },
    }),
    {
      type: 'plan',
      actionId: 'plan-1',
      plan: [
        { step: 'inspect repository', status: 'completed' },
        { step: 'run tests', status: 'in_progress' },
        { step: 'report result', status: 'pending' },
      ],
      explanation: 'continue from the first unfinished step',
      text: [
        'completed: inspect repository',
        'in_progress: run tests',
        'pending: report result',
      ].join('\n'),
    },
  );

  assert.deepEqual(
    extractCodexProgressUpdate({
      type: 'item.completed',
      item: {
        id: 'change-1',
        type: 'file_change',
        status: 'completed',
        changes: [
          { path: '/tmp/project/lib/checkpoint.mjs', kind: 'modified' },
          { path: '/tmp/project/test/checkpoint.test.mjs', kind: 'added' },
        ],
      },
    }),
    {
      type: 'file_change',
      actionId: 'change-1',
      status: 'completed',
      changes: [
        { path: '/tmp/project/lib/checkpoint.mjs', kind: 'modified' },
        { path: '/tmp/project/test/checkpoint.test.mjs', kind: 'added' },
      ],
      text: 'completed file changes: /tmp/project/lib/checkpoint.mjs, /tmp/project/test/checkpoint.test.mjs',
    },
  );
});

test('createCodexJsonStreamObserver parses JSONL updates across chunks', () => {
  const updates = [];
  const stream = createCodexJsonStreamObserver((update) => updates.push(update));
  stream.write('{"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"read');
  stream.write('ing"}}\nnot json\n');
  stream.write('{"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"checked tests"}]}}');
  stream.flush();

  assert.deepEqual(updates, [
    { type: 'response_text', text: 'reading' },
    { type: 'reasoning', text: 'checked tests' },
  ]);
});

test('createCodexJsonStreamObserver forwards Codex 0.133 intermediate messages without duplicating final', () => {
  const updates = [];
  const stream = createCodexJsonStreamObserver((update) => updates.push(update));
  stream.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\n`);
  stream.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
  stream.write(`${JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'checking path' },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'item.started',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: '/bin/bash -lc pwd',
      aggregated_output: '',
      status: 'in_progress',
    },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: '/bin/bash -lc pwd',
      aggregated_output: '/tmp/project\n',
      status: 'completed',
    },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_2', type: 'agent_message', text: 'done' },
  })}\n`);
  stream.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
  stream.flush();

  assert.deepEqual(updates, [
    { type: 'response_text', text: 'checking path' },
    {
      type: 'tool_call',
      kind: 'command',
      actionId: 'item_1',
      command: '/bin/bash -lc pwd',
      cwd: null,
      status: 'in_progress',
      text: 'running command: /bin/bash -lc pwd',
    },
    {
      type: 'tool_output',
      kind: 'command',
      actionId: 'item_1',
      command: '/bin/bash -lc pwd',
      cwd: null,
      status: 'completed',
      exitCode: 0,
      durationMs: null,
      output: '/tmp/project',
      text: 'command completed: /bin/bash -lc pwd\n/tmp/project',
    },
  ]);
});

test('createCodexJsonStreamObserver keeps the newest agent message as the final candidate', () => {
  const updates = [];
  const stream = createCodexJsonStreamObserver((update) => updates.push(update));
  stream.write(`${JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'first progress' },
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: 'final answer' },
  })}\n`);
  stream.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
  stream.flush();

  assert.deepEqual(updates, [
    { type: 'response_text', text: 'first progress' },
  ]);
});
