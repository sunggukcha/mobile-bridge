import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'github-gh-askpass.sh',
);

test('GitHub askpass returns the token username only for github.com', () => {
  const result = spawnSync(helper, ["Username for 'https://github.com':"], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'x-access-token\n');
  assert.equal(result.stderr, '');
});

test('GitHub askpass refuses credential prompts for other hosts', () => {
  for (const prompt of [
    "Password for 'https://example.com':",
    "Password for 'https://github.com.evil.example':",
    "Username for 'https://evilgithub.com':",
  ]) {
    const result = spawnSync(helper, [prompt], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
