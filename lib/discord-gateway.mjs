const GATEWAY_QUERY = '?v=10&encoding=json';
const GATEWAY_CLOSE_REASON_LIMIT = 500;

export function gatewayCloseDetails(event = {}, {
  trigger = 'remote-or-network',
  sequence = null,
  resumable = false,
} = {}) {
  const rawCode = Number(event?.code);
  const code = Number.isInteger(rawCode) && rawCode >= 0 ? rawCode : null;
  const reason = typeof event?.reason === 'string'
    ? event.reason.slice(0, GATEWAY_CLOSE_REASON_LIMIT)
    : '';

  return {
    code,
    reason,
    wasClean: event?.wasClean === true,
    trigger,
    sequence: sequence ?? null,
    resumable: Boolean(resumable),
  };
}

export function gatewayConnectionAttemptDetails(url, {
  resumeAttempt = false,
  sequence = null,
  startedAtMs = null,
  nowMs = Date.now(),
} = {}) {
  let endpoint = 'unknown';
  try {
    endpoint = new URL(String(url || '')).host || 'unknown';
  } catch {
    // Keep diagnostics safe and usable even if a future gateway URL is malformed.
  }

  const hasStartedAt = startedAtMs !== null && startedAtMs !== undefined && startedAtMs !== '';
  const started = Number(startedAtMs);
  const now = Number(nowMs);
  const attemptElapsedMs = hasStartedAt && Number.isFinite(started) && Number.isFinite(now)
    ? Math.max(0, Math.round(now - started))
    : null;

  return {
    endpoint,
    resumeAttempt: Boolean(resumeAttempt),
    sequence: sequence ?? null,
    attemptElapsedMs,
  };
}

// Detects zombie gateway connections: if Discord never ACKs (op 11) the
// previous heartbeat, the TCP connection is half-dead and events silently
// stop flowing. beat() returns false in that case so the caller can close
// the socket and reconnect (which RESUMEs the session).
export class HeartbeatMonitor {
  constructor() {
    this.awaitingAck = false;
  }

  beat() {
    if (this.awaitingAck) return false;
    this.awaitingAck = true;
    return true;
  }

  ack() {
    this.awaitingAck = false;
  }

  reset() {
    this.awaitingAck = false;
  }
}

// Tracks the Discord gateway session so a reconnect can RESUME (op 6) instead
// of re-IDENTIFYing, which makes Discord replay events missed while offline.
export class GatewaySession {
  constructor() {
    this.sequence = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
  }

  noteSequence(sequence) {
    if (sequence !== null && sequence !== undefined) this.sequence = sequence;
  }

  noteReady(ready = {}) {
    this.sessionId = ready.session_id || null;
    this.resumeGatewayUrl = ready.resume_gateway_url || null;
  }

  // op 9 INVALID_SESSION: d === true means the session may still be resumed.
  noteInvalidSession(resumable) {
    if (!resumable) this.reset();
  }

  reset() {
    this.sequence = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
  }

  canResume() {
    return Boolean(this.sessionId && this.resumeGatewayUrl && this.sequence !== null);
  }

  connectUrl(defaultUrl) {
    if (!this.canResume()) return defaultUrl;
    return `${this.resumeGatewayUrl.replace(/\/+$/, '')}/${GATEWAY_QUERY}`;
  }

  // The payload to send in response to HELLO (op 10): RESUME when a previous
  // session is resumable, otherwise a fresh IDENTIFY.
  helloReply({ token, intents, properties }) {
    if (this.canResume()) {
      return {
        op: 6,
        d: {
          token,
          session_id: this.sessionId,
          seq: this.sequence,
        },
      };
    }
    return {
      op: 2,
      d: {
        token,
        intents,
        properties,
      },
    };
  }
}
