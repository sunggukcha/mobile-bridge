#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  batchDiscordAttachments,
  captionForBatch,
  loadDiscordAttachment,
  verifyDiscordAttachments,
} from '../lib/discord-attachment-upload.mjs';
import { DiscordApi } from '../lib/discord-api.mjs';

export async function runDiscordUpload(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set in the inherited worker environment');

  const api = new DiscordApi({ token });
  const attachments = await Promise.all(options.files.map(loadDiscordAttachment));
  const batches = batchDiscordAttachments(attachments);
  const uploaded = [];

  for (const [index, batch] of batches.entries()) {
    const message = await api.postAttachments(options.channelId, batch, {
      content: captionForBatch(options.content, index, batches.length),
    });
    const reread = await api.getMessage(options.channelId, message.id);
    const verified = options.verify
      ? await verifyDiscordAttachments(reread, batch)
      : [];
    uploaded.push({
      messageId: message.id,
      files: batch.map((file) => file.filename),
      verified,
    });
  }
  return { channelId: options.channelId, messages: uploaded };
}

export function parseArguments(argv) {
  const args = [...argv];
  const files = [];
  let channelId = '';
  let content = '';
  let verify = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--channel') channelId = String(args[++index] || '');
    else if (arg === '--content') content = String(args[++index] || '');
    else if (arg === '--no-verify') verify = false;
    else if (arg === '--help' || arg === '-h') throw new Error(usage());
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}\n\n${usage()}`);
    else files.push(arg);
  }
  if (!channelId || files.length === 0) throw new Error(usage());
  return { channelId, content, verify, files };
}

function usage() {
  return [
    'Usage: node scripts/discord-upload.mjs --channel THREAD_ID [--content TEXT] FILE...',
    '',
    'Uploads at most 10 files per Discord message, re-reads each message,',
    'downloads each attachment, and verifies size plus SHA-256 by default.',
  ].join('\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runDiscordUpload()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
