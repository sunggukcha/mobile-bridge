import fs from 'node:fs/promises';
import path from 'node:path';

// Claude Code keeps OAuth credentials below HOME.  Keep account selection as a
// small, explicit profile object so a thread never needs to copy credential
// files or mutate the bridge process environment.

export function claudeAccountOptions(config = {}) {
  const configured = Array.isArray(config?.claude?.accounts) ? config.claude.accounts : [];
  const accounts = configured.length > 0
    ? configured
    : [{ id: 'primary', label: '기본', home: config?.claude?.home || '' }];

  const seen = new Set();
  return accounts
    .map((account, index) => ({
      id: String(account?.id || (index === 0 ? 'primary' : `account-${index + 1}`)).trim().toLowerCase(),
      label: String(account?.label || (index === 0 ? '기본' : `계정 ${index + 1}`)).trim(),
      home: String(account?.home || '').trim(),
    }))
    .filter((account) => {
      // A display-only primary profile is useful when a lightweight caller
      // (for example a menu test) does not provide HOME. Runtime config always
      // supplies it and the worker creates the directory before use.
      if (!account.id || seen.has(account.id)) return false;
      seen.add(account.id);
      return true;
    });
}

export function claudeAccountById(config, id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  return claudeAccountOptions(config).find((account) => account.id === key) || null;
}

export function defaultClaudeAccount(config) {
  return claudeAccountOptions(config)[0] || null;
}

export function claudeAccountBySelector(config, selector) {
  const key = String(selector || '').trim().toLowerCase();
  if (!key) return null;
  const accounts = claudeAccountOptions(config);
  if (['0', 'primary', 'default', 'main', '기본'].includes(key)) return accounts[0] || null;
  if (['1', 'secondary', 'second', 'backup', '보조'].includes(key)) return accounts[1] || null;
  if (['account1', 'account-1', 'claude1', 'claude-1'].includes(key)) return accounts[0] || null;
  if (['account2', 'account-2', 'claude2', 'claude-2'].includes(key)) return accounts[1] || null;
  return accounts.find((account) => account.id === key || account.label.toLowerCase() === key) || null;
}

export function claudeAccountSelectionFromOption(account) {
  if (!account) return null;
  return { id: account.id, label: account.label };
}

export function normalizeClaudeAccountSelection(config, selection) {
  const id = typeof selection === 'string' ? selection : selection?.id;
  return claudeAccountById(config, id) || null;
}

// This is deliberately a local credential-file check, not a usage probe.  It
// lets `/model` reject an unlogged account immediately without refreshing
// OAuth tokens or calling Anthropic.  The worker remains the source of truth
// for a credential being accepted at execution time.
export async function claudeAccountAuthenticationStatus(config, selection) {
  const account = normalizeClaudeAccountSelection(config, selection);
  if (!account?.home) {
    return { account, authenticated: false, detail: '인증 필요' };
  }

  const credentialsPath = path.join(account.home, '.claude', '.credentials.json');
  let credentials;
  try {
    credentials = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  } catch {
    return { account, authenticated: false, detail: '인증 필요' };
  }

  const oauth = credentials?.claudeAiOauth || credentials || {};
  const refreshToken = oauth.refreshToken || oauth.refresh_token;
  const accessToken = oauth.accessToken || oauth.access_token;
  return {
    account,
    authenticated: Boolean(String(refreshToken || accessToken || '').trim()),
    detail: String(refreshToken || accessToken || '').trim() ? '인증됨' : '인증 필요',
  };
}

export function formatClaudeAccountOptions(config) {
  return claudeAccountOptions(config)
    .map((account, index) => `${index}. ${account.label} (${account.id})`)
    .join('\n');
}
