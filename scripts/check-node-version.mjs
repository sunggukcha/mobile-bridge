#!/usr/bin/env node

export const NODE_REQUIREMENT = 'Node >=22.13 (or >=23.4)';

export function isSupportedNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version || '')
    .replace(/^v/, '')
    .split('.')
    .map((value) => Number.parseInt(value, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return major >= 24
    || (major === 23 && minor >= 4)
    || (major === 22 && minor >= 13);
}

if (!isSupportedNodeVersion()) {
  process.stderr.write(
    `Unsupported Node.js ${process.version}. Mobile Codex Bridge requires ${NODE_REQUIREMENT}.\n`,
  );
  process.exitCode = 1;
}
