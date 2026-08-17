#!/usr/bin/env node

// The complete, already-tested bridge business core is the v3 Workbench.
// Only its platform and model-process dependencies are replaced by durable v3
// adapters. Keeping one source of truth prevents command/state feature drift
// while Reception and detached Workers gain independent lifecycles.
process.env.BRIDGE_RUNTIME_ROLE = 'v3-workbench';
await import('../bridge-service.mjs');
