import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claudeAccountAuthenticationStatus } from '../lib/claude-accounts.mjs';

test('claudeAccountAuthenticationStatus verifies only the selected account HOME', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-claude-accounts-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const personalHome = path.join(temp, 'personal');
  const workHome = path.join(temp, 'work');
  await fs.mkdir(path.join(personalHome, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(personalHome, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { refreshToken: 'test-token' } })
  );
  const config = {
    claude: {
      accounts: [
        { id: 'primary', label: '개인', home: personalHome },
        { id: 'secondary', label: '업무', home: workHome },
      ],
    },
  };

  const personal = await claudeAccountAuthenticationStatus(config, { id: 'primary' });
  const work = await claudeAccountAuthenticationStatus(config, { id: 'secondary' });

  assert.deepEqual(personal, {
    account: { id: 'primary', label: '개인', home: personalHome },
    authenticated: true,
    detail: '인증됨',
  });
  assert.deepEqual(work, {
    account: { id: 'secondary', label: '업무', home: workHome },
    authenticated: false,
    detail: '인증 필요',
  });
});
