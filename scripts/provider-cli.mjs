#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv, workerToolSearchPath } from '../lib/config.mjs';
import { safeWorkerProcessEnv } from '../lib/worker-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(repoRoot, '.env'));
const config = loadConfig();
const action = process.argv[2] || '';

switch (action) {
  case 'codex-auth':
    process.exitCode = await run(config.codex.bin, ['login'], providerHomeEnv(config.codex.home, {
      CODEX_HOME: config.codex.home,
    }));
    break;
  case 'claude-auth':
    process.exitCode = await run(config.claude.bin, ['auth', 'login'], {
      ...providerHomeEnv(config.claude.accounts[0].home),
    });
    break;
  case 'claude-status':
    process.exitCode = await run(config.claude.bin, ['auth', 'status'], {
      ...providerHomeEnv(config.claude.accounts[0].home),
    });
    break;
  case 'gemini-auth':
    process.exitCode = await run(config.gemini.bin, [], {
      ...providerHomeEnv(config.gemini.home),
    });
    break;
  case 'versions':
    process.exitCode = await showVersions();
    break;
  default:
    process.stderr.write('Usage: provider-cli.mjs codex-auth|claude-auth|claude-status|gemini-auth|versions\n');
    process.exitCode = 2;
}

async function showVersions() {
  const providers = [
    ['Codex', config.codex.bin, ['--version'], providerHomeEnv(config.codex.home, { CODEX_HOME: config.codex.home })],
    ['Claude', config.claude.bin, ['--version'], providerHomeEnv(config.claude.accounts[0].home)],
    ['Gemini', config.gemini.bin, ['--version'], providerHomeEnv(config.gemini.home)],
    ['Antigravity', config.antigravity.bin, ['--version'], providerHomeEnv(config.antigravity.home)],
  ];
  let failed = false;
  for (const [label, command, args, extraEnv] of providers) {
    process.stdout.write(`${label}: `);
    if (!command || (command.includes(path.sep) && !fs.existsSync(command))) {
      process.stdout.write('not installed\n');
      failed = true;
      continue;
    }
    const code = await run(command, args, extraEnv);
    if (code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: repoRoot,
        env: {
          ...safeWorkerProcessEnv(process.env, config.workerEnvAllowlist),
          PATH: workerToolSearchPath(config, command),
          ...extraEnv,
        },
        stdio: 'inherit',
        shell: false,
      });
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      resolve(127);
      return;
    }
    child.once('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(127);
    });
    child.once('close', (code) => resolve(Number.isInteger(code) ? code : 1));
  });
}

function providerHomeEnv(home, extra = {}) {
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    ...extra,
  };
}
