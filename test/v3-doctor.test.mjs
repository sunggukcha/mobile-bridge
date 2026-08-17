import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { V3_SCHEMA_VERSION } from '../v3/lib/durable-bus.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('v3 doctor validates an isolated coordination runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-v3-doctor-'));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, 'v3', 'doctor.mjs'), '--json', '--require-idle'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PROJECT_ROOT: root,
          DATA_DIR: path.join(root, 'state'),
          BRIDGE_STATE_ROOT: path.join(root, 'state'),
          V3_STATE_ROOT: path.join(root, 'v3'),
          V3_DB_PATH: path.join(root, 'v3', 'coordination.sqlite'),
          V3_RUNTIME_SECRET_ROOT: path.join(root, 'linux-secrets'),
          V3_INTERNAL_TOKEN: '',
          V3_PLATFORM_MODE: 'disabled',
          DISCORD_ENABLED: 'false',
          SLACK_ENABLED: 'false',
          NODE_NO_WARNINGS: '1',
        },
      },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.schemaVersion, V3_SCHEMA_VERSION);
    assert.equal(
      report.checks.find((entry) => entry.name === 'idle-cutover')?.status,
      'pass',
    );
    assert.equal(report.runtime.tokenSource, 'file');
    assert.equal(
      report.runtime.tokenFile.startsWith(path.join(root, 'v3')),
      false,
    );
    if (process.platform !== 'win32') {
      const tokenStat = await fs.stat(report.runtime.tokenFile);
      assert.equal(tokenStat.mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
