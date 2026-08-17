import fs from 'node:fs/promises';

export async function readOutboxEntries(state, name) {
  try {
    const entries = await state.readJson(name, []);
    if (!Array.isArray(entries)) throw new TypeError(`${name} must contain a JSON array`);
    return entries;
  } catch (error) {
    const raw = await readStateFile(state, name);
    // `[]\n` is three bytes. A three-byte all-NUL sparse file therefore
    // proves that an empty outbox was damaged; larger files might have held
    // queued messages and must stay failed for manual recovery.
    if (!isRecoverableEmptyOutbox(raw)) throw error;
    await quarantineStateFile(state, name);
    return [];
  }
}

export async function readOutboxStatus(state, name) {
  try {
    const status = await state.readJson(name, {});
    if (!status || Array.isArray(status) || typeof status !== 'object') {
      throw new TypeError(`${name} must contain a JSON object`);
    }
    return status;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Status files are derived telemetry only. Preserve the corrupt bytes for
    // diagnosis, then let the next flush rebuild current counters.
    await quarantineStateFile(state, name);
    return {};
  }
}

export function isRecoverableEmptyOutbox(raw) {
  return Buffer.isBuffer(raw)
    && raw.length > 0
    && raw.length <= Buffer.byteLength('[]\n')
    && raw.every((byte) => byte === 0);
}

async function readStateFile(state, name) {
  try {
    return await fs.readFile(state.file(name));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function quarantineStateFile(state, name) {
  const file = state.file(name);
  const quarantine = `${file}.corrupt.${Date.now()}`;
  try {
    await fs.rename(file, quarantine);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return quarantine;
}
