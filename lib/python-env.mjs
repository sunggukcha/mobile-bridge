import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { channelStateDir } from './config.mjs';
import {
  KOREAN_IMAGE_FONT_FAMILY,
  KOREAN_IMAGE_FONT_FILE,
  missingKoreanImageFontFiles,
} from './image-font.mjs';

const PYTHON_COMMAND_TIMEOUT_MS = 60_000;
const PIP_MARKER_FILE = '.bridge-pip-verified.json';
const PIP_MARKER_SCHEMA = 1;

// Verifying pip costs two interpreter startups (~7s for a vendored pip on DrvFs),
// so a verified venv records the result and later jobs revalidate with stat only.
const channelVenvReady = new Map();

export function channelPythonVenvPath(config, channelId) {
  if (!channelId || !config?.python?.channelVenvEnabled) return '';
  return path.join(channelStateDir(config, channelId), config.python.channelVenvDir || '.venv');
}

export function channelPythonVenvBinDir(config, channelId) {
  const venvPath = channelPythonVenvPath(config, channelId);
  if (!venvPath) return '';
  return path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin');
}

export function channelPythonExecutable(config, channelId) {
  const binDir = channelPythonVenvBinDir(config, channelId);
  if (!binDir) return '';
  return path.join(binDir, process.platform === 'win32' ? 'python.exe' : 'python');
}

export async function prepareChannelPythonEnv(config, job = {}) {
  const channelId = job.channelId || '';
  const venvPath = channelPythonVenvPath(config, channelId);
  if (!venvPath) return unavailablePythonPatch(config);

  const venvBinDir = channelPythonVenvBinDir(config, channelId);
  const pythonBin = channelPythonExecutable(config, channelId);
  const patch = {
    ...config.python,
    venvPath,
    venvBinDir,
    pythonBin,
  };

  let available = await pathExists(pythonBin);
  if (config.python?.autoCreateChannelVenv) {
    try {
      await ensureChannelPythonVenvOnce({ ...config, python: patch }, channelId);
      available = await pathExists(pythonBin);
    } catch (error) {
      if (config.python?.requireChannelVenv) throw error;
      console.warn(`[bridge] channel Python venv unavailable for ${channelId}: ${error.message}`);
      return unavailablePythonPatch(config);
    }
  }

  if (!available) {
    if (config.python?.requireChannelVenv) {
      throw new Error(`required channel Python virtualenv is missing: ${pythonBin}`);
    }
    return unavailablePythonPatch(config);
  }

  return patch;
}

function unavailablePythonPatch(config = {}) {
  return {
    ...(config.python || {}),
    venvPath: '',
    venvBinDir: '',
    pythonBin: '',
  };
}

async function pathExists(filePath) {
  if (!filePath) return false;
  const mode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  return fs.access(filePath, mode).then(() => true, () => false);
}

// Every job start awaits this preflight, so keep one preparation per channel per
// process: concurrent job starts share the in-flight promise and later jobs skip
// the work entirely. Failures are not cached, so the next job retries.
async function ensureChannelPythonVenvOnce(config, channelId) {
  const key = channelVenvCacheKey(config, channelId);
  const pending = channelVenvReady.get(key);
  if (pending) return pending;

  const promise = ensureChannelPythonVenv(config, channelId).catch((error) => {
    if (channelVenvReady.get(key) === promise) channelVenvReady.delete(key);
    throw error;
  });
  channelVenvReady.set(key, promise);
  return promise;
}

function channelVenvCacheKey(config, channelId) {
  return JSON.stringify([
    channelId,
    channelPythonVenvPath(config, channelId),
    config.python?.bin || '',
    config.python?.candidates || [],
    Boolean(config.python?.autoUpgradeChannelVenv),
    Boolean(config.python?.bootstrapPip),
  ]);
}

export function resetChannelPythonEnvCache() {
  channelVenvReady.clear();
}

export function applyPythonEnv(env = {}, config = {}) {
  const next = { ...env };
  if (!next.BRIDGE_KOREAN_FONT_FILE && missingKoreanImageFontFiles().length === 0) {
    next.BRIDGE_KOREAN_FONT_FILE = KOREAN_IMAGE_FONT_FILE;
  }
  if (!next.BRIDGE_KOREAN_FONT_FAMILY) {
    next.BRIDGE_KOREAN_FONT_FAMILY = KOREAN_IMAGE_FONT_FAMILY;
  }
  if (config.python?.venvPath) {
    next.VIRTUAL_ENV = config.python.venvPath;
    next.PYTHON = config.python.pythonBin;
    next.PYTHON_BIN = config.python.pythonBin;
    next.PATH = prependSearchPathEntry(next.PATH || process.env.PATH || '', config.python.venvBinDir);
    if (!next.PYTHONNOUSERSITE) next.PYTHONNOUSERSITE = '1';
  }
  delete next.PYTHONHOME;
  return next;
}

export async function ensureChannelPythonVenv(config, channelId) {
  const venvPath = channelPythonVenvPath(config, channelId);
  if (!venvPath) return;

  const venvPython = channelPythonExecutable(config, channelId);
  const candidates = await resolvePythonCandidates(config);
  const existingVersion = await pythonVersion(venvPython);
  if (existingVersion) {
    const best = candidates[0];
    let versionText = existingVersion.versionText;
    if (
      best &&
      config.python?.autoUpgradeChannelVenv &&
      comparePythonVersions(best.version, existingVersion.version) > 0
    ) {
      await runVenvCommand(best.command, ['-m', 'venv', '--upgrade', venvPath]);
      versionText = best.versionText;
    }
    await ensurePip(venvPython, config, venvPath, versionText);
    return;
  }

  if (candidates.length === 0) {
    throw new Error('no usable Python interpreter found; set BRIDGE_PYTHON_BIN');
  }

  await fs.mkdir(path.dirname(venvPath), { recursive: true });
  const errors = [];
  for (const candidate of candidates) {
    const tempVenvPath = `${venvPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      try {
        await runVenvCommand(candidate.command, ['-m', 'venv', '--without-pip', tempVenvPath]);
      } catch (error) {
        await fs.rm(tempVenvPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      await fs.rename(tempVenvPath, venvPath);
      try {
        await ensurePip(venvPython, config, venvPath, candidate.versionText);
      } catch (error) {
        await fs.rm(venvPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return;
    } catch (error) {
      errors.push(`${candidate.command} ${candidate.versionText}: ${error.message}`);
      await fs.rm(tempVenvPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  throw new Error(`failed to create channel Python venv at ${venvPath}: ${errors.join('; ')}`);
}

export async function resolvePythonCandidates(config = {}) {
  const configured = String(config.python?.bin || '').trim();
  const commands = configured ? [configured] : (config.python?.candidates || []);
  const candidates = [];
  const seen = new Set();

  for (const command of commands) {
    const key = String(command || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const version = await pythonVersion(key);
    if (!version) continue;
    candidates.push({ command: key, ...version, order: candidates.length });
  }

  return candidates.sort((left, right) => {
    const byVersion = comparePythonVersions(right.version, left.version);
    if (byVersion) return byVersion;
    return left.order - right.order;
  });
}

export async function pythonVersion(command) {
  if (!command) return null;
  const result = await runCommand(command, ['--version'], { timeoutMs: 10_000 });
  if (result.error || result.code !== 0) return null;
  const versionText = `${result.stdout}\n${result.stderr}`.trim();
  const match = versionText.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    version: [Number(match[1]), Number(match[2]), Number(match[3] || 0)],
    versionText,
  };
}

export function comparePythonVersions(left = [], right = []) {
  for (let index = 0; index < 3; index += 1) {
    const diff = (Number(left[index]) || 0) - (Number(right[index]) || 0);
    if (diff) return diff;
  }
  return 0;
}

async function ensurePip(venvPython, config, venvPath, pythonVersionText = '') {
  if (await pipMarkerMatches(venvPath, pythonVersionText)) return;
  if (await verifyPip(venvPython, config, venvPath, pythonVersionText)) return;

  const ensure = await runCommand(venvPython, ['-m', 'ensurepip', '--upgrade'], {
    timeoutMs: PYTHON_COMMAND_TIMEOUT_MS,
  });
  if (ensure.code === 0 && await verifyPip(venvPython, config, venvPath, pythonVersionText)) return;

  if (config.python?.bootstrapPip) {
    await bootstrapPip(venvPython, config, venvPath);
    if (await verifyPip(venvPython, config, venvPath, pythonVersionText)) return;
  }
  throw new Error(commandFailure(venvPython, ['-m', 'ensurepip', '--upgrade'], ensure));
}

async function verifyPip(venvPython, config, venvPath, pythonVersionText) {
  const pipVersion = await hasUsablePip(venvPython, venvPath);
  if (!pipVersion) return false;
  await writePipMarker(venvPath, pythonVersionText, pipVersion);
  return true;
}

async function hasUsablePip(venvPython, venvPath) {
  const modulePip = await runCommand(venvPython, ['-m', 'pip', '--version'], {
    timeoutMs: PYTHON_COMMAND_TIMEOUT_MS,
  });
  if (modulePip.code !== 0) return '';
  const pip = await runCommand(venvPipPath(venvPath), ['--version'], {
    timeoutMs: PYTHON_COMMAND_TIMEOUT_MS,
  });
  if (pip.code !== 0) return '';
  return `${modulePip.stdout}`.trim() || 'pip';
}

// The marker records the files a working pip depends on. Revalidation is stat-only,
// so removing pip, reinstalling it, or upgrading the interpreter invalidates it and
// falls back to the full subprocess verification.
async function pipMarkerMatches(venvPath, pythonVersionText) {
  const marker = await readJsonFile(path.join(venvPath, PIP_MARKER_FILE));
  if (!marker || marker.schema !== PIP_MARKER_SCHEMA) return false;
  if (!Array.isArray(marker.files) || marker.files.length === 0) return false;
  if (pythonVersionText && marker.pythonVersionText !== pythonVersionText) return false;

  for (const entry of marker.files) {
    const stat = await fs.stat(entry?.path || '').catch(() => null);
    if (!stat) return false;
    if (stat.size !== entry.size) return false;
    if (Math.round(stat.mtimeMs) !== entry.mtimeMs) return false;
  }
  return true;
}

async function writePipMarker(venvPath, pythonVersionText, pipVersion) {
  const files = [];
  for (const file of await pipDependencyFiles(venvPath)) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) continue;
    files.push({ path: file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
  }
  if (files.length === 0) return;

  const marker = {
    schema: PIP_MARKER_SCHEMA,
    pythonVersionText,
    pipVersion,
    verifiedAt: new Date().toISOString(),
    files,
  };
  await fs.writeFile(path.join(venvPath, PIP_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`)
    .catch(() => {});
}

// Both entry points the verification exercises: the console script and the module
// the interpreter imports for `python -m pip`.
async function pipDependencyFiles(venvPath) {
  const files = [venvPipPath(venvPath)];
  for (const sitePackages of await sitePackagesDirs(venvPath)) {
    const pipInit = path.join(sitePackages, 'pip', '__init__.py');
    if (await fileExists(pipInit)) files.push(pipInit);
  }
  return files;
}

async function sitePackagesDirs(venvPath) {
  if (process.platform === 'win32') return [path.join(venvPath, 'Lib', 'site-packages')];
  const libDir = path.join(venvPath, 'lib');
  const entries = await fs.readdir(libDir).catch(() => []);
  return entries
    .filter((entry) => entry.startsWith('python'))
    .map((entry) => path.join(libDir, entry, 'site-packages'));
}

async function fileExists(file) {
  return Boolean(await fs.stat(file).catch(() => null));
}

async function readJsonFile(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function bootstrapPip(venvPython, config, venvPath) {
  const url = String(config.python?.pipBootstrapUrl || '').trim();
  if (!url) throw new Error('pip bootstrap URL is empty');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download pip bootstrap script: HTTP ${response.status}`);
  const script = await response.text();
  const scriptPath = path.join(venvPath || path.dirname(path.dirname(venvPython)), 'get-pip.py');
  await fs.writeFile(scriptPath, script, { mode: 0o600 });
  try {
    const result = await runCommand(venvPython, [scriptPath], {
      timeoutMs: Math.max(PYTHON_COMMAND_TIMEOUT_MS, 120_000),
    });
    if (result.code !== 0) throw new Error(commandFailure(venvPython, [scriptPath], result));
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

function venvPythonPath(venvPath) {
  return path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
}

function venvPipPath(venvPath) {
  return path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
}

function prependSearchPathEntry(value, entry) {
  if (!entry) return value;
  const entries = String(value || '').split(path.delimiter).filter(Boolean);
  return [entry, ...entries.filter((item) => item !== entry)].join(path.delimiter);
}

async function runVenvCommand(command, args) {
  const result = await runCommand(command, args, { timeoutMs: PYTHON_COMMAND_TIMEOUT_MS });
  if (result.code !== 0 || result.error) {
    throw new Error(commandFailure(command, args, result));
  }
}

function commandFailure(command, args, result) {
  const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.code}`;
  return `${command} ${args.join(' ')} failed: ${detail.trim()}`;
}

function runCommand(command, args = [], { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
    }, timeoutMs) : null;

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, error: null });
    });
  });
}
