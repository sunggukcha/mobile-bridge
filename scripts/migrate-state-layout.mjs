#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateStateLayout } from '../lib/state-migration.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultSource = path.join(repoRoot, '.state');
const defaultTarget = path.join(path.dirname(repoRoot), '.bridge_state');

const args = process.argv.slice(2);
const archiveSource = args.includes('--archive-source');
const once = args.includes('--once');
const positional = args.filter((arg) => !arg.startsWith('--'));
const sourceRoot = path.resolve(positional[0] || defaultSource);
const targetRoot = path.resolve(positional[1] || process.env.BRIDGE_STATE_ROOT || defaultTarget);

const result = await migrateStateLayout({ sourceRoot, targetRoot, archiveSource, once });
console.log(JSON.stringify(result));
