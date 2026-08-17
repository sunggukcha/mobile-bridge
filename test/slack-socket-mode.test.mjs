import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgeSlackEnvelope,
  SlackSocketModeClient,
} from '../lib/slack-socket-mode.mjs';

test('Socket Mode envelopes are acknowledged by envelope ID', () => {
  const sent = [];
  const socket = { send: (content) => sent.push(JSON.parse(content)) };

  assert.equal(acknowledgeSlackEnvelope(socket, { envelope_id: 'env-1' }), true);
  assert.deepEqual(sent, [{ envelope_id: 'env-1' }]);
  assert.equal(acknowledgeSlackEnvelope(socket, { type: 'hello' }), false);
});

test('Socket Mode health becomes ready only after the first handshake envelope', async () => {
  const socket = new FakeSocket();
  const logs = [];
  const client = new SlackSocketModeClient({
    api: {
      async openSocketConnection() {
        return { url: 'wss://slack.test/socket' };
      },
    },
    onEnvelope: async () => {},
    webSocketFactory: () => socket,
    log: async (type) => logs.push(type),
  });

  const connection = client.connectOnce();
  await waitFor(() => client.socket === socket);
  socket.emit('open');
  assert.equal(client.status().connected, true);
  assert.equal(client.status().ready, false);

  socket.emit('message', {
    data: JSON.stringify({ type: 'hello', envelope_id: 'hello-1' }),
  });
  await Promise.resolve();
  assert.equal(client.status().ready, true);
  assert.ok(logs.includes('slack-socket-ready'));

  socket.emit('close');
  await connection;
  assert.equal(client.status().connected, false);
  assert.equal(client.status().ready, false);
  assert.ok(logs.includes('slack-socket-not-ready'));
});

test('Socket Mode stop terminates a socket whose close handshake stalls', async () => {
  const socket = new HangingCloseSocket();
  const client = new SlackSocketModeClient({
    api: {
      async openSocketConnection() {
        return { url: 'wss://slack.test/socket' };
      },
    },
    onEnvelope: async () => {},
    stopTimeoutMs: 20,
    webSocketFactory: () => socket,
  });

  const connection = client.connectOnce();
  await waitFor(() => client.socket === socket);
  socket.emit('open');
  client.stop();
  client.stop();
  await Promise.race([
    connection,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Socket Mode stop did not settle')),
      500,
    )),
  ]);

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.terminateCalls, 1);
});

test('Socket Mode stop prevents a socket from opening after URL resolution', async () => {
  let resolveConnection;
  let socketCreations = 0;
  const client = new SlackSocketModeClient({
    api: {
      openSocketConnection() {
        return new Promise((resolve) => {
          resolveConnection = resolve;
        });
      },
    },
    onEnvelope: async () => {},
    webSocketFactory: () => {
      socketCreations += 1;
      return new FakeSocket();
    },
  });

  const connection = client.connectOnce();
  await Promise.resolve();
  client.stop();
  resolveConnection({ url: 'wss://slack.test/socket' });
  await connection;

  assert.equal(socketCreations, 0);
});

test('Socket Mode run settles when stop interrupts an unresolved URL request', async () => {
  let receivedSignal;
  const client = new SlackSocketModeClient({
    api: {
      openSocketConnection({ signal } = {}) {
        receivedSignal = signal;
        return new Promise(() => {});
      },
    },
    onEnvelope: async () => {},
    webSocketFactory: () => {
      throw new Error('a stopped client must not create a socket');
    },
  });

  const running = client.run();
  await Promise.resolve();
  client.stop();
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Socket Mode run did not stop')),
      500,
    )),
  ]);

  assert.equal(receivedSignal?.aborted, true);
});

test('Socket Mode run settles when stop interrupts reconnect backoff', async () => {
  let failureLogged;
  const logged = new Promise((resolve) => {
    failureLogged = resolve;
  });
  const client = new SlackSocketModeClient({
    api: {
      async openSocketConnection() {
        throw new Error('connection unavailable');
      },
    },
    onEnvelope: async () => {},
    reconnectDelayMs: 60_000,
    log: async (type) => {
      if (type === 'slack-socket-error') failureLogged();
    },
  });

  const running = client.run();
  await logged;
  client.stop();
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Socket Mode reconnect backoff did not stop')),
      500,
    )),
  ]);
});

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  send(content) {
    this.sent.push(content);
  }

  close() {
    this.emit('close');
  }
}

class HangingCloseSocket extends FakeSocket {
  constructor() {
    super();
    this.closeCalls = 0;
    this.terminateCalls = 0;
  }

  close() {
    this.closeCalls += 1;
  }

  terminate() {
    this.terminateCalls += 1;
  }
}

async function waitFor(probe, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
