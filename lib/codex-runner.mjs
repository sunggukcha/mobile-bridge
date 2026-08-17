import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hostGitHubAuthEnv, workerToolSearchPath } from './config.mjs';
import { applyPythonEnv } from './python-env.mjs';
import { maskSecrets } from './secret-mask.mjs';
import { clampEffortForModel } from './thread-models.mjs';
import { safeWorkerProcessEnv } from './worker-env.mjs';

const activeProcesses = new Set();
const COMMAND_TEXT_MAX_CHARS = 240;
const COMMAND_OUTPUT_EXCERPT_CHARS = 1_200;

export async function runCodexJob({
  config,
  prompt,
  timeoutMs = 0,
  noProgressKillMs = 0,
  search = false,
  model = null,
  reasoningEffort = null,
  reasoningSummary = null,
  serviceTier = null,
  sandboxMode = null,
  onUpdate = null,
  onProcessResult = null,
  signal = null,
}) {
  await ensureCodexHome(config);
  const args = buildCodexArgs(config, {
    search,
    model,
    reasoningEffort,
    reasoningSummary,
    serviceTier,
    sandboxMode,
  });
  const stream = createCodexJsonStreamObserver(onUpdate);

  const result = await runProcess(config.codex.bin, args, prompt, {
    cwd: config.codex.cwd,
    env: codexChildEnv(config),
    timeoutMs,
    noProgressKillMs: noProgressKillMs || config.jobNoProgressKillMs || 0,
    signal,
    onStdout: (chunk) => stream.write(chunk),
  });
  if (onProcessResult) onProcessResult(result);
  stream.flush();
  if (result.aborted || result.code !== 0) {
    throw processRunError(formatCodexProcessError(result), result);
  }
  const output = extractCodexFinalText(result.stdout);
  if (isMissingCodexFinalOutput(output)) {
    throw processRunError(formatCodexMissingFinalError(output), result);
  }
  return output;
}

function formatCodexProcessError(result) {
  if (result.aborted) {
    return `codex aborted${result.abortReason ? `: ${result.abortReason}` : ''}`;
  }
  if (result.noProgressKilled) {
    return `codex produced no intermediate output for ${Math.round(result.noProgressKillMs / 1000)} seconds; terminated process tree`;
  }
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const compactStdout = extractCodexFinalText(result.stdout);
  if (!['(no final message)', '(no output)'].includes(compactStdout)) return compactStdout;
  const rawStdout = result.stdout.trim();
  const structuredError = extractCodexErrorText(rawStdout);
  if (structuredError) return structuredError;
  if (rawStdout && !isJsonOnlyOutput(rawStdout)) return rawStdout;
  if (result.signal) return `codex terminated by ${result.signal}`;
  return `codex exited with ${result.code}`;
}

// `codex exec --json` reports some process failures only as JSONL stdout
// events. Preserve the useful error message without exposing the full raw
// event stream in job/system logs.
export function extractCodexErrorText(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      const type = String(event?.type || '').toLowerCase();
      if (!type.includes('error') && !type.includes('fail')) continue;
      const candidates = [
        event?.message,
        event?.error,
        event?.error?.message,
        event?.data?.error,
        event?.data?.error?.message,
        event?.payload?.error,
        event?.payload?.error?.message,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return maskSecrets(candidate.trim());
      }
    } catch {
      // Ignore malformed lines and keep looking for a structured error event.
    }
  }
  return '';
}

function processRunError(message, result) {
  const error = new Error(message);
  error.code = result.code;
  error.signal = result.signal;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  error.timedOut = result.timedOut;
  error.aborted = result.aborted;
  error.abortReason = result.abortReason;
  error.noProgressKilled = result.noProgressKilled;
  error.noProgressKillMs = result.noProgressKillMs;
  return error;
}

function isMissingCodexFinalOutput(output) {
  return output === '(no final message)' || output === '(no output)';
}

function formatCodexMissingFinalError(output) {
  if (output === '(no output)') return 'codex produced no output';
  return 'codex produced no final message';
}

export function buildCodexArgs(config, {
  search = false,
  model = null,
  reasoningEffort = null,
  reasoningSummary = null,
  serviceTier = null,
  sandboxMode = null,
} = {}) {
  const extraRoots = config.allowedRoots.filter((root) => root !== config.codex.cwd);
  const selectedModel = model || config.codex.model;
  const selectedReasoningEffort = reasoningEffort || config.codex.reasoningEffort || 'xhigh';
  const selectedReasoningSummary = reasoningSummary || config.codex.reasoningSummary || 'auto';
  const selectedSandboxMode = sandboxMode || config.codex.sandboxMode || 'workspace-write';
  return [
    '-a',
    'never',
    '-s',
    selectedSandboxMode,
    '-c',
    `model_reasoning_effort="${selectedReasoningEffort}"`,
    '-c',
    `model_reasoning_summary="${selectedReasoningSummary}"`,
    ...codexSubagentArgs(config),
    ...(serviceTier ? ['-c', `service_tier="${serviceTier}"`] : []),
    '-C',
    config.codex.cwd,
    ...extraRoots.flatMap((root) => ['--add-dir', root]),
    ...(search ? ['--search'] : []),
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-m',
    selectedModel,
    '-',
  ];
}

// Codex reads the model/effort for threads it spawns itself from the `[agents]`
// config table (`agents.default_subagent_model`,
// `agents.default_subagent_reasoning_effort`; both confirmed against codex-cli
// 0.146.0, which rejects a wrong value type for exactly these dotted keys and
// silently ignores unknown ones). Without them a delegated subagent inherits the
// root model, so an `ultra` run on Sol/Terra would fan out at Sol/Terra cost.
function codexSubagentArgs(config) {
  const { model, effort } = codexSubagentTarget(config);
  if (!model) return [];
  return [
    '-c',
    `agents.default_subagent_model="${model}"`,
    ...(effort ? ['-c', `agents.default_subagent_reasoning_effort="${effort}"`] : []),
  ];
}

// The configured effort is clamped to what the subagent model itself supports, so
// a Luna subagent gets `max` even when the root run is `ultra`.
export function codexSubagentTarget(config) {
  const model = String(config.codex?.subagentModel || '').trim();
  const requested = String(config.codex?.subagentReasoningEffort || '').trim().toLowerCase();
  if (!model) return { model: '', effort: '' };
  return { model, effort: requested ? clampEffortForModel('codex', model, requested) : '' };
}

function codexChildEnv(config) {
  return applyPythonEnv({
    ...safeWorkerProcessEnv(process.env, config.workerEnvAllowlist),
    ...hostGitHubAuthEnv(config),
    // A channel.env credential is an explicit, allowlisted opt-in and may
    // intentionally replace the host login for that channel.
    ...(config.workerEnvOverrides || {}),
    HOME: config.codex.home,
    XDG_CONFIG_HOME: path.join(config.codex.home, '.config'),
    XDG_CACHE_HOME: path.join(config.codex.home, '.cache'),
    XDG_DATA_HOME: path.join(config.codex.home, '.local', 'share'),
    CODEX_HOME: config.codex.home,
    PATH: workerToolSearchPath(config, config.codex.bin),
  }, config);
}

async function ensureCodexHome(config) {
  await fs.mkdir(config.codex.home, { recursive: true, mode: 0o700 });
  await copyIfMissing(path.join(config.codex.homeSource, 'auth.json'), path.join(config.codex.home, 'auth.json'), 0o600);
  await copyIfMissing(path.join(config.codex.homeSource, 'installation_id'), path.join(config.codex.home, 'installation_id'), 0o644);
  await writeBridgeCodexConfig(config);
}

async function copyIfMissing(source, target, mode) {
  try {
    await fs.access(target);
    return;
  } catch {
    // Copy below when the destination is absent.
  }

  try {
    await fs.copyFile(source, target);
    await fs.chmod(target, mode);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function writeBridgeCodexConfig(config) {
  const { model: subagentModel, effort: subagentEffort } = codexSubagentTarget(config);
  const content = [
    'approval_policy = "never"',
    `sandbox_mode = "${config.codex.sandboxMode || 'workspace-write'}"`,
    `model = "${config.codex.model}"`,
    `model_reasoning_effort = "${config.codex.reasoningEffort || 'xhigh'}"`,
    `model_reasoning_summary = "${config.codex.reasoningSummary || 'auto'}"`,
    '',
    // Keep the spawned-subagent default in the written config too, so a Codex
    // entry point that does not go through buildCodexArgs still delegates to the
    // configured cheaper model instead of the root one.
    ...(subagentModel ? [
      '[agents]',
      `default_subagent_model = "${escapeTomlString(subagentModel)}"`,
      ...(subagentEffort ? [`default_subagent_reasoning_effort = "${escapeTomlString(subagentEffort)}"`] : []),
      '',
    ] : []),
    '[sandbox_workspace_write]',
    'network_access = true',
    '',
    `[projects."${escapeTomlString(config.projectRoot)}"]`,
    'trust_level = "trusted"',
    '',
    `[projects."${escapeTomlString(config.codex.cwd)}"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n');
  await fs.writeFile(path.join(config.codex.home, 'config.toml'), content, { mode: 0o600 });
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function runProcess(command, args, input, {
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 0,
  noProgressKillMs = 0,
  noProgressKillGraceMs = 3000,
  signal = null,
  onStdout = null,
  onStderr = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    activeProcesses.add(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let abortReason = '';
    let noProgressKilled = false;
    let lastActivityAt = Date.now();
    let forceKillTimer = null;
    let abortHandler = null;
    const normalizedNoProgressKillMs = positiveNumber(noProgressKillMs);
    const normalizedNoProgressKillGraceMs = Math.max(0, Number(noProgressKillGraceMs) || 0);
    const noProgressCheckIntervalMs = normalizedNoProgressKillMs > 0
      ? Math.min(60_000, Math.max(50, Math.floor(normalizedNoProgressKillMs / 4)))
      : 0;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, { graceMs: normalizedNoProgressKillGraceMs });
    }, timeoutMs) : null;
    const noProgressWatchdog = normalizedNoProgressKillMs > 0 ? setInterval(() => {
      if (noProgressKilled) return;
      if (Date.now() - lastActivityAt < normalizedNoProgressKillMs) return;
      noProgressKilled = true;
      terminateProcessTree(child, { graceMs: normalizedNoProgressKillGraceMs });
    }, noProgressCheckIntervalMs) : null;
    noProgressWatchdog?.unref?.();

    const markActivity = () => {
      lastActivityAt = Date.now();
    };

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (noProgressWatchdog) clearInterval(noProgressWatchdog);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = null;
      if (signal && abortHandler && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', abortHandler);
      }
      abortHandler = null;
    };

    const terminateProcessTree = (target, { graceMs }) => {
      killProcessTree(target, 'SIGTERM');
      if (graceMs <= 0) return;
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        if (activeProcesses.has(target)) killProcessTree(target, 'SIGKILL');
      }, graceMs);
      forceKillTimer?.unref?.();
    };

    abortHandler = () => {
      if (aborted) return;
      aborted = true;
      abortReason = formatAbortReason(signal?.reason);
      terminateProcessTree(child, { graceMs: normalizedNoProgressKillGraceMs });
    };
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    }

    child.stdout.on('data', (chunk) => {
      markActivity();
      stdout += chunk;
      if (onStdout) onStdout(chunk);
    });
    child.stderr.on('data', (chunk) => {
      markActivity();
      stderr += chunk;
      if (onStderr) onStderr(chunk);
    });
    child.on('error', (error) => {
      clearTimers();
      activeProcesses.delete(child);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimers();
      activeProcesses.delete(child);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
        abortReason,
        noProgressKilled,
        noProgressKillMs: normalizedNoProgressKillMs,
      });
    });

    // A worker that exits before draining the prompt emits EPIPE on stdin;
    // without a handler that becomes an unhandled stream error and kills the
    // whole bridge process. The 'close' handler still reports the real exit.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function formatAbortReason(reason) {
  if (reason === undefined || reason === null) return '';
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function terminateActiveProcesses(signal = 'SIGTERM') {
  for (const child of [...activeProcesses]) killProcessTree(child, signal);
}

export async function terminateActiveProcessesGracefully({
  signal = 'SIGTERM',
  forceSignal = 'SIGKILL',
  graceMs = 3000,
  forceGraceMs = 1000,
} = {}) {
  const children = [...activeProcesses];
  for (const child of children) killProcessTree(child, signal);
  await waitForProcesses(children, graceMs);

  const remaining = children.filter((child) => activeProcesses.has(child));
  if (remaining.length > 0 && forceSignal) {
    for (const child of remaining) killProcessTree(child, forceSignal);
    await waitForProcesses(remaining, forceGraceMs);
  }

  return {
    signaled: children.length,
    forced: remaining.length,
    remaining: children.filter((child) => activeProcesses.has(child)).length,
  };
}

async function waitForProcesses(children, timeoutMs) {
  if (!children.length || timeoutMs <= 0) return;
  await Promise.race([
    Promise.all(children.map(waitForProcessClose)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function waitForProcessClose(child) {
  if (!child || !activeProcesses.has(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('close', resolve);
    child.once('error', resolve);
  });
}

function killProcessTree(child, signal) {
  if (!child || child.killed || !child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing only the direct child below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already be gone.
  }
}

export function extractCodexFinalText(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return '(no output)';

  let sawJson = false;
  let sawNonJson = false;
  let sawTurnStarted = false;
  let sawTurnCompleted = false;
  let sawExplicitFinalMessage = false;
  const jsonLines = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.trim().startsWith('{')) jsonLines.push(line);
    else sawNonJson = true;
  }
  let latestAssistantText = '';
  let sawAssistantMessage = false;
  let latestAssistantMessageWasEmpty = false;
  for (const line of jsonLines) {
    try {
      const event = JSON.parse(line);
      sawJson = true;
      if (String(event?.type || '') === 'turn.started') sawTurnStarted = true;
      if (isCodexTerminalEvent(event)) sawTurnCompleted = true;
      const agentMessageEvent = isAgentMessageEvent(event);
      const finalPhaseEvent = isFinalPhaseEvent(event);
      if (finalPhaseEvent) sawExplicitFinalMessage = true;
      if (agentMessageEvent || finalPhaseEvent) {
        const message = agentMessageEvent
          ? extractAgentMessageText(event)
          : extractTextContent(event?.content)
            || extractTextContent(event?.item?.content)
            || extractTextContent(event?.data?.content)
            || extractTextContent(event?.payload?.content);
        sawAssistantMessage = true;
        latestAssistantMessageWasEmpty = !message;
        if (message) latestAssistantText = message;
        continue;
      }
      const content = extractTextContent(event?.content)
        || extractTextContent(event?.item?.content)
        || extractTextContent(event?.data?.content)
        || extractTextContent(event?.payload?.content);
      if (content) latestAssistantText = content;
    } catch {
      // Fall back to raw stdout below.
    }
  }
  if (sawAssistantMessage && latestAssistantMessageWasEmpty) return '(no final message)';
  if (latestAssistantText) {
    if (sawTurnStarted && !sawTurnCompleted && !sawExplicitFinalMessage) return '(no final message)';
    return latestAssistantText;
  }
  if (sawJson && !sawNonJson) return '(no final message)';

  return text;
}

function isJsonOnlyOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith('{'));
}

export function createCodexJsonStreamObserver(onUpdate) {
  let buffer = '';
  let pendingAgentUpdate = null;

  const emitPendingAgentUpdate = () => {
    if (!pendingAgentUpdate) return;
    onUpdate(pendingAgentUpdate);
    pendingAgentUpdate = null;
  };

  const handleEvent = (event) => {
    const update = extractCodexProgressUpdate(event);
    if (!update) {
      if (isFinalPhaseEvent(event)) emitPendingAgentUpdate();
      if (isCodexTerminalEvent(event)) pendingAgentUpdate = null;
      else if (shouldReleasePendingAgentUpdate(event)) emitPendingAgentUpdate();
      return;
    }

    if (isAgentMessageEvent(event)) {
      emitPendingAgentUpdate();
      pendingAgentUpdate = update;
      return;
    }

    emitPendingAgentUpdate();
    onUpdate(update);
  };

  return {
    write(chunk) {
      if (!onUpdate) return;
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const event = parseCodexJsonLine(line);
        if (event) handleEvent(event);
      }
    },
    flush() {
      if (!onUpdate) return;
      if (buffer.trim()) {
        const event = parseCodexJsonLine(buffer);
        if (event) handleEvent(event);
      }
      buffer = '';
      pendingAgentUpdate = null;
    },
  };
}

export function extractCodexProgressUpdate(event) {
  const payload = codexPayload(event);
  const type = String(payload?.type || event?.type || '');
  const phase = String(payload?.phase || event?.phase || '');
  if (phase === 'final') return null;

  const planUpdate = extractPlanProgressUpdate(event, payload, type);
  if (planUpdate) return planUpdate;

  if (type === 'agent_message') {
    const text = extractAgentMessageText(event);
    if (text) return { type: 'response_text', text };
  }

  if (type === 'message') {
    const text = extractTextContent(payload.content) || payload.message || payload.text;
    if (text) return { type: 'response_text', text };
  }

  if (type === 'command_execution') {
    return extractCommandExecutionProgressUpdate(event, payload);
  }

  if (type === 'file_change' || type === 'fileChange') {
    return extractFileChangeProgressUpdate(event, payload);
  }

  if (isStructuredToolCallType(type)) {
    return extractStructuredToolProgressUpdate(event, payload);
  }

  if (type.includes('output_text') || type.includes('message_delta') || type.includes('agent_message_delta')) {
    const text = payload.delta || payload.text || payload.message;
    if (typeof text === 'string' && text.trim()) return { type: 'response_text', text, append: true };
  }

  if (type.includes('reasoning_summary') || type.includes('summary_text')) {
    const text = payload.delta || payload.text || payload.summary;
    if (typeof text === 'string' && text.trim()) return { type: 'reasoning', text, append: true };
  }

  if (type.includes('reasoning')) {
    const summary = extractReasoningSummary(payload.summary);
    if (summary) return { type: 'reasoning', text: summary };
    const text = extractTextContent(payload.content) || payload.text || payload.delta;
    if (text) {
      return {
        type: 'reasoning',
        text,
        ...(type.includes('delta') || type.includes('partial') ? { append: true } : {}),
      };
    }
  }

  return null;
}

function parseCodexJsonLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Non-JSON status output is ignored; the final fallback still preserves stdout.
    return null;
  }
}

export function createPlainTextStreamObserver(onUpdate, { type = 'response_text' } = {}) {
  let buffer = '';
  return {
    write(chunk) {
      if (!onUpdate) return;
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (text) onUpdate({ type, text });
      }
    },
    flush() {
      const text = buffer.trim();
      if (onUpdate && text) onUpdate({ type, text });
      buffer = '';
    },
  };
}

function extractTextContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      if (Array.isArray(item?.content)) return extractTextContent(item.content);
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractAgentMessageText(event) {
  const payload = codexPayload(event);
  if (String(payload?.type || event?.type || '') !== 'agent_message') return '';
  return extractTextContent(payload.content)
    || (typeof payload.message === 'string' ? payload.message.trim() : '')
    || (typeof payload.text === 'string' ? payload.text.trim() : '');
}

function codexPayload(event) {
  return event?.payload || event?.data || event?.item || event;
}

function isAgentMessageEvent(event) {
  const payload = codexPayload(event);
  return String(payload?.type || event?.type || '') === 'agent_message';
}

function isFinalPhaseEvent(event) {
  const payload = codexPayload(event);
  return String(payload?.phase || event?.phase || '') === 'final';
}

function isCodexTerminalEvent(event) {
  return String(event?.type || '') === 'turn.completed';
}

function shouldReleasePendingAgentUpdate(event) {
  const eventType = String(event?.type || '');
  const payload = codexPayload(event);
  const payloadType = String(payload?.type || '');
  return eventType.startsWith('item.') && payloadType !== 'agent_message';
}

function extractReasoningSummary(summary) {
  if (typeof summary === 'string') return summary.trim();
  if (!Array.isArray(summary)) return '';
  return summary
    .map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractCommandExecutionProgressUpdate(event, payload) {
  const command = compactSingleLine(
    maskSecrets(String(payload?.command
      || payload?.cmd
      || payload?.name
      || payload?.tool
      || payload?.call?.command
      || '')),
    COMMAND_TEXT_MAX_CHARS,
  );
  if (!command) return null;
  const cwd = commandExecutionWorkingDirectory(payload);

  const status = commandExecutionStatus(event, payload);
  if (status === 'started') {
    return {
      type: 'tool_call',
      kind: 'command',
      actionId: payload?.id || event?.id || null,
      command,
      cwd,
      status: 'in_progress',
      text: `running command: ${command}`,
    };
  }

  if (status === 'completed' || status === 'failed') {
    const output = commandOutputExcerpt(extractCommandExecutionOutput(payload));
    return {
      type: 'tool_output',
      kind: 'command',
      actionId: payload?.id || event?.id || null,
      command,
      cwd,
      status,
      exitCode: commandExecutionExitCode(payload, status),
      durationMs: numericEventValue(payload?.duration_ms ?? payload?.durationMs),
      output,
      text: [
        `${status === 'failed' ? 'command failed' : 'command completed'}: ${command}`,
        output,
      ].filter(Boolean).join('\n'),
    };
  }

  return {
    type: 'tool_call',
    kind: 'command',
    actionId: payload?.id || event?.id || null,
    command,
    cwd,
    status,
    text: `command ${status}: ${command}`,
  };
}

function commandExecutionWorkingDirectory(payload = {}) {
  const explicit = payload?.cwd
    || payload?.working_directory
    || payload?.workingDirectory
    || payload?.workdir
    || payload?.call?.cwd
    || payload?.call?.workdir
    || null;
  if (explicit) return String(explicit);

  const processId = Number(payload?.process_id ?? payload?.processId);
  if (!Number.isSafeInteger(processId) || processId <= 0 || process.platform !== 'linux') return null;
  try {
    return readlinkSync(`/proc/${processId}/cwd`);
  } catch {
    return null;
  }
}

function extractPlanProgressUpdate(event, payload, type) {
  const normalizedType = String(type || '').toLowerCase().replace(/[/.]/g, '_');
  const isPlanType = normalizedType === 'plan'
    || normalizedType === 'todo_list'
    || normalizedType.includes('plan_updated');
  if (!isPlanType) return null;

  const rawPlan = payload?.plan
    || payload?.items
    || payload?.steps
    || event?.plan
    || event?.params?.plan
    || [];
  const plan = Array.isArray(rawPlan)
    ? rawPlan.map((item) => normalizeCodexPlanItem(item)).filter(Boolean)
    : [];
  const text = plan.length > 0
    ? plan.map((item) => `${item.status}: ${item.step}`).join('\n')
    : extractTextContent(payload?.content) || payload?.text || '';
  if (plan.length === 0 && !String(text || '').trim()) return null;
  return {
    type: 'plan',
    actionId: payload?.id || event?.id || null,
    plan,
    explanation: payload?.explanation || event?.explanation || event?.params?.explanation || null,
    text: String(text || '').trim(),
  };
}

function normalizeCodexPlanItem(item) {
  if (typeof item === 'string') return { step: item.trim(), status: 'pending' };
  const step = String(item?.step || item?.text || item?.title || '').trim();
  if (!step) return null;
  const rawStatus = item?.completed === true
    ? 'completed'
    : item?.inProgress === true || item?.in_progress === true || item?.active === true
      ? 'in_progress'
      : String(item?.status || '');
  const normalized = rawStatus.toLowerCase().replace(/[-\s]/g, '_');
  const status = ['completed', 'complete', 'done', 'success', 'succeeded'].includes(normalized)
    ? 'completed'
    : ['in_progress', 'inprogress', 'active', 'running', 'started'].includes(normalized)
      ? 'in_progress'
      : 'pending';
  return { step, status };
}

function extractFileChangeProgressUpdate(event, payload) {
  const changes = (Array.isArray(payload?.changes) ? payload.changes : [])
    .map((change) => {
      if (typeof change === 'string') return { path: change, kind: 'modified' };
      const filePath = change?.path || change?.file || change?.file_path || change?.filePath;
      if (!filePath) return null;
      return {
        path: String(filePath),
        kind: String(change?.kind || change?.type || change?.status || 'modified'),
      };
    })
    .filter(Boolean);
  const status = commandExecutionStatus(event, payload);
  return {
    type: 'file_change',
    actionId: payload?.id || event?.id || null,
    status,
    changes,
    text: changes.length > 0
      ? `${status} file changes: ${changes.map((change) => change.path).join(', ')}`
      : `${status} file changes`,
  };
}

function isStructuredToolCallType(type) {
  return [
    'mcp_tool_call',
    'mcpToolCall',
    'dynamic_tool_call',
    'dynamicToolCall',
    'collab_tool_call',
    'collabToolCall',
  ].includes(String(type || ''));
}

function extractStructuredToolProgressUpdate(event, payload) {
  const status = commandExecutionStatus(event, payload);
  const tool = String(payload?.tool || payload?.name || payload?.action || 'tool').trim();
  const server = String(payload?.server || '').trim();
  const label = `${server ? `${server}/` : ''}${tool}`;
  const completed = status === 'completed' || status === 'failed';
  return {
    type: completed ? 'tool_output' : 'tool_call',
    kind: 'structured_tool',
    actionId: payload?.id || event?.id || null,
    tool,
    server: server || null,
    status,
    text: completed
      ? `${status === 'failed' ? 'tool failed' : 'tool completed'}: ${label}`
      : `using tool: ${label}`,
  };
}

function commandExecutionStatus(event, payload) {
  const explicit = String(payload?.status || payload?.state || '').trim().toLowerCase();
  if (['failed', 'failure', 'error', 'errored', 'timed_out', 'timeout', 'cancelled', 'canceled'].includes(explicit)) {
    return 'failed';
  }
  if (['completed', 'complete', 'done', 'success', 'succeeded', 'finished'].includes(explicit)) {
    return 'completed';
  }
  if (['in_progress', 'running', 'started', 'pending'].includes(explicit)) {
    return 'started';
  }

  const eventType = String(event?.type || '').toLowerCase();
  if (eventType.includes('completed')) return 'completed';
  if (eventType.includes('started')) return 'started';
  return explicit || 'updated';
}

function commandExecutionExitCode(payload, status) {
  const value = numericEventValue(payload?.exit_code ?? payload?.exitCode);
  if (value !== null) return value;
  return status === 'completed' ? 0 : null;
}

function numericEventValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractCommandExecutionOutput(payload) {
  return payload?.aggregated_output
    || payload?.output
    || payload?.stdout
    || payload?.stderr
    || payload?.result
    || '';
}

function commandOutputExcerpt(value) {
  const text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
  if (!text) return '';
  // Progress updates are posted to Discord verbatim in /verbose jobs; command
  // output can echo credentials (e.g. `gh auth token`), so mask before excerpting.
  return maskSecrets(compactMultiline(text, COMMAND_OUTPUT_EXCERPT_CHARS));
}

function compactSingleLine(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactMultiline(value, maxChars) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  return `[output truncated; showing last ${maxChars} chars]\n${text.slice(-maxChars).trimStart()}`;
}
