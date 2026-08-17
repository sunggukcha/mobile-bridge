import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_DISCORD_ATTACHMENTS_PER_MESSAGE = 10;

export async function loadDiscordAttachment(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''));
  const data = await fs.readFile(resolvedPath);
  if (data.length === 0) throw new Error(`refusing to upload an empty file: ${resolvedPath}`);
  return {
    path: resolvedPath,
    filename: path.basename(resolvedPath),
    contentType: contentTypeForFilename(resolvedPath),
    data,
    size: data.length,
    sha256: sha256(data),
  };
}

export function batchDiscordAttachments(attachments, limit = MAX_DISCORD_ATTACHMENTS_PER_MESSAGE) {
  const size = Math.max(1, Math.min(
    Number(limit) || MAX_DISCORD_ATTACHMENTS_PER_MESSAGE,
    MAX_DISCORD_ATTACHMENTS_PER_MESSAGE,
  ));
  const batches = [];
  for (let index = 0; index < attachments.length; index += size) {
    const batch = attachments.slice(index, index + size);
    assertUniqueFilenames(batch);
    batches.push(batch);
  }
  return batches;
}

export async function verifyDiscordAttachments(message, localAttachments, { fetchImpl = fetch } = {}) {
  const uploaded = Array.isArray(message?.attachments) ? message.attachments : [];
  if (uploaded.length !== localAttachments.length) {
    throw new Error(`Discord attachment count mismatch: expected ${localAttachments.length}, got ${uploaded.length}`);
  }

  const results = [];
  const claimed = new Set();
  for (const [index, local] of localAttachments.entries()) {
    const remote = matchUploadedAttachment(uploaded, local, index, claimed);
    if (!remote?.url) throw new Error(`Discord attachment missing after upload: ${local.filename}`);
    claimed.add(remote);
    if (Number(remote.size) !== local.size) {
      throw new Error(`Discord attachment size mismatch for ${local.filename}: expected ${local.size}, got ${remote.size}`);
    }
    const response = await fetchImpl(remote.url);
    if (!response.ok) throw new Error(`failed to download ${local.filename} for verification: HTTP ${response.status}`);
    const downloaded = Buffer.from(await response.arrayBuffer());
    const downloadedSha256 = sha256(downloaded);
    if (downloadedSha256 !== local.sha256) {
      throw new Error(`Discord attachment SHA-256 mismatch for ${local.filename}`);
    }
    results.push({
      filename: local.filename,
      size: local.size,
      sha256: local.sha256,
      attachmentId: remote.id || null,
    });
  }
  return results;
}

export function captionForBatch(content, index, total) {
  const base = String(content || '').trim();
  if (total <= 1) return base;
  return [base, `첨부 ${index + 1}/${total}`].filter(Boolean).join('\n');
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Filename equality is not a reliable pairing key. Unicode normalization can
// make an uploaded name look identical while using a different byte sequence.
// Size and SHA-256 are checked afterwards, so pairing by position remains safe:
// a wrong pairing cannot pass those checks.
function matchUploadedAttachment(uploaded, local, index, claimed) {
  const free = uploaded.filter((attachment) => !claimed.has(attachment));
  const exact = free.find((attachment) => attachment.filename === local.filename);
  if (exact) return exact;

  const wanted = normalizeFilename(local.filename);
  const normalized = free.find((attachment) => normalizeFilename(attachment.filename) === wanted);
  if (normalized) return normalized;

  // Counts already match, so the remaining candidate at this position is the
  // only one this local file can be.
  const bySize = free.filter((attachment) => Number(attachment.size) === Number(local.size));
  if (bySize.length === 1) return bySize[0];
  return uploaded[index] && !claimed.has(uploaded[index]) ? uploaded[index] : free[0] || null;
}

function normalizeFilename(value) {
  return String(value || '').normalize('NFC');
}

function assertUniqueFilenames(attachments) {
  const seen = new Set();
  for (const attachment of attachments) {
    if (seen.has(attachment.filename)) {
      throw new Error(`duplicate attachment filename in one Discord message: ${attachment.filename}`);
    }
    seen.add(attachment.filename);
  }
}

function contentTypeForFilename(filename) {
  const extension = path.extname(filename).toLowerCase();
  return new Map([
    ['.gif', 'image/gif'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.json', 'application/json'],
    ['.md', 'text/markdown'],
    ['.pdf', 'application/pdf'],
    ['.png', 'image/png'],
    ['.txt', 'text/plain'],
    ['.webp', 'image/webp'],
  ]).get(extension) || 'application/octet-stream';
}
