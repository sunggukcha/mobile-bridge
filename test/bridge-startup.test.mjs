import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('bridge foreground startup reports missing configuration on stderr', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-startup-'));
  await assert.rejects(
    execFileAsync(process.execPath, [path.join(repoRoot, 'bridge-service.mjs')], {
      cwd: repoRoot,
      env: {
        HOME: temp,
        PATH: process.env.PATH,
        PROJECT_ROOT: temp,
        BRIDGE_REPO_ROOT: repoRoot,
        BRIDGE_STATE_ROOT: path.join(temp, 'state'),
        DISCORD_ENABLED: 'true',
        DISCORD_BOT_TOKEN: '',
        DISCORD_ALLOWED_CHANNEL_IDS: '',
        DISCORD_ALLOWED_USER_IDS: '',
        BRIDGE_RUNTIME_VERSION: 'v2',
      },
      timeout: 10_000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /\[bridge\] startup failed: Discord bridge is not configured/);
      return true;
    },
  );
});

test('bridge foreground startup refuses an inherited worker runtime role', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-startup-role-'));
  await assert.rejects(
    execFileAsync(process.execPath, [path.join(repoRoot, 'bridge-service.mjs')], {
      cwd: repoRoot,
      env: {
        HOME: temp,
        PATH: process.env.PATH,
        PROJECT_ROOT: temp,
        BRIDGE_REPO_ROOT: repoRoot,
        BRIDGE_STATE_ROOT: path.join(temp, 'state'),
        BRIDGE_RUNTIME_ROLE: 'v3-worker',
        BRIDGE_RUNTIME_VERSION: 'v3',
        V3_PROMOTION_REQUEST_ID: 'must-not-run',
        DISCORD_ENABLED: 'true',
        DISCORD_BOT_TOKEN: 'synthetic-test-token',
        DISCORD_ALLOWED_CHANNEL_IDS: '1000000000000000001',
        DISCORD_ALLOWED_USER_IDS: '1000000000000000002',
      },
      timeout: 10_000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /refusing to start the v2 service from runtime role v3-worker/);
      return true;
    },
  );
  await assert.rejects(
    fs.access(path.join(temp, 'state', '_system', 'v3-promotion.json')),
    { code: 'ENOENT' },
  );
});
