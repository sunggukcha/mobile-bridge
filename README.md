# Mobile Codex Bridge

Mobile Codex Bridge is a self-hosted gateway from Discord—and optionally Slack—to local coding-agent command-line tools. Each conversation thread gets durable state, a serialized job queue, progress updates, attachments, TODOs, reminders, and optional repository access.

The current v2 runtime is the stable entry point. The process-separated v3 runtime is available for testing but is not the default.

> [!CAUTION]
> This service can launch coding agents that read files, run commands, edit repositories, and use credentials available to the host. Restrict both channel IDs and user IDs, begin with `workspace-write`, and run it on a dedicated account or machine. Do not expose the bot to an untrusted server.

This is an independent community project. It is not affiliated with or endorsed by OpenAI, Anthropic, Google, Discord, or Slack. Product names and trademarks belong to their respective owners.

## What it does

- Connects Discord Gateway messages to local Codex, Claude Code, Gemini CLI, or compatible Antigravity workers.
- Optionally maps one Slack Socket Mode channel onto the same logical channel state.
- Keeps each thread serialized while allowing configurable cross-thread concurrency.
- Streams concise progress, preserves job checkpoints, and recovers queued work after a restart.
- Stores per-channel TODOs, alerts, shared memory, artifacts, and a Python virtual environment.
- Supports per-thread model, effort, repository, queueing, and output-style controls.
- Can fall back between configured providers when a provider is unavailable or out of quota.
- Includes optional reports, maintenance, Git polling, and a durable v3 lifecycle prototype.

## Requirements

- Linux or WSL2. The supervised launcher depends on `/proc`, `setsid`, `pgrep`, and Unix process groups. Native Windows and macOS launchers are not supported; the included Windows wrapper starts the service inside WSL.
- Node.js `>=22.13 <23` or `>=23.4` (including Node 24 and later).
- npm plus common Unix tools from `bash`, `coreutils`, `procps`, and `util-linux`.
- A Discord bot application and at least one locally installed, authenticated provider CLI.

Provider accounts, API access, model availability, and usage charges are the operator's responsibility. Model identifiers in `.env.example` are examples and may need updating as provider catalogs change.

## Quick start

1. Install dependencies and create a local configuration:

   ```bash
   npm ci
   cp .env.example .env
   ```

2. Set at least these values in `.env`:

   ```dotenv
   DISCORD_BOT_TOKEN=replace-with-your-bot-token
   DISCORD_ALLOWED_CHANNEL_IDS=replace-with-a-channel-id
   DISCORD_ALLOWED_USER_IDS=replace-with-your-user-id
   DEFAULT_WORKER_CHAIN=codex
   ```

   Use comma-separated IDs for multiple channels or users. `DISCORD_ALLOW_ALL_USERS=true` deliberately removes the user allowlist inside the configured channels and should be reserved for fully trusted servers.

3. Install a supported provider CLI using its official instructions, then authenticate it as the bridge runtime user. For Codex:

   ```bash
   npm run auth:codex
   ```

   The helper invokes the configured `CODEX_BIN` with the isolated `BRIDGE_CODEX_HOME`. Equivalent helpers are available as `auth:claude`, `auth:claude:status`, and `auth:gemini`. `npm run worker:versions` reports all configured CLIs; it exits nonzero if an optional provider is absent.

4. Validate the checkout:

   ```bash
   npm test
   ```

5. Run in the foreground while configuring the bot:

   ```bash
   npm start
   ```

   For supervised Linux/WSL operation:

   ```bash
   bash start-bridge-host.sh
   ```

   On Windows, `start-bridge-host.cmd` or `start-bridge-host.ps1` delegates to WSL and derives the checkout path automatically.

### Discord application setup

In the Discord Developer Portal:

1. Create a bot and enable the privileged **Message Content Intent**.
2. Invite it only to the intended server.
3. Grant the minimum permissions needed by your deployment: View Channels, Read Message History, Send Messages, Send Messages in Threads, Create Public Threads, Add Reactions, and Attach Files.
4. Enable Discord Developer Mode, copy the allowed channel and user IDs, and put them in `.env`.

The service fails closed at startup when Discord is enabled without a token, channel allowlist, or user allowlist (unless the explicit allow-all switch is enabled).

## Safe configuration

The checked-in template favors a constrained first run:

| Setting | Template default | Meaning |
| --- | --- | --- |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Keeps normal Codex jobs inside the configured workspace sandbox. |
| `CODEX_MAINTENANCE_SANDBOX_MODE` | `workspace-write` | Keeps maintenance constrained unless explicitly expanded. |
| `CLAUDE_PERMISSION_MODE` | `default` | Does not bypass Claude Code permission checks. |
| `GEMINI_APPROVAL_MODE` | `default` | Does not auto-approve Gemini operations. |
| `ANTIGRAVITY_APPROVAL_MODE` | `default` | Does not skip Antigravity permissions. |
| `CODEX_MAX_CONCURRENT_JOBS` | `1` | Limits cross-thread resource use during initial setup. `0` means unlimited. |
| `DAILY_MAINTENANCE_MODE` | `off` | Disables unattended repository maintenance. |
| `DAILY_REPORTS_ENABLED` | `false` | Disables scheduled report jobs. |
| `BRIDGE_PREFER_HOST_GH_CREDENTIAL` | `false` | Does not expose the host `gh` login to worker homes. |
| `CHANNEL_PYTHON_BOOTSTRAP_PIP` | `false` | Does not download and execute `get-pip.py` automatically. |

`/yolo`, `danger-full-access`, permission-bypass modes, host GitHub credentials, channel secret forwarding, reports, and maintenance all expand authority. Review the relevant code and deployment isolation before enabling them.

### Paths and state

By default, the checkout is the bridge repository and its parent is `PROJECT_ROOT`. Runtime data is stored outside the checkout at:

```text
{PROJECT_ROOT}/.bridge_state/
├── <channel-id>_common/       shared TODOs, alerts, memory, venv, artifacts
├── <channel-id>/<thread-id>/  thread events, jobs, checkpoints, controls
├── codex-home/                isolated Codex state
├── claude-home/               isolated Claude state
├── gemini-home/               isolated Gemini state
├── repositories/              repositories made available to jobs
└── workspace/                 default worker working directory
```

Set absolute paths with `PROJECT_ROOT`, `BRIDGE_REPO_ROOT`, `BRIDGE_STATE_ROOT`, or `CODEX_WORKING_DIR` when the defaults do not fit. The `.env` reader is intentionally simple: it removes matching quotes but does not perform shell expansion, so do not use `~`, `$HOME`, or command substitutions in path values.

Live `.env`, `.bridge_state`, logs, provider homes, channel exports, and credentials are ignored and must never be committed.

Provider subprocesses receive a deliberately reduced environment rather than the bridge process's complete `process.env`. Basic OS values and standard provider API credentials are retained. Bridge platform tokens, internal service tokens, host Git/SSH credentials, report credentials, and unrelated host secrets are excluded. Use `WORKER_ENV_ALLOWLIST` for an additional main-process variable, or `CHANNEL_ENV_ALLOWLIST` plus a channel-local `channel.env` for an explicitly scoped secret.

### Repository access

Workers start in `{BRIDGE_STATE_ROOT}/workspace`. Leave `CODEX_ALLOWED_ROOTS` empty unless jobs need explicitly named additional roots. The bridge repository is not added as a broad allowed root; a user must explicitly select repository access.

To let isolated worker homes use an existing GitHub CLI login, set `BRIDGE_PREFER_HOST_GH_CREDENTIAL=true` and review `BRIDGE_GH_CONFIG_DIR`, `BRIDGE_GIT_CONFIG_GLOBAL`, and `BRIDGE_GH_ASKPASS`. This forwards access to a privileged host credential and is intentionally opt-in.

### Channel-scoped Python

When enabled and present, workers prepend `{BRIDGE_STATE_ROOT}/<channel-id>_common/.venv/bin` to `PATH`, so packages are shared across threads in that channel. `CHANNEL_PYTHON_VENV_AUTO_CREATE=true` creates the environment with an available Python interpreter; Python is otherwise optional. If Python lacks `ensurepip`, install pip through the operating system; only enable `CHANNEL_PYTHON_BOOTSTRAP_PIP` after reviewing the configured download URL and trust model.

### Catch-up boundary

`BRIDGE_IGNORE_BEFORE` is an optional ISO-8601 cutoff for platform catch-up. If it is empty, each fresh host start uses the current UTC time and does not invent messages from before the process began. Set and persist a deployment timestamp only when deliberate catch-up across restarts is required.

## Provider routing

`DEFAULT_WORKER_CHAIN` is a comma-separated fallback chain. Configure only CLIs that are installed and authenticated:

```dotenv
DEFAULT_WORKER_CHAIN=codex
# or
DEFAULT_WORKER_CHAIN=codex,claude,gemini
```

Provider binaries and isolated homes are configured with `CODEX_BIN`, `CLAUDE_BIN`, `GEMINI_BIN`, `ANTIGRAVITY_BIN`, and their corresponding home variables. The runtime classifies missing CLI, authentication, capacity, billing, and quota failures before trying the next configured worker.

Direct quota probes for Claude and Gemini are best-effort integrations with provider-specific endpoints. They are not required for job execution. OAuth client values are never embedded; operators who choose direct refresh must supply `CLAUDE_OAUTH_CLIENT_ID`, `GEMINI_OAUTH_CLIENT_ID`, and `GEMINI_OAUTH_CLIENT_SECRET` themselves and must be authorized to use them.

## Bridge commands

Send `/help` in Discord for the authoritative command catalog. Slack uses `!` because Slack consumes slash commands before Socket Mode can deliver normal messages.

Common controls include:

| Discord | Slack | Purpose |
| --- | --- | --- |
| `/model` | `!model` | List or select a model and fallback chain. |
| `/effort` | `!effort` | Select reasoning effort. |
| `/queue <task>` | `!queue <task>` | Preserve FIFO ordering instead of replacing older thread work. |
| `/cancel` | `!cancel` | Stop the current thread's worker and clear queued work. |
| `/status` | `!status` | Show persistent controls for the thread. |
| `/todo` | `!todo` | List or update channel-scoped TODOs. |
| `/reserve` | `!reserve` | Schedule a future bridge command. |
| `/gitpoll` | `!gitpoll` | Wait for a remote update, pull it, and queue continuation work. |
| `/repo` | `!repo` | Select repository access for the thread. |
| `/yolo` | `!yolo` | Enable persistent direct bridge-repository write access. |

New follow-ups replace older queued or running work in the same thread by default. Prefix a task with `/queue` to preserve earlier work. Use `/cancel` or `/stop` to terminate the thread's active work.

## Slack Socket Mode

Slack is optional and shares a configured Discord logical channel's state. Set:

```dotenv
SLACK_ENABLED=true
SLACK_APP_TOKEN=replace-with-app-level-token
SLACK_BOT_TOKEN=replace-with-bot-token
SLACK_TEAM_ID=replace-me
SLACK_CHANNEL_ID=replace-me
SLACK_LOGICAL_CHANNEL_ID=replace-with-a-discord-channel-id
SLACK_ALLOWED_USER_IDS=replace-with-a-slack-user-id
```

The app-level token needs `connections:write`. A public-channel deployment typically needs `chat:write`, `reactions:write`, `users:read`, `channels:read`, `channels:history`, and the `message.channels` event. Add the corresponding private-channel scopes and events only when needed. File-aware deployments also need `files:read` and `files:write`.

Slack also fails closed without an allowed user unless `SLACK_ALLOW_ALL_USERS=true` is explicitly set.

## Runtime architecture

The stable v2 service owns platform connections, scheduling, queues, and workers in one runtime:

```text
Discord Gateway / Slack Socket Mode
                 │
                 ▼
          bridge-service.mjs
                 │
        thread queue + state
                 │
                 ▼
     local coding-agent CLI process
```

The experimental v3 prototype separates stable reception, replaceable orchestration, and detached workers using a SQLite journal and WebSocket wake-ups. See [v3/README.md](v3/README.md) and [v3/FEATURE_PARITY.md](v3/FEATURE_PARITY.md).

On WSL, v3 coordination SQLite must live on the native Linux filesystem, not under `/mnt/c`; DrvFS latency can stall WAL operations and expire health leases. Use an absolute path such as `/home/your-user/.local/state/mobile-codex-bridge/coordination.sqlite` for `V3_DB_PATH`. Run `npm run v3:doctor` before a canary or cutover. v3 remains opt-in with `BRIDGE_RUNTIME_VERSION=v2` in the template.

## Known limitations

- The supervised host runtime currently targets Linux and WSL2.
- Some user-facing strings and maintenance/report schedules are Korean/KST-specific. Nightly maintenance runs at 03:00 KST, and daily reports use `DAILY_REPORTS_HOUR_KST`; there is no general deployment-time-zone setting yet.
- Provider model catalogs, CLI flags, authentication layouts, and quota endpoints can change independently of this project.
- External Discord and Slack delivery is at-least-once across a host crash; a message can be repeated if the platform accepted it before the local acknowledgement was persisted.
- v3 protects detached workers during bridge process replacement, not during host shutdown or reboot.

## Development and release checks

```bash
npm run check          # syntax-check every source module
npm test               # full regression suite
npm run test:v3        # v3-focused suite
npm run release:check  # tests plus npm package dry run
```

Before publishing a release, run these checks on the supported Node releases. The package remains marked `private` because this repository is a self-hosted application rather than an npm library. A Git clone or GitHub-generated source archive—including `package-lock.json`—is the supported source artifact; `npm pack --dry-run` is used only to detect accidental package-content regressions and is not a distribution format.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [RELEASING.md](RELEASING.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before contributing or redistributing a bundle.

## License

MIT. See [LICENSE](LICENSE).
