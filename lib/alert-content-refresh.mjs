import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { channelStateDir } from './config.mjs';
import { channelPythonExecutable } from './python-env.mjs';
import { formatErrorDetail } from './error-detail.mjs';

// An alert may carry a `refresh` hook so its body is rebuilt from the source of
// truth at send time instead of from whatever was true when the alert was
// created. This supports alerts rendered from an external calendar, document,
// or other source that may change after the alert is scheduled.
//
// The hook is deliberately narrow. It is not "run a command": it is "run this
// Python script, which must live inside this channel's own state directory,
// with the channel venv interpreter, no shell". The channel state directory is
// already agent-writable, so this grants no reach the agent did not have — but
// a state file still must not be able to name an arbitrary binary.
//
// Failure is never fatal. A refresh that errors, times out, or prints garbage
// leaves the stored content untouched and the alert still goes out.
const DEFAULT_REFRESH_TIMEOUT_MS = 90_000;
const MAX_REFRESH_TIMEOUT_MS = 300_000;
const MAX_REFRESH_STDOUT_BYTES = 256 * 1024;

export function alertRefreshSpec(alert) {
  const raw = alert?.refresh;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const script = String(raw.script || '').trim();
  if (!script) return null;
  const timeoutMs = Number(raw.timeout_ms);
  return {
    script,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, MAX_REFRESH_TIMEOUT_MS)
        : DEFAULT_REFRESH_TIMEOUT_MS,
  };
}

// Keeps the script inside the channel state root. Accepts `artifacts/x/y.py` or
// any other relative path under that root; rejects absolute paths and `..`
// escapes outright rather than clamping them.
export function resolveAlertRefreshScript(root, value) {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  if (!normalized || path.isAbsolute(normalized)) return '';
  const candidate = path.resolve(root, normalized.replace(/^\/+/, ''));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  if (!/\.py$/i.test(candidate)) return '';
  return candidate;
}

// Returns the alert unchanged unless the hook succeeded and actually produced
// something. `content` replaces the body; `attachments` replaces the file list
// (an explicit empty array drops attachments that the refreshed source no
// longer considers current).
export async function refreshAlertContent({
  config,
  channelId,
  alert,
  now = new Date(),
  logSystem = async () => {},
} = {}) {
  const spec = alertRefreshSpec(alert);
  if (!spec) return { alert, refreshed: false };

  const root = path.resolve(channelStateDir(config, channelId));
  const scriptPath = resolveAlertRefreshScript(root, spec.script);
  if (!scriptPath) {
    await logSystem('todo-alert-refresh-skipped', {
      channelId,
      alertId: alert?.id || null,
      script: spec.script,
      reason: 'outside-channel-state-dir',
    });
    return { alert, refreshed: false };
  }

  const stat = await fs.stat(scriptPath).catch(() => null);
  if (!stat?.isFile()) {
    await logSystem('todo-alert-refresh-skipped', {
      channelId,
      alertId: alert?.id || null,
      script: spec.script,
      reason: 'missing',
    });
    return { alert, refreshed: false };
  }

  const python = channelPythonExecutable(config, channelId);
  if (!python) {
    await logSystem('todo-alert-refresh-skipped', {
      channelId,
      alertId: alert?.id || null,
      script: spec.script,
      reason: 'no-channel-python',
    });
    return { alert, refreshed: false };
  }

  const run = await runRefreshScript({
    python,
    scriptPath,
    cwd: root,
    timeoutMs: spec.timeoutMs,
    input: JSON.stringify({
      alert,
      now: now.toISOString(),
      channel_id: channelId,
      state_root: root,
    }),
  });

  if (run.error) {
    await logSystem('todo-alert-refresh-failed', {
      channelId,
      alertId: alert?.id || null,
      script: spec.script,
      reason: run.reason || 'error',
      error: run.error,
      stderr: tail(run.stderr),
    });
    return { alert, refreshed: false };
  }

  let payload = null;
  try {
    payload = JSON.parse(run.stdout.trim() || '{}');
  } catch (error) {
    await logSystem('todo-alert-refresh-failed', {
      channelId,
      alertId: alert?.id || null,
      script: spec.script,
      reason: 'bad-json',
      error: formatErrorDetail(error),
      stdout: tail(run.stdout),
    });
    return { alert, refreshed: false };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { alert, refreshed: false };
  }

  const next = { ...alert };
  const changes = [];

  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  if (content && content !== String(alert?.content || '').trim()) {
    next.content = content;
    changes.push('content');
  }

  if (Array.isArray(payload.attachments)) {
    const attachments = payload.attachments
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);
    if (JSON.stringify(attachments) !== JSON.stringify(alert?.attachments || [])) {
      next.attachments = attachments;
      changes.push('attachments');
    }
  }

  if (typeof payload.title === 'string' && payload.title.trim() && payload.title.trim() !== alert?.title) {
    next.title = payload.title.trim();
    changes.push('title');
  }

  if (changes.length === 0) return { alert, refreshed: false };

  next.content_refreshed_at = now.toISOString();
  await logSystem('todo-alert-refreshed', {
    channelId,
    alertId: alert?.id || null,
    script: spec.script,
    changed: changes,
    note: typeof payload.note === 'string' ? payload.note.slice(0, 500) : undefined,
  });
  return { alert: next, refreshed: true, changed: changes };
}

function runRefreshScript({ python, scriptPath, cwd, timeoutMs, input }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [scriptPath], {
        cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
    } catch (error) {
      resolve({ error: formatErrorDetail(error), reason: 'spawn-failed', stdout: '', stderr: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ error: `refresh timed out after ${timeoutMs}ms`, reason: 'timeout', stdout, stderr });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_REFRESH_STDOUT_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_REFRESH_STDOUT_BYTES) stderr += chunk;
    });

    child.on('error', (error) => {
      finish({ error: formatErrorDetail(error), reason: 'spawn-failed', stdout, stderr });
    });
    child.on('close', (code) => {
      if (code === 0) finish({ stdout, stderr });
      else finish({ error: `refresh exited with code ${code}`, reason: 'exit-code', stdout, stderr });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function tail(value, limit = 800) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? text.slice(-limit) : text;
}
