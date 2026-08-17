import assert from 'node:assert/strict';
import test from 'node:test';
import { safeWorkerProcessEnv } from '../lib/worker-env.mjs';

test('safeWorkerProcessEnv excludes bridge, host GitHub, and unrelated secrets', () => {
  const env = safeWorkerProcessEnv({
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    OPENAI_API_KEY: 'provider-key',
    DISCORD_BOT_TOKEN: 'discord-secret',
    SLACK_APP_TOKEN: 'slack-app-secret',
    SLACK_BOT_TOKEN: 'slack-bot-secret',
    V3_INTERNAL_TOKEN: 'internal-secret',
    X_BEARER_TOKEN: 'report-secret',
    GEMINI_OAUTH_CLIENT_SECRET: 'quota-probe-secret',
    GH_CONFIG_DIR: '/host/gh',
    GIT_CONFIG_GLOBAL: '/host/gitconfig',
    GIT_ASKPASS: '/host/askpass',
    GITHUB_TOKEN: 'github-secret',
    GH_TOKEN: 'gh-secret',
    SSH_AUTH_SOCK: '/host/ssh-agent',
    AWS_SECRET_ACCESS_KEY: 'unrelated-secret',
  });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    OPENAI_API_KEY: 'provider-key',
  });
});

test('safeWorkerProcessEnv supports an explicit main-process allowlist', () => {
  const env = safeWorkerProcessEnv({
    PATH: '/usr/bin',
    CUSTOM_SERVICE_TOKEN: 'explicit-secret',
    UNRELATED_SECRET: 'hidden-secret',
  }, new Set(['CUSTOM_SERVICE_TOKEN']));

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    CUSTOM_SERVICE_TOKEN: 'explicit-secret',
  });
});
