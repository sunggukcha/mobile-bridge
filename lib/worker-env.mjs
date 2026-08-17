// Provider processes should not inherit the bridge control plane's entire
// environment. Keep a small set of OS/runtime values and the provider
// credentials those processes are expected to consume. Deployments can opt
// additional names in through WORKER_ENV_ALLOWLIST or channel.env.
const DEFAULT_WORKER_ENV_KEYS = new Set([
  'ALL_PROXY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'BRIDGE_KOREAN_FONT_FAMILY',
  'BRIDGE_KOREAN_FONT_FILE',
  'CI',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_API_KEY',
  'COLORTERM',
  'COMSPEC',
  'CURL_CA_BUNDLE',
  'DISPLAY',
  'FORCE_COLOR',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'HOSTNAME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LANGUAGE',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'OPENAI_PROJECT_ID',
  'PATH',
  'PATHEXT',
  'PYTHONIOENCODING',
  'PYTHONUTF8',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERNAME',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'WSLENV',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
  'XDG_RUNTIME_DIR',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]);

export function safeWorkerProcessEnv(baseEnv = process.env, extraAllowedKeys = []) {
  const allowed = new Set([
    ...DEFAULT_WORKER_ENV_KEYS,
    ...normalizedAllowedKeys(extraAllowedKeys),
  ]);
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (allowed.has(key) || key.startsWith('LC_')) env[key] = value;
  }
  return env;
}

function normalizedAllowedKeys(values) {
  const input = values instanceof Set
    ? [...values]
    : Array.isArray(values)
      ? values
      : String(values || '').split(',');
  return input
    .map((value) => String(value || '').trim())
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value));
}
