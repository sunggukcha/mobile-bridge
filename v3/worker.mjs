#!/usr/bin/env node
import { DurableBus } from './lib/durable-bus.mjs';
import { loadV3RuntimeConfig } from './lib/runtime-config.mjs';
import { WorkerRuntime } from './lib/worker-runtime.mjs';

const args = parseArgs(process.argv.slice(2));
const jobId = String(args.job || '').trim();
if (!jobId) {
  console.error('usage: node v3/worker.mjs --job <job-id>');
  process.exit(2);
}

// Workbench passes the complete, filtered Worker environment. Do not reload
// the repository .env here or stripped Discord/Slack credentials would leak
// back into this independent process.
const runtimeConfig = loadV3RuntimeConfig(process.env, {
  loadEnvFile: false,
});
const bus = new DurableBus(runtimeConfig.dbPath);
const worker = new WorkerRuntime({
  bus,
  bridgeConfig: runtimeConfig.bridgeConfig,
  jobId,
  token: runtimeConfig.internalToken,
  workbenchUrl: runtimeConfig.workbenchUrl,
  heartbeatMs: runtimeConfig.workerHeartbeatMs,
  reconnectMinMs: runtimeConfig.reconnectMinMs,
  reconnectMaxMs: runtimeConfig.reconnectMaxMs,
  onLog: (type, payload) => {
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      ...payload,
    })}\n`);
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => worker.abort(signal));
}

try {
  const result = await worker.run();
  if (result.status === 'failed') process.exitCode = 1;
} finally {
  bus.close();
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = String(values[index] || '');
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = values[index + 1];
    if (next && !String(next).startsWith('--')) {
      parsed[name] = next;
      index += 1;
    } else {
      parsed[name] = true;
    }
  }
  return parsed;
}
