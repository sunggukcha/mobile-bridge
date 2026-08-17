import WebSocket from 'ws';

const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const STOPPED_CONNECTION = Symbol('stopped-connection');

export class SlackSocketModeClient {
  constructor({
    api,
    onEnvelope,
    log = async () => {},
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    webSocketFactory = (url) => new WebSocket(url),
  } = {}) {
    if (!api?.openSocketConnection) throw new Error('Slack Socket Mode requires an API client');
    if (typeof onEnvelope !== 'function') throw new Error('Slack Socket Mode requires an envelope handler');
    this.api = api;
    this.onEnvelope = onEnvelope;
    this.log = log;
    this.reconnectDelayMs = reconnectDelayMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.stopTimeoutMs = Math.max(20, Number(stopTimeoutMs) || DEFAULT_STOP_TIMEOUT_MS);
    this.webSocketFactory = webSocketFactory;
    this.stopped = false;
    this.socket = null;
    this.connected = false;
    this.ready = false;
    this.lastReadyAt = '';
    this.stopTimer = null;
    this.activeConnection = null;
    this.stopController = new AbortController();
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (error) {
        if (!this.stopped) await this.log('slack-socket-error', { error: error.message || String(error) });
      }
      if (!this.stopped) {
        await delay(this.reconnectDelayMs, {
          signal: this.stopController.signal,
        });
      }
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopController.abort();
    this.connected = false;
    this.ready = false;
    const socket = this.socket;
    const activeConnection = this.activeConnection;
    this.socket = null;
    this.clearStopTimer();
    if (socket) {
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        try {
          socket.terminate?.();
        } catch {
          // A concurrent close may have already released the socket.
        }
        if (this.activeConnection === activeConnection) {
          activeConnection?.settle();
        }
      }, this.stopTimeoutMs);
      this.stopTimer.unref?.();
    }
    try {
      socket?.close();
    } catch {
      this.clearStopTimer();
      try {
        socket?.terminate?.();
      } catch {
        // The reconnect loop observes stopped even if a half-open socket throws.
      }
      if (this.activeConnection === activeConnection) {
        activeConnection?.settle();
      }
    }
  }

  clearStopTimer() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  async connectOnce() {
    if (this.stopped || this.stopController.signal.aborted) return;
    const connection = await raceWithAbort(
      this.api.openSocketConnection({ signal: this.stopController.signal }),
      this.stopController.signal,
    );
    if (connection === STOPPED_CONNECTION || this.stopped) return;
    if (!connection?.url) throw new Error('Slack Socket Mode did not return a WebSocket URL');

    await new Promise((resolve, reject) => {
      const socket = this.webSocketFactory(connection.url);
      this.socket = socket;
      let settled = false;
      let handshakeComplete = false;
      const handshakeTimer = setTimeout(() => {
        if (handshakeComplete) return;
        try {
          socket.close();
        } catch {
          // close/error below settles the connection.
        }
        settleReject(new Error('Slack Socket Mode handshake timed out'));
      }, this.handshakeTimeoutMs);
      handshakeTimer.unref?.();

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this.clearStopTimer();
        const wasReady = this.ready;
        this.connected = false;
        this.ready = false;
        clearTimeout(handshakeTimer);
        if (this.socket === socket) this.socket = null;
        if (this.activeConnection?.socket === socket) this.activeConnection = null;
        if (wasReady) {
          this.log('slack-socket-not-ready', {
            reason: 'socket closed',
          }).catch(() => {});
        }
        resolve();
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        this.clearStopTimer();
        const wasReady = this.ready;
        this.connected = false;
        this.ready = false;
        clearTimeout(handshakeTimer);
        if (this.socket === socket) this.socket = null;
        if (this.activeConnection?.socket === socket) this.activeConnection = null;
        if (wasReady) {
          this.log('slack-socket-not-ready', {
            reason: error?.message || 'socket error',
          }).catch(() => {});
        }
        reject(error);
      };
      this.activeConnection = {
        socket,
        settle: settleResolve,
      };

      socket.addEventListener('open', () => {
        this.connected = true;
        this.log('slack-socket-open').catch(() => {});
      });
      socket.addEventListener('message', (messageEvent) => {
        let envelope;
        try {
          envelope = JSON.parse(String(messageEvent.data || ''));
        } catch (error) {
          this.log('slack-socket-invalid-json', { error: error.message || String(error) }).catch(() => {});
          return;
        }
        handshakeComplete = true;
        clearTimeout(handshakeTimer);
        if (!this.ready) {
          this.ready = true;
          this.lastReadyAt = new Date().toISOString();
          this.log('slack-socket-ready', {
            lastReadyAt: this.lastReadyAt,
          }).catch(() => {});
        }
        acknowledgeSlackEnvelope(socket, envelope);
        if (envelope.type === 'disconnect') {
          socket.close();
          return;
        }
        Promise.resolve(this.onEnvelope(envelope)).catch((error) =>
          this.log('slack-envelope-error', { error: error.message || String(error) }).catch(() => {}),
        );
      });
      socket.addEventListener('close', settleResolve);
      socket.addEventListener('error', (event) => {
        settleReject(new Error(event?.message || 'Slack websocket error'));
      });
    });
  }

  status() {
    return {
      connected: this.connected,
      ready: this.ready,
      lastReadyAt: this.lastReadyAt || null,
      stopped: this.stopped,
    };
  }
}

export function acknowledgeSlackEnvelope(socket, envelope = {}) {
  if (!envelope.envelope_id || typeof socket?.send !== 'function') return false;
  socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
  return true;
}

function delay(ms, { signal = null } = {}) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function raceWithAbort(promise, signal) {
  if (signal?.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.resolve(STOPPED_CONNECTION);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(resolve, STOPPED_CONNECTION);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}
