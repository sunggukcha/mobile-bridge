#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set([
  '.git',
  '.bridge_state',
  '.bridge-git',
  '.claude',
  '.codex-cli',
  '.state',
  '.venv',
  'node_modules',
  'coverage',
  'data',
  'scratch',
]);
const files = [];

await walk(root);
files.sort();

const requestedConcurrency = Number(process.env.BRIDGE_CHECK_JOBS || 4);
const concurrency = Math.max(1, Math.min(16, Number.isFinite(requestedConcurrency) ? requestedConcurrency : 4));
const failures = [];
let cursor = 0;

await Promise.all(Array.from({ length: Math.min(concurrency, files.length || 1) }, async () => {
  while (cursor < files.length) {
    const file = files[cursor++];
    try {
      await execFileAsync(process.execPath, ['--check', file], {
        cwd: root,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      failures.push({
        file: path.relative(root, file),
        detail: String(error?.stderr || error?.message || error).trim(),
      });
    }
  }
}));

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`\n${failure.file}\n${failure.detail}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax check passed for ${files.length} JavaScript modules.\n`);
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isDirectory()
      && (ignoredDirectories.has(entry.name) || entry.name.startsWith('scratch_'))
    ) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(target);
  }
}
