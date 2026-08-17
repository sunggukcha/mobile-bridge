const RECEPTION_ENTRYPOINTS = new Set([
  'v3/reception.mjs',
]);

const RECEPTION_V3_MODULES = new Set([
  'v3/lib/discord-reception.mjs',
  'v3/lib/durable-bus.mjs',
  'v3/lib/platform-rpc.mjs',
  'v3/lib/reception-service.mjs',
  'v3/lib/role-health.mjs',
  'v3/lib/runtime-config.mjs',
  'v3/lib/slack-reception.mjs',
  'v3/lib/ws-link.mjs',
]);

const RECEPTION_SHARED_MODULES = [
  'lib/bridge-commands.mjs',
  'lib/config.mjs',
  'lib/discord-api.mjs',
  'lib/discord-attachment-upload.mjs',
  'lib/discord-gateway.mjs',
  'lib/file-lock.mjs',
  'lib/image-font.mjs',
  // Pulled in by lib/config.mjs, which normalizes the maintenance mode.
  'lib/maintenance-adaptive.mjs',
  'lib/message-markdown.mjs',
  'lib/rich-delivery-progress.mjs',
  'lib/rich-content.mjs',
  'lib/rich-style-themes.mjs',
  'lib/slack-api.mjs',
  'lib/slack-message.mjs',
  'lib/slack-socket-mode.mjs',
  'lib/state.mjs',
];

const SUPERVISOR_MODULES = new Set([
  // `.env` is read once per process start, so an operational change such as a
  // worker-chain or scheduler switch only reaches a role that restarts. The
  // Supervisor owns the Workbench and Worker generations that resolve it.
  '.env',
  'v3/supervisor.mjs',
  'v3/lib/runtime-config.mjs',
  'v3/lib/runtime-handoff.mjs',
  'v3/lib/runtime-roles.mjs',
  'v3/lib/role-health.mjs',
  'lib/config.mjs',
  'lib/error-detail.mjs',
  'lib/file-lock.mjs',
  // Pulled in by lib/config.mjs, which normalizes the maintenance mode.
  'lib/maintenance-adaptive.mjs',
  'lib/state.mjs',
  'lib/supervisor-lock.mjs',
]);

export function runtimeRolesForChanges(paths = []) {
  const normalized = [...new Set(
    (Array.isArray(paths) ? paths : [])
      .map((value) => String(value || '').replace(/\\/g, '/'))
      .filter(Boolean),
  )];
  return {
    // Runtime-source changes are detected by the Workbench job that made them,
    // so the Workbench generation is always replaced.
    workbench: normalized.length > 0,
    reception: normalized.some(receptionReloadRequired),
    // Existing Workers finish on their loaded generation; only future Workers
    // observe changed Worker/provider modules.
    futureWorkers: normalized.length > 0,
    supervisor: normalized.some((entry) => SUPERVISOR_MODULES.has(entry)),
  };
}

export function receptionReloadRequired(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (RECEPTION_ENTRYPOINTS.has(normalized)) return true;
  if (RECEPTION_V3_MODULES.has(normalized)) return true;
  if (RECEPTION_SHARED_MODULES.includes(normalized)) return true;
  return normalized === '.env'
    || normalized === 'package.json'
    || normalized === 'package-lock.json';
}
