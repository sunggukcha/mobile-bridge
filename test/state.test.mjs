import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonState, readJsonlTail, writeJsonAtomic } from '../lib/state.mjs';

test('readJsonlTail reads only complete recent records across small UTF-8 chunks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-state-tail-'));
  const filePath = path.join(root, 'events.jsonl');
  try {
    await fs.writeFile(filePath, [
      'invalid historical row that is outside the requested tail',
      JSON.stringify({ id: 1, text: '한국어 첫 번째 레코드' }),
      '',
      JSON.stringify({ id: 2, text: '두 번째' }),
      JSON.stringify({ id: 3, text: '줄바꿈 없는 마지막' }),
    ].join('\r\n'));

    assert.deepEqual(
      await readJsonlTail(filePath, { limit: 2, chunkBytes: 17 }),
      [
        { id: 2, text: '두 번째' },
        { id: 3, text: '줄바꿈 없는 마지막' },
      ],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('readJsonlTail fills short FileHandle reads without skipping bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-state-short-read-'));
  const filePath = path.join(root, 'events.jsonl');
  try {
    await fs.writeFile(filePath, [1, 2, 3]
      .map((id) => JSON.stringify({ id, text: `record-${id}` }))
      .join('\n'));
    const fsImpl = {
      ...fs,
      async open(...args) {
        const handle = await fs.open(...args);
        return {
          stat: (...statArgs) => handle.stat(...statArgs),
          close: (...closeArgs) => handle.close(...closeArgs),
          read: (buffer, offset, length, position) => handle.read(
            buffer,
            offset,
            Math.min(length, 5),
            position,
          ),
        };
      },
    };
    assert.deepEqual(
      await readJsonlTail(filePath, { limit: 2, chunkBytes: 17, fsImpl }),
      [{ id: 2, text: 'record-2' }, { id: 3, text: 'record-3' }],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('JsonState writeJson forwards restrictive file modes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-state-mode-'));
  const state = new JsonState(root);
  try {
    await state.writeJson('private.json', { ok: true }, { mode: 0o600 });
    assert.equal((await fs.stat(path.join(root, 'private.json'))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('JsonState readJsonl preserves empty, missing, and zero-limit behavior', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-state-tail-empty-'));
  const state = new JsonState(root);
  try {
    assert.deepEqual(await state.readJsonl('missing.jsonl'), []);
    await fs.writeFile(path.join(root, 'events.jsonl'), '{"id":1}\n');
    assert.deepEqual(await state.readJsonl('events.jsonl', { limit: 0 }), []);
    assert.deepEqual(await state.readJsonl('events.jsonl', { limit: 1 }), [{ id: 1 }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeJsonAtomic retries transient DrvFS rename failures and removes its temp file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-state-retry-'));
  const filePath = path.join(root, 'status.json');
  await fs.writeFile(filePath, '{"old":true}\n');
  let renameCalls = 0;
  const fsImpl = {
    ...fs,
    async rename(source, destination) {
      renameCalls += 1;
      if (renameCalls <= 3) {
        const error = new Error('destination is temporarily locked');
        error.code = 'EACCES';
        throw error;
      }
      return fs.rename(source, destination);
    },
  };

  try {
    await writeJsonAtomic(filePath, { ready: true }, {
      fsImpl,
      renameRetryDelaysMs: [0, 0, 0],
      sleepFn: async () => {},
    });

    assert.equal(renameCalls, 4);
    assert.deepEqual(
      JSON.parse(await fs.readFile(filePath, 'utf8')),
      { ready: true },
    );
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeJsonAtomic serializes concurrent writes to one destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-state-order-'));
  const filePath = path.join(root, 'status.json');
  let activeRenames = 0;
  let maximumActiveRenames = 0;
  const fsImpl = {
    ...fs,
    async rename(source, destination) {
      activeRenames += 1;
      maximumActiveRenames = Math.max(maximumActiveRenames, activeRenames);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        await fs.rename(source, destination);
      } finally {
        activeRenames -= 1;
      }
    },
  };

  try {
    await Promise.all([
      writeJsonAtomic(filePath, { revision: 1 }, { fsImpl }),
      writeJsonAtomic(filePath, { revision: 2 }, { fsImpl }),
      writeJsonAtomic(filePath, { revision: 3 }, { fsImpl }),
    ]);

    assert.equal(maximumActiveRenames, 1);
    assert.deepEqual(
      JSON.parse(await fs.readFile(filePath, 'utf8')),
      { revision: 3 },
    );
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeJsonAtomic does not retry permanent errors and still cleans up', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-state-fail-'));
  const filePath = path.join(root, 'status.json');
  let renameCalls = 0;
  const fsImpl = {
    ...fs,
    async rename() {
      renameCalls += 1;
      const error = new Error('invalid destination');
      error.code = 'EINVAL';
      throw error;
    },
  };

  try {
    await assert.rejects(
      writeJsonAtomic(filePath, { ready: false }, {
        fsImpl,
        sleepFn: async () => {},
      }),
      { code: 'EINVAL' },
    );
    assert.equal(renameCalls, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
