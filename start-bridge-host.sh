#!/usr/bin/env bash
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
node_bin="${BRIDGE_NODE_BIN:-}"
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  node_bin="$(command -v node || true)"
fi
[ -n "$node_bin" ] && [ -x "$node_bin" ] || {
  echo "Node.js was not found. Install a supported Node.js release (22.13+ or 23.4+) or set BRIDGE_NODE_BIN." >&2
  exit 127
}
if ! "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13) ? 0 : 1)'; then
  echo "Unsupported Node.js version: $($node_bin --version). Use Node.js 22.13+ or 23.4+." >&2
  exit 2
fi
missing_commands=""
for required_command in awk date pgrep ps readlink setsid sort tr xargs; do
  command -v "$required_command" >/dev/null 2>&1 \
    || missing_commands="${missing_commands} ${required_command}"
done
if [ -n "$missing_commands" ]; then
  echo "Missing required host commands:${missing_commands}. Install procps, util-linux, and standard POSIX utilities." >&2
  exit 127
fi
node_dir="$(dirname -- "$node_bin")"
bridge_path="${node_dir}:$PATH"
gh_bin="$(command -v gh || true)"
if [ -n "$gh_bin" ]; then
  bridge_path="$(dirname -- "$gh_bin"):${bridge_path}"
fi
stop_grace_seconds="${BRIDGE_STOP_GRACE_SECONDS:-15}"
case "$stop_grace_seconds" in
  ''|*[!0-9]*) stop_grace_seconds=15 ;;
esac

dotenv_value() {
  local key="$1"
  [ -f "$repo/.env" ] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$repo/.env" \
    | tr -d "\"'\r"
}

ignore_before="${BRIDGE_IGNORE_BEFORE:-$(dotenv_value BRIDGE_IGNORE_BEFORE)}"
ignore_before="${ignore_before:-$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")}"

runtime_version="${BRIDGE_RUNTIME_VERSION:-$(dotenv_value BRIDGE_RUNTIME_VERSION)}"
runtime_version="${runtime_version:-v2}"
case "$runtime_version" in
  v2|v3) ;;
  *)
    echo "BRIDGE_RUNTIME_VERSION must be v2 or v3 (received: $runtime_version)" >&2
    exit 2
    ;;
esac

# runtime: replace the selected bridge runtime while preserving detached v3
# Workers. full: explicitly terminate every Worker/provider process too.
restart_scope="${BRIDGE_RESTART_SCOPE:-runtime}"
case "$restart_scope" in
  runtime|full) ;;
  *)
    echo "BRIDGE_RESTART_SCOPE must be runtime or full (received: $restart_scope)" >&2
    exit 2
    ;;
esac

health_gate_ms="${V3_HEALTH_GATE_TIMEOUT_MS:-120000}"
case "$health_gate_ms" in
  ''|*[!0-9]*) health_gate_ms=120000 ;;
esac

platform_mode=""
if [ "$runtime_version" = "v3" ]; then
  platform_mode="${V3_PLATFORM_MODE:-$(dotenv_value V3_PLATFORM_MODE)}"
  platform_mode="${platform_mode:-live}"
fi

cd "$repo"
state_root="${BRIDGE_STATE_ROOT:-$(dotenv_value BRIDGE_STATE_ROOT)}"
project_root="${PROJECT_ROOT:-$(dotenv_value PROJECT_ROOT)}"
if [ -z "$state_root" ] && [ -n "$project_root" ]; then
  state_root="${project_root%/}/.bridge_state"
fi
state_root="${state_root:-$(cd "$repo/.." && pwd)/.bridge_state}"
if [ -d "$repo/.state" ]; then
  "$node_bin" scripts/migrate-state-layout.mjs "$repo/.state" "$state_root" --archive-source --once
fi
mkdir -p "$state_root/logs" "$state_root/_system"

collect_descendants() {
  local frontier="$*"
  local descendants=""
  while [ -n "${frontier// /}" ]; do
    local children=""
    for pid in $frontier; do
      children="$children $(pgrep -P "$pid" 2>/dev/null || true)"
    done
    children="$(xargs <<< "$children" 2>/dev/null || true)"
    [ -n "$children" ] || break
    descendants="$descendants $children"
    frontier="$children"
  done
  xargs <<< "$descendants" 2>/dev/null || true
}

promotion_control_pids() {
  local pid="${1:-$$}"
  local parent=""
  local command=""
  printf '%s\n' "$pid"
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | xargs 2>/dev/null || true)"
    [ -n "$parent" ] && [ "$parent" != "$pid" ] || break
    command="$(tr '\0' ' ' < "/proc/$parent/cmdline" 2>/dev/null || true)"
    case "$command" in
      *"$repo/scripts/v3-promotion-launcher.mjs"*) printf '%s\n' "$parent" ;;
      *) break ;;
    esac
    pid="$parent"
  done
}

active_pids_excluding() {
  local candidates="$1"
  local excluded="$2"
  local pid=""
  for pid in $candidates; do
    kill -0 "$pid" 2>/dev/null || continue
    case " $excluded " in
      *" $pid "*) ;;
      *) printf '%s\n' "$pid" ;;
    esac
  done
}

bridge_worker_pids() {
  local bridge_process_snapshot
  # Snapshot before awk starts. Inspecting a live ps|awk pipeline lets awk see
  # its own command text, including the provider names below, and falsely
  # classify itself as an active Worker.
  bridge_process_snapshot="$(ps -eo pid=,cmd=)"
  awk -v repo="$repo" -v tools="$state_root/worker-tools" -v self="$$" '
    $1 == self { next }
    index($0, "codex") && index($0, " -C " repo) && index($0, " exec --json") { print $1; next }
    index($0, tools) && ($0 ~ /(claude|gemini|antigravity|\/agy([[:space:]]|$))/) { print $1; next }
  ' <<< "$bridge_process_snapshot"
}

kill_pid_groups() {
  local signal="$1"
  shift || true
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill "-$signal" "-$pid" 2>/dev/null || kill "-$signal" "$pid" 2>/dev/null || true
  done
}

find_v2_supervisor_pids() {
  find_repo_role_pids 'bridge-supervisor.mjs'
}

# Match both absolute argv (host launcher) and relative argv (npm/direct runs),
# but only when /proc reports this checkout as the process cwd. This prevents a
# restart from touching another bridge checkout on the same host.
find_repo_role_pids() {
  local role="$1"
  local pid cwd arg
  # `pgrep` is only a cheap candidate index. Every result is still scoped by
  # its physical cwd and an exact argv element below, so a similarly named
  # process (or another checkout) cannot be signalled. Avoiding a full /proc
  # walk for every role makes restart and rollback reliable on WSL/DrvFS.
  for pid in $(pgrep -f -- "$role" 2>/dev/null || true); do
    [ -r "/proc/$pid/cmdline" ] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$cwd" = "$repo" ] || continue
    while IFS= read -r -d '' arg; do
      case "$arg" in
        "$role"|"./$role"|"$repo/$role")
          printf '%s\n' "$pid"
          break
          ;;
      esac
    done < "/proc/$pid/cmdline"
  done
}

v2_service_pids="$(find_repo_role_pids 'bridge-service.mjs')"
v2_supervisor_pids="$(find_v2_supervisor_pids)"
v3_reception_pids="$(find_repo_role_pids 'v3/reception.mjs')"
v3_workbench_pids="$(find_repo_role_pids 'v3/workbench.mjs')"
v3_supervisor_pids="$(find_repo_role_pids 'v3/supervisor.mjs')"
v3_watchdog_pids="$(find_repo_role_pids 'v3/watchdog.mjs')"
v3_worker_pids="$(find_repo_role_pids 'v3/worker.mjs')"
v2_descendant_pids="$(collect_descendants $v2_service_pids)"
launcher_control_pids="$(promotion_control_pids "$$" | xargs 2>/dev/null || true)"
legacy_v2_descendant_pids="$(
  active_pids_excluding "$v2_descendant_pids" "$launcher_control_pids" \
    | xargs 2>/dev/null || true
)"
v3_worker_descendant_pids="$(collect_descendants $v3_worker_pids)"
cutover_from_v2="false"
if [ "$runtime_version" = "v3" ] \
  && [ -n "$v2_service_pids$v2_supervisor_pids" ]; then
  cutover_from_v2="true"
fi

# A v2 process cannot be adopted by v3. Refuse the first cutover while a model
# process is visibly active unless the operator explicitly requested a full
# stop. The same rule protects rollback from abandoning live v3 Workers.
if [ "$restart_scope" != "full" ] && [ "$runtime_version" = "v3" ] \
  && [ -n "$v2_service_pids$v2_supervisor_pids" ] \
  && [ -n "$legacy_v2_descendant_pids$(bridge_worker_pids)" ]; then
  echo "Refusing v2 -> v3 cutover while legacy Workers are active; drain them or use BRIDGE_RESTART_SCOPE=full." >&2
  exit 3
fi
if [ "$restart_scope" != "full" ] && [ "$runtime_version" = "v2" ] \
  && [ -n "$v3_worker_pids" ]; then
  echo "Refusing v3 -> v2 rollback while detached v3 Workers are active; drain them or use BRIDGE_RESTART_SCOPE=full." >&2
  exit 3
fi

if [ "$runtime_version" = "v3" ]; then
  doctor_args=()
  if [ "$cutover_from_v2" = "true" ]; then
    doctor_args+=(--require-idle)
  fi
  if [ "$platform_mode" = "live" ]; then
    # Prove both platform credentials and channel/workspace access while the
    # current runtime is still serving users. A transient or revoked token
    # therefore refuses the replacement instead of creating an outage.
    doctor_args+=(--probe-platforms)
  fi
  if ! PATH="$bridge_path" \
    BRIDGE_STATE_ROOT="$state_root" \
    V3_PLATFORM_MODE="$platform_mode" \
    "$node_bin" "$repo/v3/doctor.mjs" "${doctor_args[@]}"; then
    echo "Refusing v3 start because the preflight doctor failed; the current runtime was left running." >&2
    exit 4
  fi
fi

# Stop the external watchdog first so it cannot replace the supervisor while
# the host launcher is deliberately cycling the v3 runtime.
if [ -n "$v3_watchdog_pids" ]; then
  kill -TERM $v3_watchdog_pids 2>/dev/null || true
  watchdog_deadline=$((SECONDS + stop_grace_seconds))
  while [ "$SECONDS" -lt "$watchdog_deadline" ] \
    && [ -n "$(find_repo_role_pids 'v3/watchdog.mjs')" ]; do
    sleep 1
  done
fi

if [ -n "$v2_service_pids" ]; then
  kill -TERM $v2_service_pids 2>/dev/null || true
fi
if [ -n "$v3_workbench_pids" ]; then
  kill -TERM $v3_workbench_pids 2>/dev/null || true
fi
if [ -n "$v3_reception_pids" ]; then
  kill -TERM $v3_reception_pids 2>/dev/null || true
fi
if [ -n "$v2_supervisor_pids" ]; then
  kill -TERM $v2_supervisor_pids 2>/dev/null || true
fi
if [ -n "$v3_supervisor_pids" ]; then
  kill -TERM $v3_supervisor_pids 2>/dev/null || true
fi

# v3 Workers are detached process-group leaders. A normal runtime restart
# deliberately never signals them or their Codex/Claude/Gemini descendants.
if [ "$restart_scope" = "full" ] && [ -n "$v3_worker_pids" ]; then
  kill_pid_groups TERM $v3_worker_pids
fi

deadline=$((SECONDS + stop_grace_seconds))
while [ "$SECONDS" -lt "$deadline" ]; do
  remaining_v2_service_pids="$(find_repo_role_pids 'bridge-service.mjs')"
  remaining_v2_supervisor_pids="$(find_v2_supervisor_pids)"
  remaining_v3_reception_pids="$(find_repo_role_pids 'v3/reception.mjs')"
  remaining_v3_workbench_pids="$(find_repo_role_pids 'v3/workbench.mjs')"
  remaining_v3_supervisor_pids="$(find_repo_role_pids 'v3/supervisor.mjs')"
  remaining_v3_watchdog_pids="$(find_repo_role_pids 'v3/watchdog.mjs')"
  remaining_roles="$remaining_v2_service_pids$remaining_v2_supervisor_pids$remaining_v3_reception_pids$remaining_v3_workbench_pids$remaining_v3_supervisor_pids$remaining_v3_watchdog_pids"
  [ -n "$remaining_roles" ] || break
  sleep 1
done

remaining_v2_service_pids="$(find_repo_role_pids 'bridge-service.mjs')"
remaining_v2_supervisor_pids="$(find_v2_supervisor_pids)"
remaining_v3_reception_pids="$(find_repo_role_pids 'v3/reception.mjs')"
remaining_v3_workbench_pids="$(find_repo_role_pids 'v3/workbench.mjs')"
remaining_v3_supervisor_pids="$(find_repo_role_pids 'v3/supervisor.mjs')"
remaining_v3_watchdog_pids="$(find_repo_role_pids 'v3/watchdog.mjs')"

for pid in $remaining_v2_service_pids $remaining_v2_supervisor_pids \
  $remaining_v3_reception_pids $remaining_v3_workbench_pids \
  $remaining_v3_supervisor_pids $remaining_v3_watchdog_pids; do
  kill -KILL "$pid" 2>/dev/null || true
done

if [ "$runtime_version" = "v2" ] || [ "$restart_scope" = "full" ]; then
  remaining_role_descendants="$(collect_descendants \
    $remaining_v2_service_pids \
    $remaining_v2_supervisor_pids \
    $remaining_v3_reception_pids \
    $remaining_v3_workbench_pids \
    $remaining_v3_supervisor_pids \
    $remaining_v3_watchdog_pids)"
  remaining_worker_pids="$(bridge_worker_pids)"
  remaining_v3_worker_pids="$(find_repo_role_pids 'v3/worker.mjs')"
  kill_pid_groups KILL $v2_descendant_pids $v3_worker_descendant_pids \
    $remaining_role_descendants $remaining_worker_pids $remaining_v3_worker_pids
fi

launch_v2_runtime() {
  rm -f "$state_root/_system/supervisor.lock"
  PATH="$bridge_path" \
    BRIDGE_IGNORE_BEFORE="$ignore_before" \
    BRIDGE_RUNTIME_VERSION="v2" \
    BRIDGE_STATE_ROOT="$state_root" \
    setsid -f "$node_bin" "$repo/bridge-supervisor.mjs" \
      >> "$state_root/logs/supervisor.log" 2>&1 < /dev/null
}

launch_v3_runtime() {
  rm -f \
    "$state_root/_system/v3-watchdog.lock" \
    "$state_root/_system/v3-supervisor.lock"
  PATH="$bridge_path" \
    BRIDGE_IGNORE_BEFORE="$ignore_before" \
    BRIDGE_RUNTIME_VERSION="v3" \
    BRIDGE_STATE_ROOT="$state_root" \
    V3_PLATFORM_MODE="$platform_mode" \
    setsid -f "$node_bin" "$repo/v3/watchdog.mjs" \
      >> "$state_root/logs/v3-supervisor.log" 2>&1 < /dev/null
}

wait_for_v2_runtime() {
  local restore_deadline stable_seconds
  restore_deadline=$((SECONDS + 30))
  stable_seconds=0
  while [ "$SECONDS" -lt "$restore_deadline" ]; do
    if [ -n "$(find_v2_supervisor_pids)" ] \
      && [ -n "$(find_repo_role_pids 'bridge-service.mjs')" ]; then
      stable_seconds=$((stable_seconds + 1))
      [ "$stable_seconds" -ge 5 ] && return 0
    else
      stable_seconds=0
    fi
    sleep 1
  done
  return 1
}

stop_v3_candidate() {
  local watchdogs supervisors receptions workbenches stop_deadline remaining
  watchdogs="$(find_repo_role_pids 'v3/watchdog.mjs')"
  [ -z "$watchdogs" ] || kill -TERM $watchdogs 2>/dev/null || true
  stop_deadline=$((SECONDS + stop_grace_seconds))
  while [ "$SECONDS" -lt "$stop_deadline" ]; do
    remaining="$(
      find_repo_role_pids 'v3/watchdog.mjs'
      find_repo_role_pids 'v3/supervisor.mjs'
      find_repo_role_pids 'v3/reception.mjs'
      find_repo_role_pids 'v3/workbench.mjs'
    )"
    [ -z "$remaining" ] && return 0
    sleep 1
  done
  supervisors="$(find_repo_role_pids 'v3/supervisor.mjs')"
  receptions="$(find_repo_role_pids 'v3/reception.mjs')"
  workbenches="$(find_repo_role_pids 'v3/workbench.mjs')"
  watchdogs="$(find_repo_role_pids 'v3/watchdog.mjs')"
  for pid in $watchdogs $supervisors $receptions $workbenches; do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

if [ "$runtime_version" = "v3" ]; then
  launch_v3_runtime
  if ! PATH="$bridge_path" \
    BRIDGE_STATE_ROOT="$state_root" \
    V3_PLATFORM_MODE="$platform_mode" \
    "$node_bin" "$repo/v3/health.mjs" \
      --wait-ms "$health_gate_ms" --require-watchdog; then
    echo "Bridge v3 failed its startup health gate." >&2
    if [ "$cutover_from_v2" = "true" ]; then
      active_v3_workers="$(find_repo_role_pids 'v3/worker.mjs')"
      if [ -n "$active_v3_workers" ]; then
        echo "Automatic v2 rollback is blocked because a detached v3 Worker became active; the v3 watchdog remains responsible for recovery." >&2
        exit 5
      fi
      stop_v3_candidate
      launch_v2_runtime
      if wait_for_v2_runtime; then
        echo "Bridge v3 promotion failed; v2 was automatically restored and its service process is running." >&2
      else
        echo "Bridge v3 promotion failed and the automatic v2 restore did not reach a running service process; inspect $state_root/logs/supervisor.log." >&2
        exit 6
      fi
    else
      echo "The external v3 watchdog remains running and will continue recovery attempts." >&2
    fi
    exit 4
  fi
else
  launch_v2_runtime
fi
