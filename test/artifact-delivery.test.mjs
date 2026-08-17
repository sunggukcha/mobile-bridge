import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendArtifactDeliveryWarning,
  artifactDeliveryNonce,
  artifactDeliveryFingerprint,
  captureArtifactDeliverySnapshot,
  compactArtifactDeliveryFiles,
  deserializeArtifactDeliverySnapshot,
  deliveryArtifactsForFinalMessage,
  serializeArtifactDeliverySnapshot,
} from '../lib/artifact-delivery.mjs';

test('explicit artifacts reference selects immutable Discord delivery metadata', async (t) => {
  const root = await temporaryArtifactRoot(t);
  const filePath = path.join(root, 'style_v2_a.png');
  await fs.writeFile(filePath, Buffer.from('image-a'));

  const result = await deliveryArtifactsForFinalMessage({
    artifactRoot: root,
    finalText: '이미지입니다: `artifacts/style_v2_a.png`',
  });

  assert.equal(result.skipped.length, 0);
  assert.deepEqual(compactArtifactDeliveryFiles(result.files), [{
    filename: 'style_v2_a.png',
    relativePath: 'artifacts/style_v2_a.png',
    size: 7,
    sha256: '84127d9feb9345703f2ea1ce0c14f6dfb935b8b04816230d160f03922c94ff31',
  }]);
  assert.match(artifactDeliveryFingerprint(result.files), /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(result.files[0].dataBase64, 'base64').toString(), 'image-a');
});

test('unreferenced artifacts are never selected automatically', async (t) => {
  const root = await temporaryArtifactRoot(t);
  await fs.writeFile(path.join(root, 'style_v2_a.png'), Buffer.from('image-a'));

  const result = await deliveryArtifactsForFinalMessage({
    artifactRoot: root,
    finalText: '이미지를 만들었습니다.',
  });

  assert.deepEqual(result, { files: [], skipped: [], unreferenced: [] });
  assert.equal(artifactDeliveryFingerprint([]), '');
});

test('absolute artifact links and paths with spaces do not create a partial missing reference', async (t) => {
  const root = await temporaryArtifactRoot(t);
  const filePath = path.join(root, 'comparison image.png');
  await fs.writeFile(filePath, Buffer.from('png'));

  const result = await deliveryArtifactsForFinalMessage({
    artifactRoot: root,
    finalText: `결과: [이미지](<${filePath}>)`,
  });

  assert.deepEqual(result.files.map((file) => file.filename), ['comparison image.png']);
  assert.equal(result.skipped.length, 0);
});

test('a common Korean postposition after an unquoted artifact path is not part of the filename', async (t) => {
  const root = await temporaryArtifactRoot(t);
  await fs.writeFile(path.join(root, 'comparison.png'), Buffer.from('png'));

  const result = await deliveryArtifactsForFinalMessage({
    artifactRoot: root,
    finalText: '결과 이미지 artifacts/comparison.png를 전달합니다.',
  });

  assert.deepEqual(result.files.map((file) => file.filename), ['comparison.png']);
  assert.equal(result.skipped.length, 0);
});

test('new or changed artifacts omitted from the final response are reported as unreferenced', async (t) => {
  const root = await temporaryArtifactRoot(t);
  await fs.writeFile(path.join(root, 'existing.png'), Buffer.from('before'));
  const beforeSnapshot = await captureArtifactDeliverySnapshot(root);
  const durableSnapshot = serializeArtifactDeliverySnapshot(beforeSnapshot);
  assert.deepEqual(
    [...deserializeArtifactDeliverySnapshot(JSON.parse(JSON.stringify(durableSnapshot))).keys()],
    ['existing.png'],
  );
  await fs.writeFile(path.join(root, 'existing.png'), Buffer.from('after'));
  await fs.writeFile(path.join(root, 'unmentioned.png'), Buffer.from('new'));
  await fs.writeFile(path.join(root, 'mentioned.png'), Buffer.from('sent'));

  const result = await deliveryArtifactsForFinalMessage({
    artifactRoot: root,
    beforeSnapshot,
    finalText: '보낸 파일: `artifacts/mentioned.png`',
  });

  assert.deepEqual(result.files.map((file) => file.filename), ['mentioned.png']);
  assert.deepEqual(result.unreferenced, ['existing.png', 'unmentioned.png']);
  assert.match(
    appendArtifactDeliveryWarning('이미지를 보내드렸습니다.', result),
    /artifacts 파일 2개.*첨부 대상으로 명시되지 않음.*전송 완료로 간주하지 않습니다/s,
  );
});

test('artifact delivery nonce is stable, bounded, and changes with the delivery manifest', () => {
  const base = {
    jobId: 'job-1',
    destinationChannelId: 'thread-1',
    purpose: 'job-final',
    content: '이미지입니다.',
    files: [{ relativePath: 'artifacts/a.png', filename: 'a.png', size: 3, sha256: 'abc' }],
  };
  const first = artifactDeliveryNonce(base);
  assert.equal(first, artifactDeliveryNonce(base));
  assert.equal(first.length, 25);
  assert.notEqual(first, artifactDeliveryNonce({
    ...base,
    files: [{ ...base.files[0], sha256: 'def' }],
  }));
  assert.equal(artifactDeliveryNonce({ ...base, files: [] }), '');
});

test('unsafe, directory, shell, Korean prose, missing, and empty references are not delivered', async (t) => {
  const root = await temporaryArtifactRoot(t);
  await fs.mkdir(path.join(root, 'project'));
  await fs.mkdir(path.join(root, 'bin'));
  await fs.writeFile(path.join(root, 'bin', 'php'), 'wrapper');
  await fs.writeFile(path.join(root, 'empty.png'), Buffer.alloc(0));

  const result = await deliveryArtifactsForFinalMessage({
    artifactRoot: root,
    finalText: [
      'artifacts/../secret.txt',
      'artifacts/project',
      '`artifacts/bin:$PATH`',
      '결과는 artifacts/에 저장',
      'artifacts/missing.png',
      'artifacts/empty.png',
    ].join('\n'),
  });

  assert.equal(result.files.length, 0);
  assert.deepEqual(result.skipped, [
    { relativePath: '../secret.txt', reason: 'outside-artifacts-dir' },
    { relativePath: 'missing.png', reason: 'missing' },
    { relativePath: 'empty.png', reason: 'empty' },
  ]);
});

test('artifact delivery rejects symlinks and duplicate filenames', async (t) => {
  const root = await temporaryArtifactRoot(t);
  const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.png`);
  t.after(() => fs.rm(outside, { force: true }));
  await fs.writeFile(outside, Buffer.from('outside'));
  await fs.symlink(outside, path.join(root, 'escape.png'));
  await fs.mkdir(path.join(root, 'one'));
  await fs.mkdir(path.join(root, 'two'));
  await fs.writeFile(path.join(root, 'one', 'same.png'), Buffer.from('one'));
  await fs.writeFile(path.join(root, 'two', 'same.png'), Buffer.from('two'));

  const result = await deliveryArtifactsForFinalMessage({
    artifactRoot: root,
    finalText: [
      'artifacts/escape.png',
      'artifacts/one/same.png',
      'artifacts/two/same.png',
    ].join(' '),
  });

  assert.deepEqual(result.files.map((file) => file.relativePath), ['artifacts/one/same.png']);
  assert.deepEqual(result.skipped, [
    { relativePath: 'escape.png', reason: 'symlink' },
    { relativePath: 'two/same.png', reason: 'duplicate-filename' },
  ]);
});

test('artifact delivery enforces file, total, and count limits', async (t) => {
  const root = await temporaryArtifactRoot(t);
  await fs.writeFile(path.join(root, 'large.png'), Buffer.alloc(5));
  await fs.writeFile(path.join(root, 'one.png'), Buffer.alloc(3));
  await fs.writeFile(path.join(root, 'two.png'), Buffer.alloc(3));

  const result = await deliveryArtifactsForFinalMessage({
    artifactRoot: root,
    finalText: 'artifacts/large.png artifacts/one.png artifacts/two.png',
    maxFiles: 1,
    maxFileBytes: 4,
    maxTotalBytes: 4,
  });

  assert.deepEqual(result.files.map((file) => file.relativePath), ['artifacts/one.png']);
  assert.deepEqual(result.skipped, [
    { relativePath: 'large.png', reason: 'file-too-large', size: 5 },
    { relativePath: 'two.png', reason: 'too-many-files' },
  ]);
});

test('job final delivery wires referenced artifacts into the Discord send options and audit record', async () => {
  const source = await fs.readFile(new URL('../bridge-service.mjs', import.meta.url), 'utf8');

  assert.match(source, /deliveryArtifactsForFinalMessage\(\{[\s\S]*?artifactRoot:\s*jobArtifactRoot\(config, job\)[\s\S]*?finalText:\s*finalOutput/);
  assert.match(source, /postJobFinalMessage\([\s\S]*?files: artifactDelivery\.files,/);
  assert.match(source, /attachments:\s*compactArtifactDeliveryFiles\(files\)/);
  assert.match(source, /artifactDelivery\.unreferenced\.length/);
  assert.match(source, /durableWorker\.spec\?\.job\?\.artifactDeliveryBaseline/);
  assert.match(source, /deliveryNonce:\s*artifactDeliveryNonce/);
  assert.match(source, /discordAttachmentVerificationPending[\s\S]*?reconcileAttachmentMessageId/);
  assert.doesNotMatch(source, /postJobFinalMessage\([\s\S]{0,300}?artifactDelivery\.files[\s\S]{0,300}?attachments:\s*\[\]/);
});

async function temporaryArtifactRoot(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-artifact-delivery-'));
  const root = path.join(parent, 'artifacts');
  await fs.mkdir(root);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}
