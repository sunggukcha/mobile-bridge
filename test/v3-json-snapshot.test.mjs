import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonSnapshot } from '../v3/lib/json-snapshot.mjs';

test('readJsonSnapshot retries a transient partial overwrite', async () => {
  const bodies = ['{"revision":', '{"revision":42}'];
  const delays = [];

  const value = await readJsonSnapshot('/state/v3-supervisor.json', {
    fsImpl: {
      readFile: async () => bodies.shift(),
    },
    retryDelaysMs: [7],
    sleepFn: async (delayMs) => { delays.push(delayMs); },
  });

  assert.deepEqual(value, { revision: 42 });
  assert.deepEqual(delays, [7]);
});

test('readJsonSnapshot surfaces persistently malformed state after bounded retries', async () => {
  let reads = 0;
  await assert.rejects(
    readJsonSnapshot('/state/v3-supervisor.json', {
      fsImpl: {
        readFile: async () => {
          reads += 1;
          return '{';
        },
      },
      retryDelaysMs: [0, 0],
      sleepFn: async () => {},
    }),
    SyntaxError,
  );
  assert.equal(reads, 3);
});

test('readJsonSnapshot treats a missing snapshot as not yet published', async () => {
  const missing = new Error('missing');
  missing.code = 'ENOENT';

  const value = await readJsonSnapshot('/state/v3-supervisor.json', {
    fsImpl: {
      readFile: async () => { throw missing; },
    },
    sleepFn: async () => assert.fail('missing files must not be retried'),
  });

  assert.equal(value, null);
});

test('readJsonSnapshot does not hide non-parse I/O errors', async () => {
  const ioError = new Error('I/O failure');
  ioError.code = 'EIO';

  await assert.rejects(
    readJsonSnapshot('/state/v3-supervisor.json', {
      fsImpl: {
        readFile: async () => { throw ioError; },
      },
      sleepFn: async () => assert.fail('I/O errors must not be retried'),
    }),
    (error) => error === ioError,
  );
});
