# Bridge v3 feature parity and ownership

The parity strategy is deliberately conservative: the proven bridge business
core remains the Workbench, while platform I/O and model execution are replaced
with durable adapters. This avoids reimplementing hundreds of behavior branches
and makes the existing test suite the parity oracle.

| Existing feature surface | v3 owner | Migration mechanism |
|---|---|---|
| Discord Gateway resume, heartbeat, filtering | Reception | `DiscordReceptionAdapter` keeps the live socket and journals raw events |
| Slack Socket Mode and immediate envelope ACK | Reception | `SlackReceptionAdapter` keeps the live socket and journals raw events |
| Discord/Slack REST, reactions, threads, history, files/images | Reception | allowlisted `platform.request` RPC through SQLite; WebSocket is wake-up only |
| Message catch-up, forwarded-message hydration, thread starter/scope | Workbench | existing `bridge-service.mjs` handlers call Reception platform proxies |
| `/help`, `/yolo`, `/god`, `/repo`, `/verbose`, `/quiet`, `/fast` | Workbench | existing command router |
| `/model`, `/effort`, `/usage`, `/status` and selection state | Workbench | existing command and thread-model modules/state |
| `/queue`, supersede, `/cancel`, retry, thread locks, priorities | Workbench | existing scheduler/state; cancellation is a durable request plus wake, and each legacy retry gets a distinct Worker execution generation |
| `/reserve`, `/gitpoll`, reboot/restart coordination | Workbench | existing timers and JSONL recovery; supervisor replaces only affected roles |
| TODO list/edit/completion, alerts, daily digests | Workbench | existing channel-common JSONL state and alert scheduler |
| Pending asks and answer continuations | Workbench | existing pending-ask state and continuation routing |
| Daily reports, maintenance, GitHub issue work, git sync | Workbench | existing maintenance/report/GitHub modules |
| State migration, compaction, secret masking/redaction | Workbench | existing state root and startup sequence |
| Discord/Slack outboxes, delivery ordering, completion markers, dedupe | Workbench + Reception | legacy outboxes call durable platform RPC; Reception performs external send |
| Inbound crash recovery and duplicate suppression | Workbench | message locks distinguish `processing` from `done`; a replacement generation reclaims only the unacknowledged SQLite row |
| Prompt context, channel preferences, TODO context, repo/state permissions | Workbench | existing prompt builder and job state-root logic |
| Codex/Claude/Gemini/other provider selection and fallback | Worker | existing `runAgentJob` runs inside the detached per-job process |
| Provider progress and Worker start/final/failure | Worker → Workbench | raw updates and terminal result are journaled with per-job sequence |
| Provider error classification/backoff | Worker → Workbench | quota reset, input-limit, timeout, signal, abort, and no-progress metadata survive serialization |
| Checkpoint, handoff, transcript, final formatting | Workbench | existing job pipeline consumes the reattached Worker stream/result |
| Worker heartbeat, PID, immutable spec, terminal result | SQLite | `jobs` table plus durable bus messages |
| Workbench generation fencing | SQLite | monotonic `role_leases` epoch |
| Startup/cutover admission | Supervisor + Workbench | inbound rows remain durable and unacknowledged until Reception platform readiness opens the gate |
| Workbench patch while jobs run | Supervisor + Worker | Workbench exits; detached Workers remain; new Workbench reuses the same job ID |
| Reception-only patch | Supervisor | path-to-role mapping restarts Reception without terminating Workers |
| Supervisor patch/crash/stall | External watchdog | planned code reloads and failed/stale Supervisor generations replace the fenced Reception/Workbench process group; detached Worker process groups survive |
| Promotion failure | Host launcher | full readiness gate fails closed and restores v2 when no v3 Worker has become active |

## Persistence contract

SQLite is coordination state, not a replacement for existing user state.

- Existing authoritative state remains under `BRIDGE_STATE_ROOT`: channel
  memory, TODOs, alerts, reservations, git polls, jobs JSONL, checkpoint,
  handoff, transcript, outboxes, and system events.
- `<BRIDGE_STATE_ROOT>/_v3/coordination.sqlite` stores transport messages,
  sequence/ack state, leases, immutable Worker specs, Worker PID/heartbeat, and
  terminal Worker results.
- The internal bearer token is not stored on `/mnt/c`; its default location is
  a state-root-hashed directory under native Linux `~/.local/state`, with a
  verified regular-file owner and `0600` mode.
- The coordination database carries a checked `PRAGMA user_version`; startup
  refuses a schema newer than the runtime understands, and `v3:doctor` reports
  the expected/current version.
- A bus message is acknowledged only after its next durable hop or handler
  succeeds. WebSocket loss therefore affects latency, not correctness.
- Worker terminal state/result is committed before its terminal wake event.
  If that event cannot be written, the next Workbench settles from the jobs
  table; if it is written, every stored update is drained before settlement.
- The first generation's pre-job runtime-source digest travels in the immutable
  Worker spec. A replacement Workbench therefore still detects source changed
  while it was offline and requests the correct role reload.
- Acknowledged transport rows older
  than seven days are pruned by Reception on startup and every six hours.

## Validation gates

- The complete existing `test/*.test.mjs` suite must remain green.
- v3 tests cover journal ordering/dedupe, lease fencing, Reception RPC,
  Reception restart ordering, durable cancel/supersede, detached Worker
  survival, bounded role-stop escalation, supervisor replacement, PNG
  attachment RPC, and full Workbench reattachment to the same PID.
- Health tests kill the supervisor, verify orphan Reception/Workbench cleanup,
  keep the external watchdog PID alive, and require the replacement generation
  to pass PID/heartbeat/lease/link checks.
- The host rollback test starts an isolated v2 process pair, forces the v3
  health gate to fail, and requires a new v2 supervisor/service pair to remain
  running after candidate cleanup.
- The supervised-admission test persists an inbound request before readiness,
  proves that no Worker starts, then opens admission and completes the same
  durable request.
- The provider canary supports replacing Workbench while real Codex and Claude
  calls are held open, and verifies the detached Worker PID is unchanged.
- Integration tests bind port `0` and pass the OS-selected port to replacement
  generations, eliminating the previous find-free-port/rebind race.
- `V3_PLATFORM_MODE=console` exercises Reception → full Workbench → detached
  mock Worker → full legacy completion pipeline without external credentials.
