# Bridge v3 prototype

This prototype separates the current monolith into three process lifecycles:

```text
Discord / Slack
       │
       ▼
Reception (stable, always on)
       │  SQLite journal + WebSocket wake-up
       ▼
Workbench (replaceable orchestration generation)
       │  job record + detached process
       ▼
Worker (one independent process per job)
       │  SQLite journal + WebSocket wake-up when Workbench is online
       └───────────────────────────────────────────────┐
                                                       ▼
Worker event → Workbench → Reception → Discord / Slack
```

## Why both SQLite and WebSocket

SQLite is the delivery authority. Every inbound request and every Worker
update is committed before a WebSocket notification is attempted. WebSocket
is only the low-latency wake-up path.

This removes the race where a socket appears open, a sender writes, and the
receiver disappears during a patch:

1. The sender commits a message with a unique ID and per-job sequence.
2. If the receiver is connected, the sender sends a small `wake` frame.
3. The receiver drains unacknowledged rows in sequence.
4. If the socket is down, the normal SQLite poll finds the same rows.
5. The receiver acknowledges a row only after the next durable hop (or the
   external platform delivery) succeeds.

Raw platform inputs also keep a `processing`/`done` reservation in the
existing state root. A Workbench crash leaves both the reservation and SQLite
row unfinished, so the next fenced generation reclaims the input. Once the
legacy handler has durably queued or completed the action, it marks `done`;
redelivery can then be acknowledged without running the command twice.

SQLite has no daemon and consumes no idle CPU of its own. The prototype uses
Node 22's built-in SQLite binding, so it also needs no native npm addon. The
services use WAL, short transactions, a 1-second fallback poll, and WebSocket
wake-ups for the normal fast path.

## Process ownership

- Reception owns Discord Gateway / Slack Socket Mode and external sends.
- Workbench runs the existing bridge business core unchanged: command routing,
  TODO/alerts, catch-up, state migration, schedules, maintenance, prompt
  construction, queue admission, checkpoints, transcripts, and recovery.
- Platform reads/writes made by that core use durable Reception RPC; the
  Workbench never owns Discord or Slack credentials/connections.
- Workbench launches each Worker detached with no stdio pipe back to the
  Workbench. The Worker reads its immutable job specification from SQLite.
- A Worker writes progress and final events directly to SQLite. Killing or
  replacing Workbench therefore does not kill or disconnect the actual model
  process.
- Cancellation is committed to SQLite and also sent as a wake frame for low
  latency; the heartbeat poll remains the fallback if that frame is missed.
- A lease with a monotonically increasing epoch prevents two Workbench
  generations from consuming the same queue during a handoff.
- A supervisor admission gate keeps inbound jobs durable but paused until
  Reception and every configured platform are ready. Worker updates continue
  draining while admission is paused.
- The v3 supervisor owns Reception and Workbench as sibling processes. An
  external watchdog owns that supervisor and replaces its process group if its
  health heartbeat stalls. A
  Workbench exit replaces only Workbench. Reception is replaced only when the
  recorded runtime-change paths include a module loaded by Reception. A
  Supervisor dependency change performs a clean exit with restart code 75 so
  the still-running watchdog loads the new Supervisor generation.

## Feature parity

The Workbench does not contain a second, partial rewrite of the bridge. It
loads `bridge-service.mjs` in `v3-workbench` mode and swaps only two dependency
boundaries:

```text
DiscordApi / SlackApi  → WorkbenchPlatformRpc → Reception adapters
runAgentJob            → DetachedWorkerBroker → one Worker process per job
```

This retains the existing JSONL state layout and the complete command,
scheduling, recovery, checkpoint, transcript, TODO, maintenance, GitHub,
outbox, dedupe, model-selection, and pending-ask behavior. The detailed
ownership/parity matrix is in [`FEATURE_PARITY.md`](./FEATURE_PARITY.md).

## Local smoke run

Use three terminals from this checkout:

```bash
V3_PLATFORM_MODE=console npm run v3:reception
npm run v3:workbench
npm run v3:submit -- --mock --content "v3 smoke test"
```

`console` mode does not connect to Discord or Slack. It prints Reception
deliveries as JSON. The `--mock` submission launches a real independent Node
Worker process but does not spend a model call.

Or let the lifecycle watchdog and supervisor own the long-lived roles:

```bash
V3_PLATFORM_MODE=console npm run v3:watchdog
npm run v3:submit -- --mock --content "v3 smoke test"
```

Run the preflight before a canary or promotion:

```bash
npm run v3:doctor
npm run v3:doctor -- --require-idle
npm run v3:health -- --require-watchdog
```

The doctor verifies Node, the versioned SQLite schema, state/token
permissions, loopback-only internal sockets, live platform configuration, and
durable Worker liveness. `v3:health` verifies fresh watchdog/supervisor/role
heartbeats, matching role PIDs, Reception/Workbench leases, the internal
listener, the authenticated Workbench→Reception link, and platform readiness.

Safe read-only credential/channel probes do not open a second live Gateway:

```bash
V3_PLATFORM_MODE=live npm run v3:doctor -- --probe-platforms
```

Actual provider shadow canaries use isolated state and console delivery:

```bash
npm run v3:canary -- --providers codex,claude
```

To prove that real provider processes keep the same PID through a Workbench
generation change, run the stronger drill:

```bash
npm run v3:canary -- --providers codex,claude --replace-workbench
```

Provider selectors can be pinned for a canary, for example
`--codex-model luna`.

For configured platform credentials:

```bash
V3_PLATFORM_MODE=live npm run v3:reception
npm run v3:workbench
```

The internal sockets bind to `127.0.0.1` by default. A random shared token is
stored with mode `0600` under the native Linux
`~/.local/state/mobile-codex-bridge/runtime-secrets/<state-hash>` tree and is
inherited by detached Workers. The token deliberately does not live below a
DrvFS-backed `/mnt/c` state root, where WSL commonly reports every mode as
`0777`.

## Patch drill

1. Start a job whose Worker is still producing updates.
2. Stop only `v3/workbench.mjs`, or let it exit with restart code 75 after a
   runtime-source patch.
3. Verify the Worker PID remains alive and its SQLite heartbeat/events advance.
4. The v3 supervisor starts the new Workbench generation on the same port.
5. The new generation acquires the lease, drains the stored Worker sequence,
   rebuilds the legacy run context, and reattaches to the same durable job ID.
6. Checkpoints, transcripts, final formatting, outbox writes, and completion
   state finish through the existing bridge core.

Reception does not need to restart for Workbench-only source changes.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `V3_STATE_ROOT` | Native XDG state path on WSL DrvFS; otherwise `<BRIDGE_STATE_ROOT>/_v3` | Durable coordination state |
| `V3_DB_PATH` | `<V3_STATE_ROOT>/coordination.sqlite` | Durable journal |
| `V3_RUNTIME_SECRET_ROOT` | `~/.local/state` namespaced path | Native-Linux private token storage |
| `V3_INTERNAL_TOKEN_FILE` | `<secret-root>/internal.token` | Explicit token-file override |
| `V3_RECEPTION_PORT` | `8793` | Reception internal WebSocket |
| `V3_WORKBENCH_PORT` | `8794` | Worker-to-Workbench WebSocket |
| `V3_PLATFORM_MODE` | `disabled` | `disabled`, `console`, or `live` |
| `V3_WORKER_MODE` | `agent` | Default Worker implementation |
| `V3_POLL_INTERVAL_MS` | `1000` | Missed-wake fallback |
| `V3_LEASE_TTL_MS` | `10000` | Generation fencing lease |
| `V3_HEALTH_HEARTBEAT_MS` | `1000` | Role health publication interval |
| `V3_HEALTH_STALE_MS` | `15000` | Maximum role-heartbeat age |
| `V3_ROLE_STARTUP_TIMEOUT_MS` | `120000` | Initial role-readiness deadline |
| `V3_ROLE_STOP_TIMEOUT_MS` | `10000` | Graceful role-stop deadline before Supervisor escalation |
| `V3_UNHEALTHY_GRACE_MS` | `30000` | Grace before replacing an unhealthy role |
| `V3_WATCHDOG_ROLE_RECOVERY_MS` | `max(startup timeout, 2 × unhealthy grace)` | Time the watchdog leaves fresh-heartbeat role recovery to the supervisor |
| `V3_WATCHDOG_POLL_MS` | `2000` | External supervisor-monitor interval |

On WSL, place `V3_DB_PATH` on the native Linux filesystem (for example under
`/home/your-user/.local/state/mobile-codex-bridge/`), not `/mnt/c`. When the
shared bridge state is on DrvFS, the default v3 root is moved automatically to
a checkout-specific directory below the native XDG state home. SQLite WAL
traffic and maintenance scans can stall on DrvFS long enough to expire role
health leases; the doctor rejects a DrvFS database in live mode.

The host launcher also accepts:

| Variable | Default | Purpose |
|---|---:|---|
| `BRIDGE_RUNTIME_VERSION` | `v2` | Select the v2 supervisor or watchdog-owned v3 runtime |
| `BRIDGE_RESTART_SCOPE` | `runtime` | Preserve detached v3 Workers; `full` explicitly terminates them |

## Promotion boundary

The lifecycle split and existing bridge feature surface are connected in this
branch, but `BRIDGE_RUNTIME_VERSION` remains `v2` until an explicit promotion.
Use this one-time sequence:

1. Run `npm test`, `npm run test:v3`, and
   `npm run v3:doctor -- --require-idle`.
2. Stop new v2 admission and drain every visible v2 Worker. The host launcher
   refuses a v2 → v3 cutover while it can see a legacy provider process.
3. Back up the existing channel/thread JSONL state and `_system` directory.
   SQLite is coordination state and does not replace those files.
4. Set `BRIDGE_RUNTIME_VERSION=v3`, `V3_PLATFORM_MODE=live`, and a new unique
   `V3_PROMOTION_REQUEST_ID`, then request one normal planned service restart.
   The replacement v2 Service schedules the detached promotion coordinator,
   which runs `start-bridge-host.sh`. A host operator may invoke that launcher
   directly instead. `V3_PROMOTION_NOTIFY_DISCORD_CHANNEL_ID` optionally sends
   a definitive success/failure message after the gate. Before stopping v2,
   the launcher probes Discord REST access and Slack authentication, channel
   membership, and Socket Mode URL issuance.
5. The launcher waits for the watchdog, both roles, both leases, internal
   links, Discord READY, and Slack Socket Mode handshake. If this first v2→v3
   gate fails with no v3 Worker active, it terminates the candidate and
   restores v2, requiring its service process to remain alive for five
   consecutive seconds. The admission gate guarantees that the candidate
   cannot start a new Worker before those readiness checks pass.
6. Verify Discord/Slack ingress and one PNG attachment after cutover. Codex and
   Claude can be shadow-tested beforehand with `npm run v3:canary`.

Normal v3 runtime replacement terminates Reception/Workbench/supervisor roles
through the watchdog but deliberately leaves `v3/worker.mjs` process groups
and their provider children alive. `BRIDGE_RESTART_SCOPE=full` is the explicit
destructive variant. Rollback to v2 is refused while detached v3 Workers are
active.

External Discord/Slack posting remains at-least-once: a host crash after the
platform accepts a message but before SQLite records the acknowledgement can
repeat that message. A production promotion should add platform-specific
idempotency keys or reconciliation before claiming exact-once delivery.

Host/WSL reboot still terminates all local processes. This design protects
Workers from Reception/Workbench code replacement, not from loss of the host.
