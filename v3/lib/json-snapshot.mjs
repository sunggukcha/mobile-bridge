import fs from 'node:fs/promises';

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40]);

// Some hot health snapshots are overwritten in place on DrvFS because Windows
// readers can make atomic rename fail. A concurrent read can therefore observe
// the brief truncate/write window. Retry only parse failures; durable I/O errors
// must remain visible to the caller.
export async function readJsonSnapshot(filePath, {
  fsImpl = fs,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleepFn = sleep,
} = {}) {
  const delays = Array.isArray(retryDelaysMs)
    ? retryDelaysMs
    : DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(await fsImpl.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (!(error instanceof SyntaxError) || attempt >= delays.length) {
        throw error;
      }
      await sleepFn(Math.max(0, Number(delays[attempt]) || 0));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
