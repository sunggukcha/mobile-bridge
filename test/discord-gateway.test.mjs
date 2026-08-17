import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gatewayCloseDetails,
  GatewaySession,
  HeartbeatMonitor,
  gatewayConnectionAttemptDetails,
} from '../lib/discord-gateway.mjs';

const HELLO_CONTEXT = {
  token: 'test-token',
  intents: 33280,
  properties: { os: 'linux', browser: 'bridge', device: 'bridge' },
};
const DEFAULT_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

test('gateway close diagnostics preserve safe reconnect context', () => {
  assert.deepEqual(gatewayCloseDetails({
    code: 1001,
    reason: 'Discord requested reconnect',
    wasClean: true,
  }, {
    trigger: 'discord-op7-reconnect',
    sequence: 119,
    resumable: true,
  }), {
    code: 1001,
    reason: 'Discord requested reconnect',
    wasClean: true,
    trigger: 'discord-op7-reconnect',
    sequence: 119,
    resumable: true,
  });

  const truncated = gatewayCloseDetails({
    code: 'not-a-code',
    reason: 'x'.repeat(600),
    wasClean: false,
  });
  assert.equal(truncated.code, null);
  assert.equal(truncated.reason.length, 500);
  assert.equal(truncated.wasClean, false);
  assert.equal(truncated.trigger, 'remote-or-network');
});

test('gateway connection diagnostics expose safe retry context without the full URL', () => {
  assert.deepEqual(gatewayConnectionAttemptDetails(
    'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json&token=secret',
    { resumeAttempt: true, sequence: 20, startedAtMs: 1_000, nowMs: 1_215.4 },
  ), {
    endpoint: 'gateway-us-east1-b.discord.gg',
    resumeAttempt: true,
    sequence: 20,
    attemptElapsedMs: 215,
  });

  assert.deepEqual(gatewayConnectionAttemptDetails('not a url'), {
    endpoint: 'unknown',
    resumeAttempt: false,
    sequence: null,
    attemptElapsedMs: null,
  });
});

test('fresh session identifies on the default gateway url', () => {
  const session = new GatewaySession();

  assert.equal(session.canResume(), false);
  assert.equal(session.connectUrl(DEFAULT_URL), DEFAULT_URL);
  const reply = session.helloReply(HELLO_CONTEXT);
  assert.equal(reply.op, 2);
  assert.equal(reply.d.token, 'test-token');
  assert.equal(reply.d.intents, 33280);
});

test('session resumes after READY with session id, resume url, and a sequence', () => {
  const session = new GatewaySession();
  session.noteReady({ session_id: 'session-1', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg' });
  session.noteSequence(42);

  assert.equal(session.canResume(), true);
  assert.equal(session.connectUrl(DEFAULT_URL), 'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json');
  assert.deepEqual(session.helloReply(HELLO_CONTEXT), {
    op: 6,
    d: { token: 'test-token', session_id: 'session-1', seq: 42 },
  });
});

test('session does not resume before any dispatch sequence is seen', () => {
  const session = new GatewaySession();
  session.noteReady({ session_id: 'session-1', resume_gateway_url: 'wss://resume.discord.gg' });

  assert.equal(session.canResume(), false);
  assert.equal(session.helloReply(HELLO_CONTEXT).op, 2);
});

test('noteSequence ignores null and undefined heartbeat payloads', () => {
  const session = new GatewaySession();
  session.noteReady({ session_id: 'session-1', resume_gateway_url: 'wss://resume.discord.gg' });
  session.noteSequence(7);
  session.noteSequence(null);
  session.noteSequence(undefined);

  assert.equal(session.sequence, 7);
  assert.equal(session.canResume(), true);
});

test('non-resumable invalid session falls back to a fresh identify', () => {
  const session = new GatewaySession();
  session.noteReady({ session_id: 'session-1', resume_gateway_url: 'wss://resume.discord.gg' });
  session.noteSequence(42);

  session.noteInvalidSession(false);

  assert.equal(session.canResume(), false);
  assert.equal(session.connectUrl(DEFAULT_URL), DEFAULT_URL);
  assert.equal(session.helloReply(HELLO_CONTEXT).op, 2);
});

test('resumable invalid session keeps the resume state', () => {
  const session = new GatewaySession();
  session.noteReady({ session_id: 'session-1', resume_gateway_url: 'wss://resume.discord.gg' });
  session.noteSequence(42);

  session.noteInvalidSession(true);

  assert.equal(session.canResume(), true);
  assert.equal(session.helloReply(HELLO_CONTEXT).op, 6);
});

test('a fresh READY after re-identify replaces the previous session', () => {
  const session = new GatewaySession();
  session.noteReady({ session_id: 'session-1', resume_gateway_url: 'wss://resume-1.discord.gg' });
  session.noteSequence(42);
  session.noteInvalidSession(false);

  session.noteReady({ session_id: 'session-2', resume_gateway_url: 'wss://resume-2.discord.gg/' });
  session.noteSequence(1);

  assert.deepEqual(session.helloReply(HELLO_CONTEXT).d, {
    token: 'test-token',
    session_id: 'session-2',
    seq: 1,
  });
  assert.equal(session.connectUrl(DEFAULT_URL), 'wss://resume-2.discord.gg/?v=10&encoding=json');
});

test('heartbeat monitor allows beats while ACKs keep arriving', () => {
  const monitor = new HeartbeatMonitor();

  assert.equal(monitor.beat(), true);
  monitor.ack();
  assert.equal(monitor.beat(), true);
  monitor.ack();
  assert.equal(monitor.beat(), true);
});

test('heartbeat monitor flags a zombie connection when an ACK is missed', () => {
  const monitor = new HeartbeatMonitor();

  assert.equal(monitor.beat(), true);
  // No ack() — Discord went silent.
  assert.equal(monitor.beat(), false);

  // After a reconnect the monitor starts fresh.
  monitor.reset();
  assert.equal(monitor.beat(), true);
});

test('full reconnect cycle: identify, dispatch, drop, resume', () => {
  const session = new GatewaySession();

  // First connection: HELLO -> IDENTIFY -> READY -> dispatches.
  assert.equal(session.helloReply(HELLO_CONTEXT).op, 2);
  session.noteReady({ session_id: 'session-9', resume_gateway_url: 'wss://resume.discord.gg' });
  session.noteSequence(1);
  session.noteSequence(2);
  session.noteSequence(3);

  // Connection drops (op 7 or socket close): state is untouched, so the next
  // connect goes to the resume url and replies to HELLO with RESUME at seq 3.
  assert.equal(session.connectUrl(DEFAULT_URL), 'wss://resume.discord.gg/?v=10&encoding=json');
  const resume = session.helloReply(HELLO_CONTEXT);
  assert.equal(resume.op, 6);
  assert.equal(resume.d.seq, 3);

  // Replayed dispatches after RESUMED keep advancing the same session.
  session.noteSequence(4);
  assert.equal(session.helloReply(HELLO_CONTEXT).d.seq, 4);
});
