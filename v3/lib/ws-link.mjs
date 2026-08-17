import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

const OPEN = WebSocket.OPEN;
const MAX_FRAME_BYTES = 256 * 1024;

export class WakeServer extends EventEmitter {
  constructor({
    host = '127.0.0.1',
    port,
    token,
    allowedRoles = [],
    heartbeatMs = 15_000,
    onWake = null,
    onError = null,
  } = {}) {
    super();
    if (!Number.isInteger(Number(port)) || Number(port) < 0) {
      throw new Error('WakeServer port must be a non-negative integer');
    }
    if (!token) throw new Error('WakeServer token is required');
    this.host = host;
    this.port = Number(port);
    this.token = String(token);
    this.allowedRoles = new Set(allowedRoles.map(String));
    this.heartbeatMs = Math.max(1_000, Number(heartbeatMs) || 15_000);
    this.onWake = onWake;
    this.onError = onError;
    this.server = null;
    this.heartbeatTimer = null;
    this.peers = new Map();
  }

  async start() {
    if (this.server) return this.address();
    const server = new WebSocketServer({
      host: this.host,
      port: this.port,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.server = server;
    server.on('connection', (socket, request) => this.accept(socket, request));
    server.on('error', (error) => this.reportError(error));
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.off('error', onStartError);
        resolve();
      };
      const onStartError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onStartError);
    });
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    return this.address();
  }

  address() {
    const address = this.server?.address();
    if (!address || typeof address === 'string') return null;
    const host = address.address === '::' ? '127.0.0.1' : address.address;
    return {
      host,
      port: address.port,
      url: `ws://${host}:${address.port}`,
    };
  }

  accept(socket, request) {
    const peer = {
      socket,
      role: '',
      instanceId: '',
      authenticated: false,
      alive: true,
      connectedAt: new Date().toISOString(),
      remoteAddress: request?.socket?.remoteAddress || '',
    };
    const helloTimer = setTimeout(() => {
      if (!peer.authenticated) socket.close(1008, 'hello timeout');
    }, 5_000);
    helloTimer.unref?.();

    socket.on('pong', () => {
      peer.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text frames only');
        return;
      }
      const frame = parseFrame(data);
      if (!frame) {
        socket.close(1007, 'invalid JSON');
        return;
      }
      if (!peer.authenticated) {
        if (!this.authenticate(peer, frame)) {
          socket.close(1008, 'authentication failed');
          return;
        }
        clearTimeout(helloTimer);
        socket.send(JSON.stringify({
          type: 'hello.accepted',
          role: peer.role,
          instanceId: peer.instanceId,
        }));
        this.emit('peer.connected', compactPeer(peer));
        return;
      }
      if (frame.type === 'wake') {
        Promise.resolve(this.onWake?.(frame, compactPeer(peer)))
          .catch((error) => this.reportError(error));
        this.emit('wake', frame, compactPeer(peer));
      }
    });
    socket.on('error', (error) => this.reportError(error));
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.removePeer(peer);
    });
  }

  authenticate(peer, frame) {
    const role = String(frame?.role || '');
    const instanceId = String(frame?.instanceId || '');
    if (frame?.type !== 'hello' || frame?.token !== this.token || !role || !instanceId) {
      return false;
    }
    if (this.allowedRoles.size > 0 && !this.allowedRoles.has(role)) return false;
    peer.role = role;
    peer.instanceId = instanceId;
    peer.authenticated = true;
    const key = peerKey(role, instanceId);
    const previous = this.peers.get(key);
    if (previous && previous !== peer) {
      try {
        previous.socket.close(1008, 'superseded connection');
      } catch {
        // The new authenticated peer is already authoritative for this key.
      }
    }
    this.peers.set(key, peer);
    return true;
  }

  sendTo(role, frame) {
    let sent = 0;
    for (const peer of this.peers.values()) {
      if (peer.role !== role || peer.socket.readyState !== OPEN) continue;
      peer.socket.send(JSON.stringify(frame));
      sent += 1;
    }
    return sent;
  }

  wake(role, message) {
    return this.sendTo(role, {
      type: 'wake',
      ...message,
    });
  }

  connected(role) {
    return [...this.peers.values()].some(
      (peer) => peer.role === role && peer.socket.readyState === OPEN,
    );
  }

  heartbeat() {
    for (const peer of this.peers.values()) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }
      peer.alive = false;
      try {
        peer.socket.ping();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  removePeer(peer) {
    const key = peerKey(peer.role, peer.instanceId);
    if (this.peers.get(key) === peer) this.peers.delete(key);
    if (peer.authenticated) this.emit('peer.disconnected', compactPeer(peer));
  }

  async stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const peer of this.peers.values()) {
      try {
        peer.socket.close(1001, 'service stopping');
      } catch {
        // Server close below remains authoritative.
      }
    }
    this.peers.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  reportError(error) {
    this.onError?.(error);
    this.emit('link.error', error);
  }
}

export class WakeClient extends EventEmitter {
  constructor({
    url,
    token,
    role,
    instanceId,
    reconnectMinMs = 200,
    reconnectMaxMs = 5_000,
    onWake = null,
    onError = null,
  } = {}) {
    super();
    if (!url) throw new Error('WakeClient URL is required');
    if (!token) throw new Error('WakeClient token is required');
    if (!role || !instanceId) throw new Error('WakeClient role and instanceId are required');
    this.url = String(url);
    this.token = String(token);
    this.role = String(role);
    this.instanceId = String(instanceId);
    this.reconnectMinMs = Math.max(20, Number(reconnectMinMs) || 200);
    this.reconnectMaxMs = Math.max(this.reconnectMinMs, Number(reconnectMaxMs) || 5_000);
    this.onWake = onWake;
    this.onError = onError;
    this.socket = null;
    this.stopped = true;
    this.authenticated = false;
    this.retryMs = this.reconnectMinMs;
    this.retryTimer = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.socket) return;
    const socket = new WebSocket(this.url, {
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'hello',
        token: this.token,
        role: this.role,
        instanceId: this.instanceId,
      }));
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = parseFrame(data);
      if (!frame) return;
      if (frame.type === 'hello.accepted') {
        this.authenticated = true;
        this.retryMs = this.reconnectMinMs;
        this.emit('connected');
        return;
      }
      if (frame.type === 'wake') {
        Promise.resolve(this.onWake?.(frame))
          .catch((error) => this.reportError(error));
        this.emit('wake', frame);
      }
    });
    socket.on('error', (error) => this.reportError(error));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      const wasAuthenticated = this.authenticated;
      this.authenticated = false;
      if (wasAuthenticated) this.emit('disconnected');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const delayMs = this.retryMs;
    this.retryMs = Math.min(this.reconnectMaxMs, Math.ceil(this.retryMs * 1.8));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  wake(message) {
    if (!this.authenticated || this.socket?.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify({
      type: 'wake',
      ...message,
    }));
    return true;
  }

  connected() {
    return this.authenticated && this.socket?.readyState === OPEN;
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    if (!socket) return;
    try {
      socket.close(1000, 'client stopping');
    } catch {
      socket.terminate();
    }
  }

  reportError(error) {
    this.onError?.(error);
    this.emit('link.error', error);
  }
}

function parseFrame(data) {
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function peerKey(role, instanceId) {
  return `${role}:${instanceId}`;
}

function compactPeer(peer) {
  return {
    role: peer.role,
    instanceId: peer.instanceId,
    connectedAt: peer.connectedAt,
    remoteAddress: peer.remoteAddress,
  };
}
