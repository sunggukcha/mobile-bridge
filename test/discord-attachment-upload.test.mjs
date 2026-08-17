import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  batchDiscordAttachments,
  captionForBatch,
  loadDiscordAttachment,
  verifyDiscordAttachments,
} from '../lib/discord-attachment-upload.mjs';
import { parseArguments } from '../scripts/discord-upload.mjs';

test('attachment helpers batch, load, and verify downloaded bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-attachment-'));
  const filePath = path.join(root, 'slide.png');
  await fs.writeFile(filePath, Buffer.from('image-data'));
  const attachment = await loadDiscordAttachment(filePath);

  const batches = batchDiscordAttachments(Array.from({ length: 11 }, (_, index) => ({ filename: `${index}.png` })));
  assert.deepEqual(batches.map((batch) => batch.length), [10, 1]);
  assert.equal(attachment.contentType, 'image/png');
  assert.equal(attachment.size, 10);

  const verified = await verifyDiscordAttachments({
    attachments: [{ id: 'remote-1', filename: 'slide.png', size: 10, url: 'https://cdn.test/slide.png' }],
  }, [attachment], {
    fetchImpl: async () => new Response(Buffer.from('image-data'), { status: 200 }),
  });
  assert.equal(verified[0].filename, 'slide.png');
  assert.equal(verified[0].sha256, attachment.sha256);
});

test('attachment verification fails when Discord bytes differ', async () => {
  const local = {
    filename: 'slide.png',
    size: 4,
    sha256: 'not-the-downloaded-hash',
  };
  await assert.rejects(() => verifyDiscordAttachments({
    attachments: [{ filename: 'slide.png', size: 4, url: 'https://cdn.test/slide.png' }],
  }, [local], {
    fetchImpl: async () => new Response(Buffer.from('nope'), { status: 200 }),
  }), /SHA-256 mismatch/);
});

test('CLI parsing keeps verification enabled by default', () => {
  assert.deepEqual(
    parseArguments(['--channel', 'thread-1', '--content', '결과', 'one.png']),
    { channelId: 'thread-1', content: '결과', verify: true, files: ['one.png'] },
  );
  assert.equal(captionForBatch('결과', 1, 3), '결과\n첨부 2/3');
});
