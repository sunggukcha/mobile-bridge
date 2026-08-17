#!/usr/bin/env node
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isControlOnlyCommandRequest,
  isFastCommandRequest,
  isGodCommandRequest,
  isHelpCommandRequest,
  isModelCommandRequest,
  isQuietCommandRequest,
  isRepoCommandRequest,
  isReserveCommandRequest,
  isUsageCommandRequest,
  isStatusCommandRequest,
  parseStyleCommand,
  isQueueCommandRequest,
  isCancelCommandRequest,
  isRebootRequest,
  isTodoListRequest,
  isVerboseCommandRequest,
  isUnfastCommandRequest,
  isYoloCommandRequest,
  isWebSearchRequest,
  parseGitPollCommand,
  modelSelectionSequenceFromContent,
  effortCommandSelectionFromContent,
  effortCommandSelectionSequenceFromContent,
  effortSelectionFromContent,
  effortSelectionSequenceFromContent,
  parseTodoCommand,
  parseJobStartCommands,
  parseModelEffortCommand,
  rebootReasonFromMessage,
  repoAccessDirectiveFromContent,
  repoRootDirectiveFromContent,
  stateAccessDirectiveFromContent,
  verboseDirectiveFromContent,
  yoloAccessDirectiveFromContent,
  isEffortCommandRequest,
  formatThreadStatusSummary,
  formatBridgeHelpSummary,
  modelCommandSelectionSequenceFromContent,
  unknownBridgeCommandFromContent,
  UNKNOWN_COMMAND_MESSAGE,
} from './lib/bridge-commands.mjs';
import { buildBridgePrompt } from './lib/bridge-prompt.mjs';
import { formatOutboundMessage } from './lib/bridge-output.mjs';
import { formatChannelPreferencesForPrompt, readChannelPreferences } from './lib/channel-memory.mjs';
import {
  mergeForwardedMessageHydration,
  needsForwardedMessageHydration,
} from './lib/forwarded-messages.mjs';
import {
  buildDailyMaintenanceMinimalResumeTask,
  buildDailyMaintenanceTask,
  collectDailyMaintenanceContext,
  createDailyMaintenanceRun,
  maintenancePromptBudget,
  updateDailyMaintenanceManifest,
} from './lib/daily-maintenance.mjs';
import { dailyReportDefinitions, nextDailyReportAtKst } from './lib/daily-reports.mjs';
import { discordAuthorDisplayName } from './lib/discord-author.mjs';
import {
  gatewayCloseDetails,
  GatewaySession,
  HeartbeatMonitor,
  gatewayConnectionAttemptDetails,
} from './lib/discord-gateway.mjs';
import {
  discordOutboxProgressFromError,
  flushDiscordOutbox,
  queueDiscordOutbox,
} from './lib/discord-outbox.mjs';
import { buildJobThreadContext } from './lib/discord-thread-context.mjs';
import { DiscordApi } from './lib/discord-api.mjs';
import { formatErrorDetail } from './lib/error-detail.mjs';
import {
  appendArtifactDeliveryWarning,
  artifactDeliveryNonce,
  artifactDeliveryFingerprint,
  captureArtifactDeliverySnapshot,
  compactArtifactDeliveryFiles,
  deserializeArtifactDeliverySnapshot,
  deliveryArtifactsForFinalMessage,
  serializeArtifactDeliverySnapshot,
} from './lib/artifact-delivery.mjs';
import { SlackApi } from './lib/slack-api.mjs';
import {
  compactSlackFiles,
  isSlackUserMessageEvent,
  parseSlackThreadStateId,
  slackCommandToBridgeCommand,
  slackMessageReservationId,
  slackThreadStateId,
  slackTimestampToIso,
} from './lib/slack-message.mjs';
import {
  flushSlackOutbox,
  queueSlackOutbox,
  slackOutboxProgressFromError,
} from './lib/slack-outbox.mjs';
import { SlackSocketModeClient } from './lib/slack-socket-mode.mjs';
import {
  commitEligibleWorktreeChanges,
  getHeadSyncStatus,
  getWorktreeChangedPaths,
  reconcileLocalHeadWithRemote,
  runGit,
  syncLocalHeadToRemote,
} from './lib/git-sync.mjs';
import {
  buildGitHubIssueMaintenanceStartMessage,
  buildGitHubIssueMaintenanceTask,
  githubIssueMaintenanceThreadTitle,
  githubRepositoryFromRemoteUrl,
  listOpenGitHubIssues,
  resolveGitHubIssueWithCommit,
  verifiedMaintenanceCommitHead,
  verifiedMaintenanceResolutionHead,
} from './lib/github-issues.mjs';
import {
  MAINTENANCE_ISSUE_FOLLOWUP_FILE,
  formatMaintenanceIssueScheduleLine,
  issueFollowupKey,
  normalizeFollowupState,
  planIssueMaintenanceRun,
  pruneFollowupState,
  recordIssueMaintenanceOutcome,
} from './lib/maintenance-issue-followup.mjs';
import {
  applyGitPollEdit,
  buildGitPollContinuationContent,
  currentGitBranch as currentGitPollBranch,
  formatGitPollTarget,
  gitPollIsInThread,
  gitPollMatchesCancelThread,
  normalizeGitPollRequest,
  resolveGitPollRepoPath,
  shortSha,
} from './lib/git-poll.mjs';
import {
  acquireThreadJobLock,
  isThreadJobLockOwnerFromPreviousService,
  readThreadJobLockOwner,
  releaseThreadJobLock,
} from './lib/job-thread-lock.mjs';
import {
  jobAllowedRoots,
  jobArtifactRoot,
  jobCanModifyBridgeSource,
  jobNeedsFullStateAccess,
  jobNeedsRepoAccess,
  jobWorkingDirectory,
} from './lib/job-state-roots.mjs';
import { channelPythonVenvPath } from './lib/python-env.mjs';
import {
  eventForRecoverableJob,
  interruptedJobCandidatesFromEntries,
  newestRecoverySupersedingThreadEventAfter,
  newestThreadJobAfter,
  shouldSupersedeLiveJob,
} from './lib/job-recovery.mjs';
import {
  isActionableJobEvent,
  shouldPostSupersededNotice,
} from './lib/job-admission.mjs';
import {
  createProgressUpdateForwarder,
  createTerminalResponseProgressGate,
  formatJobStopMessage,
  jobStatusAfterOutboundDelivery,
  startJobProgressTimer,
} from './lib/job-progress.mjs';
import {
  formatJobCompletionSummary,
  shouldPostStandaloneCompletionMarker,
} from './lib/job-completion.mjs';
import { continuationJobId, rootJobId } from './lib/job-id.mjs';
import { captureWorkspaceState, createJobCheckpointRecorder } from './lib/job-checkpoint.mjs';
import { withJobStepDeadline as withJobStepDeadlineFor } from './lib/job-step-deadline.mjs';
import {
  comparableJobMessageContents,
  createJobMessageDedupe,
  isTerminalJobOutboundPurpose,
  jobMessageDedupeKey,
  shouldReconcileSuppressedJobFinalToMemory,
  shouldSuppressDuplicateJobOutbound,
  TERMINAL_JOB_OUTBOUND_PURPOSES,
  stripTrailingJobCompletionMarkers,
} from './lib/job-message-dedupe.mjs';
import {
  buildJobHandoffMarkdown,
  jobTranscriptRoot,
  previousJobHandoffContext,
  previousJobWorkerDurationMs,
} from './lib/job-transcript.mjs';
import { delayUntil, nextDailyMaintenanceAtKst } from './lib/maintenance-schedule.mjs';
import {
  formatDailyMaintenanceResult,
  parseDailyMaintenanceResultFromOutput,
} from './lib/maintenance-report.mjs';
import { parseMaintenanceIssueResultFromOutput } from './lib/maintenance-issue-result.mjs';
import {
  beginDurableMessageProcessing,
  completeDurableMessageProcessing,
  isDiscordMessageReserved,
  reserveDiscordMessage,
} from './lib/message-dedupe.mjs';
import { recentlyActiveThreadIds, selectCatchupMessages } from './lib/missed-messages.mjs';
import {
  isWorkerInputLimitError,
  plannedWorkerStartInfo,
  runAgentJob,
  workerChainSummaryForJob,
} from './lib/agent-runner.mjs';
import { terminateActiveProcesses, terminateActiveProcessesGracefully } from './lib/codex-runner.mjs';
import {
  channelStateDir,
  hostGitHubAuthEnv,
  loadConfig,
  loadDotEnv,
  statePathPart,
  threadStateDir,
} from './lib/config.mjs';
import {
  MAX_THREAD_CREATE_ATTEMPTS,
  exceededThreadCreateAttempts,
  isNonRetryableJobError,
  isNonRetryableThreadCreateError,
  isOperatorTerminatedError,
  retryDelayMs,
  retryDelayMsForError,
  shouldNotifyRetry,
  shouldRecoverJobInterruptedByServiceShutdown,
} from './lib/retry-policy.mjs';
import { createRestartCoordinator } from './lib/restart-coordinator.mjs';
import {
  formatRestartRequestNotice,
  resolveRestartNoticeDestination,
} from './lib/restart-notices.mjs';
import {
  JobScheduler,
  PRIORITY,
  classifyJob,
  jobConcurrencyKey,
  jobThreadKey,
} from './lib/scheduler.mjs';
import { JsonState } from './lib/state.mjs';
import { assertParentChannelDestination, assertThreadDestination } from './lib/thread-delivery.mjs';
import {
  mergeThreadRepoContextIntoJobSync,
  readThreadStatusSync,
  requestThreadModelSelectionSync,
  resolveThreadRepoContextSync,
  writeInheritedThreadStatusSync,
  writeThreadRepositoryRootSync,
  writeThreadRepoAccessSync,
  writeThreadVerboseProgressSync,
  writeThreadCodexFastModeSync,
  writeThreadModelOverrideSync,
  requestThreadEffortSelectionSync,
  clearPendingEffortSelectionSync,
  writeThreadEffortOverrideSync,
  readThreadRichStyleIdSync,
  resolveJobRichStyleIdSync,
  writeThreadRichStyleSync,
} from './lib/thread-repo-context.mjs';
import {
  DEFAULT_RICH_STYLE_ID,
  formatRichStylePresetList,
  normalizeRichStyleId,
  richStyleBySelector,
} from './lib/rich-style-themes.mjs';
import {
  formatThreadModelOptionsCodeBlock,
  compactThreadModelOverride,
  isPendingModelSelectionActive,
  modelOptionByNumber,
  modelOptionBySelector,
  modelSelectionFromOption,
  threadModelSelectionOptions,
  getModelFamily,
  defaultThreadModelFallbackChain,
  effortOptionsForModel,
} from './lib/thread-models.mjs';
import { claudeAccountAuthenticationStatus } from './lib/claude-accounts.mjs';
import { processDueTodoAlerts } from './lib/todo-alerts.mjs';
import { formatActiveTodoList, formatTodoStateForPrompt, readChannelTodoState } from './lib/todo-state.mjs';
import { applyTodoCommand, formatTodoCommandResult } from './lib/todo-commands.mjs';
import {
  attributeRuntimeSourceChanges,
  captureRuntimeSourceSnapshot,
  changedRuntimeSourcePaths,
} from './lib/runtime-source-changes.mjs';
import { migrateStateLayout } from './lib/state-migration.mjs';
import { compactBridgeStateFiles } from './lib/jsonl-compaction.mjs';
import {
  PENDING_ASKS_FILE,
  activePendingAskFromEntries,
  compactPendingAskAnswer,
  expiredPendingAsksFromEntries,
  formatPendingAskMessage,
  parsePendingAskCommand,
  parsePendingAskFromOutput,
} from './lib/pending-ask.mjs';
import {
  MAX_RESERVE_TIMER_DELAY_MS,
  RESERVED_COMMANDS_FILE,
  activeReservationsFromEntries,
  formatReserveCommandUsage,
  formatReserveTimeLabel,
  parseReserveCommand,
  parseReserveTime,
} from './lib/reserve-command.mjs';
import { maskSecrets, redactEventSecrets } from './lib/secret-mask.mjs';
import {
  parseServiceRestartRequestFromOutput,
  resolveRuntimeSourceRestartExplanation,
} from './lib/service-restart-request.mjs';
import { observeSourceEventHighWatermark } from './lib/source-event-high-watermark.mjs';
import { sweepPersistedStateSecrets } from './lib/state-secret-redaction.mjs';
import { collectCachedUsageSummary, formatLiveUsageSummary } from './lib/usage-probe.mjs';
import {
  adaptiveMaintenanceDecision,
  adaptiveSkipNotice,
  describeAdaptiveDecision,
  maintenanceQuotaWorkerId,
  weeklyQuotaWindow,
} from './lib/maintenance-adaptive.mjs';
import { maybeScheduleV3Promotion } from './lib/v3-promotion.mjs';
import { DurableBus } from './v3/lib/durable-bus.mjs';
import { FullWorkbenchRuntime } from './v3/lib/full-workbench-runtime.mjs';
import {
  DiscordPlatformProxy,
  SlackPlatformProxy,
  WorkbenchPlatformRpc,
} from './v3/lib/platform-rpc.mjs';
import { RoleHealthReporter } from './v3/lib/role-health.mjs';
import { loadV3RuntimeConfig } from './v3/lib/runtime-config.mjs';

const RESTART_EXIT_CODE = 75;
// A fresh installation must not replay messages that predate its first start.
// Operators that want downtime catch-up should persist BRIDGE_IGNORE_BEFORE in
// .env; the host launcher does this value resolution before starting a role.
const DEFAULT_IGNORE_BEFORE = new Date().toISOString();
const ACK_REACTION_EMOJI = '👍';
const SUPERSEDED_ABORT_REASON_PREFIX = 'superseded-by:';
const CANCELLED_ABORT_REASON_PREFIX = 'cancelled-by:';
// Aborting a job only asks it to unwind. A step awaiting a Worker that already
// died never settles, so without a deadline the job keeps its `running` slot
// and its `working for N minutes.` heartbeat forever — a superseded job was
// observed still ticking 60 minutes after its abort, with no Worker process and
// no state writes. After this grace window the job is forced to the terminal
// state its abort reason already implies.
const JOB_ABORT_SETTLE_GRACE_MS = 30_000;
// Every step between accepting a job and handing it to a Worker is local state
// I/O that measures in milliseconds. One stuck past this is a bug, and failing
// loudly with the phase name beats dangling silently: jobs stalled here for
// five hours across three Workbench generations while every log stayed quiet.
const JOB_PREPARE_STEP_TIMEOUT_MS = 5 * 60_000;
const JOB_COMPLETION_MARKER = '【응답완료】';
const DEDUPED_JOB_OUTBOUND_PURPOSES = new Set([
  'worker-progress',
  'job-superseded',
  'job-cancelled',
  ...TERMINAL_JOB_OUTBOUND_PURPOSES,
]);
// Sentinel returned by ensureWorkThread when a source message can never host a
// thread (permanent Discord rejection); callers must stop, not schedule retries.
const THREAD_CREATE_ABANDONED = Symbol('thread-create-abandoned');
const GIT_POLL_STATE_FILE = 'git-polls/git-polls.jsonl';
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const serviceStartedAt = new Date();

loadDotEnv(path.join(repoRoot, '.env'));
const v3WorkbenchMode = process.env.BRIDGE_RUNTIME_ROLE === 'v3-workbench';
const v3Supervised = v3WorkbenchMode
  && process.env.V3_SUPERVISED === '1';
const v3RuntimeConfig = v3WorkbenchMode
  ? loadV3RuntimeConfig(process.env, { repoRoot })
  : null;
const config = v3RuntimeConfig?.bridgeConfig || loadConfig();
const v3Bus = v3WorkbenchMode
  ? new DurableBus(v3RuntimeConfig.dbPath)
  : null;
const v3PlatformRpc = v3WorkbenchMode
  ? new WorkbenchPlatformRpc({
      bus: v3Bus,
      receptionUrl: v3RuntimeConfig.receptionUrl,
      token: v3RuntimeConfig.internalToken,
      pollIntervalMs: v3RuntimeConfig.pollIntervalMs,
      reconnectMinMs: v3RuntimeConfig.reconnectMinMs,
      reconnectMaxMs: v3RuntimeConfig.reconnectMaxMs,
      onLog: (type, payload) => logSystem(type, payload),
    })
  : null;
const api = v3WorkbenchMode
  ? new DiscordPlatformProxy(v3PlatformRpc)
  : new DiscordApi(config.discord);
const slackApi = v3WorkbenchMode
  ? new SlackPlatformProxy(v3PlatformRpc)
  : new SlackApi(config.slack);
const ignoreBefore = new Date(process.env.BRIDGE_IGNORE_BEFORE || DEFAULT_IGNORE_BEFORE);
const scheduler = new JobScheduler();
const running = new Map();
const runningJobPromises = new Map();
const maintenanceRuntimeChanges = new Map();
const maintenanceGroupsBeingScheduled = new Set();
const jobMessageDedupe = createJobMessageDedupe();
const gatewaySession = new GatewaySession();
const heartbeatMonitor = new HeartbeatMonitor();
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const MAX_GATEWAY_FAILURES_BEFORE_FRESH_SESSION = 3;
const GATEWAY_HANDSHAKE_TIMEOUT_MS = 60_000;
// Gateway RESUME only replays events missed during socket-level drops within
// a live process. Messages sent while the process itself was down (frequent:
// runtime-source restarts, maintenance) used to be lost entirely.
const CATCHUP_WINDOW_MS = Math.max(0, Number(process.env.BRIDGE_CATCHUP_WINDOW_MS ?? 30 * 60_000));
let heartbeat = null;
let reconnect = true;
let botUserId = null;
let slackBotUserId = null;
let slackTeamId = config.slack.teamId || null;
let slackSocketClient = null;
const slackUserNameCache = new Map();
let todoAlertTimer = null;
let v3WorkbenchRuntime = null;
let v3HealthReporter = null;
let v3WorkbenchInitialized = false;
let v3AdmissionEnabled = !v3Supervised;
const activeGitPolls = new Map();
const activeReservedCommands = new Map();
let shuttingDown = false;
const restartCoordinator = createRestartCoordinator({
  // The v3 Workbench owns orchestration only. Detached Workers remain alive
  // across a Workbench generation handoff.
  runningJobs: () => v3WorkbenchMode ? [] : running.values(),
  isShuttingDown: () => shuttingDown,
  formatNotice: formatRestartRequestNotice,
  postNotice: (request, content) => postRestartNotice(request, content),
  logEvent: (type, payload) => logSystem(type, payload),
  writeState: (name, value) => writeSystemState(name, value),
  readState: (name) => readSystemState(name),
  removeState: (name) => removeSystemState(name),
  freezeSchedulers: () => {
    clearGitPollTimers();
    clearReservedCommandTimers();
  },
  prepareShutdown: () => {
    shuttingDown = true;
    reconnect = false;
    clearHeartbeat();
    slackSocketClient?.stop();
    if (todoAlertTimer) clearInterval(todoAlertTimer);
    clearGitPollTimers();
    clearReservedCommandTimers();
  },
  terminateChildren: () => v3WorkbenchMode
    ? Promise.resolve([])
    : terminateActiveProcessesGracefully(),
  exit: (code) => process.exit(code),
  restartExitCode: RESTART_EXIT_CODE,
});

async function main() {
  const runtimeRole = String(process.env.BRIDGE_RUNTIME_ROLE || '').trim();
  if (!v3WorkbenchMode && runtimeRole && runtimeRole !== 'v2-service') {
    throw new Error(`refusing to start the v2 service from runtime role ${runtimeRole}`);
  }
  if (!v3WorkbenchMode) {
    if (!config.discord.enabled || !config.discord.token) {
      throw new Error('Discord bridge is not configured: set DISCORD_BOT_TOKEN.');
    }
    if (config.discord.allowedChannelIds.size === 0) {
      throw new Error('Discord bridge is not configured: set DISCORD_ALLOWED_CHANNEL_IDS.');
    }
    if (!config.discord.allowAllUsers && config.discord.allowedUserIds.size === 0) {
      throw new Error('Discord bridge is not configured: set DISCORD_ALLOWED_USER_IDS or explicitly set DISCORD_ALLOW_ALL_USERS=true.');
    }
    if (config.slack.enabled && !config.slack.allowAllUsers && config.slack.allowedUserIds.size === 0) {
      throw new Error('Slack bridge is not configured: set SLACK_ALLOWED_USER_IDS or explicitly set SLACK_ALLOW_ALL_USERS=true.');
    }
  }
  await ensureDir(config.stateRoot);
  await ensureDir(config.repositoriesRoot);
  if (!v3WorkbenchMode) await scheduleRequestedV3Promotion();
  if (v3WorkbenchMode) {
    v3WorkbenchRuntime = new FullWorkbenchRuntime({
      bus: v3Bus,
      bridgeConfig: config,
      repoRoot: v3RuntimeConfig.repoRoot,
      dbPath: v3RuntimeConfig.dbPath,
      token: v3RuntimeConfig.internalToken,
      receptionUrl: v3RuntimeConfig.receptionUrl,
      workerHost: v3RuntimeConfig.host,
      workerPort: v3RuntimeConfig.workbenchPort,
      workerLogRoot: v3RuntimeConfig.workerLogRoot,
      workerMode: v3RuntimeConfig.workerMode,
      pollIntervalMs: v3RuntimeConfig.pollIntervalMs,
      reconnectMinMs: v3RuntimeConfig.reconnectMinMs,
      reconnectMaxMs: v3RuntimeConfig.reconnectMaxMs,
      leaseTtlMs: v3RuntimeConfig.leaseTtlMs,
      leaseRenewMs: v3RuntimeConfig.leaseRenewMs,
      workerHeartbeatMs: v3RuntimeConfig.workerHeartbeatMs,
      onInbound: handleV3Inbound,
      onLog: (type, payload) => logSystem(type, payload),
    });
    v3HealthReporter = new RoleHealthReporter({
      role: 'workbench',
      stateRoot: config.stateRoot,
      intervalMs: v3RuntimeConfig.healthHeartbeatMs,
      getStatus: () => v3WorkbenchHealthStatus(),
      onError: (error) => logSystem('v3-workbench-health-write-error', {
        error: formatErrorDetail(error),
      }).catch(() => {}),
    });
    await v3HealthReporter.start();
    // Fence this generation and bind the Worker wake socket before recovery.
    // New platform events remain paused until all legacy state is reconciled.
    await v3WorkbenchRuntime.start({ paused: true });
    v3PlatformRpc.start();
  }
  await initializeBugReportRepository();
  await migrateLegacyRepoState();
  // Before the gateway connects and logging ramps up, so no appends race the
  // read-rewrite cycle.
  const compacted = await compactBridgeStateFiles(config.stateRoot).catch(() => []);
  if (compacted.length > 0) await logSystem('state-compaction', { files: compacted });
  await writeSystemState('service.json', {
    pid: process.pid,
    startedAt: serviceStartedAt.toISOString(),
    ignoreBefore: ignoreBefore.toISOString(),
    channelIds: config.discord.channelIds,
    slack: config.slack.enabled ? {
      teamId: slackTeamId,
      channelId: config.slack.channelId,
      logicalChannelId: config.slack.logicalChannelId,
      socketMode: !v3WorkbenchMode,
    } : null,
    queue: {
      maxConcurrentJobs: config.queue.maxConcurrentJobs,
      singleJobMode: config.queue.singleJobMode,
      backgroundStartOnlyBelowRunning: config.queue.backgroundStartOnlyBelowRunning,
    },
  });
  // Open Socket Mode before sequential restart/job recovery. Slack can then
  // acknowledge messages posted during the restart window while the remaining
  // durable state is still being reconciled.
  const slackGatewayPromise = config.slack.enabled
    ? v3WorkbenchMode
      ? runV3SlackBridge()
      : runSlackBridge()
    : null;
  await completePendingRestart();
  await completeAbandonedDeferredRestart();
  await recoverPendingThreadCreations();
  await recoverInterruptedJobs();
  await recoverGitPolls();
  await recoverReservedCommands();
  scheduleDiscordOutboxFlush();
  scheduleSlackOutboxFlush();
  scheduleTodoAlerts();
  scheduleDailyMaintenance();
  scheduleDailyReports();
  catchUpMissedMessages().catch((error) =>
    logSystem('catchup-error', { error: formatErrorDetail(error) }).catch(() => {}),
  );
  sweepPersistedStateSecretsInBackground();
  if (v3WorkbenchMode) {
    if (slackGatewayPromise) {
      slackGatewayPromise.then(() =>
        catchUpSlackMessages().catch((error) =>
          logSystem('slack-catchup-error', {
            error: formatErrorDetail(error),
          }).catch(() => {}),
        ),
      );
    }
    v3WorkbenchInitialized = true;
    if (v3AdmissionEnabled) v3WorkbenchRuntime.resume();
    await v3HealthReporter.requestPublish();
    await v3WorkbenchRuntime.waitUntilStopped();
    return;
  }
  const gatewayPromises = [gatewayLoop()];
  if (slackGatewayPromise) gatewayPromises.push(slackGatewayPromise);
  await Promise.all(gatewayPromises);
}

if (v3WorkbenchMode) {
  process.on('message', (message) => {
    if (message?.type !== 'v3-workbench-admission') return;
    setV3WorkbenchAdmission(message.enabled === true, {
      reason: message.reason || 'supervisor',
    });
  });
}

function setV3WorkbenchAdmission(enabled, { reason = '' } = {}) {
  const next = Boolean(enabled);
  const changed = v3AdmissionEnabled !== next;
  v3AdmissionEnabled = next;
  if (v3WorkbenchInitialized) {
    if (next) v3WorkbenchRuntime?.resume();
    else v3WorkbenchRuntime?.pause();
    v3HealthReporter?.requestPublish();
  }
  if (changed) {
    logSystem('v3-workbench-admission-changed', {
      enabled: next,
      reason: String(reason || ''),
      initialized: v3WorkbenchInitialized,
    }).catch(() => {});
  }
}

async function runV3SlackBridge() {
  let failures = 0;
  while (!shuttingDown) {
    try {
      await initializeSlackBridge({ socketMode: false });
      return;
    } catch (error) {
      failures += 1;
      const retryInMs = Math.min(
        5 * 60_000,
        Math.max(
          5_000,
          Number(config.slack.reconnectIntervalMs || 0),
        ) * 2 ** Math.min(failures - 1, 6),
      );
      await logSystem('slack-initialization-failed', {
        error: formatErrorDetail(error),
        failures,
        retryInMs,
        owner: 'reception',
      });
      await delay(retryInMs);
    }
  }
}

async function handleV3Inbound(payload = {}, envelope = {}) {
  if (envelope.kind === 'platform.event') {
    if (payload.platform === 'discord') {
      await handleMessage(payload.event || {}, { durableEnvelope: envelope });
      return;
    }
    if (payload.platform === 'slack') {
      await handleSlackMessage(payload.event || {}, {
        teamId: payload.teamId || '',
        eventId: payload.eventId || '',
        durableEnvelope: envelope,
      });
      return;
    }
    throw new Error(`unsupported v3 inbound platform: ${payload.platform}`);
  }

  // Console/submission ingress already carries a normalized bridge event.
  // Route it through the same command core while preserving test-only Worker
  // options such as mock plans.
  const source = payload.event || {};
  const event = {
    ...source,
    id: String(source.id || envelope.jobId || ''),
    timestamp: source.timestamp || new Date().toISOString(),
    authorId: String(source.authorId || ''),
    authorName: String(source.authorName || source.authorId || 'user'),
    channelId: String(source.channelId || ''),
    threadId: String(source.threadId || source.channelId || ''),
    content: String(source.content || ''),
    platform: source.platform === 'slack' ? 'slack' : 'discord',
    source: source.platform === 'slack' ? 'slack' : 'discord',
    attachments: Array.isArray(source.attachments) ? source.attachments : [],
    embeds: Array.isArray(source.embeds) ? source.embeds : [],
    acknowledged: source.acknowledged !== false,
    acknowledgedAt: source.acknowledgedAt || new Date().toISOString(),
  };
  if (!event.id || !event.channelId || !event.threadId) {
    throw new Error('normalized v3 inbound event is missing its scope');
  }
  const message = {
    id: event.id,
    timestamp: event.timestamp,
    author: {
      id: event.authorId,
      username: event.authorName,
    },
    channel_id: event.threadId,
    content: event.content,
    attachments: event.attachments,
    embeds: event.embeds,
    platform: event.platform,
  };
  const scope = {
    channelId: event.channelId,
    threadId: event.threadId,
    inThread: true,
    platform: event.platform,
  };
  const acknowledgement = {
    ok: event.acknowledged,
    acknowledgedAt: event.acknowledgedAt,
  };
  if (isTodoListRequest(message.content)) {
    await handleTodoListRequest(message, scope, acknowledgement);
    return;
  }
  const todoCommand = parseTodoCommand(message.content);
  if (todoCommand) {
    await handleTodoCommandRequest(
      message,
      scope,
      acknowledgement,
      todoCommand,
    );
    return;
  }
  const unknownCommand = unknownBridgeCommandFromContent(message.content);
  if (unknownCommand) {
    await handleUnknownCommandRequest(
      message,
      scope,
      acknowledgement,
      unknownCommand,
    );
    return;
  }
  await recordAndDispatchEvent(event, message, {
    enqueueOptions: payload.options || {},
  });
}

async function runSlackBridge() {
  let failures = 0;
  while (!shuttingDown) {
    try {
      await initializeSlackBridge();
      break;
    } catch (error) {
      failures += 1;
      const retryInMs = Math.min(
        5 * 60_000,
        Math.max(5_000, Number(config.slack.reconnectIntervalMs || 0)) * 2 ** Math.min(failures - 1, 6),
      );
      await logSystem('slack-initialization-failed', {
        error: formatErrorDetail(error),
        failures,
        retryInMs,
      });
      await delay(retryInMs);
    }
  }
  if (shuttingDown || !slackSocketClient) return;
  catchUpSlackMessages().catch((error) =>
    logSystem('slack-catchup-error', { error: formatErrorDetail(error) }).catch(() => {}),
  );
  await slackSocketClient.run();
}

async function initializeSlackBridge({ socketMode = true } = {}) {
  if (!config.slack.enabled) return;
  const required = [
    ['SLACK_APP_TOKEN', config.slack.appToken],
    ['SLACK_BOT_TOKEN', config.slack.botToken],
    ['SLACK_CHANNEL_ID', config.slack.channelId],
    ['SLACK_LOGICAL_CHANNEL_ID', config.slack.logicalChannelId],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (required.length > 0) {
    throw new Error(`Slack bridge is enabled but missing ${required.join(', ')}`);
  }

  const auth = await slackApi.authTest();
  slackBotUserId = auth.user_id || null;
  slackTeamId = auth.team_id || config.slack.teamId || null;
  if (config.slack.teamId && slackTeamId && String(config.slack.teamId) !== String(slackTeamId)) {
    throw new Error(`Slack workspace mismatch: configured ${config.slack.teamId}, authenticated ${slackTeamId}`);
  }
  const channel = await slackApi.channelInfo(config.slack.channelId);
  if (!channel?.channel?.is_member) {
    throw new Error(`Slack bot is not a member of configured channel ${config.slack.channelId}`);
  }
  if (socketMode) {
    slackSocketClient = new SlackSocketModeClient({
      api: slackApi,
      reconnectDelayMs: config.slack.reconnectIntervalMs,
      onEnvelope: handleSlackEnvelope,
      log: logSystem,
    });
  }
  await logSystem('slack-ready', {
    teamId: slackTeamId,
    botUserId: slackBotUserId,
    channelId: config.slack.channelId,
    logicalChannelId: config.slack.logicalChannelId,
    socketMode,
  });
}

async function catchUpMissedMessages() {
  if (!CATCHUP_WINDOW_MS) return;
  const notBefore = new Date(Date.now() - CATCHUP_WINDOW_MS);
  const channelIds = [...config.discord.allowedChannelIds];
  const threads = await recentlyActiveThreadIds(config.stateRoot, channelIds).catch(() => []);
  const targetIds = [...new Set([
    ...channelIds,
    ...threads.map((thread) => thread.threadId).filter((threadId) => /^\d+$/.test(String(threadId))),
  ])];
  let processed = 0;
  for (const targetId of targetIds) {
    let fetched;
    try {
      fetched = await api.listMessages(targetId, { limit: 50 });
    } catch (error) {
      await logSystem('catchup-fetch-failed', {
        channelId: targetId,
        error: formatErrorDetail(error),
      });
      continue;
    }
    for (const message of selectCatchupMessages(fetched, { notBefore })) {
      if (message.author?.bot) continue;
      if (await isDiscordMessageReserved(systemState(), message)) continue;
      try {
        await handleMessage(message);
        processed += 1;
      } catch (error) {
        await logSystem('catchup-message-error', {
          channelId: targetId,
          messageId: message?.id || null,
          error: formatErrorDetail(error),
        });
      }
    }
  }
  await logSystem('catchup-completed', {
    targets: targetIds.length,
    notBefore: notBefore.toISOString(),
    processed,
  });
}

// Retroactive cleanup of secrets persisted before a token shape was recognized.
// It is not a boot precondition — every live write is already masked — but as an
// awaited startup step it read the whole state tree (~90 s on /mnt/c) before the
// gateways connected, which is precisely how long Slack stayed unacknowledged
// after a restart. Fire-and-forget, and never allowed to reject into startup.
function sweepPersistedStateSecretsInBackground() {
  sweepPersistedStateSecrets(config.stateRoot)
    .then(async (result) => {
      if (result.changed.length > 0) {
        await logSystem('persisted-state-secrets-redacted', {
          files: result.changed,
          mode: result.mode,
        });
      }
      // Quiet incremental sweeps stay unlogged; a full pass or a slow one is
      // what matters when restart latency is being diagnosed again.
      if (result.mode === 'full' || result.changed.length > 0 || result.durationMs >= 5_000) {
        await logSystem('persisted-state-secrets-swept', {
          mode: result.mode,
          patternVersion: result.patternVersion,
          scannedFiles: result.scannedFiles,
          skippedFiles: result.skippedFiles,
          skippedThreads: result.skippedThreads,
          changedFiles: result.changed.length,
          durationMs: result.durationMs,
        });
      }
    })
    .catch((error) =>
      logSystem('persisted-state-secrets-sweep-failed', {
        error: formatErrorDetail(error),
      }).catch(() => {}),
    );
}

async function catchUpSlackMessages() {
  const windowMs = Math.max(0, Number(config.slack.catchupWindowMs || 0));
  if ((!slackSocketClient && !v3WorkbenchMode) || !windowMs) return;
  const notBeforeMs = Date.now() - windowMs;
  const oldest = String(notBeforeMs / 1000);
  const messagesByTimestamp = new Map();
  const history = await slackApi.listMessages(config.slack.channelId, { oldest, limit: 100 });
  for (const message of history) {
    if (message?.ts) messagesByTimestamp.set(String(message.ts), message);
  }

  const threadRoots = new Set(history
    .filter((message) => Number(message?.reply_count || 0) > 0)
    .map((message) => String(message.thread_ts || message.ts || ''))
    .filter(Boolean));
  const activeThreads = await recentlyActiveThreadIds(
    config.stateRoot,
    [config.slack.logicalChannelId],
  ).catch(() => []);
  for (const thread of activeThreads) {
    const destination = parseSlackThreadStateId(thread.threadId);
    if (destination
      && destination.channelId === config.slack.channelId
      && (!slackTeamId || destination.teamId === slackTeamId)) {
      threadRoots.add(destination.threadTs);
    }
  }

  for (const threadTs of threadRoots) {
    const replies = await slackApi.listReplies(config.slack.channelId, threadTs, { oldest, limit: 100 })
      .catch(async (error) => {
        await logSystem('slack-catchup-thread-failed', {
          channelId: config.slack.channelId,
          threadTs,
          error: formatErrorDetail(error),
        });
        return [];
      });
    for (const message of replies) {
      if (message?.ts) messagesByTimestamp.set(String(message.ts), message);
    }
  }

  let processed = 0;
  const messages = [...messagesByTimestamp.values()]
    .filter((message) => slackTimestampMs(message.ts) >= notBeforeMs)
    .sort((left, right) => slackTimestampMs(left.ts) - slackTimestampMs(right.ts));
  for (const message of messages) {
    try {
      if (await handleSlackMessage(message, {
        teamId: slackTeamId,
        eventId: `catchup-${config.slack.channelId}-${message.ts}`,
      })) processed += 1;
    } catch (error) {
      await logSystem('slack-catchup-message-error', {
        channelId: config.slack.channelId,
        messageTs: message?.ts || null,
        error: formatErrorDetail(error),
      });
    }
  }
  await logSystem('slack-catchup-completed', {
    channelId: config.slack.channelId,
    notBefore: new Date(notBeforeMs).toISOString(),
    candidates: messages.length,
    processed,
  });
}

async function handleSlackEnvelope(envelope = {}) {
  if (envelope.type !== 'events_api') return;
  const payload = envelope.payload || {};
  const event = payload.event || {};
  const teamId = payload.team_id || envelope.team_id || slackTeamId || '';
  await handleSlackMessage(event, {
    teamId,
    eventId: payload.event_id || envelope.envelope_id || '',
  });
}

async function handleSlackMessage(
  event,
  {
    teamId = '',
    eventId = '',
    durableEnvelope = null,
  } = {},
) {
  if (!isSlackUserMessageEvent(event)) return false;
  if (String(event.channel || '') !== String(config.slack.channelId || '')) return false;
  if (slackTeamId && teamId && String(teamId) !== String(slackTeamId)) {
    await logSystem('slack-workspace-message-rejected', {
      expectedTeamId: slackTeamId,
      receivedTeamId: teamId,
      channelId: event.channel,
      messageTs: event.ts,
    });
    return false;
  }
  if (String(event.user || '') === String(slackBotUserId || '')) return false;
  if (!isAllowedSlackUser(event.user)) return false;

  const timestamp = slackTimestampToIso(event.ts);
  if (!timestamp || Date.parse(timestamp) < ignoreBefore.getTime()) return false;
  const resolvedTeamId = String(teamId || slackTeamId || config.slack.teamId || '');
  if (!resolvedTeamId) {
    await logSystem('slack-message-rejected-missing-team', {
      channelId: event.channel,
      messageTs: event.ts,
    });
    return false;
  }
  const rootTs = String(event.thread_ts || event.ts);
  const threadId = slackThreadStateId({
    teamId: resolvedTeamId,
    channelId: event.channel,
    threadTs: rootTs,
  });
  const messageId = slackMessageReservationId(event);
  const message = {
    id: messageId || `slack-${eventId || Date.now()}`,
    timestamp,
    author: {
      id: String(event.user),
      username: String(event.user),
    },
    channel_id: threadId,
    content: slackCommandToBridgeCommand(event.text || ''),
    attachments: compactSlackFiles(event.files),
    embeds: [],
    platform: 'slack',
    source_channel_id: String(event.channel),
    source_thread_ts: rootTs,
    source_message_ts: String(event.ts),
    slack_event_id: String(eventId || ''),
  };
  const scope = {
    channelId: config.slack.logicalChannelId,
    threadId,
    inThread: true,
    platform: 'slack',
  };
  const reservation = durableEnvelope
    ? await beginDurableMessageProcessing(systemState(), message, {
      ownerId: v3WorkbenchRuntime?.instanceId || durableEnvelope.messageId,
    })
    : { accepted: await reserveDiscordMessage(systemState(), message) };
  if (!reservation.accepted) {
    await logSystem('slack-message-duplicate-suppressed', {
      channelId: event.channel,
      messageTs: event.ts,
      eventId: eventId || null,
      durable: Boolean(durableEnvelope),
    });
    return false;
  }

  try {
    const acknowledgement = await acknowledgeSlackMessage(event.channel, event.ts);
    message.author.username = await slackUserDisplayName(event.user);
    if (isTodoListRequest(message.content)) {
      await handleTodoListRequest(message, scope, acknowledgement);
    } else {
      const todoCommand = parseTodoCommand(message.content);
      if (todoCommand) {
        await handleTodoCommandRequest(message, scope, acknowledgement, todoCommand);
      } else {
        const unknownCommand = unknownBridgeCommandFromContent(message.content);
        if (unknownCommand) {
          await handleUnknownCommandRequest(
            message,
            scope,
            acknowledgement,
            unknownCommand,
          );
        } else {
          const bridgeEvent = buildMessageEvent(
            message,
            scope.channelId,
            scope.threadId,
            acknowledgement,
          );
          await recordAndDispatchEvent(bridgeEvent, message, {
            durableEnvelope,
          });
        }
      }
    }
    if (durableEnvelope) {
      await completeDurableMessageProcessing(systemState(), message, {
        ownerId: v3WorkbenchRuntime?.instanceId || durableEnvelope.messageId,
      });
    }
    return true;
  } catch (error) {
    // Keep a durable reservation in "processing". The unacknowledged bus row
    // is retried by this or the next Workbench generation, which reclaims it.
    throw error;
  }
}

async function slackUserDisplayName(userId) {
  const id = String(userId || '');
  if (!id) return '';
  if (slackUserNameCache.has(id)) return slackUserNameCache.get(id);
  let name = id;
  try {
    const result = await slackApi.userInfo(id);
    name = result.user?.profile?.display_name
      || result.user?.profile?.real_name
      || result.user?.real_name
      || result.user?.name
      || id;
  } catch (error) {
    await logSystem('slack-user-info-failed', {
      userId: id,
      error: formatErrorDetail(error),
    });
  }
  if (slackUserNameCache.size >= 1000) slackUserNameCache.clear();
  slackUserNameCache.set(id, name);
  return name;
}

function slackTimestampMs(value) {
  const seconds = Number.parseFloat(String(value || ''));
  return Number.isFinite(seconds) ? Math.floor(seconds * 1000) : Number.NaN;
}

async function migrateLegacyRepoState() {
  const legacyRoot = path.join(repoRoot, '.state');
  if (path.resolve(legacyRoot) === path.resolve(config.stateRoot)) return;
  try {
    const result = await migrateStateLayout({
      sourceRoot: legacyRoot,
      targetRoot: config.stateRoot,
      archiveSource: false,
      // One-time only: re-running on every restart re-merges legacy .jsonl records and
      // resurrects alerts/todos deleted from canonical state.
      once: true,
    });
    if (result.migrated) await logSystem('legacy-state-migrated', result);
  } catch (error) {
    await logSystem('legacy-state-migration-failed', {
      sourceRoot: legacyRoot,
      targetRoot: config.stateRoot,
      error: formatErrorDetail(error),
    });
  }
}

async function gatewayLoop() {
  let consecutiveFailures = 0;
  while (reconnect) {
    const resumeAttempt = gatewaySession.canResume();
    const connectionUrl = gatewaySession.connectUrl(GATEWAY_URL);
    const attemptStartedAtMs = Date.now();
    try {
      await connectGateway(connectionUrl);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      await logSystem('gateway-error', {
        error: formatErrorDetail(error),
        consecutiveFailures,
        ...gatewayConnectionAttemptDetails(connectionUrl, {
          resumeAttempt,
          sequence: gatewaySession.sequence,
          startedAtMs: attemptStartedAtMs,
        }),
      });
      // The resume endpoint may itself be unreachable; fall back to a fresh
      // session on the default gateway URL after repeated connection errors.
      if (consecutiveFailures >= MAX_GATEWAY_FAILURES_BEFORE_FRESH_SESSION && gatewaySession.canResume()) {
        gatewaySession.reset();
        await logSystem('gateway-resume-abandoned', { consecutiveFailures });
      }
      await delay(5000);
    }
  }
}

function connectGateway(connectionUrl = gatewaySession.connectUrl(GATEWAY_URL)) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(connectionUrl);
    let settled = false;
    let closeTrigger = 'remote-or-network';
    // A socket that connects but never delivers HELLO would hang the gateway
    // loop forever (the heartbeat watchdog only starts after HELLO).
    const handshakeTimer = setTimeout(() => {
      closeTrigger = 'handshake-timeout';
      logSystem('gateway-handshake-timeout', { timeoutMs: GATEWAY_HANDSHAKE_TIMEOUT_MS }).catch(() => {});
      try {
        socket.close();
      } catch {
        // close() may throw if the socket is already dead; the close/error
        // listeners below settle the promise either way.
      }
    }, GATEWAY_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();

    socket.addEventListener('open', () => {
      logSystem('gateway-open').catch(() => {});
    });
    socket.addEventListener('message', (event) => {
      clearTimeout(handshakeTimer);
      handleGatewayPayload(socket, JSON.parse(event.data), {
        noteCloseTrigger(trigger) {
          closeTrigger = trigger;
        },
      }).catch((error) => {
        logSystem('gateway-message-error', { error: formatErrorDetail(error) }).catch(() => {});
      });
    });
    socket.addEventListener('close', (event) => {
      clearTimeout(handshakeTimer);
      clearHeartbeat();
      logSystem('gateway-close', gatewayCloseDetails(event, {
        trigger: closeTrigger,
        sequence: gatewaySession.sequence,
        resumable: gatewaySession.canResume(),
      })).catch(() => {});
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    socket.addEventListener('error', (event) => {
      clearTimeout(handshakeTimer);
      clearHeartbeat();
      closeTrigger = 'socket-error';
      if (!settled) {
        settled = true;
        reject(new Error(event.message || 'Discord websocket error'));
      }
    });
  });
}

async function handleGatewayPayload(socket, payload, {
  noteCloseTrigger = () => {},
} = {}) {
  gatewaySession.noteSequence(payload.s);

  // op 1: Discord requests an immediate heartbeat.
  if (payload.op === 1) {
    socket.send(JSON.stringify({ op: 1, d: gatewaySession.sequence }));
    return;
  }

  // op 11: heartbeat ACK — the connection is alive.
  if (payload.op === 11) {
    heartbeatMonitor.ack();
    return;
  }

  if (payload.op === 10) {
    clearHeartbeat();
    heartbeat = setInterval(() => {
      if (!heartbeatMonitor.beat()) {
        logSystem('gateway-zombie-connection', { sequence: gatewaySession.sequence }).catch(() => {});
        clearHeartbeat();
        noteCloseTrigger('heartbeat-watchdog');
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ op: 1, d: gatewaySession.sequence }));
    }, payload.d.heartbeat_interval);
    const resuming = gatewaySession.canResume();
    socket.send(JSON.stringify(gatewaySession.helloReply({
      token: config.discord.token,
      intents: config.discord.gatewayIntents,
      properties: {
        os: 'linux',
        browser: 'mobile-codex-bridge',
        device: 'mobile-codex-bridge',
      },
    })));
    if (resuming) {
      await logSystem('gateway-resuming', { sequence: gatewaySession.sequence });
    }
    return;
  }

  // op 7 RECONNECT: close and keep the session so the next connect RESUMEs.
  if (payload.op === 7) {
    noteCloseTrigger('discord-op7-reconnect');
    socket.close();
    return;
  }

  // op 9 INVALID_SESSION: d === true means the session is still resumable.
  if (payload.op === 9) {
    const resumable = payload.d === true;
    gatewaySession.noteInvalidSession(resumable);
    await logSystem('gateway-invalid-session', { resumable });
    noteCloseTrigger(resumable
      ? 'discord-op9-invalid-session-resumable'
      : 'discord-op9-invalid-session-fresh');
    // Discord asks clients to wait 1-5s before re-identifying a fresh session.
    if (!resumable) await delay(1000 + Math.floor(Math.random() * 4000));
    socket.close();
    return;
  }

  if (payload.op !== 0) return;
  if (payload.t === 'READY') {
    gatewaySession.noteReady(payload.d);
    botUserId = payload.d.user?.id || null;
    await logSystem('ready', {
      botUserId,
      ignoreBefore: ignoreBefore.toISOString(),
      resumable: gatewaySession.canResume() || Boolean(gatewaySession.sessionId),
    });
    return;
  }
  if (payload.t === 'RESUMED') {
    await logSystem('gateway-resumed', { sequence: gatewaySession.sequence });
    return;
  }
  if (payload.t === 'MESSAGE_CREATE') await handleMessage(payload.d);
}

async function handleMessage(message, { durableEnvelope = null } = {}) {
  if (!isFreshMessage(message)) return;
  if (message.author?.bot || message.author?.id === botUserId) return;
  if (!isAllowedUser(message.author?.id)) return;

  const scope = await resolveScope(message);
  if (!scope) return;
  const reservation = durableEnvelope
    ? await beginDurableMessageProcessing(systemState(), message, {
      ownerId: v3WorkbenchRuntime?.instanceId || durableEnvelope.messageId,
    })
    : { accepted: await reserveDiscordMessage(systemState(), message) };
  if (!reservation.accepted) {
    await logSystem('message-duplicate-suppressed', {
      channelId: message.channel_id,
      messageId: message.id,
      durable: Boolean(durableEnvelope),
    });
    return;
  }

  try {
    message = await hydrateForwardedMessage(message);
    if (!isActionableJobEvent(message)) {
      await logSystem('empty-message-suppressed', {
        channelId: message.channel_id,
        messageId: message.id,
        messageType: message.type ?? null,
        durable: Boolean(durableEnvelope),
      });
      if (durableEnvelope) {
        await completeDurableMessageProcessing(systemState(), message, {
          ownerId: v3WorkbenchRuntime?.instanceId || durableEnvelope.messageId,
        });
      }
      return;
    }
    const acknowledgement = await acknowledgeMessage(message.channel_id, message.id);
    if (isTodoListRequest(message.content)) {
      if (scope.inThread) await recordThreadStarterIfAvailable(scope);
      await handleTodoListRequest(message, scope, acknowledgement);
    } else {
      const todoCommand = parseTodoCommand(message.content);
      if (todoCommand) {
        if (scope.inThread) await recordThreadStarterIfAvailable(scope);
        await handleTodoCommandRequest(message, scope, acknowledgement, todoCommand);
      } else {
        const unknownCommand = unknownBridgeCommandFromContent(message.content);
        if (unknownCommand) {
          await handleUnknownCommandRequest(
            message,
            scope,
            acknowledgement,
            unknownCommand,
          );
        } else {
          const workThreadId = await ensureWorkThread(message, scope);
          if (workThreadId !== THREAD_CREATE_ABANDONED) {
            if (!workThreadId) {
              await scheduleThreadCreationRetry(message, scope, acknowledgement, {
                attempt: 1,
                reason: 'initial thread creation failed',
              });
            } else {
              if (scope.inThread) await recordThreadStarterIfAvailable(scope);
              const event = buildMessageEvent(
                message,
                scope.channelId,
                workThreadId,
                acknowledgement,
              );
              await recordAndDispatchEvent(event, message, {
                durableEnvelope,
              });
            }
          }
        }
      }
    }
    if (durableEnvelope) {
      await completeDurableMessageProcessing(systemState(), message, {
        ownerId: v3WorkbenchRuntime?.instanceId || durableEnvelope.messageId,
      });
    }
  } catch (error) {
    // Leave a v3 reservation as "processing" so the durable inbox retries it.
    throw error;
  }
}

// Gateway payloads can arrive without message_snapshots for forwards, leaving
// only the comment text (or nothing). Recover the forwarded body via REST
// before the event is recorded, and log the message type when even the REST
// copy has no body so empty-message reports stay diagnosable.
async function hydrateForwardedMessage(message) {
  if (!needsForwardedMessageHydration(message)) return message;
  try {
    const fetched = await api.getMessage(message.channel_id, message.id);
    const hydrated = mergeForwardedMessageHydration(message, fetched);
    await logSystem(hydrated === message ? 'forwarded-message-hydration-empty' : 'forwarded-message-hydrated', {
      channelId: message.channel_id,
      messageId: message.id,
      messageType: fetched?.type ?? null,
      referenceType: fetched?.message_reference?.type ?? null,
      snapshotCount: (fetched?.message_snapshots || []).length,
    });
    return hydrated;
  } catch (error) {
    await logSystem('forwarded-message-hydration-failed', {
      channelId: message.channel_id,
      messageId: message.id,
      error: formatErrorDetail(error),
    });
    return message;
  }
}

function buildMessageEvent(message, channelId, threadId, acknowledgement) {
  const platform = message.platform === 'slack' ? 'slack' : 'discord';
  return {
    id: message.id,
    timestamp: message.timestamp || new Date().toISOString(),
    authorId: message.author?.id || '',
    authorName: discordAuthorDisplayName(message),
    channelId,
    threadId,
    content: message.content || '',
    platform,
    source: platform,
    sourceChannelId: message.source_channel_id || message.channel_id || '',
    sourceThreadId: message.source_thread_ts || threadId,
    sourceMessageId: message.source_message_ts || message.id,
    sourceEventId: message.slack_event_id || '',
    acknowledged: acknowledgement.ok,
    acknowledgedAt: acknowledgement.ok
      ? acknowledgement.acknowledgedAt || new Date().toISOString()
      : null,
    acknowledgementError: acknowledgement.error || null,
    attachments: compactAttachments(message.attachments),
    embeds: compactEmbeds(message.embeds),
    referencedMessage: compactReferencedMessage(message.referenced_message || message.referencedMessage),
    forwardedMessages: compactMessageSnapshots(message),
  };
}

// Threads whose starter is already verified in events.jsonl, so repeat
// messages skip the per-message file read (slow on the WSL2 mount).
const threadStarterVerified = new Set();
const THREAD_STARTER_VERIFIED_MAX = 5000;

async function recordThreadStarterIfAvailable(scope) {
  if (!scope?.inThread || !scope.channelId || !scope.threadId) return;
  const memoKey = `${scope.channelId}:${scope.threadId}`;
  if (threadStarterVerified.has(memoKey)) return;
  const state = threadState(scope.channelId, scope.threadId);
  const events = await state.readJsonl('memory/events.jsonl', { limit: 1000 });
  if (events.some((event) => event.id === scope.threadId || event.source === 'discord-thread-starter')) {
    rememberThreadStarterVerified(memoKey);
    return;
  }

  const starter = await api.getMessage(scope.channelId, scope.threadId).catch(async (error) => {
    // 404 means the thread has no starter message at all (e.g. a standalone
    // fallback thread) — remember that so every later message in the thread
    // does not repeat the failing lookup.
    if (error?.status === 404) {
      rememberThreadStarterVerified(memoKey);
      return null;
    }
    await logSystem('thread-starter-fetch-failed', {
      channelId: scope.channelId,
      threadId: scope.threadId,
      error: formatErrorDetail(error),
    });
    return null;
  });
  if (!starter) return;

  await state.appendJsonl('memory/events.jsonl', redactEventSecrets({
    ...buildMessageEvent(starter, scope.channelId, scope.threadId, {
      ok: true,
      error: null,
    }),
    id: starter.id || scope.threadId,
    source: 'discord-thread-starter',
    threadStarter: true,
    acknowledged: true,
    acknowledgedAt: null,
  }));
  rememberThreadStarterVerified(memoKey);
}

function rememberThreadStarterVerified(memoKey) {
  if (threadStarterVerified.size >= THREAD_STARTER_VERIFIED_MAX) threadStarterVerified.clear();
  threadStarterVerified.add(memoKey);
}

async function recordAndDispatchEvent(event, message, {
  enqueueOptions = {},
  durableEnvelope = null,
} = {}) {
  if (!isActionableJobEvent(event)) {
    await logSystem('empty-job-event-suppressed', {
      messageId: event?.id || message?.id || null,
      channelId: event?.channelId || null,
      threadId: event?.threadId || null,
      platform: event?.platform || message?.platform || 'discord',
    });
    return false;
  }
  const state = threadState(event.channelId, event.threadId);
  const persistedNewerThreadEvent = await observeSourceEventHighWatermark({
    state,
    event,
    isIgnoredEvent: isNonSupersedingThreadEvent,
  });
  // Persist a secret-masked copy; keep the in-memory `event` (with original
  // content) for command routing and worker dispatch below.
  await state.appendJsonl('memory/events.jsonl', redactEventSecrets(event));
  if (isHelpCommandRequest(message.content)) {
    await handleHelpCommandRequest(event);
    return;
  }
  const styleCommand = parseStyleCommand(message.content);
  if (styleCommand) {
    await handleStyleCommandRequest(event, styleCommand);
    return;
  }
  if (isYoloCommandRequest(message.content)) {
    await handleYoloCommandRequest(event);
    return;
  }
  if (isGodCommandRequest(message.content)) {
    await handleGodCommandRequest(event);
    return;
  }
  if (isRepoCommandRequest(message.content)) {
    await handleRepoCommandRequest(event);
    return;
  }
  if (isVerboseCommandRequest(message.content)) {
    await handleVerboseCommandRequest(event);
    return;
  }
  if (isQuietCommandRequest(message.content)) {
    await handleQuietCommandRequest(event);
    return;
  }
  if (isFastCommandRequest(message.content)) {
    await handleFastCommandRequest(event);
    return;
  }
  if (isUnfastCommandRequest(message.content)) {
    await handleUnfastCommandRequest(event);
    return;
  }
  const modelEffortCommand = parseModelEffortCommand(message.content);
  if (modelEffortCommand) {
    await handleModelEffortCommandRequest(event, modelEffortCommand);
    return;
  }
  if (isModelCommandRequest(message.content)) {
    await handleModelCommandRequest(event);
    return;
  }
  if (isEffortCommandRequest(message.content)) {
    await handleEffortCommandRequest(event);
    return;
  }
  if (isUsageCommandRequest(message.content)) {
    await handleUsageCommandRequest(event);
    return;
  }
  if (isStatusCommandRequest(message.content)) {
    await handleStatusCommandRequest(event);
    return;
  }
  if (isCancelCommandRequest(message.content)) {
    await handleCancelCommandRequest(event);
    return;
  }
  if (isReserveCommandRequest(message.content)) {
    await handleReserveCommandRequest(event);
    return;
  }
  const gitPollCommand = parseGitPollCommand(message.content);
  if (gitPollCommand) {
    await handleGitPollCommandRequest(event, gitPollCommand, message);
    return;
  }
  if (await maybeHandlePendingAskResponse(event, message.content)) {
    return;
  }
  if (await maybeHandleModelSelectionResponse(event, message.content)) {
    return;
  }
  if (await maybeHandleEffortSelectionResponse(event, message.content)) {
    return;
  }
  const jobStartCommands = parseJobStartCommands(message.content);
  if (jobStartCommands && await maybeHandleJobStartCommands(
    event,
    jobStartCommands,
    persistedNewerThreadEvent,
  )) {
    return;
  }

  if (isRebootRequest(message.content)) {
    // A durable platform event is normally marked done after this function
    // returns. A reboot exits the Workbench before that normal completion path
    // can run, so the next generation would reclaim the still-processing row
    // and execute `/reboot` again forever. Complete this one-shot control event
    // before handing control to the restart coordinator; the next generation
    // will then acknowledge the already-consumed inbox row and continue booting.
    if (durableEnvelope) {
      await completeDurableMessageProcessing(systemState(), message, {
        ownerId: v3WorkbenchRuntime?.instanceId || durableEnvelope.messageId,
      });
      await logSystem('durable-restart-command-completed-before-restart', {
        messageId: message.id,
        channelId: event.channelId,
        threadId: event.threadId,
        ownerId: v3WorkbenchRuntime?.instanceId || durableEnvelope.messageId,
      });
    }
    await handleRebootRequest(message, event.channelId, event.threadId);
    return;
  }

  const queueWithoutInterrupt = isQueueCommandRequest(message.content);
  const enqueued = enqueueCodexJob(event, {
    ...enqueueOptions,
    supersedeQueuedThreadJobs: !queueWithoutInterrupt,
    persistedNewerThreadEvent,
  });
  if (queueWithoutInterrupt) {
    await logSystem('queue-command-enqueued-without-interrupt', {
      jobId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
    });
    return;
  }
  if (enqueued) await abortSupersededRunningThreadJobs(event);
}

async function scheduleThreadCreationRetry(message, scope, acknowledgement, { attempt = 1, reason = '' } = {}) {
  if (exceededThreadCreateAttempts(attempt)) {
    await abandonThreadCreation(message, scope, {
      reason: 'max-attempts-exceeded',
      detail: `gave up after ${attempt - 1} retries (cap ${MAX_THREAD_CREATE_ATTEMPTS}): ${reason}`,
    });
    return;
  }
  const delayMs = retryDelayMs(attempt);
  const pending = {
    id: message.id,
    status: 'retry-scheduled',
    attempt,
    delayMs,
    retryAt: new Date(Date.now() + delayMs).toISOString(),
    reason,
    message,
    scope,
    acknowledgement,
  };
  await channelState(scope.channelId).appendJsonl('pending-thread/jobs.jsonl', {
    ...pending,
    message: compactMessageForState(message),
  });
  await logSystem('thread-create-retry-scheduled', {
    messageId: message.id,
    channelId: scope.channelId,
    attempt,
    delayMs,
    reason,
  });
  setTimeout(() => retryThreadCreation(pending).catch((error) =>
    logSystem('thread-create-retry-error', {
      messageId: message.id,
      channelId: scope.channelId,
      attempt,
      error: formatErrorDetail(error),
    }),
  ), delayMs);
}

async function retryThreadCreation(pending) {
  const threadId = await ensureWorkThread(pending.message, pending.scope);
  if (threadId === THREAD_CREATE_ABANDONED) return;
  if (!threadId) {
    await scheduleThreadCreationRetry(pending.message, pending.scope, pending.acknowledgement, {
      attempt: pending.attempt + 1,
      reason: 'thread creation still failing',
    });
    return;
  }

  await channelState(pending.scope.channelId).appendJsonl('pending-thread/jobs.jsonl', {
    id: pending.message.id,
    status: 'thread-created',
    finishedAt: new Date().toISOString(),
    attempt: pending.attempt,
    threadId,
  });
  const event = buildMessageEvent(pending.message, pending.scope.channelId, threadId, pending.acknowledgement);
  await recordAndDispatchEvent(event, pending.message);
}

// Records a terminal `abandoned` state for a message whose thread can never be
// created. Because recoverPendingThreadCreations only re-arms `retry-scheduled`
// records and reads the latest entry per id, this stops the retry loop for good
// and survives restarts.
async function abandonThreadCreation(message, scope, { reason, detail = '' } = {}) {
  await channelState(scope.channelId).appendJsonl('pending-thread/jobs.jsonl', {
    id: message.id,
    status: 'abandoned',
    finishedAt: new Date().toISOString(),
    reason,
    detail,
  });
  await logSystem('thread-create-abandoned', {
    channelId: scope.channelId,
    messageId: message.id,
    reason,
    detail,
  });
  // Never drop a user request silently: tell the user this message could not
  // be processed and how to retry.
  await postSystemMessage(scope.channelId, [
    '작업 스레드 생성 실패',
    `사유: ${reason}`,
    '이 메시지는 처리되지 않았습니다. 내용을 일반 메시지로 다시 보내주세요.',
  ].join('\n'), {
    purpose: 'thread-create-abandoned',
    options: {
      message_reference: {
        message_id: message.id,
        channel_id: scope.channelId,
        fail_if_not_exists: false,
      },
    },
  }).catch((error) => logSystem('thread-create-abandoned-notify-failed', {
    channelId: scope.channelId,
    messageId: message.id,
    error: formatErrorDetail(error),
  }).catch(() => {}));
}

function compactMessageForState(message) {
  return {
    id: message.id,
    channel_id: message.channel_id,
    timestamp: message.timestamp,
    author: message.author,
    content: message.content || '',
    attachments: message.attachments || [],
    embeds: compactEmbeds(message.embeds),
    referenced_message: compactReferencedMessage(message.referenced_message || message.referencedMessage),
    message_snapshots: compactMessageSnapshots(message).map((snapshot) => ({ message: snapshot })),
  };
}

// Forwarded messages arrive with empty content and the real body inside
// message_snapshots; losing it breaks worker context ("본문 loss").
function compactMessageSnapshots(message) {
  return (message?.message_snapshots || [])
    .map((snapshot) => snapshot?.message || snapshot || null)
    .filter(Boolean)
    .map((snapshot) => ({
      timestamp: snapshot.timestamp || '',
      content: snapshot.content || '',
      attachments: compactAttachments(snapshot.attachments),
      embeds: compactEmbeds(snapshot.embeds),
    }))
    .filter((snapshot) => snapshot.content || snapshot.attachments.length > 0 || snapshot.embeds.length > 0);
}

function compactReferencedMessage(message) {
  if (!message) return null;
  return {
    id: message.id || '',
    channel_id: message.channel_id || '',
    timestamp: message.timestamp || '',
    author: message.author || null,
    content: message.content || '',
    attachments: compactAttachments(message.attachments),
    embeds: compactEmbeds(message.embeds),
  };
}

function compactAttachments(attachments = []) {
  return (attachments || []).map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    url: attachment.url,
    content_type: attachment.content_type,
  }));
}

function compactEmbeds(embeds = []) {
  return (embeds || []).map((embed) => ({
    title: embed.title || '',
    description: embed.description || '',
    url: embed.url || '',
    type: embed.type || '',
  })).filter((embed) => embed.title || embed.description || embed.url || embed.type);
}

// threadId -> allowed parent channelId ('' when the thread is not in scope).
// A thread's parent never changes, so resolving it once per process is enough;
// without this every thread message paid a Discord REST round-trip.
const threadParentCache = new Map();
const THREAD_PARENT_CACHE_MAX = 5000;

async function resolveScope(message) {
  const channelId = String(message.channel_id);
  if (config.discord.allowedChannelIds.has(channelId)) {
    return { channelId, threadId: channelId, inThread: false };
  }

  const cachedParentId = threadParentCache.get(channelId);
  if (cachedParentId !== undefined) {
    return cachedParentId ? { channelId: cachedParentId, threadId: channelId, inThread: true } : null;
  }

  let channel = null;
  try {
    channel = await api.getChannel(channelId);
  } catch (error) {
    // Transient lookup failure: do not cache, and leave a trace instead of
    // silently dropping the message.
    await logSystem('scope-resolve-failed', {
      channelId,
      messageId: message.id,
      error: formatErrorDetail(error),
    });
    if (v3WorkbenchMode) throw error;
    return null;
  }
  const parentId = channel?.parent_id ? String(channel.parent_id) : '';
  const allowedParentId = parentId && config.discord.allowedChannelIds.has(parentId) ? parentId : '';
  if (threadParentCache.size >= THREAD_PARENT_CACHE_MAX) threadParentCache.clear();
  threadParentCache.set(channelId, allowedParentId);
  return allowedParentId ? { channelId: allowedParentId, threadId: channelId, inThread: true } : null;
}

async function ensureWorkThread(message, scope) {
  if (scope.inThread || config.discord.threadMode !== 'per_message') return scope.threadId;
  if (message.thread?.id) return String(message.thread.id);

  const threadSeedText = message.content
    || compactMessageSnapshots(message)[0]?.content
    || 'Codex 작업';
  try {
    const thread = await api.createThreadFromMessage(
      scope.channelId,
      message.id,
      threadSeedText,
      config.discord.autoArchiveDuration,
    );
    return String(thread.id);
  } catch (error) {
    const existingThreadId = await existingThreadForMessage(scope.channelId, message.id);
    if (existingThreadId) return existingThreadId;
    const permanent = isNonRetryableThreadCreateError(error);
    await logSystem('thread-create-failed', {
      channelId: scope.channelId,
      messageId: message.id,
      error: formatErrorDetail(error),
      ...(permanent ? { permanent: true } : {}),
    });
    if (permanent) {
      // Some messages can never host a thread (e.g. forwarded messages,
      // Discord error 50068). Dropping the request silently was a major pain
      // point, so fall back to a standalone work thread in the same channel.
      const fallbackThreadId = await createStandaloneWorkThread(message, scope, threadSeedText);
      if (fallbackThreadId) return fallbackThreadId;
      await abandonThreadCreation(message, scope, {
        reason: 'unthreadable-message',
        detail: formatErrorDetail(error),
      });
      return THREAD_CREATE_ABANDONED;
    }
    return null;
  }
}

async function createStandaloneWorkThread(message, scope, name) {
  try {
    const thread = await api.createThread(scope.channelId, name, config.discord.autoArchiveDuration);
    if (!thread?.id) return null;
    await logSystem('thread-create-fallback-standalone', {
      channelId: scope.channelId,
      messageId: message.id,
      threadId: String(thread.id),
    });
    return String(thread.id);
  } catch (error) {
    await logSystem('thread-create-fallback-failed', {
      channelId: scope.channelId,
      messageId: message.id,
      error: formatErrorDetail(error),
    });
    return null;
  }
}

async function existingThreadForMessage(channelId, messageId) {
  const refreshed = await api.getMessage(channelId, messageId).catch(() => null);
  return refreshed?.thread?.id ? String(refreshed.thread.id) : null;
}

async function handleRebootRequest(message, channelId, threadId) {
  const reason = rebootReasonFromMessage(message);
  await requestServiceRestart({
    reason,
    improvement: '요청에 따라 서비스 재시작',
    channelId,
    threadId,
    messageId: message.id,
    source: 'manual',
  });
}

async function handleTodoListRequest(message, scope, acknowledgement) {
  const todoState = await readChannelTodoState(config, scope.channelId);
  const delivery = await postSystemMessage(message.channel_id, formatActiveTodoList(todoState), {
    purpose: 'todo-list-command',
    options: {
      message_reference: {
        message_id: message.id,
        channel_id: message.channel_id,
      },
    },
  });
  await logSystem('todo-list-command-handled', {
    messageId: message.id,
    channelId: scope.channelId,
    destinationId: message.channel_id,
    acknowledged: acknowledgement.ok,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleTodoCommandRequest(message, scope, acknowledgement, todoCommand) {
  const result = await applyTodoCommand(config, scope.channelId, todoCommand, { id: message.id });
  const todoState = await readChannelTodoState(config, scope.channelId);
  const delivery = await postSystemMessage(message.channel_id, formatTodoCommandResult(result, todoState), {
    purpose: 'todo-fast-command',
    options: {
      message_reference: {
        message_id: message.id,
        channel_id: message.channel_id,
        fail_if_not_exists: false,
      },
    },
  });
  await logSystem('todo-fast-command-handled', {
    messageId: message.id,
    channelId: scope.channelId,
    destinationId: message.channel_id,
    action: todoCommand.action,
    ok: result.ok,
    reason: result.reason || null,
    todoId: result.entry?.id || null,
    acknowledged: acknowledgement.ok,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

// A message that is only a mistyped control used to be dispatched as if it were
// a task: a work thread was created and a worker spent a full job on the typo.
// Answer it in place with one fixed line, before any of that machinery starts.
async function handleUnknownCommandRequest(message, scope, acknowledgement, command) {
  const delivery = await postSystemMessage(message.channel_id, UNKNOWN_COMMAND_MESSAGE, {
    purpose: 'unknown-command',
    options: {
      message_reference: {
        message_id: message.id,
        channel_id: message.channel_id,
        fail_if_not_exists: false,
      },
    },
  });
  await logSystem('unknown-command-handled', {
    messageId: message.id,
    channelId: scope.channelId,
    destinationId: message.channel_id,
    command,
    acknowledged: acknowledgement.ok,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleHelpCommandRequest(event) {
  const commandPrefix = event.platform === 'slack' ? '!' : '/';
  const delivery = await postSystemMessage(event.threadId, formatBridgeHelpSummary({ commandPrefix }), {
    purpose: 'help-command',
  });
  await logSystem('help-command', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    platform: event.platform || 'discord',
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleStyleCommandRequest(event, command) {
  const currentStyleId = readThreadRichStyleIdSync(config, event.channelId, event.threadId);
  if (!command.selector) {
    const delivery = await postSystemMessage(event.threadId, [
      'Rendering themes',
      '',
      formatRichStylePresetList(currentStyleId),
      '',
      'Select one with `/style <number-or-id>` (Slack: `!style <number-or-id>`).',
    ].join('\n'), {
      purpose: 'style-command',
      options: {
        styleId: currentStyleId,
        includeStylePreview: true,
      },
    });
    await logSystem('style-command-listed', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      currentStyleId,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const selected = richStyleBySelector(command.selector);
  if (!selected) {
    const delivery = await postSystemMessage(event.threadId, [
      `Unknown rendering theme: ${command.selector}`,
      'Use one of these numbers or IDs:',
      formatRichStylePresetList(currentStyleId),
    ].join('\n'), {
      purpose: 'style-command-invalid',
      options: { styleId: currentStyleId },
    });
    await logSystem('style-command-invalid', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      selector: command.selector,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const status = writeThreadRichStyleSync(config, event, selected.id);
  const styleId = status?.richStyleId || selected.id;
  const delivery = await postSystemMessage(
    event.threadId,
    `Rendering theme selected for this thread: ${selected.name} \`${styleId}\`.`,
    { purpose: 'style-command-selected', options: { styleId } },
  );
  await logSystem('style-command-selected', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    styleId,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleYoloCommandRequest(event) {
  const context = writeThreadRepoAccessSync(config, event);
  if (context?.repoPath) await ensureDir(context.repoPath);
  const upgrade = await restartRunningThreadJobsForAccess(event, context);
  const lines = [
    'bridge 레포를 포함한 전역 레포 권한을 저장했습니다.',
    '이후 모든 스레드의 작업은 `/yolo` 없이도 bridge 레포를 직접 수정할 수 있습니다.',
  ];
  if (upgrade.requeued > 0) {
    lines.push(`현재 스레드의 실행 중 작업 ${upgrade.requeued}개를 새 권한으로 이어서 재시작합니다.`);
  }
  const delivery = await postSystemMessage(event.threadId, [
    ...lines,
  ].join('\n'), { purpose: 'yolo-command' });
  await logSystem('yolo-command-handled', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    repoPath: context?.repoPath || null,
    repoAccessScope: context?.repoAccessScope || null,
    requeuedJobs: upgrade.requeued,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleGodCommandRequest(event) {
  const context = resolveThreadRepoContextSync(config, {
    channelId: event.channelId,
    threadId: event.threadId,
    stateAccess: true,
    stateAccessDirective: true,
    repoAccessDirective: true,
  });
  const upgrade = await restartRunningThreadJobsForAccess(event, {
    ...context,
    stateAccess: true,
  });
  const lines = [
    'God 권한은 sticky로 저장하지 않습니다.',
    '새 작업은 작업 메시지에 `/god`를 붙이면 그 job에만 전체 state 접근이 적용됩니다.',
  ];
  if (upgrade.requeued > 0) {
    lines.push(`실행 중 작업 ${upgrade.requeued}개를 God 모드 권한으로 이어서 재시작합니다.`);
  }
  const delivery = await postSystemMessage(event.threadId, [
    ...lines,
  ].join('\n'), { purpose: 'god-command' });
  await logSystem('god-command-handled', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    repoPath: context?.repoPath || null,
    stateAccess: Boolean(context?.stateAccess),
    requeuedJobs: upgrade.requeued,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleRepoCommandRequest(event) {
  const context = writeThreadRepositoryRootSync(config, event);
  if (context?.repoPath) await ensureDir(context.repoPath);
  const upgrade = await restartRunningThreadJobsForAccess(event, context);
  const lines = [
    '이 스레드의 repository root를 `.bridge_state/repositories`로 저장했습니다.',
    '이후 이 스레드의 작업은 해당 경로를 repo 작업 루트로 참조합니다.',
  ];
  if (upgrade.requeued > 0) {
    lines.push(`실행 중 작업 ${upgrade.requeued}개를 새 repo root로 이어서 재시작합니다.`);
  }
  const delivery = await postSystemMessage(event.threadId, lines.join('\n'), { purpose: 'repo-command' });
  await logSystem('repo-command-handled', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    repoPath: context?.repoPath || null,
    requeuedJobs: upgrade.requeued,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleVerboseCommandRequest(event) {
  const context = writeThreadVerboseProgressSync(config, event, true);
  const upgrade = await restartRunningThreadJobsForVerbose(event, true);
  const lines = [
    '이 스레드의 verbose 진행 로그를 켰습니다.',
    '이후 이 스레드의 작업은 `/verbose` 없이도 명령 실행 진행 로그를 포함합니다.',
  ];
  if (upgrade.requeued > 0) {
    lines.push(`실행 중 작업 ${upgrade.requeued}개를 verbose 진행 로그로 이어서 재시작합니다.`);
  }
  const delivery = await postSystemMessage(event.threadId, lines.join('\n'), { purpose: 'verbose-command' });
  await logSystem('verbose-command-handled', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    verboseProgress: Boolean(context?.verboseProgress),
    requeuedJobs: upgrade.requeued,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleQuietCommandRequest(event) {
  const context = writeThreadVerboseProgressSync(config, event, false, { source: 'quiet-command' });
  const upgrade = await restartRunningThreadJobsForVerbose(event, false);
  const lines = [
    '이 스레드의 verbose 진행 로그를 껐습니다.',
    '이후 이 스레드의 작업은 `/verbose`를 다시 켜기 전까지 요약 진행 로그만 표시합니다.',
  ];
  if (upgrade.requeued > 0) {
    lines.push(`실행 중 작업 ${upgrade.requeued}개를 quiet 진행 로그로 이어서 재시작합니다.`);
  }
  const delivery = await postSystemMessage(event.threadId, lines.join('\n'), { purpose: 'quiet-command' });
  await logSystem('quiet-command-handled', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    verboseProgress: Boolean(context?.verboseProgress),
    requeuedJobs: upgrade.requeued,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleFastCommandRequest(event) {
  const context = writeThreadCodexFastModeSync(config, event, true);
  const delivery = await postSystemMessage(event.threadId, [
    '이 스레드의 Codex Fast mode를 켰습니다.',
    '이후 지원되는 Codex 모델은 Fast service tier로 실행됩니다.',
    'Fast mode는 응답 속도를 높이는 대신 더 많은 크레딧을 사용하며, Codex-Spark와 다른 provider에는 적용되지 않습니다.',
  ].join('\n'), { purpose: 'fast-command' });
  await logSystem('fast-command-handled', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    codexFastMode: Boolean(context?.codexFastMode),
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleUnfastCommandRequest(event) {
  const context = writeThreadCodexFastModeSync(config, event, false);
  const delivery = await postSystemMessage(event.threadId, [
    '이 스레드의 Codex Fast mode를 껐습니다.',
    '이후 Codex 작업은 기본 Standard service tier로 실행됩니다.',
  ].join('\n'), { purpose: 'unfast-command' });
  await logSystem('unfast-command-handled', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    codexFastMode: Boolean(context?.codexFastMode),
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleModelCommandRequest(event) {
  const directSelectors = modelCommandSelectionSequenceFromContent(event.content || '');
  if (directSelectors) {
    await applyModelSelectionSelectors(event, directSelectors, { requirePendingSelection: false });
    return;
  }

  const status = requestThreadModelSelectionSync(config, event);
  const usageSummary = await collectCachedUsageSummary(config);
  const lines = [
    '사용할 모델 번호나 별칭을 답해주세요.',
    formatThreadModelOptionsCodeBlock(config, { usageSummary }),
    '30분 안에 번호 하나만 보내면 그 모델 하나로 고정됩니다 (폴백 없음).',
    '"3 4 1"처럼 번호 여러 개를 보내면 그 순서대로 폴백 체인이 고정됩니다.',
    'Claude 행은 모델과 계정이 한 세트입니다. 별칭: fable:primary, opus:secondary.',
    '그 외 별칭: sol, terra, luna, fable, opus, agy-opus, gemini, spark.',
  ];
  if (status?.threadModelOverride) {
    lines.push(`현재 모델: ${formatThreadModelOverrideLabel(status.threadModelOverride)}`);
  }
  const delivery = await postSystemMessage(event.threadId, lines.join('\n'), { purpose: 'model-command' });
  await logSystem('model-command-listed', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    optionCount: threadModelSelectionOptions(config).length,
    currentModel: status?.threadModelOverride?.label || null,
    usageCheckedAt: usageSummary.checkedAt,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleModelEffortCommandRequest(event, command) {
  await applyModelSelectionSelectors(event, command.modelSelectors, {
    requirePendingSelection: false,
    effortSelectors: command.effortSelectors,
  });
}

async function maybeHandleJobStartCommands(event, command, persistedNewerThreadEvent = null) {
  const hasYolo = command.commands.includes('yolo');
  const hasRepo = command.commands.includes('repo');
  const hasQueue = command.commands.includes('queue');
  const hasSupersede = command.commands.includes('supersede');
  const hasAccessCommand = hasYolo || hasRepo;
  const hasModelCommand = command.commands.includes('model');
  const hasEffortCommand = command.commands.includes('effort');
  const hasParameterizedCommand = hasModelCommand || hasEffortCommand;

  if (!hasAccessCommand && !hasParameterizedCommand && !hasQueue && !hasSupersede) return false;
  if (!command.parameterCommandsComplete && !hasAccessCommand && !hasQueue && !hasSupersede) return false;

  if (command.parameterCommandsComplete && hasParameterizedCommand) {
    if (hasModelCommand) {
      await applyModelSelectionSelectors(event, command.modelSelectors, {
        requirePendingSelection: false,
        effortSelectors: hasEffortCommand ? command.effortSelectors : null,
      });
    } else {
      await applyEffortSelections(event, command.effortSelectors, {
        requirePendingSelection: false,
      });
    }

    const selected = readThreadStatusSync(config, event.channelId, event.threadId)
      ?.threadModelOverride;
    if (String(selected?.selectedByMessageId || '') !== String(event.id || '')) {
      // The selection handler already explained an invalid selector, count
      // mismatch, unsupported effort, or unavailable account. Do not start the
      // task under stale settings after an explicit complete control failed.
      return true;
    }
  }

  const accessContext = applyJobStartAccessCommands(event, {
    yolo: hasYolo,
    repo: hasRepo,
  });
  const taskContent = command.parameterCommandsComplete
    ? command.taskContent
    : command.contentWithoutAccessCommands;
  if (!taskContent) {
    if (accessContext) {
      const upgrade = await restartRunningThreadJobsForAccess(event, accessContext);
      const applied = [
        hasYolo ? '/yolo' : null,
        hasRepo ? '/repo' : null,
      ].filter(Boolean);
      const lines = [
        `작업 시작 명령을 적용했습니다: ${applied.join(', ')}`,
      ];
      if (!command.parameterCommandsComplete) {
        lines.push('불완전한 /model 또는 /effort 명령은 적용하지 않았습니다.');
      }
      if (upgrade.requeued > 0) {
        lines.push(`실행 중 작업 ${upgrade.requeued}개를 새 권한으로 이어서 재시작합니다.`);
      }
      await postSystemMessage(event.threadId, lines.join('\n'), {
        purpose: 'job-start-access-commands',
      });
    }
    return true;
  }

  const jobEvent = {
    ...event,
    content: taskContent,
    startupCommands: {
      commands: command.commands,
      modelSelectors: command.parameterCommandsComplete ? command.modelSelectors : null,
      effortSelectors: command.parameterCommandsComplete ? command.effortSelectors : null,
      parameterCommandsComplete: command.parameterCommandsComplete,
    },
  };
  const queueWithoutInterrupt = isQueueCommandRequest(event.content);
  const enqueued = enqueueCodexJob(jobEvent, {
    repoAccess: hasAccessCommand ? true : undefined,
    repoPath: accessContext?.repoPath || null,
    supersedeQueuedThreadJobs: !queueWithoutInterrupt,
    persistedNewerThreadEvent,
  });
  await logSystem('job-start-commands-applied', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    commands: command.commands,
    modelSelectors: command.parameterCommandsComplete ? command.modelSelectors : null,
    effortSelectors: command.parameterCommandsComplete ? command.effortSelectors : null,
    parameterCommandsComplete: command.parameterCommandsComplete,
    taskContent,
    enqueued,
  });
  if (queueWithoutInterrupt) {
    await logSystem('queue-command-enqueued-without-interrupt', {
      jobId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
    });
    return true;
  }
  if (enqueued) await abortSupersededRunningThreadJobs(jobEvent);
  return true;
}

async function handleCancelCommandRequest(event) {
  const cancelledQueued = cancelQueuedThreadJobs(event);
  const cancelledRunning = await cancelRunningThreadJobs(event);
  const delivery = await postSystemMessage(event.threadId, [
    '이 스레드의 작업을 취소했습니다.',
    `queued: ${cancelledQueued}`,
    `running: ${cancelledRunning}`,
  ].join('\n'), { purpose: 'cancel-command' });
  await logSystem('cancel-command', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    cancelledQueued,
    cancelledRunning,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

function applyJobStartAccessCommands(event, { yolo = false, repo = false } = {}) {
  let context = null;
  // Keep the established directive order: select the channel repository root
  // first, then let /yolo grant global bridge access without losing that root.
  if (repo) {
    context = writeThreadRepositoryRootSync(config, event, {
      source: 'job-start-repo-command',
    });
  }
  if (yolo) {
    context = writeThreadRepoAccessSync(config, {
      ...event,
      repoPath: context?.repoPath || null,
    }, {
      source: 'job-start-yolo-command',
    });
  }
  if (context?.repoPath) fsSync.mkdirSync(context.repoPath, { recursive: true });
  return context;
}

async function maybeHandlePendingAskResponse(event, content) {
  if (!config.activeAsks?.enabled) return false;
  const activeAsk = await activePendingAskForThread(event.channelId, event.threadId);
  if (!activeAsk) return false;

  const command = parsePendingAskCommand(content);
  if (command?.action === 'cancel') {
    await cancelPendingAsk(activeAsk, event);
    return true;
  }

  await answerPendingAsk(activeAsk, event);
  return true;
}

async function activePendingAskForThread(channelId, threadId) {
  const state = threadState(channelId, threadId);
  const entries = await state.readJsonl(PENDING_ASKS_FILE, { limit: 200 });
  const now = new Date();
  const expired = expiredPendingAsksFromEntries(entries, { now });
  for (const ask of expired) {
    await state.appendJsonl(PENDING_ASKS_FILE, {
      id: ask.id,
      status: 'expired',
      expiredAt: now.toISOString(),
      jobId: ask.jobId || null,
      channelId,
      threadId,
    });
    await logSystem('pending-ask-expired', {
      askId: ask.id,
      jobId: ask.jobId || null,
      channelId,
      threadId,
      expiresAt: ask.expiresAt || null,
    });
  }
  return activePendingAskFromEntries(entries, { now });
}

async function answerPendingAsk(activeAsk, event) {
  const now = new Date().toISOString();
  const answerJobId = continuationJobId(activeAsk.jobId || event.id);
  const answer = compactPendingAskAnswer({
    askId: activeAsk.id,
    askedJobId: activeAsk.jobId || null,
    askedAt: activeAsk.createdAt || null,
    answeredAt: now,
    answerMessageId: event.id,
    worker: activeAsk.worker || null,
    question: activeAsk.question || '',
    reason: activeAsk.reason || '',
    answer: event.content || '',
  });

  await threadState(event.channelId, event.threadId).appendJsonl(PENDING_ASKS_FILE, {
    id: activeAsk.id,
    status: 'answered',
    answeredAt: now,
    answerMessageId: event.id,
    answerJobId,
    jobId: activeAsk.jobId || null,
    channelId: event.channelId,
    threadId: event.threadId,
  });

  enqueueCodexJob(event, {
    id: answerJobId,
    recoveredFromJobId: activeAsk.jobId || null,
    repoAccess: Boolean(activeAsk.repoAccess),
    repoPath: activeAsk.repoPath || null,
    stateAccess: Boolean(activeAsk.stateAccess),
    richStyleId: normalizeRichStyleId(activeAsk.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(activeAsk.search),
    verboseProgress: Boolean(activeAsk.verboseProgress),
    priority: activeAsk.priority ?? PRIORITY.ACTIVE_THREAD_FOLLOW_UP,
    finalChannelId: activeAsk.finalChannelId || null,
    threadModelOverride: activeAsk.threadModelOverride || null,
    pendingAskAnswer: answer,
    supersedeQueuedThreadJobs: true,
  });

  await logSystem('pending-ask-answered', {
    askId: activeAsk.id,
    jobId: activeAsk.jobId || null,
    answerMessageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
  });
}

async function cancelPendingAsk(activeAsk, event) {
  const now = new Date().toISOString();
  await threadState(event.channelId, event.threadId).appendJsonl(PENDING_ASKS_FILE, {
    id: activeAsk.id,
    status: 'cancelled',
    cancelledAt: now,
    cancelledByMessageId: event.id,
    jobId: activeAsk.jobId || null,
    channelId: event.channelId,
    threadId: event.threadId,
  });
  const delivery = await postSystemMessage(event.threadId, '대기 중인 질문을 취소했습니다.', {
    purpose: 'pending-ask-cancelled',
  });
  await logSystem('pending-ask-cancelled', {
    askId: activeAsk.id,
    jobId: activeAsk.jobId || null,
    cancelledByMessageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function maybeHandleModelSelectionResponse(event, content) {
  const selectors = modelSelectionSequenceFromContent(content);
  if (!selectors) return false;

  return applyModelSelectionSelectors(event, selectors, { requirePendingSelection: true });
}

async function applyModelSelectionSelectors(event, selectors, {
  requirePendingSelection = true,
  effortSelectors = null,
} = {}) {
  if (!Array.isArray(selectors) || selectors.length === 0) return false;

  const status = readThreadStatusSync(config, event.channelId, event.threadId);
  if (requirePendingSelection && !isPendingModelSelectionActive(status?.pendingModelSelection)) return false;

  const matched = selectors.map((selector) => ({
    selector,
    option: modelOptionBySelector(config, selector),
  }));
  const invalid = matched.filter((entry) => !entry.option).map((entry) => entry.selector);
  if (invalid.length > 0) {
    const usageSummary = await collectCachedUsageSummary(config);
    const delivery = await postSystemMessage(event.threadId, [
      `모델 선택 ${invalid.map((value) => `"${value}"`).join(', ')}을 찾을 수 없습니다.`,
      formatThreadModelOptionsCodeBlock(config, { usageSummary }),
      '사용 가능한 별칭: sol, terra, luna, fable, opus, agy-opus, gemini, spark, fable:primary, opus:secondary',
    ].join('\n'), { purpose: 'model-command-invalid-selection' });
    await logSystem('model-command-invalid-selection', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      requestedSelectors: selectors,
      invalidSelectors: invalid,
      optionCount: threadModelSelectionOptions(config).length,
      usageCheckedAt: usageSummary.checkedAt,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return true;
  }

  // Collapse duplicate picks (e.g. "1 1") while preserving the order the user typed.
  const chosen = [];
  const seen = new Set();
  for (const entry of matched) {
    if (seen.has(entry.option.id)) continue;
    seen.add(entry.option.id);
    chosen.push(entry);
  }

  const effortResolution = effortSelectors
    ? resolveEffortAssignments(chosen.map((entry) => entry.option), effortSelectors)
    : null;
  if (effortResolution && !effortResolution.ok) {
    const delivery = await postSystemMessage(event.threadId, effortResolution.lines.join('\n'), {
      purpose: 'model-effort-command-invalid',
    });
    await logSystem('model-effort-command-invalid', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      requestedModelSelectors: selectors,
      requestedEffortSelectors: effortSelectors,
      reason: effortResolution.reason,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return true;
  }

  const unavailableClaudeAccounts = await unavailableClaudeAccountsForSelection(chosen);
  if (unavailableClaudeAccounts.length > 0) {
    const accountNames = unavailableClaudeAccounts
      .map(({ account }) => account?.label || account?.id || '선택한 계정')
      .join(', ');
    const loginCommands = unavailableClaudeAccounts
      .map(({ account }) => account?.home
        ? `\`HOME=${shellQuote(account.home)} ${shellQuote(config.claude.bin)} auth login\``
        : null)
      .filter(Boolean);
    const lines = [
      `Claude 계정 인증 필요: ${accountNames}. 모델 설정은 변경하지 않았습니다.`,
      '브리지 호스트에서 아래 명령으로 로그인한 뒤 같은 `/model` 선택을 다시 해주세요.',
      ...loginCommands,
    ];
    const delivery = await postSystemMessage(event.threadId, lines.join('\n'), {
      purpose: 'model-command-claude-auth-required',
    });
    await logSystem('model-command-claude-auth-required', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      requestedSelectors: selectors,
      claudeAccountIds: unavailableClaudeAccounts.map(({ account }) => account?.id || null),
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return true;
  }

  const updated = writeThreadModelOverrideSync(
    config,
    event,
    chosen.map((entry) => entry.option),
    {
      source: effortResolution ? 'model-effort-command' : 'model-command',
      effortOverrides: effortResolution?.efforts || null,
    },
  );
  const override = updated?.threadModelOverride;
  const isChain = Array.isArray(override?.chain) && override.chain.length > 1;
  const overrideEntries = modelOverrideEntries(override);
  const lines = effortResolution
    ? (isChain
        ? [
            `모델 폴백/effort 고정됨: ${chosen.map((entry, index) =>
              `${entry.selector}(${modelEffortValue(overrideEntries[index]) || '기본값'})`).join(' → ')}`,
            '앞 모델이 실패하면 다음 모델로 순서대로 폴백합니다.',
            '이 스레드의 이후 작업부터 적용됩니다.',
          ]
        : [
            `모델/effort 고정됨: ${chosen[0].selector}(${modelEffortValue(overrideEntries[0]) || '기본값'}) — ${override?.label || chosen[0].option.label}`,
            '이 모델 하나로만 실행합니다 (폴백 없음).',
            '이 스레드의 이후 작업부터 적용됩니다.',
          ])
    : (isChain
        ? [
            `모델 폴백 순서 고정됨: ${chosen.map((entry) => `${entry.selector}. ${entry.option.label}`).join(' → ')}`,
            '앞 모델이 실패하면 다음 모델로 순서대로 폴백합니다.',
            '이 스레드의 이후 작업부터 적용됩니다.',
          ]
        : [
            `모델 고정됨: ${override?.label || chosen[0].option.label}`,
            '이 모델 하나로만 실행합니다 (폴백 없음).',
            '이 스레드의 이후 작업부터 적용됩니다.',
          ]);
  const selectedEvent = effortResolution ? 'model-effort-command-selected' : 'model-command-selected';
  const delivery = await postSystemMessage(event.threadId, lines.join('\n'), { purpose: selectedEvent });
  await logSystem(selectedEvent, {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    requestedSelectors: selectors,
    requestedEffortSelectors: effortSelectors,
    selectedModels: chosen.map((entry) => entry.option.label),
    selectedWorkers: chosen.map((entry) => entry.option.worker),
    selectedEfforts: effortResolution ? overrideEntries.map(modelEffortValue) : null,
    pinned: !isChain,
    fallbackChain: isChain,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
  return true;
}

async function unavailableClaudeAccountsForSelection(entries) {
  const uniqueSelections = new Map();
  for (const { option } of entries) {
    if (option?.worker !== 'claude' || !option.claudeAccount?.id) continue;
    uniqueSelections.set(option.claudeAccount.id, option.claudeAccount);
  }
  const statuses = await Promise.all(
    [...uniqueSelections.values()].map((selection) => claudeAccountAuthenticationStatus(config, selection))
  );
  return statuses.filter((status) => !status.authenticated);
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function formatThreadModelOverrideLabel(override) {
  if (!override) return '';
  if (Array.isArray(override.chain) && override.chain.length > 1) {
    return override.chain.map((entry) => entry.label).join(' → ');
  }
  return override.label || '';
}

async function handleEffortCommandRequest(event) {
  const directSelectors = effortCommandSelectionSequenceFromContent(event.content || '');
  if (directSelectors) {
    await applyEffortSelections(event, directSelectors, { requirePendingSelection: false });
    return;
  }

  const directSelector = effortCommandSelectionFromContent(event.content || '');
  if (directSelector) {
    await applyEffortSelection(event, directSelector, { requirePendingSelection: false });
    return;
  }

  const target = currentEffortTargetForEvent(event);
  const options = effortOptionsForModel(target.family, target.model);
  if (options.length === 0) {
    clearPendingEffortSelectionSync(config, event, { source: 'effort-command-unsupported' });
    const label = target.currentModel?.label || target.defaultOption?.label || target.family;
    const delivery = await postSystemMessage(event.threadId, [
      `현재 모델은 CLI effort 조절을 지원하지 않습니다: ${label}`,
      'Codex/Claude 계열 모델에서만 /effort가 적용됩니다.',
    ].join('\n'), { purpose: 'effort-command-unsupported' });
    await logSystem('effort-command-unsupported', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      family: target.family,
      model: label,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  requestThreadEffortSelectionSync(config, event);

  const lines = [
    '사용할 effort 번호나 이름을 답해주세요.',
    ...options.map((opt, idx) => `${idx + 1}. ${opt}`),
    '30분 안에 번호나 이름을 보내면 이 스레드의 effort로 적용됩니다.',
    '`/effort max`처럼 한 줄로도 설정할 수 있습니다.',
  ];
  if (target.currentEffort) {
    lines.push(`현재 effort: ${target.currentEffort}`);
  }
  const delivery = await postSystemMessage(event.threadId, lines.join('\n'), { purpose: 'effort-command' });
  await logSystem('effort-command-listed', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    family: target.family,
    currentEffort: target.currentEffort,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function maybeHandleEffortSelectionResponse(event, content) {
  const selectors = effortSelectionSequenceFromContent(content);
  if (selectors) {
    return applyEffortSelections(event, selectors, { requirePendingSelection: true });
  }

  const selector = effortSelectionFromContent(content);
  if (!selector) return false;

  return applyEffortSelection(event, selector, { requirePendingSelection: true });
}

async function applyEffortSelection(event, selector, { requirePendingSelection = true } = {}) {
  return applyEffortSelections(event, [selector], { requirePendingSelection });
}

async function applyEffortSelections(event, selectors, { requirePendingSelection = true } = {}) {
  const status = readThreadStatusSync(config, event.channelId, event.threadId);
  const pending = status?.pendingEffortSelection;
  if (requirePendingSelection && (!pending || !isPendingModelSelectionActive(pending))) return false;

  const modelOptions = currentEffortModelOptionsForEvent(event, status);
  const resolution = resolveEffortAssignments(modelOptions, selectors);
  if (!resolution.ok) {
    if (resolution.reason === 'unsupported-model') {
      clearPendingEffortSelectionSync(config, event, { source: 'effort-command-unsupported' });
    }
    const delivery = await postSystemMessage(event.threadId, resolution.lines.join('\n'), {
      purpose: `effort-command-${resolution.reason}`,
    });
    await logSystem(`effort-command-${resolution.reason}`, {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      requestedSelections: selectors,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return true;
  }

  const updated = writeThreadEffortOverrideSync(config, event, resolution.efforts);
  const overrideEntries = modelOverrideEntries(updated?.threadModelOverride);
  const selectedLabel = updated?.threadModelOverride?.label || updated?.threadModelOverride?.worker;
  const lines = resolution.efforts.length > 1
    ? [
        `모델별 effort 고정됨: ${overrideEntries.map((entry) =>
          `${entry.label || entry.worker}(${modelEffortValue(entry) || '기본값'})`).join(' → ')}`,
        '이 스레드의 이후 작업부터 적용됩니다.',
      ]
    : [
        `effort 고정됨: ${resolution.efforts[0]} (모델: ${selectedLabel})`,
        '이 스레드의 이후 작업부터 적용됩니다.',
      ];
  const delivery = await postSystemMessage(event.threadId, lines.join('\n'), { purpose: 'effort-command-selected' });
  await logSystem('effort-command-selected', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    selectedEfforts: resolution.efforts,
    models: overrideEntries.map((entry) => entry.label || entry.worker),
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
  return true;
}

function resolveEffortAssignments(modelOptions, selectors) {
  if (!Array.isArray(modelOptions) || modelOptions.length === 0
    || !Array.isArray(selectors) || selectors.length === 0) {
    return {
      ok: false,
      reason: 'invalid-selection',
      lines: ['적용할 모델과 effort 선택을 찾을 수 없습니다.'],
    };
  }

  const positional = selectors.length > 1;
  if (positional && selectors.length !== modelOptions.length) {
    return {
      ok: false,
      reason: 'count-mismatch',
      lines: [
        `모델 ${modelOptions.length}개에 대해 effort ${selectors.length}개가 지정되었습니다. 설정은 변경하지 않았습니다.`,
        'effort 하나는 모든 지원 모델에 공통 적용하고, 여러 개는 모델 수와 같아야 합니다.',
      ],
    };
  }

  const targets = positional ? modelOptions : [modelOptions[0]];
  const efforts = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const family = cliEffortFamily(target?.worker, target?.model);
    const options = effortOptionsForModel(family, target?.model || '');
    const label = target?.label || target?.worker || family;
    if (options.length === 0) {
      return {
        ok: false,
        reason: 'unsupported-model',
        lines: [
          `CLI effort 조절을 지원하지 않는 모델입니다: ${label}. 설정은 변경하지 않았습니다.`,
          'Codex/Claude 계열 모델에서만 /effort가 적용됩니다.',
        ],
      };
    }

    const selector = selectors[index];
    const numericIndex = /^\d+$/.test(selector) ? Number.parseInt(selector, 10) - 1 : -1;
    const selectedEffort = numericIndex >= 0
      ? options[numericIndex]
      : options.find((option) => option.toLowerCase() === selector.toLowerCase());
    if (!selectedEffort) {
      return {
        ok: false,
        reason: 'invalid-selection',
        lines: [
          `effort 선택 "${selector}"은 ${label}에서 사용할 수 없습니다. 설정은 변경하지 않았습니다.`,
          ...options.map((option, optionIndex) => `${optionIndex + 1}. ${option}`),
        ],
      };
    }
    efforts.push(selectedEffort);
  }

  return { ok: true, efforts };
}

function currentEffortModelOptionsForEvent(event, status = null) {
  const context = status || readThreadStatusSync(config, event.channelId, event.threadId);
  const currentModel = context?.threadModelOverride || null;
  if (currentModel) return modelOverrideEntries(currentModel);

  const isCompany = config.workers?.companyChannelIds?.has(String(event.channelId || ''));
  const defaultOption = defaultThreadModelFallbackChain(config, { company: isCompany })[0];
  return defaultOption ? [defaultOption] : [];
}

function modelOverrideEntries(override) {
  if (!override) return [];
  return Array.isArray(override.chain) && override.chain.length > 0
    ? override.chain
    : [override];
}

function modelEffortValue(model) {
  return model?.effort || model?.reasoningEffort || '';
}

function currentEffortTargetForEvent(event, status = null) {
  const context = status || readThreadStatusSync(config, event.channelId, event.threadId);
  const currentModel = context?.threadModelOverride || null;
  if (currentModel) {
    return {
      currentModel,
      defaultOption: null,
      family: cliEffortFamily(currentModel.worker, currentModel.model),
      model: currentModel.model || '',
      currentEffort: currentModel.effort || currentModel.reasoningEffort || '',
    };
  }

  const isCompany = config.workers?.companyChannelIds?.has(String(event.channelId || ''));
  const defaultOption = defaultThreadModelFallbackChain(config, { company: isCompany })[0];
  const primaryWorker = defaultOption?.worker || 'codex';
  return {
    currentModel: null,
    defaultOption,
    family: cliEffortFamily(primaryWorker, defaultOption?.model || ''),
    model: defaultOption?.model || '',
    currentEffort: defaultOption?.effort || defaultOption?.reasoningEffort || '',
  };
}

function cliEffortFamily(worker, model) {
  const normalizedWorker = String(worker || '');
  if (normalizedWorker === 'antigravity') return 'antigravity';
  return ['codex', 'codex-spark', 'claude'].includes(normalizedWorker)
    ? getModelFamily(normalizedWorker, model)
    : 'other';
}

async function handleUsageCommandRequest(event) {
  const usageSummary = await collectCachedUsageSummary(config);
  const company = isCompanyEventChannel(event);
  const lines = formatLiveUsageSummary(usageSummary, config, { company });
  const delivery = await postSystemMessage(event.threadId, lines, { purpose: 'usage-command' });
  await logSystem('usage-command', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    usage: usageSummary.workers.map((worker) => ({
      id: worker.id,
      state: worker.state,
      plan: worker.plan || null,
      windows: (worker.windows || []).map((window) => ({
        key: window.key,
        usedPercent: window.usedPercent,
        remainingPercent: window.remainingPercent,
      })),
      source: worker.source,
    })),
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

// `/status` answers "what is switched on in this thread" from state only: no
// worker job, no API probe. Reads are non-mutating, so a status check never
// expires a pending ask or advances any schedule.
async function handleStatusCommandRequest(event) {
  const context = resolveThreadRepoContextSync(config, {
    channelId: event.channelId,
    threadId: event.threadId,
  });
  const modelChain = workerChainSummaryForJob(config, {
    channelId: event.channelId,
    threadId: event.threadId,
    threadModelOverride: context.threadModelOverride,
  });
  const state = threadState(event.channelId, event.threadId);
  const reservations = activeReservationsFromEntries(
    await state.readJsonl(RESERVED_COMMANDS_FILE, { limit: 1000 }),
  );
  const pendingAsk = config.activeAsks?.enabled
    ? activePendingAskFromEntries(await state.readJsonl(PENDING_ASKS_FILE, { limit: 200 }))
    : null;
  const activeGitPoll = findActiveGitPollForThread(event.channelId, event.threadId);
  const summary = formatThreadStatusSummary({
    repoAccess: context.repoAccess,
    repoPath: context.repoPath,
    bridgeRepoAccess: context.bridgeRepoAccess,
    stateAccess: context.stateAccess,
    storedRepoAccess: context.storedRepoAccess,
    globalRepoAccess: context.globalRepoAccess,
    verboseProgress: context.verboseProgress,
    codexFastMode: context.codexFastMode,
    modelChain,
    modelPinned: Boolean(context.threadModelOverride),
    effortPinned: Boolean(context.threadEffortOverride),
    activeReservationCount: reservations.length,
    activeGitPollLabel: activeGitPoll
      ? `${formatGitPollTarget(activeGitPoll)} (${formatDuration(activeGitPoll.intervalMs)} 간격)`
      : null,
    pendingAsk: Boolean(pendingAsk),
  }, { commandPrefix: threadControlPrefix(event.threadId) });
  const delivery = await postSystemMessage(event.threadId, summary, { purpose: 'status-command' });
  await logSystem('status-command', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    repoAccess: context.repoAccess,
    bridgeRepoAccess: context.bridgeRepoAccess,
    stateAccess: context.stateAccess,
    verboseProgress: context.verboseProgress,
    codexFastMode: context.codexFastMode,
    modelPinned: Boolean(context.threadModelOverride),
    modelChain: modelChain.map((entry) => entry.name),
    activeReservationCount: reservations.length,
    activeGitPoll: activeGitPoll?.id || null,
    pendingAsk: Boolean(pendingAsk),
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

// Slack consumes a leading slash as a platform slash command, so bridge
// controls are documented with `!` there and `/` on Discord.
function threadControlPrefix(threadId) {
  return parseSlackThreadStateId(threadId) ? '!' : '/';
}

async function handleReserveCommandRequest(event) {
  const command = parseReserveCommand(event.content || '');
  if (!command || command.action === 'help' || command.action === 'invalid' || command.errors?.length > 0) {
    const errors = command?.errors?.length ? ['', ...command.errors.map((error) => `- ${error}`)] : [];
    const delivery = await postSystemMessage(event.threadId, [
      formatReserveCommandUsage(),
      ...errors,
    ].join('\n'), { purpose: 'reserve-command-help' });
    await logSystem('reserve-command-help', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      errors: command?.errors || [],
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  if (command.action === 'list') {
    await handleReserveListCommand(event);
    return;
  }
  if (command.action === 'cancel') {
    await handleReserveCancelCommand(event, command);
    return;
  }

  const parsedTime = parseReserveTime(command.timeText);
  if (!parsedTime.ok) {
    const delivery = await postSystemMessage(event.threadId, [
      '예약 시간 오류',
      `사유: ${parsedTime.error}`,
      '',
      formatReserveCommandUsage(),
    ].join('\n'), { purpose: 'reserve-command-invalid-time' });
    await logSystem('reserve-command-invalid-time', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      timeText: command.timeText,
      error: parsedTime.error,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const model = buildReserveModelOverride(event, command.modelNumbers);
  if (model.invalidNumbers.length > 0) {
    const usageSummary = await collectCachedUsageSummary(config);
    const delivery = await postSystemMessage(event.threadId, [
      `모델 번호 ${model.invalidNumbers.join(', ')}번은 없습니다.`,
      formatThreadModelOptionsCodeBlock(config, { usageSummary }),
    ].join('\n'), { purpose: 'reserve-command-invalid-model' });
    await logSystem('reserve-command-invalid-model', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      requestedNumbers: command.modelNumbers,
      invalidNumbers: model.invalidNumbers,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const orderEvent = { ...event, content: command.order };
  const reserveContext = resolveThreadRepoContextSync(config, {
    channelId: event.channelId,
    threadId: event.threadId,
    repoAccess: jobNeedsRepoAccess({ event: orderEvent }),
    repoAccessDirective: repoAccessDirectiveFromContent(command.order),
    stateAccess: jobNeedsFullStateAccess({ event: orderEvent }),
    stateAccessDirective: stateAccessDirectiveFromContent(command.order),
  });
  const now = new Date();
  const reservation = {
    id: `reserve_${event.id}`,
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    scheduledAt: parsedTime.scheduledAt,
    scheduledLabel: parsedTime.label,
    expiresAt: new Date(Date.parse(parsedTime.scheduledAt) + 24 * 60 * 60_000).toISOString(),
    channelId: event.channelId,
    threadId: event.threadId,
    sourceMessageId: event.id,
    requesterId: event.authorId || null,
    requesterName: event.authorName || null,
    order: command.order,
    modelNumbers: command.modelNumbers,
    modelLabels: model.labels,
    threadModelOverride: compactThreadModelOverride(model.override),
    repoAccess: Boolean(reserveContext.repoAccess),
    repoPath: reserveContext.repoPath || null,
    stateAccess: Boolean(reserveContext.stateAccess),
    verboseProgress: Boolean(command.verboseProgress || verboseDirectiveFromContent(command.order)),
  };

  await threadState(event.channelId, event.threadId).appendJsonl(RESERVED_COMMANDS_FILE, reservation);
  scheduleReservedCommand(reservation);

  const delivery = await postSystemMessage(event.threadId, [
    '예약 설정됨',
    `id: ${reservation.id}`,
    `time: ${reservation.scheduledLabel}`,
    `model: ${reservation.modelLabels.length > 0 ? reservation.modelLabels.join(' -> ') : 'thread/default at run time'}`,
    `order: ${truncateLine(reservation.order, 240)}`,
  ].join('\n'), { purpose: 'reserve-command-scheduled' });
  await logSystem('reserve-command-scheduled', {
    reservationId: reservation.id,
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    scheduledAt: reservation.scheduledAt,
    modelLabels: reservation.modelLabels,
    repoAccess: reservation.repoAccess,
    repoPath: reservation.repoPath,
    stateAccess: reservation.stateAccess,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleReserveListCommand(event) {
  const entries = await threadState(event.channelId, event.threadId).readJsonl(RESERVED_COMMANDS_FILE, { limit: 1000 });
  const active = activeReservationsFromEntries(entries);
  const lines = active.length > 0
    ? ['활성 예약', ...active.map(formatReservedCommandLine)]
    : ['활성 예약이 없습니다.'];
  const delivery = await postSystemMessage(event.threadId, lines.join('\n'), { purpose: 'reserve-command-list' });
  await logSystem('reserve-command-list', {
    messageId: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    count: active.length,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function handleReserveCancelCommand(event, command) {
  const id = String(command.id || '').trim();
  if (!id) {
    const delivery = await postSystemMessage(event.threadId, [
      '취소할 예약 id를 지정하세요.',
      '`/reserve cancel reserve_...`',
    ].join('\n'), { purpose: 'reserve-command-cancel-missing-id' });
    await logSystem('reserve-command-cancel-missing-id', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const entries = await threadState(event.channelId, event.threadId).readJsonl(RESERVED_COMMANDS_FILE, { limit: 1000 });
  const active = activeReservationsFromEntries(entries);
  const target = active.find((reservation) => reservation.id === id);
  if (!target) {
    const delivery = await postSystemMessage(event.threadId, `active 예약을 찾지 못했습니다: ${id}`, {
      purpose: 'reserve-command-cancel-missing',
    });
    await logSystem('reserve-command-cancel-missing', {
      messageId: event.id,
      reservationId: id,
      channelId: event.channelId,
      threadId: event.threadId,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const activeTimer = activeReservedCommands.get(target.id);
  if (activeTimer?.timer) clearTimeout(activeTimer.timer);
  activeReservedCommands.delete(target.id);
  const now = new Date().toISOString();
  await threadState(event.channelId, event.threadId).appendJsonl(RESERVED_COMMANDS_FILE, {
    ...target,
    status: 'cancelled',
    updatedAt: now,
    cancelledAt: now,
    cancelledByMessageId: event.id,
  });
  const delivery = await postSystemMessage(event.threadId, `예약 취소됨: ${target.id}`, {
    purpose: 'reserve-command-cancelled',
  });
  await logSystem('reserve-command-cancelled', {
    messageId: event.id,
    reservationId: target.id,
    channelId: event.channelId,
    threadId: event.threadId,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

function buildReserveModelOverride(event, numbers = []) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return { override: null, labels: [], invalidNumbers: [] };
  }

  const matched = numbers.map((number) => ({
    number,
    option: modelOptionByNumber(config, number),
  }));
  const invalidNumbers = matched.filter((entry) => !entry.option).map((entry) => entry.number);
  if (invalidNumbers.length > 0) return { override: null, labels: [], invalidNumbers };

  const chosen = [];
  const seen = new Set();
  for (const entry of matched) {
    if (seen.has(entry.option.id)) continue;
    seen.add(entry.option.id);
    chosen.push(entry);
  }
  const selections = chosen.map((entry) => modelSelectionFromOption(entry.option, {
    messageId: event.id || null,
  }));
  const override = selections.length > 1
    ? { ...selections[0], chain: selections }
    : selections[0] || null;
  return {
    override,
    labels: chosen.map((entry) => `${entry.number}. ${entry.option.label}`),
    invalidNumbers: [],
  };
}

function formatReservedCommandLine(reservation) {
  const model = Array.isArray(reservation.modelLabels) && reservation.modelLabels.length > 0
    ? reservation.modelLabels.join(' -> ')
    : 'thread/default';
  return `- ${reservation.id}: ${formatReserveTimeLabel(reservation.scheduledAt)} | ${model} | ${truncateLine(reservation.order, 140)}`;
}

function truncateLine(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function handleGitPollCommandRequest(event, command, sourceMessage = null) {
  if (command.action === 'cancel') {
    const cancelled = await cancelGitPollsForThread(event.channelId, event.threadId, { reason: 'user-cancelled' });
    const delivery = await postSystemMessage(event.threadId, [
      cancelled > 0
        ? `git polling ${cancelled}개를 취소했습니다.`
        : '취소할 active git polling이 없습니다.',
    ].join('\n'), { purpose: 'git-poll-command' });
    await logSystem('git-poll-cancel-command', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      cancelled,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }
  if (command.action === 'edit') {
    await handleGitPollEditCommandRequest(event, command);
    return;
  }

  const normalized = normalizeGitPollRequest(command);
  const remote = command.remote || 'origin';
  let repoPath = null;
  let branch = command.branch || null;
  let status = null;
  let pollThread = null;
  try {
    const context = resolveThreadRepoContextSync(config, {
      channelId: event.channelId,
      threadId: event.threadId,
      repoAccess: true,
      repoAccessDirective: true,
    });
    repoPath = await resolveGitPollRepoPath({
      basePath: context?.repoPath || config.repositoriesRoot,
      repositoriesRoot: config.repositoriesRoot,
      requestedPath: command.repoPath,
    });
    branch = branch || await currentGitPollBranch(repoPath);
    status = await getHeadSyncStatus({
      cwd: repoPath,
      remote,
      branch,
      allowStoredRemoteFallback: false,
    });
    pollThread = await ensureGitPollWorkThread(event, sourceMessage, { repoPath, remote, branch });
    writeInheritedThreadStatusSync(config, {
      sourceChannelId: event.channelId,
      sourceThreadId: event.threadId,
      targetChannelId: event.channelId,
      targetThreadId: pollThread.threadId,
      sourceMessageId: event.id,
      repoPath,
      repoAccess: true,
    }, { source: 'git-poll-thread-inherit' });
    await recordGitPollForkEvent(event, pollThread);
  } catch (error) {
    const delivery = await postSystemMessage(event.threadId, [
      'git polling 설정 실패',
      `사유: ${formatErrorDetail(error)}`,
      '예: `/gitpoll interval=1m timeout=6h path=example-repo -- pull 뒤 검증 이어서`',
    ].join('\n'), { purpose: 'git-poll-command-failed' });
    await logSystem('git-poll-command-failed', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      error: formatErrorDetail(error),
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const now = new Date();
  const startAt = new Date(now.getTime() + normalized.startAfterMs);
  const poll = {
    id: `git_poll_${event.id}`,
    channelId: event.channelId,
    threadId: pollThread.threadId,
    sourceChannelId: event.channelId,
    sourceThreadId: event.threadId,
    sourceMessageId: event.id,
    createdAt: now.toISOString(),
    repoPath,
    remote,
    branch,
    baselineRemoteHead: status.remoteHead || status.localHead || null,
    baselineLocalHead: status.localHead || null,
    intervalMs: normalized.intervalMs,
    startAt: startAt.toISOString(),
    timeoutAt: new Date(startAt.getTime() + normalized.timeoutMs).toISOString(),
    task: normalized.task,
    requesterId: event.authorId || sourceMessage?.author?.id || null,
  };

  await appendGitPollState(poll, {
    status: 'active',
    createdAt: poll.createdAt,
    baselineStatus: compactHeadStatus(status),
  });
  scheduleGitPoll(poll);

  const lines = [
    `${discordUserMention(poll.requesterId)} git polling 설정됨`.trim(),
    `polling: ${formatGitPollTarget(poll)}`,
    `will do: ${poll.task}`,
    String(poll.threadId) !== String(poll.sourceThreadId) ? `source thread: <#${poll.sourceThreadId}>` : null,
    `baseline remote: ${shortSha(poll.baselineRemoteHead) || 'unknown'}`,
    `starts: ${formatGitPollStart(poll.startAt)}`,
    `interval: ${formatDuration(poll.intervalMs)}, timeout: ${poll.timeoutAt}`,
    'on update: pull the repo, then start the continuation worker in this polling thread.',
    '대기 중에는 worker job을 만들지 않으므로 working 진행 문구가 뜨지 않습니다.',
    '수정: `/gitpoll -e ...`, 취소: `/gitpoll cancel`',
  ].filter(Boolean);
  if (status.remoteVerified && status.relation === 'behind' && isGitPollStarted(poll)) {
    lines.push('현재 로컬이 이미 remote보다 뒤라서 곧바로 pull 후 continuation을 큐에 넣습니다.');
  } else if (status.remoteVerified && status.relation === 'behind') {
    lines.push('현재 로컬이 이미 remote보다 뒤지만, start delay가 끝난 뒤 pull/continuation을 시작합니다.');
  } else if (!status.remoteVerified) {
    lines.push('remote 확인은 현재 실패했지만 poll은 유지합니다. 다음 주기에서 다시 확인합니다.');
  }
  const delivery = await postSystemMessage(poll.threadId, lines.join('\n'), {
    purpose: 'git-poll-command',
    options: mentionOptions(poll.requesterId),
  });
  let sourceDelivery = null;
  if (String(poll.threadId) !== String(event.threadId)) {
    sourceDelivery = await postSystemMessage(event.threadId, [
      'git polling 작업을 새 스레드로 열었습니다.',
      `thread: <#${poll.threadId}>`,
      `target: ${formatGitPollTarget(poll)}`,
      `will do: ${poll.task}`,
      '권한과 모델 설정은 현재 스레드에서 상속했습니다.',
    ].join('\n'), { purpose: 'git-poll-thread-created' });
  }
  await logSystem('git-poll-armed', {
    pollId: poll.id,
    channelId: poll.channelId,
    threadId: poll.threadId,
    sourceThreadId: poll.sourceThreadId,
    createdThread: Boolean(pollThread.created),
    target: formatGitPollTarget(poll),
    baselineStatus: compactHeadStatus(status),
    intervalMs: poll.intervalMs,
    timeoutAt: poll.timeoutAt,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
    sourceDelivered: sourceDelivery ? sourceDelivery.delivered : null,
    sourceQueued: sourceDelivery ? Boolean(sourceDelivery.queued) : null,
  });

  if (status.remoteVerified && status.relation === 'behind' && isGitPollStarted(poll)) {
    triggerGitPoll(poll, { reason: 'already-behind', status })
      .catch((error) => logSystem('git-poll-trigger-error', {
        pollId: poll.id,
        channelId: poll.channelId,
        threadId: poll.threadId,
        error: formatErrorDetail(error),
      }));
  }
}

async function handleGitPollEditCommandRequest(event, command) {
  const active = findActiveGitPollForThread(event.channelId, event.threadId);
  if (!active) {
    const delivery = await postSystemMessage(event.threadId, [
      '수정할 active git polling이 없습니다.',
      '새 polling은 `/gitpoll ...`로 만들고, active polling 수정은 해당 polling 스레드에서 `/gitpoll -e ...`로 지시하세요.',
    ].join('\n'), { purpose: 'git-poll-edit-missing' });
    await logSystem('git-poll-edit-missing', {
      messageId: event.id,
      channelId: event.channelId,
      threadId: event.threadId,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const now = new Date();
  const updated = {
    ...applyGitPollEdit(active, command, { now }),
    lastEditedAt: now.toISOString(),
    lastEditMessageId: event.id,
  };

  if (active.timer) clearTimeout(active.timer);
  activeGitPolls.delete(active.id);
  await appendGitPollState(updated, {
    status: 'active',
    editedAt: updated.lastEditedAt,
    editSourceMessageId: event.id,
  });
  scheduleGitPoll(updated);

  const lines = [
    'git polling 수정됨',
    `polling: ${formatGitPollTarget(updated)}`,
    `will do: ${updated.task}`,
    String(updated.threadId) !== String(updated.sourceThreadId || '') ? `source thread: <#${updated.sourceThreadId}>` : null,
    `starts: ${formatGitPollStart(updated.startAt)}`,
    `interval: ${formatDuration(updated.intervalMs)}, timeout: ${updated.timeoutAt}`,
    '수정: `/gitpoll -e ...`, 취소: `/gitpoll cancel`',
  ].filter(Boolean);
  const delivery = await postSystemMessage(updated.threadId, lines.join('\n'), { purpose: 'git-poll-edited' });
  await logSystem('git-poll-edited', {
    pollId: updated.id,
    messageId: event.id,
    channelId: updated.channelId,
    threadId: updated.threadId,
    sourceThreadId: updated.sourceThreadId,
    target: formatGitPollTarget(updated),
    intervalMs: updated.intervalMs,
    startAt: updated.startAt,
    timeoutAt: updated.timeoutAt,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function ensureGitPollWorkThread(event, sourceMessage = null, { repoPath = '', remote = 'origin', branch = '' } = {}) {
  const name = gitPollThreadName({ repoPath, remote, branch });
  const threadId = await createStandaloneWorkThread({
    id: event.id,
    content: event.content,
  }, {
    channelId: event.channelId,
  }, name);
  if (!threadId) throw new Error('failed to create dedicated git polling thread');
  return { threadId, created: true };
}

async function recordGitPollForkEvent(event, pollThread = {}) {
  if (!pollThread.created || !pollThread.threadId || String(pollThread.threadId) === String(event.threadId)) return;
  await threadState(event.channelId, pollThread.threadId).appendJsonl('memory/events.jsonl', redactEventSecrets({
    ...event,
    id: `${event.id}_gitpoll_thread`,
    timestamp: new Date().toISOString(),
    threadId: pollThread.threadId,
    content: [
      'Git polling work thread opened from another Discord thread.',
      `Source thread: ${event.threadId}`,
      `Source message: ${event.id}`,
      '',
      event.content || '',
    ].join('\n').trim(),
    source: 'bridge-git-poll-thread-fork',
    sourceThreadId: event.threadId,
    sourceMessageId: event.id,
    acknowledged: true,
    acknowledgedAt: new Date().toISOString(),
  }));
}

function gitPollThreadName({ repoPath = '', remote = 'origin', branch = '' } = {}) {
  const repoName = path.basename(String(repoPath || '').replace(/[\\/]+$/, '')) || 'repo';
  return `git poll ${repoName} ${remote}/${branch || 'HEAD'}`;
}

function scheduleGitPoll(poll) {
  if (shuttingDown || restartCoordinator.deferred) return;
  const now = Date.now();
  const timeoutMs = Date.parse(poll.timeoutAt || '') - now;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    expireGitPoll(poll).catch((error) => logSystem('git-poll-expire-error', {
      pollId: poll.id,
      error: formatErrorDetail(error),
    }));
    return;
  }
  const startDelayMs = Math.max(0, (Date.parse(poll.startAt || '') || now) - now);
  const baseDelayMs = startDelayMs > 0 ? startDelayMs : Number(poll.intervalMs) || 60_000;
  const delayMs = Math.max(1_000, Math.min(baseDelayMs, timeoutMs));
  const timer = setTimeout(() => {
    tickGitPoll(poll).catch((error) => logSystem('git-poll-tick-error', {
      pollId: poll.id,
      channelId: poll.channelId,
      threadId: poll.threadId,
      error: formatErrorDetail(error),
    }));
  }, delayMs);
  timer.unref?.();
  activeGitPolls.set(poll.id, { ...poll, timer });
}

async function tickGitPoll(poll) {
  if (shuttingDown || restartCoordinator.deferred || !activeGitPolls.has(poll.id)) return;
  if (Date.parse(poll.timeoutAt || '') <= Date.now()) {
    await expireGitPoll(poll);
    return;
  }
  if (!isGitPollStarted(poll)) {
    scheduleGitPoll(poll);
    return;
  }

  let status;
  try {
    status = await getHeadSyncStatus({
      cwd: poll.repoPath,
      remote: poll.remote,
      branch: poll.branch,
      allowStoredRemoteFallback: false,
    });
  } catch (error) {
    await logSystem('git-poll-status-error', {
      pollId: poll.id,
      channelId: poll.channelId,
      threadId: poll.threadId,
      error: formatErrorDetail(error),
    });
    scheduleGitPoll(poll);
    return;
  }

  if (status.remoteHead && status.remoteHead !== poll.baselineRemoteHead) {
    await triggerGitPoll(poll, { reason: 'remote-head-changed', status });
    return;
  }

  scheduleGitPoll(poll);
}

async function triggerGitPoll(poll, { reason, status } = {}) {
  const active = activeGitPolls.get(poll.id);
  if (active?.timer) clearTimeout(active.timer);
  activeGitPolls.delete(poll.id);
  await appendGitPollState(poll, {
    status: 'pulling',
    reason,
    detectedStatus: compactHeadStatus(status),
  });

  const sync = await syncLocalHeadToRemote({
    cwd: poll.repoPath,
    remote: poll.remote,
    branch: poll.branch,
    allowStoredRemoteFallback: false,
  }).catch((error) => ({
    synced: false,
    action: 'pull-error',
    error: formatErrorDetail(error),
  }));

  if (!sync.synced) {
    await appendGitPollState(poll, {
      status: 'blocked',
      finishedAt: new Date().toISOString(),
      reason,
      sync,
    });
    const delivery = await postSystemMessage(poll.threadId, [
      'git polling이 remote 변경을 감지했지만 pull에 실패해서 continuation을 큐에 넣지 않았습니다.',
      `target: ${formatGitPollTarget(poll)}`,
      `action: ${sync.action || 'unknown'}`,
      sync.error ? `error: ${sync.error}` : null,
    ].filter(Boolean).join('\n'), { purpose: 'git-poll-blocked' });
    await logSystem('git-poll-blocked', {
      pollId: poll.id,
      channelId: poll.channelId,
      threadId: poll.threadId,
      target: formatGitPollTarget(poll),
      sync,
      delivered: delivery.delivered,
      queued: Boolean(delivery.queued),
    });
    return;
  }

  const jobEvent = {
    id: `${poll.id}_job_${Date.now()}`,
    timestamp: new Date().toISOString(),
    authorId: 'bridge-agent',
    authorName: 'git-poll',
    channelId: poll.channelId,
    threadId: poll.threadId,
    content: buildGitPollContinuationContent(poll, sync),
    attachments: [],
    acknowledged: true,
    acknowledgedAt: new Date().toISOString(),
    source: 'bridge-git-poll',
    gitPollId: poll.id,
  };
  await threadState(jobEvent.channelId, jobEvent.threadId).appendJsonl('memory/events.jsonl', jobEvent);
  enqueueCodexJob(jobEvent, {
    id: jobEvent.id,
    priority: PRIORITY.ACTIVE_THREAD_FOLLOW_UP,
    repoAccess: true,
    repoPath: poll.repoPath,
  });

  await appendGitPollState(poll, {
    status: 'queued-continuation',
    finishedAt: new Date().toISOString(),
    reason,
    sync,
    continuationJobId: jobEvent.id,
  });
  const delivery = await postSystemMessage(poll.threadId, [
    'git polling이 remote 변경을 감지했고 pull을 완료했습니다.',
    `target: ${formatGitPollTarget(poll)}`,
    `pull action: ${sync.action || 'unknown'}`,
    `continuation job: ${jobEvent.id}`,
  ].join('\n'), { purpose: 'git-poll-triggered' });
  await logSystem('git-poll-triggered', {
    pollId: poll.id,
    continuationJobId: jobEvent.id,
    channelId: poll.channelId,
    threadId: poll.threadId,
    target: formatGitPollTarget(poll),
    sync,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function expireGitPoll(poll) {
  const active = activeGitPolls.get(poll.id);
  if (active?.timer) clearTimeout(active.timer);
  activeGitPolls.delete(poll.id);
  await appendGitPollState(poll, {
    status: 'timed-out',
    finishedAt: new Date().toISOString(),
  });
  const delivery = await postSystemMessage(poll.threadId, [
    'git polling timeout',
    `target: ${formatGitPollTarget(poll)}`,
    `baseline remote: ${shortSha(poll.baselineRemoteHead) || 'unknown'}`,
  ].join('\n'), { purpose: 'git-poll-timeout' });
  await logSystem('git-poll-timeout', {
    pollId: poll.id,
    channelId: poll.channelId,
    threadId: poll.threadId,
    target: formatGitPollTarget(poll),
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

async function cancelGitPollsForThread(channelId, threadId, { reason = 'cancelled' } = {}) {
  let cancelled = 0;
  for (const [pollId, poll] of [...activeGitPolls.entries()]) {
    if (!gitPollMatchesCancelThread(poll, channelId, threadId)) continue;
    if (poll.timer) clearTimeout(poll.timer);
    activeGitPolls.delete(pollId);
    cancelled += 1;
    await appendGitPollState(poll, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      reason,
    });
  }
  return cancelled;
}

function clearGitPollTimers() {
  for (const poll of activeGitPolls.values()) {
    if (poll.timer) clearTimeout(poll.timer);
  }
  activeGitPolls.clear();
}

function scheduleReservedCommand(reservation) {
  if (shuttingDown || restartCoordinator.deferred || !reservation?.id) return;
  const existing = activeReservedCommands.get(reservation.id);
  if (existing?.timer) clearTimeout(existing.timer);

  const scheduledMs = Date.parse(reservation.scheduledAt || '');
  if (!Number.isFinite(scheduledMs)) return;
  const remainingMs = scheduledMs - Date.now();
  const delayMs = remainingMs <= 0
    ? 1_000
    : Math.min(Math.max(1_000, remainingMs), MAX_RESERVE_TIMER_DELAY_MS);
  const timer = setTimeout(() => {
    const stillRemainingMs = scheduledMs - Date.now();
    if (stillRemainingMs > 1_000) {
      scheduleReservedCommand(reservation);
      return;
    }
    triggerReservedCommand(reservation).catch((error) => logSystem('reserve-command-trigger-error', {
      reservationId: reservation.id,
      channelId: reservation.channelId,
      threadId: reservation.threadId,
      error: formatErrorDetail(error),
    }));
  }, delayMs);
  timer.unref?.();
  activeReservedCommands.set(reservation.id, { ...reservation, timer });
}

async function triggerReservedCommand(reservation) {
  const active = activeReservedCommands.get(reservation.id);
  if (active?.timer) clearTimeout(active.timer);
  activeReservedCommands.delete(reservation.id);
  if (shuttingDown || restartCoordinator.deferred) return;

  const now = new Date().toISOString();
  await appendReservedCommandState(reservation, {
    status: 'triggering',
    triggeredAt: now,
  });

  const jobEvent = {
    id: `${reservation.id}_job_${Date.now()}`,
    timestamp: now,
    authorId: 'bridge-agent',
    authorName: 'reserve',
    channelId: reservation.channelId,
    threadId: reservation.threadId,
    content: reservation.order || '',
    attachments: [],
    acknowledged: true,
    acknowledgedAt: now,
    source: 'bridge-reserve',
    reserveId: reservation.id,
    sourceMessageId: reservation.sourceMessageId || null,
  };
  await threadState(jobEvent.channelId, jobEvent.threadId)
    .appendJsonl('memory/events.jsonl', redactEventSecrets(jobEvent));

  enqueueCodexJob(jobEvent, {
    id: jobEvent.id,
    priority: PRIORITY.ACTIVE_THREAD_FOLLOW_UP,
    repoAccess: reservation.repoAccess ? true : undefined,
    repoPath: reservation.repoAccess ? reservation.repoPath || null : null,
    stateAccess: reservation.stateAccess ? true : undefined,
    search: isWebSearchRequest(jobEvent.content),
    verboseProgress: Boolean(reservation.verboseProgress),
    threadModelOverride: reservation.threadModelOverride || null,
    preserveThreadModelOverride: Boolean(reservation.threadModelOverride),
    supersedeQueuedThreadJobs: false,
  });

  await appendReservedCommandState(reservation, {
    status: 'queued',
    queuedAt: new Date().toISOString(),
    continuationJobId: jobEvent.id,
  });
  const delivery = await postSystemMessage(reservation.threadId, [
    '예약 실행 큐에 넣었습니다.',
    `id: ${reservation.id}`,
    `job: ${jobEvent.id}`,
    `order: ${truncateLine(reservation.order, 180)}`,
  ].join('\n'), { purpose: 'reserve-command-triggered' });
  await logSystem('reserve-command-triggered', {
    reservationId: reservation.id,
    continuationJobId: jobEvent.id,
    channelId: reservation.channelId,
    threadId: reservation.threadId,
    scheduledAt: reservation.scheduledAt,
    delivered: delivery.delivered,
    queued: Boolean(delivery.queued),
  });
}

function clearReservedCommandTimers() {
  for (const reservation of activeReservedCommands.values()) {
    if (reservation.timer) clearTimeout(reservation.timer);
  }
  activeReservedCommands.clear();
}

async function appendReservedCommandState(reservation, entry) {
  await threadState(reservation.channelId, reservation.threadId).appendJsonl(RESERVED_COMMANDS_FILE, {
    ...reservation,
    updatedAt: new Date().toISOString(),
    ...entry,
  });
}

async function appendGitPollState(poll, entry) {
  await threadState(poll.channelId, poll.threadId).appendJsonl(GIT_POLL_STATE_FILE, {
    id: poll.id,
    updatedAt: new Date().toISOString(),
    channelId: poll.channelId,
    threadId: poll.threadId,
    sourceChannelId: poll.sourceChannelId || null,
    sourceThreadId: poll.sourceThreadId || null,
    sourceMessageId: poll.sourceMessageId || null,
    repoPath: poll.repoPath,
    remote: poll.remote,
    branch: poll.branch,
    baselineRemoteHead: poll.baselineRemoteHead || null,
    baselineLocalHead: poll.baselineLocalHead || null,
    intervalMs: poll.intervalMs,
    startAt: poll.startAt || null,
    timeoutAt: poll.timeoutAt,
    task: poll.task || '',
    requesterId: poll.requesterId || null,
    ...entry,
  });
}

function compactHeadStatus(status = {}) {
  return {
    synced: Boolean(status.synced),
    relation: status.relation || 'unknown',
    localHead: status.localHead || null,
    remoteHead: status.remoteHead || null,
    remoteVerified: Boolean(status.remoteVerified),
    dirty: Boolean(status.dirty),
    action: status.action || null,
  };
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  if (value % (60 * 60_000) === 0) return `${value / (60 * 60_000)}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1_000 === 0) return `${value / 1_000}s`;
  return `${value}ms`;
}

function formatGitPollStart(startAt) {
  const startMs = Date.parse(startAt || '');
  if (!Number.isFinite(startMs)) return 'now';
  const delayMs = startMs - Date.now();
  if (delayMs <= 1_000) return 'now';
  return `${startAt} (${formatDuration(delayMs)} from now)`;
}

function isGitPollStarted(poll = {}) {
  const startMs = Date.parse(poll.startAt || '');
  return !Number.isFinite(startMs) || startMs <= Date.now();
}

function findActiveGitPollForThread(channelId, threadId) {
  const matches = [...activeGitPolls.values()]
    .filter((poll) => gitPollIsInThread(poll, channelId, threadId));
  if (matches.length === 0) return null;
  matches.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
  return matches[0];
}

function discordUserMention(userId) {
  const id = String(userId || '').trim();
  return /^\d{5,}$/.test(id) ? `<@${id}>` : '';
}

function mentionOptions(userId) {
  const id = String(userId || '').trim();
  return /^\d{5,}$/.test(id)
    ? { allowed_mentions: { parse: [], users: [id] } }
    : {};
}

function isCompanyEventChannel(event) {
  return Boolean(config.workers?.companyChannelIds?.has(String(event?.channelId || '')));
}

async function requestServiceRestart(request) {
  return restartCoordinator.request({
    interruptRunningJobs: true,
    ...request,
  });
}

async function runDeferredServiceRestartIfIdle() {
  return restartCoordinator.runIfIdle();
}

async function completeAbandonedDeferredRestart() {
  return restartCoordinator.completeAbandoned();
}

async function acknowledgeMessage(channelId, messageId) {
  try {
    await api.addReaction(channelId, messageId, ACK_REACTION_EMOJI);
    return { ok: true, acknowledgedAt: new Date().toISOString() };
  } catch (error) {
    await logSystem('acknowledgement-failed', {
      channelId,
      messageId,
      error: formatErrorDetail(error),
    });
    return { ok: false, error: error.message || formatErrorDetail(error) };
  }
}

async function acknowledgeSlackMessage(channelId, messageTs) {
  try {
    await slackApi.addReaction(
      channelId,
      messageTs,
      config.slack.acknowledgementReaction || 'thumbsup',
    );
    return { ok: true, acknowledgedAt: new Date().toISOString() };
  } catch (error) {
    if (error?.slackError === 'already_reacted') {
      return { ok: true, acknowledgedAt: new Date().toISOString() };
    }
    await logSystem('slack-acknowledgement-failed', {
      channelId,
      messageTs,
      error: formatErrorDetail(error),
    });
    return { ok: false, error: error.message || formatErrorDetail(error) };
  }
}

function enqueueCodexJob(event, options = {}) {
  if (!isActionableJobEvent({
    ...event,
    pendingAskAnswer: options.pendingAskAnswer ?? event?.pendingAskAnswer,
    recoveredFromJobId: options.recoveredFromJobId ?? event?.recoveredFromJobId,
    resumeContext: options.resumeContext ?? event?.resumeContext,
  })) {
    logSystem('empty-job-enqueue-suppressed', {
      messageId: event?.id || null,
      channelId: event?.channelId || null,
      threadId: event?.threadId || null,
    }).catch(() => {});
    return false;
  }
  const repoAccessDirective = repoAccessDirectiveFromContent(event.content);
  const yoloAccessDirective = yoloAccessDirectiveFromContent(event.content);
  const repoRootDirective = repoRootDirectiveFromContent(event.content);
  const stateAccessDirective = stateAccessDirectiveFromContent(event.content);
  const verboseDirective = verboseDirectiveFromContent(event.content);
  const explicitVerboseProgress = typeof options.verboseProgress === 'boolean'
    ? options.verboseProgress
    : null;
  let requestedRepoPath = options.repoPath || null;
  if (repoRootDirective) {
    const context = writeThreadRepositoryRootSync(config, event, { source: 'repo-directive' });
    if (context?.repoPath) {
      fsSync.mkdirSync(context.repoPath, { recursive: true });
      requestedRepoPath = requestedRepoPath || context.repoPath;
    }
  }
  if (yoloAccessDirective) {
    const context = writeThreadRepoAccessSync(config, {
      ...event,
      repoPath: requestedRepoPath,
    }, { source: 'yolo-directive' });
    if (context?.repoPath) {
      fsSync.mkdirSync(context.repoPath, { recursive: true });
      requestedRepoPath = requestedRepoPath || context.repoPath;
    }
  }
  if (verboseDirective) {
    writeThreadVerboseProgressSync(config, event, true, { source: 'verbose-directive' });
  }
  const requestedRepoAccess = typeof options.repoAccess === 'boolean'
    ? options.repoAccess
    : typeof repoAccessDirective === 'boolean'
      ? repoAccessDirective
    : jobNeedsRepoAccess({ event, maintenance: Boolean(options.maintenance) });
  const requestedStateAccess = typeof options.stateAccess === 'boolean'
    ? options.stateAccess
    : typeof stateAccessDirective === 'boolean'
      ? stateAccessDirective
      : jobNeedsFullStateAccess({ event });
  const repoContext = resolveThreadRepoContextSync(config, {
    channelId: event.channelId,
    threadId: event.threadId,
    maintenance: Boolean(options.maintenance),
    repoAccess: requestedRepoAccess,
    repoAccessDirective,
    stateAccess: requestedStateAccess,
    stateAccessDirective,
    repoPath: requestedRepoPath,
  });
  const verboseProgress = Boolean(explicitVerboseProgress || verboseDirective || repoContext.verboseProgress);
  const job = {
    id: options.id || event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    priority: options.priority ?? classifyJob({ threadId: event.threadId }),
    event,
    recoveredFromJobId: options.recoveredFromJobId || null,
    maintenance: Boolean(options.maintenance),
    maintenanceIssue: compactMaintenanceIssue(options.maintenanceIssue),
    concurrencyKey: String(options.concurrencyKey || '').trim() || null,
    maintenanceMode: options.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(options.maintenanceInputLimitResume),
    maintenanceManifestPath: options.maintenanceManifestPath || null,
    maintenanceRawContextPath: options.maintenanceRawContextPath || null,
    maintenanceSummaryPath: options.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(options.maintenanceGitBaselinePaths)
      ? options.maintenanceGitBaselinePaths
      : null,
    repoAccess: repoContext.repoAccess,
    repoPath: repoContext.repoPath,
    bridgeRepoAccess: repoContext.bridgeRepoAccess,
    stateAccess: repoContext.stateAccess,
    threadModelOverride: options.threadModelOverride || repoContext.threadModelOverride || null,
    preserveThreadModelOverride: Boolean(options.preserveThreadModelOverride || options.threadModelOverride),
    codexFastMode: repoContext.codexFastMode,
    richStyleId: normalizeRichStyleId(
      options.richStyleId ?? repoContext.richStyleId,
      DEFAULT_RICH_STYLE_ID,
    ),
    search: Boolean(options.search) || isWebSearchRequest(event.content),
    verboseProgress,
    attempt: options.attempt || 1,
    finalChannelId: options.finalChannelId || null,
    pendingAskAnswer: compactPendingAskAnswer(options.pendingAskAnswer),
    workerMode: options.workerMode || null,
    mockPlan: options.mockPlan || null,
    runtimeSourceBaseline: options.runtimeSourceBaseline || null,
    artifactDeliveryBaseline: options.artifactDeliveryBaseline || null,
  };
  appendQueuedJobState(job);
  if (options.supersedeQueuedThreadJobs) {
    const newerJob = newestAcceptedThreadJobAfter(job, options.persistedNewerThreadEvent);
    if (newerJob) {
      markQueuedJobSuperseded(job, newerJob.id);
      return false;
    }
    supersedeQueuedThreadJobs(job);
  }
  scheduler.enqueue(job);
  drainQueue();
  return true;
}

function appendQueuedJobState(job) {
  const file = path.join(threadStateDir(config, job.channelId, job.threadId), 'jobs', 'jobs.jsonl');
  const entry = {
    id: job.id,
    createdAt: new Date().toISOString(),
    priority: job.priority ?? PRIORITY.NORMAL_TOP_LEVEL_JOB,
    status: 'queued',
    recoveredFromJobId: job.recoveredFromJobId || null,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
      ? job.maintenanceGitBaselinePaths
      : null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    threadModelOverride: compactThreadModelOverride(job.threadModelOverride),
    preserveThreadModelOverride: Boolean(job.preserveThreadModelOverride),
    codexFastMode: Boolean(job.codexFastMode),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    attempt: job.attempt || 1,
    finalChannelId: job.finalChannelId || null,
    pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    workerMode: job.workerMode || null,
    mockPlan: job.mockPlan || null,
    runtimeSourceBaseline: job.runtimeSourceBaseline || null,
    artifactDeliveryBaseline: job.artifactDeliveryBaseline || null,
  };
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function supersedeQueuedThreadJobs(incomingJob) {
  const removed = scheduler.removeQueuedThreadJobs(jobThreadKey(incomingJob), {
    excludeIds: [incomingJob.id],
    predicate: (queuedJob) => shouldSupersedeLiveJob(incomingJob, queuedJob),
  });
  for (const job of removed) markQueuedJobSuperseded(job, incomingJob.id);
  return removed.length;
}

function cancelQueuedThreadJobs(event) {
  const removed = scheduler.removeQueuedThreadJobs(jobThreadKey(event));
  for (const job of removed) markQueuedJobCancelled(job, event.id);
  return removed.length;
}

function newestAcceptedThreadJobAfter(incomingJob, persistedNewerThreadEvent = null) {
  const threadKey = jobThreadKey(incomingJob);
  const candidates = [
    ...scheduler.queuedThreadJobs(threadKey),
    ...[...running.values()].filter((job) => jobThreadKey(job) === threadKey),
  ];
  if (persistedNewerThreadEvent?.id) {
    candidates.push({
      id: persistedNewerThreadEvent.id,
      channelId: incomingJob.channelId,
      threadId: incomingJob.threadId,
      event: persistedNewerThreadEvent,
    });
  }
  return newestThreadJobAfter(candidates, incomingJob);
}

function markQueuedJobSuperseded(job, supersededByJobId) {
  logSystem('job-queued-superseded', {
    jobId: job.id,
    supersededByJobId,
    channelId: job.channelId,
    threadId: job.threadId,
  }).catch(() => {});

  const file = path.join(threadStateDir(config, job.channelId, job.threadId), 'jobs', 'jobs.jsonl');
  const now = new Date().toISOString();
  const entry = {
    id: job.id,
    updatedAt: now,
    finishedAt: now,
    status: 'superseded',
    delivered: false,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    supersededByJobId,
    error: `queued job superseded by newer job ${supersededByJobId}`,
  };
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function markQueuedJobCancelled(job, cancelledByMessageId) {
  logSystem('job-queued-cancelled', {
    jobId: job.id,
    cancelledByMessageId,
    channelId: job.channelId,
    threadId: job.threadId,
  }).catch(() => {});

  const file = path.join(threadStateDir(config, job.channelId, job.threadId), 'jobs', 'jobs.jsonl');
  const now = new Date().toISOString();
  const entry = {
    id: job.id,
    updatedAt: now,
    finishedAt: now,
    status: 'cancelled',
    delivered: false,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    cancelledByMessageId,
    error: `queued job cancelled by command ${cancelledByMessageId}`,
  };
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function refreshJobAccessFromThreadContext(job) {
  const before = compactJobAccess(job);
  const refreshed = mergeThreadRepoContextIntoJobSync(config, job);
  const preservedThreadModelOverride = job.preserveThreadModelOverride ? job.threadModelOverride : null;
  job.repoAccess = refreshed.repoAccess;
  job.repoPath = refreshed.repoPath;
  job.bridgeRepoAccess = refreshed.bridgeRepoAccess;
  job.stateAccess = refreshed.stateAccess;
  job.threadModelOverride = preservedThreadModelOverride || refreshed.threadModelOverride || null;
  job.verboseProgress = Boolean(refreshed.verboseProgress);
  job.codexFastMode = Boolean(refreshed.codexFastMode);
  const after = compactJobAccess(job);
  return sameJobAccess(before, after) ? null : { before, after };
}

function drainQueue() {
  if (shuttingDown) return;
  while (hasJobQueueCapacity()) {
    const job = scheduler.next({
      runningCount: running.size,
      backgroundStartOnlyBelowRunning: config.queue.backgroundStartOnlyBelowRunning,
      blockedThreadKeys: runningThreadKeys(),
    });
    if (!job) return;
    job.abortController = new AbortController();
    running.set(job.id, job);
    const promise = runJob(job)
      .catch((error) => handleJobError(job, error))
      .finally(() => {
        running.delete(job.id);
        runningJobPromises.delete(job.id);
        runDeferredServiceRestartIfIdle()
          .catch((error) => logSystem('restart-deferred-run-error', {
            error: formatErrorDetail(error),
          }))
          .finally(() => drainQueue());
      });
    runningJobPromises.set(job.id, promise);
  }
}

function hasJobQueueCapacity() {
  const maxConcurrentJobs = Number(config.queue.maxConcurrentJobs);
  return !Number.isFinite(maxConcurrentJobs) || maxConcurrentJobs <= 0 || running.size < maxConcurrentJobs;
}

function runningThreadKeys() {
  return new Set([...running.values()].map((job) => jobConcurrencyKey(job)));
}

function reportForcedJobSettlement({ job, phase, error, reason }) {
  logSystem('job-step-forced-settlement', {
    jobId: job?.id || null,
    channelId: job?.channelId || null,
    threadId: job?.threadId || null,
    phase,
    reason,
    abortReason: error?.abortReason || null,
  }).catch(() => {});
}

function withJobStepDeadline(job, phase, start, { hardTimeoutMs = 0 } = {}) {
  return withJobStepDeadlineFor(job, phase, start, {
    hardTimeoutMs,
    abortGraceMs: JOB_ABORT_SETTLE_GRACE_MS,
    onForcedSettlement: reportForcedJobSettlement,
  });
}

function withJobPrepareStep(job, phase, start) {
  return withJobStepDeadline(job, phase, start, {
    hardTimeoutMs: JOB_PREPARE_STEP_TIMEOUT_MS,
  });
}

async function runJob(job) {
  assertThreadDestination(job.channelId, job.threadId);
  const refreshedAccess = refreshJobAccessFromThreadContext(job);
  if (refreshedAccess) {
    await logSystem('job-access-refreshed', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      before: refreshedAccess.before,
      after: refreshedAccess.after,
    });
  }
  const threadLock = await acquireThreadJobLock(config, job);
  if (!threadLock.acquired) {
    await handleThreadJobLocked(job, threadLock.owner);
    return;
  }

  try {
    job.previousWorkerDurationMs = await previousJobWorkerDurationMs({
      threadRoot: threadStateDir(config, job.channelId, job.threadId),
      job,
    }).catch(async (error) => {
      await logSystem('job-duration-history-read-failed', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        error: formatErrorDetail(error),
      });
      return 0;
    });
    await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
      id: job.id,
      createdAt: new Date().toISOString(),
      priority: job.priority ?? PRIORITY.NORMAL_TOP_LEVEL_JOB,
      status: 'started',
      recoveredFromJobId: job.recoveredFromJobId || null,
      maintenance: Boolean(job.maintenance),
      maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
      concurrencyKey: job.concurrencyKey || null,
      maintenanceMode: job.maintenanceMode || null,
      maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
      maintenanceManifestPath: job.maintenanceManifestPath || null,
      maintenanceRawContextPath: job.maintenanceRawContextPath || null,
      maintenanceSummaryPath: job.maintenanceSummaryPath || null,
      maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
        ? job.maintenanceGitBaselinePaths
        : null,
      repoAccess: Boolean(job.repoAccess),
      repoPath: job.repoPath || null,
      stateAccess: Boolean(job.stateAccess),
      threadModelOverride: compactThreadModelOverride(job.threadModelOverride),
      preserveThreadModelOverride: Boolean(job.preserveThreadModelOverride),
      codexFastMode: Boolean(job.codexFastMode),
      richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
      search: Boolean(job.search),
      verboseProgress: Boolean(job.verboseProgress),
      attempt: job.attempt || 1,
      finalChannelId: job.finalChannelId || null,
      pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    });
    await updateMaintenanceManifestSafe(job, {
      status: 'running',
      mode: job.maintenanceMode || (job.maintenanceInputLimitResume ? 'minimal-resume' : 'sharded'),
    });

    let progressTimer = null;
    let progressForwarder = null;
    let progressUpdateGate = null;
    // `working for N minutes.` must name the worker even before onWorkerStart
    // fires. Two windows have no reported worker: a detached worker queued
    // behind the concurrency limit, and a restart that reattaches an already
    // running one (its `worker.started` was acknowledged by the previous
    // Workbench and is never replayed). Without this the notice degraded to the
    // raw job id — "1000000000000000010 working for 1 minute.".
    let currentWorkerInfo = await reattachedWorkerStartInfo(job);
    let plannedWorkerInfo = null;
    try {
      plannedWorkerInfo = plannedWorkerStartInfo(config, job);
    } catch (error) {
      await logSystem('job-planned-worker-resolve-failed', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        error: formatErrorDetail(error),
      });
    }
    const announcedWorkerStarts = new Set();
    const announceWorkerStart = async (workerInfo) => {
      job.workerStarted = true;
      currentWorkerInfo = workerInfo || null;
      const marker = jobStartMarker(workerInfo, job);
      if (!marker || announcedWorkerStarts.has(marker)) return;
      announcedWorkerStarts.add(marker);
      // Stamp the silence window from when the send starts, not when the round
      // trip finishes, so delivery latency does not push the next heartbeat out.
      const messageSentAt = Date.now();
      try {
        const delivery = await postJobMessage(job, marker, { purpose: 'job-progress', queueOnFailure: false });
        await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
          id: job.id,
          updatedAt: new Date().toISOString(),
          status: 'worker-started',
          delivered: Boolean(delivery.delivered),
          queued: Boolean(delivery.queued),
          skipped: Boolean(delivery.skipped),
          duplicate: Boolean(delivery.duplicate),
          worker: workerInfo?.worker || null,
          workerLabel: jobWorkerDisplay(workerInfo, job) || null,
          workerEffort: jobWorkerEffort(workerInfo, job) || null,
          outboxId: delivery.outboxId || null,
        });
        if (delivery.delivered) progressTimer?.markMessageSent(messageSentAt);
      } catch (error) {
        logSystem('worker-start-notify-failed', {
          jobId: job.id,
          channelId: job.channelId,
          threadId: job.threadId,
          worker: workerInfo?.worker || null,
          error: formatErrorDetail(error),
        }).catch(() => {});
      }
    };
    progressTimer = startJobProgressTimer({
      job,
      config,
      isRunning: (jobId) => running.has(jobId),
      notify: async (progressJob, _status, summary) => {
        const delivery = await postJobMessage(progressJob, summary, {
          purpose: 'job-progress',
          queueOnFailure: false,
        });
        await threadState(progressJob.channelId, progressJob.threadId).appendJsonl('jobs/jobs.jsonl', {
          id: progressJob.id,
          updatedAt: new Date().toISOString(),
          status: 'progress-update',
          delivered: Boolean(delivery.delivered),
          queued: Boolean(delivery.queued),
          skipped: Boolean(delivery.skipped),
          duplicate: Boolean(delivery.duplicate),
          outboxId: delivery.outboxId || null,
          details: summary,
          source: 'heartbeat',
        });
      },
      details: () => ({
        workerDisplay: jobWorkerProgressDisplay(currentWorkerInfo || plannedWorkerInfo, job),
      }),
      onError: (error) => {
        logSystem('job-progress-notify-failed', {
          jobId: job.id,
          channelId: job.channelId,
          threadId: job.threadId,
          error: formatErrorDetail(error),
        }).catch(() => {});
      },
    });
    progressForwarder = config.workerProgressUpdatesEnabled
      ? createProgressUpdateForwarder({
          delayMs: config.jobProgressForwardDelayMs,
          verbose: Boolean(job.verboseProgress),
          send: async (details) => {
            const messageSentAt = Date.now();
            const delivery = await postJobMessage(job, details, { purpose: 'worker-progress', queueOnFailure: false });
            await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
              id: job.id,
              updatedAt: new Date().toISOString(),
              status: 'progress-update',
              delivered: Boolean(delivery.delivered),
              queued: Boolean(delivery.queued),
              skipped: Boolean(delivery.skipped),
              duplicate: Boolean(delivery.duplicate),
              outboxId: delivery.outboxId || null,
              details,
            });
            if (delivery.delivered) progressTimer?.markMessageSent(messageSentAt);
          },
          onError: (error) => {
            logSystem('worker-progress-forward-failed', {
              jobId: job.id,
              channelId: job.channelId,
              threadId: job.threadId,
              error: formatErrorDetail(error),
            }).catch(() => {});
          },
        })
      : null;
    progressUpdateGate = progressForwarder
      ? createTerminalResponseProgressGate({
          forward: (update) => progressForwarder.add(update),
        })
      : null;

    let prompt = '';
    let transcriptSaved = false;
    let checkpointRecorder = null;
    let checkpointSnapshot = null;
    let skipProgressFlush = false;
    let terminalProgressClosed = false;
    const closeProgressBeforeTerminalMessage = async () => {
      if (terminalProgressClosed) return;
      terminalProgressClosed = true;
      skipProgressFlush = true;
      progressTimer?.stop();
      await progressForwarder?.flush().catch((error) => {
        logSystem('worker-progress-flush-before-terminal-failed', {
          jobId: job.id,
          channelId: job.channelId,
          threadId: job.threadId,
          error: formatErrorDetail(error),
        }).catch(() => {});
      });
      progressForwarder?.stop();
    };
    try {
      const runtimeSourceBeforeJob = job.runtimeSourceBaseline
        || await withJobPrepareStep(
          job,
          'runtime-source-snapshot',
          () => captureJobRuntimeSourceSnapshot(job),
        );
      if (v3WorkbenchMode && runtimeSourceBeforeJob) {
        // The first Workbench generation's snapshot must travel with the
        // detached execution. A replacement generation must compare against
        // the pre-job source, not against files already changed while it was
        // offline.
        job.runtimeSourceBaseline = runtimeSourceBeforeJob;
      }
      const carriedArtifactDeliveryBaseline = deserializeArtifactDeliverySnapshot(
        job.artifactDeliveryBaseline,
      );
      const artifactDeliveryBeforeJob = parseSlackThreadStateId(job.threadId)
        ? null
        : carriedArtifactDeliveryBaseline
          || await withJobPrepareStep(job, 'artifact-snapshot', () =>
            captureArtifactDeliverySnapshot(jobArtifactRoot(config, job)).then((snapshot) => {
              // Truncation costs delivery detection for whatever was not
              // reached, so it must never pass silently.
              if (snapshot?.truncated) {
                logSystem('artifact-snapshot-truncated', {
                  jobId: job.id,
                  channelId: job.channelId,
                  threadId: job.threadId,
                  artifactRoot: jobArtifactRoot(config, job),
                  scannedFiles: snapshot.size,
                }).catch(() => {});
              }
              return snapshot;
            }).catch((error) => {
              logSystem('discord-artifact-snapshot-failed', {
                jobId: job.id,
                channelId: job.channelId,
                threadId: job.threadId,
                phase: 'before-job',
                error: formatErrorDetail(error),
              }).catch(() => {});
              return null;
            }));
      if (v3WorkbenchMode && artifactDeliveryBeforeJob) {
        job.artifactDeliveryBaseline = serializeArtifactDeliverySnapshot(
          artifactDeliveryBeforeJob,
        );
      }
      const workingDir = jobWorkingDirectory(config, job);
      const checkpointRoots = jobCheckpointWorkspaceRoots(job, workingDir);
      const [events, todoState, channelPreferences, checkpointBaseline] =
        await withJobPrepareStep(job, 'thread-context', () => Promise.all([
          threadState(job.channelId, job.threadId).readJsonl('memory/events.jsonl', { limit: 80 }),
          readChannelTodoState(config, job.channelId),
          readChannelPreferences(config, job.channelId),
          captureWorkspaceState({ roots: checkpointRoots }).catch(() => null),
        ]));
      const todoContext = formatTodoStateForPrompt(todoState);
      const channelMemoryContext = formatChannelPreferencesForPrompt(channelPreferences);
      const handoffContext = job.maintenance && !job.maintenanceIssue
        ? ''
        : await withJobPrepareStep(job, 'handoff-context', () => previousJobHandoffContext({
            threadRoot: threadStateDir(config, job.channelId, job.threadId),
            job,
            currentInputFingerprint: checkpointBaseline?.available
              ? checkpointBaseline.fingerprint
              : null,
          }));
      prompt = buildPrompt(
        job,
        buildJobThreadContext(events, job, maintenanceThreadContextOptions(job)),
        todoContext,
        handoffContext,
        channelMemoryContext,
      );
      prompt = await withJobPrepareStep(job, 'prompt-compaction', () =>
        maybeCompactMaintenancePrompt(job, prompt, todoContext, channelMemoryContext));
      checkpointRecorder = await withJobPrepareStep(job, 'checkpoint-start', () =>
        startJobCheckpointSafe(job, prompt, {
          baselineSnapshot: checkpointBaseline,
          workspaceRoots: checkpointRoots,
        }));
      const executeAgentJob = v3WorkbenchMode
        ? (options) => v3WorkbenchRuntime.executeAgentJob(options)
        : runAgentJob;
      // No hard deadline here: a Worker legitimately runs for hours. Only the
      // abort grace applies, so an abort can never leave this awaiting a Worker
      // that already exited.
      const result = await withJobStepDeadline(job, 'worker-dispatch', () => executeAgentJob({
        config,
        job,
        prompt,
        search: Boolean(job.search),
        onUpdate: (update) => {
          checkpointRecorder?.record(update);
          progressUpdateGate?.add(update);
        },
        onWorkerStart: async (workerInfo) => {
          checkpointRecorder?.workerStarted(workerInfo);
          await announceWorkerStart(workerInfo);
        },
        signal: job.abortController?.signal,
        isShuttingDown: () => shuttingDown,
      }));
      progressUpdateGate?.complete();
      // A worker response is not an authorization boundary for restarting the
      // bridge.  It may accidentally emit a syntactically valid control block
      // while discussing an unrelated task.  Keep the structured explanation
      // for a runtime-source restart below, but strip the control block and
      // never let it initiate a manual restart by itself.
      const modelRestartRequest = parseServiceRestartRequestFromOutput(result.output);
      const resultWithoutRestartControl = modelRestartRequest
        ? {
            ...result,
            output: modelRestartRequest.visibleText || '작업 결과 본문이 제공되지 않았습니다.',
          }
        : result;
      const pendingAsk = canJobWaitForUser(job)
        ? parsePendingAskFromOutput(resultWithoutRestartControl.output)
        : null;
      const maintenanceIssueResult = job.maintenanceIssue
        ? parseMaintenanceIssueResultFromOutput(resultWithoutRestartControl.output)
        : null;
      const dailyMaintenanceResult = job.maintenance && !job.maintenanceIssue
        ? parseDailyMaintenanceResultFromOutput(resultWithoutRestartControl.output)
        : null;
      const transcriptStatus = pendingAsk ? 'waiting_for_user' : 'succeeded';
      const persistedResult = resultWithoutRestartControl;
      checkpointSnapshot = await finishJobCheckpointSafe(job, checkpointRecorder, {
        status: transcriptStatus,
        output: persistedResult.output,
        worker: result.worker,
        finalAnswerReady: !pendingAsk && Boolean(String(persistedResult.output || '').trim()),
        nextAction: pendingAsk ? `Wait for the user's answer: ${pendingAsk.question || pendingAsk.reason || 'requested input'}` : undefined,
      });
      await saveJobTranscript(job, persistedResult, prompt, {
        status: transcriptStatus,
        checkpoint: checkpointSnapshot,
        checkpointPath: checkpointRecorder?.path || '',
      });
      transcriptSaved = true;
      if (await finishIfJobStopped(job)) return;
      if (result.attempts.length > 1) {
        await logSystem('worker-fallback-used', {
          jobId: job.id,
          channelId: job.channelId,
          threadId: job.threadId,
          worker: result.worker,
          attempts: result.attempts,
        });
      }
      const runtimeChangedPaths = await runtimeSourceChangesSince(
        runtimeSourceBeforeJob,
        job,
        checkpointSnapshot,
      );
      if (await finishIfJobStopped(job)) return;
      const deliveries = [];
      let maintenanceGitSummary = null;
      if (job.maintenance) {
        maintenanceGitSummary = await runMaintenanceGitSync(job);
        if (await finishIfJobStopped(job)) return;
      }
      if (job.maintenance && runtimeChangedPaths.length > 0) {
        recordMaintenanceRuntimeChanges(job, runtimeChangedPaths);
      }
      if (!job.maintenance && runtimeChangedPaths.length > 0) {
        const restartExplanation = resolveRuntimeSourceRestartExplanation({
          request: modelRestartRequest,
          output: resultWithoutRestartControl.output,
          changedPaths: runtimeChangedPaths,
        });
        if (restartExplanation.usedFallback) {
          await logSystem('runtime-source-restart-explanation-fallback', {
            jobId: job.id,
            channelId: job.channelId,
            threadId: job.threadId,
            reasonSource: restartExplanation.reasonSource,
            runtimeChangedPaths,
          });
        }
        await markJobNeedsRuntimeRestart(job, resultWithoutRestartControl, runtimeChangedPaths);
        await requestServiceRestart({
          reason: restartExplanation.reason,
          improvement: restartExplanation.improvement,
          channelId: job.channelId,
          threadId: job.threadId,
          messageId: job.id,
          source: 'runtime-source-change',
          runtimeChangedPaths,
          allowRunningJobIds: [job.id],
          workerLabel: jobWorkerDisplay(result, job),
          workerEffort: jobWorkerEffort(result, job),
        });
        return;
      }
      const maintenanceIssueOutcome = job.maintenanceIssue
        ? await finalizeMaintenanceIssue(job, maintenanceIssueResult, maintenanceGitSummary)
        : null;
      if (await finishIfJobStopped(job)) return;
      if (modelRestartRequest) {
        await logSystem('model-restart-marker-ignored', {
          jobId: job.id,
          channelId: job.channelId,
          threadId: job.threadId,
          reason: modelRestartRequest.reason,
          improvement: modelRestartRequest.improvement,
        });
      }
      if (pendingAsk) {
        await closeProgressBeforeTerminalMessage();
        await markJobWaitingForUser(job, result, pendingAsk);
        return;
      }
      await closeProgressBeforeTerminalMessage();
      const marker = jobCompletionSummary(result, job);
      const inlineMarkerOnFinal = shouldInlineCompletionMarker(config);
      let finalOutput = job.maintenanceIssue
        ? maintenanceIssueOutcome.content
        : job.maintenance
          ? formatDailyMaintenanceResult(dailyMaintenanceResult, {
              changesVerified: Boolean(verifiedMaintenanceCommitHead(maintenanceGitSummary)),
              unverifiedReason: generalMaintenanceGitBlocker(maintenanceGitSummary),
            })
          : stripTrailingJobCompletionMarkers(resultWithoutRestartControl.output);
      const artifactDelivery = parseSlackThreadStateId(job.threadId)
        ? { files: [], skipped: [], unreferenced: [] }
        : await deliveryArtifactsForFinalMessage({
            artifactRoot: jobArtifactRoot(config, job),
            finalText: finalOutput,
            beforeSnapshot: artifactDeliveryBeforeJob,
          });
      if (artifactDelivery.skipped.length > 0 || artifactDelivery.unreferenced.length > 0) {
        await logSystem('discord-artifact-delivery-skipped', {
          jobId: job.id,
          channelId: job.channelId,
          threadId: job.threadId,
          skipped: artifactDelivery.skipped,
          unreferenced: artifactDelivery.unreferenced,
        });
        finalOutput = appendArtifactDeliveryWarning(finalOutput, artifactDelivery);
      }
      const finalDelivery = await postJobFinalMessage(
        job,
        inlineMarkerOnFinal ? appendJobCompletionMarker(finalOutput, marker) : finalOutput,
        {
          files: artifactDelivery.files,
          threadOnly: Boolean(maintenanceIssueOutcome?.suppressChannelPost),
        },
      );
      deliveries.push(finalDelivery);
      if (shouldPostStandaloneCompletionMarker(config.jobCompletionMarkerMode, finalDelivery)) {
        deliveries.push(await postJobCompletionMarker(job, deliveries, {
          marker,
          threadOnly: Boolean(maintenanceIssueOutcome?.suppressChannelPost),
        }));
      }
      const delivered = deliveries.every((delivery) => delivery.delivered);
      await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
        id: job.id,
        updatedAt: new Date().toISOString(),
        finishedAt: delivered ? new Date().toISOString() : null,
        status: delivered ? 'done' : 'delivery-queued',
        delivered,
        worker: result.worker,
        workerAttempts: result.attempts,
        maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
        maintenanceIssueResolved: maintenanceIssueOutcome?.resolved ?? null,
        maintenanceIssueCommitHead: maintenanceIssueOutcome?.head || null,
        outboxIds: deliveries.flatMap((delivery) => delivery.outboxId ? [delivery.outboxId] : []),
      });
      await updateMaintenanceManifestSafe(job, {
        status: delivered ? 'completed' : 'delivery-queued',
        mode: job.maintenanceMode || (job.maintenanceInputLimitResume ? 'minimal-resume' : 'sharded'),
        cursor: {
          last_completed_task_id: delivered ? 'verification-and-report' : null,
          next_task_id: delivered ? null : 'verification-and-report',
        },
      });
      await maybeRestartAfterMaintenanceGroup(job, result);
    } catch (error) {
      if (job.maintenance && isWorkerInputLimitError(error) && error.promptChars === undefined) {
        error.promptChars = prompt.length;
      }
      if (!transcriptSaved) {
        const transcriptStatus = isSupersededJobError(error)
          ? 'superseded'
          : isCancelledJobError(error)
            ? 'cancelled'
            : isServiceShutdownInterruptedJobError(error)
              ? 'interrupted'
              : 'failed';
        checkpointSnapshot = await finishJobCheckpointSafe(job, checkpointRecorder, {
          status: transcriptStatus,
          error: formatErrorDetail(error),
          worker: error.worker || null,
          finalAnswerReady: false,
        });
        await saveJobTranscript(job, {
          output: '',
          worker: error.worker || null,
          attempts: error.workerAttempts || [],
          workerTranscripts: error.workerTranscripts || [],
          error: formatErrorDetail(error),
        }, prompt, {
          status: transcriptStatus,
          error: formatErrorDetail(error),
          checkpoint: checkpointSnapshot,
          checkpointPath: checkpointRecorder?.path || '',
        });
      }
      throw error;
    } finally {
      if (!skipProgressFlush && !isJobStopAbortReason(job.abortController?.signal?.reason)) {
        progressUpdateGate?.release();
        await progressForwarder?.flush({ force: true }).catch((error) => {
          logSystem('worker-progress-flush-failed', {
            jobId: job.id,
            channelId: job.channelId,
            threadId: job.threadId,
            error: formatErrorDetail(error),
          }).catch(() => {});
        });
      }
      progressForwarder?.stop();
      progressTimer?.stop();
    }
  } finally {
    const released = await releaseThreadJobLock(config, job).catch((error) => {
      logSystem('thread-job-lock-release-failed', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        error: formatErrorDetail(error),
      }).catch(() => {});
      return false;
    });
    if (!released) {
      await logSystem('thread-job-lock-release-skipped', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
      });
    }
  }
}

function canJobWaitForUser(job = {}) {
  return Boolean(config.activeAsks?.enabled)
    && !job.maintenance
    && !job.finalChannelId;
}

async function markJobWaitingForUser(job, result = {}, pendingAsk = {}) {
  const now = new Date();
  const timeoutMs = Math.max(0, Number(config.activeAsks?.timeoutMs) || 0);
  const expiresAt = timeoutMs > 0 ? new Date(now.getTime() + timeoutMs).toISOString() : null;
  const askId = `${job.id}_ask`;
  const waitingRecord = {
    id: askId,
    status: 'waiting',
    createdAt: now.toISOString(),
    expiresAt,
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    worker: result.worker || null,
    workerAttempts: result.attempts || [],
    question: pendingAsk.question || '',
    reason: pendingAsk.reason || '',
    answerFormat: pendingAsk.answerFormat || '',
    choices: Array.isArray(pendingAsk.choices) ? pendingAsk.choices : [],
    rawPayload: pendingAsk.rawPayload || '',
    visibleText: pendingAsk.visibleText || '',
    threadModelOverride: compactThreadModelOverride(job.threadModelOverride),
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.ACTIVE_THREAD_FOLLOW_UP,
    finalChannelId: job.finalChannelId || null,
  };
  await threadState(job.channelId, job.threadId).appendJsonl(PENDING_ASKS_FILE, waitingRecord);

  const deliveries = [];
  const visibleText = String(pendingAsk.visibleText || '').trim();
  if (visibleText) {
    deliveries.push(await postJobFinalMessage(job, visibleText, { purpose: 'job-final' }));
  }

  const askDelivery = await postJobThreadMessageAfter(job, formatPendingAskMessage(pendingAsk), deliveries, {
    purpose: 'job-waiting-for-user',
  });
  deliveries.push(askDelivery);
  if (shouldPostPendingAskCompletionMarker(config)) {
    deliveries.push(await postJobCompletionMarker(job, deliveries, { marker: jobCompletionSummary(result, job) }));
  }

  const delivered = deliveries.every((delivery) => delivery.delivered);
  const queued = deliveries.some((delivery) => delivery.queued);
  const skipped = deliveries.some((delivery) => delivery.skipped);
  const duplicate = deliveries.some((delivery) => delivery.duplicate);
  const messageIds = deliveries.flatMap((delivery) => Array.isArray(delivery.messageIds)
    ? delivery.messageIds.filter(Boolean)
    : []);
  const outboxIds = deliveries.flatMap((delivery) => delivery.outboxId ? [delivery.outboxId] : []);

  await threadState(job.channelId, job.threadId).appendJsonl(PENDING_ASKS_FILE, {
    id: askId,
    status: 'waiting',
    updatedAt: new Date().toISOString(),
    delivered: Boolean(askDelivery.delivered),
    queued: Boolean(askDelivery.queued),
    skipped: Boolean(askDelivery.skipped),
    duplicate: Boolean(askDelivery.duplicate),
    outboxId: askDelivery.outboxId || null,
    messageIds: Array.isArray(askDelivery.messageIds) ? askDelivery.messageIds.filter(Boolean) : [],
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    status: 'waiting_for_user',
    waitingAskId: askId,
    expiresAt,
    delivered,
    queued,
    skipped,
    duplicate,
    outboxId: outboxIds[0] || null,
    outboxIds,
    messageIds,
    worker: result.worker || null,
    workerAttempts: result.attempts || [],
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.ACTIVE_THREAD_FOLLOW_UP,
    attempt: job.attempt || 1,
    finalChannelId: job.finalChannelId || null,
  });
  await logSystem('job-waiting-for-user', {
    jobId: job.id,
    askId,
    channelId: job.channelId,
    threadId: job.threadId,
    worker: result.worker || null,
    expiresAt,
    delivered,
    queued,
    outboxIds,
  });
}

async function handleThreadJobLocked(job, owner) {
  const retryMs = Math.max(1_000, Number(config.jobThreadLockRetryMs) || 5_000);
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    status: 'thread-lock-waiting',
    retryAt: new Date(Date.now() + retryMs).toISOString(),
    priority: job.priority ?? PRIORITY.NORMAL_TOP_LEVEL_JOB,
    recoveredFromJobId: job.recoveredFromJobId || null,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
      ? job.maintenanceGitBaselinePaths
      : null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    attempt: job.attempt || 1,
    finalChannelId: job.finalChannelId || null,
    pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    lockOwner: compactLockOwner(owner),
  });
  await logSystem('thread-job-lock-waiting', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    retryMs,
    owner: compactLockOwner(owner),
  });
  const timer = setTimeout(() => requeueJob(job), retryMs);
  timer.unref?.();
}

function requeueJob(job) {
  enqueueJobIfNotSupersededByNewerThreadEvent(job, {
    id: job.id,
    recoveredFromJobId: job.recoveredFromJobId,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
      ? job.maintenanceGitBaselinePaths
      : null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority,
    attempt: job.attempt || 1,
    finalChannelId: job.finalChannelId,
    pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
  }).catch((error) => logSystem('job-requeue-error', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    error: formatErrorDetail(error),
  }));
}

function compactLockOwner(owner) {
  if (!owner) return null;
  return {
    pid: owner.pid ?? null,
    startedAt: owner.startedAt || null,
    jobId: owner.jobId || null,
    channelId: owner.channelId || null,
    threadId: owner.threadId || null,
  };
}

async function handleJobError(job, error) {
  const detail = formatErrorDetail(error);
  if (isSupersededJobError(error)) {
    await markJobSuperseded(job, detail, supersededByJobIdFromError(error));
    return;
  }
  if (isCancelledJobError(error)) {
    await markJobCancelled(job, detail);
    return;
  }
  if (isServiceShutdownInterruptedJobError(error)) {
    await markJobInterruptedByServiceShutdown(job, detail);
    return;
  }
  if (isOperatorTerminatedError(error)) {
    await markJobCancelled(job, detail);
    return;
  }
  if (job.maintenance && isWorkerInputLimitError(error)) {
    if (job.maintenanceIssue) {
      await markMaintenanceInputLimitFailed(job, error, detail);
      return;
    }
    if (!job.maintenanceInputLimitResume) {
      await scheduleMaintenanceInputLimitResume(job, error, detail);
      return;
    }
    await markMaintenanceInputLimitFailed(job, error, detail);
    return;
  }
  if (isNonRetryableJobError(error)) {
    await markJobFailedNonRetryable(job, error, detail);
    return;
  }

  const attempt = job.attempt || 1;
  const nextAttempt = attempt + 1;
  const delayMs = retryDelayMsForError(error, attempt);
  await logSystem('job-retry-scheduled', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    attempt,
    nextAttempt,
    delayMs,
    error: detail,
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    status: 'retry-scheduled',
    attempt,
    nextAttempt,
    retryAt: new Date(Date.now() + delayMs).toISOString(),
    recoveredFromJobId: job.recoveredFromJobId || null,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.NORMAL_TOP_LEVEL_JOB,
    finalChannelId: job.finalChannelId || null,
    pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    error: detail,
  });
  if (shouldNotifyRetry(attempt)) {
    await postJobMessage(job, [
      '작업 지연',
      `사유: 내부 실행 오류로 자동 재시도 중입니다. attempt=${attempt}`,
      '개선: 이 작업은 완료 전까지 폐기하지 않고 backoff로 계속 재시도합니다.',
    ].join('\n')).catch((postError) =>
      logSystem('job-retry-notify-failed', {
        jobId: job.id,
        error: formatErrorDetail(postError),
      }),
    );
  }
  setTimeout(() => {
    enqueueJobIfNotSupersededByNewerThreadEvent(job, {
      id: job.id,
      recoveredFromJobId: job.recoveredFromJobId,
      maintenance: job.maintenance,
      maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
      concurrencyKey: job.concurrencyKey || null,
      maintenanceMode: job.maintenanceMode || null,
      maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
      maintenanceManifestPath: job.maintenanceManifestPath || null,
      maintenanceRawContextPath: job.maintenanceRawContextPath || null,
      maintenanceSummaryPath: job.maintenanceSummaryPath || null,
      maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
        ? job.maintenanceGitBaselinePaths
        : null,
      repoAccess: Boolean(job.repoAccess),
      repoPath: job.repoPath || null,
      stateAccess: Boolean(job.stateAccess),
      richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
      search: job.search,
      verboseProgress: Boolean(job.verboseProgress),
      priority: job.priority,
      attempt: nextAttempt,
      finalChannelId: job.finalChannelId,
      pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    }).catch((enqueueError) => logSystem('job-retry-enqueue-error', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      error: formatErrorDetail(enqueueError),
    }));
  }, delayMs);
}

async function markJobFailedNonRetryable(job, error, errorDetail) {
  if (job.maintenance) {
    await updateMaintenanceManifestSafe(job, {
      status: 'failed',
      mode: job.maintenanceMode || (job.maintenanceInputLimitResume ? 'minimal-resume' : 'sharded'),
      failed_reason: 'non-retryable-worker-error',
      last_error: errorDetail,
    });
  }
  await logSystem('job-non-retryable-failed', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    worker: error?.worker || null,
    error: errorDetail,
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'failed',
    failed_reason: 'non-retryable-worker-error',
    nonRetryable: true,
    delivered: false,
    recoveredFromJobId: job.recoveredFromJobId || null,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
      ? job.maintenanceGitBaselinePaths
      : null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.NORMAL_TOP_LEVEL_JOB,
    attempt: job.attempt || 1,
    finalChannelId: job.finalChannelId || null,
    pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    worker: error?.worker || null,
    workerAttempts: Array.isArray(error?.workerAttempts) ? error.workerAttempts : [],
    error: errorDetail,
  });
  const visibleDetail = errorDetail.length > 1_200
    ? `${errorDetail.slice(0, 1_200)}...`
    : errorDetail;
  const maintenanceFailure = job.maintenanceIssue
    ? [
        `버그 #${job.maintenanceIssue.number} 미해결`,
        `- worker 실행 오류로 해결 여부를 검증하지 못했습니다: ${conciseError(errorDetail)}`,
        job.maintenanceIssue.url || '',
      ].filter(Boolean).join('\n')
    : `적용한 개선 없음 — 유지보수 worker 실행을 완료하지 못했습니다: ${conciseError(errorDetail)}`;
  const issueFollowup = job.maintenanceIssue
    ? await recordMaintenanceIssueFollowup({
        issue: compactMaintenanceIssue(job.maintenanceIssue),
        resolved: false,
        blockerCode: 'worker-error',
      })
    : { report: true };
  const normalFailure = [
    '작업 실패',
    '사유: worker 접근/인증 설정 오류라 자동 재시도로 해결되지 않는 유형입니다.',
    '자동 재시도하지 않습니다. 설정을 수정한 뒤 다시 요청해주세요.',
    `오류: ${visibleDetail}`,
  ].join('\n');
  const delivery = await (job.maintenance
    ? postJobFinalMessage(job, maintenanceFailure, {
        purpose: 'job-final',
        threadOnly: issueFollowup.report === false,
      })
    : postJobMessage(job, normalFailure, { purpose: 'job-non-retryable-failed' }))
    .catch((postError) => {
      logSystem('job-non-retryable-failed-notify-failed', {
        jobId: job.id,
        error: formatErrorDetail(postError),
      }).catch(() => {});
      return { delivered: false, queued: false };
    });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: delivery.delivered ? new Date().toISOString() : null,
    status: delivery.delivered ? 'failed' : 'delivery-queued',
    failed_reason: 'non-retryable-worker-error',
    delivered: Boolean(delivery.delivered),
    outboxId: delivery.outboxId || null,
  });
  await maybeRestartAfterMaintenanceGroup(job, {
    worker: error?.worker || null,
    attempts: error?.workerAttempts || [],
  });
}

async function scheduleMaintenanceInputLimitResume(job, error, errorDetail) {
  const promptChars = error?.promptChars ?? null;
  const maxPromptChars = config.maintenance.inputBudgetChars;
  const resumeId = `${job.id}_minimal_resume_${Date.now()}`;
  await updateDailyMaintenanceManifest(job.maintenanceManifestPath, {
    status: 'minimal-resume-queued',
    mode: 'minimal-resume',
    failed_reason: 'input-limit',
    input_budget: {
      last_prompt_chars: promptChars,
      max_prompt_chars: maxPromptChars,
    },
    last_error: errorDetail,
  }).catch((manifestError) => logSystem('maintenance-manifest-update-failed', {
    jobId: job.id,
    manifestPath: job.maintenanceManifestPath || null,
    error: formatErrorDetail(manifestError),
  }));

  const resumeEvent = {
    ...job.event,
    id: resumeId,
    timestamp: new Date().toISOString(),
    authorId: 'system',
    authorName: 'system-maintenance',
    content: buildDailyMaintenanceMinimalResumeTask({
      manifestPath: job.maintenanceManifestPath,
      rawContextPath: job.maintenanceRawContextPath,
      summaryPath: job.maintenanceSummaryPath,
      reason: 'input-limit',
      failedWorker: error?.worker || job.worker || null,
      errorDetail,
      promptChars,
      maxPromptChars,
    }),
    acknowledged: true,
    acknowledgedAt: new Date().toISOString(),
  };
  await threadState(job.channelId, job.threadId).appendJsonl('memory/events.jsonl', resumeEvent);
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'input-limit-resume-queued',
    continuationJobId: resumeId,
    recoveredFromJobId: job.recoveredFromJobId || null,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
      ? job.maintenanceGitBaselinePaths
      : null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.SYSTEM_MAINTENANCE,
    attempt: job.attempt || 1,
    error: errorDetail,
  });
  await logSystem('maintenance-input-limit-resume-queued', {
    jobId: job.id,
    continuationJobId: resumeId,
    channelId: job.channelId,
    threadId: job.threadId,
    manifestPath: job.maintenanceManifestPath || null,
    promptChars,
    maxPromptChars,
    worker: error?.worker || null,
  });
  await postJobMessage(job, [
    '새벽유지보수 입력 제한 감지',
    'normal prompt를 같은 크기로 재시도하지 않고 minimal-resume job을 1회 큐에 넣었습니다.',
    `manifest: ${job.maintenanceManifestPath || '(missing)'}`,
  ].join('\n'), { purpose: 'maintenance-input-limit-resume' }).catch((postError) =>
    logSystem('maintenance-input-limit-resume-notify-failed', {
      jobId: job.id,
      error: formatErrorDetail(postError),
    }),
  );
  enqueueCodexJob(resumeEvent, {
    id: resumeId,
    recoveredFromJobId: job.id,
    maintenance: true,
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: 'minimal-resume',
    maintenanceInputLimitResume: true,
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
      ? job.maintenanceGitBaselinePaths
      : null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.SYSTEM_MAINTENANCE,
    attempt: 1,
    finalChannelId: job.finalChannelId || null,
  });
}

async function markMaintenanceInputLimitFailed(job, error, errorDetail) {
  await updateMaintenanceManifestSafe(job, {
    status: 'failed',
    mode: job.maintenanceMode || 'minimal-resume',
    failed_reason: 'input-limit',
    input_budget: {
      last_prompt_chars: error?.promptChars ?? null,
      max_prompt_chars: config.maintenance.inputBudgetChars,
    },
    last_error: errorDetail,
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'input-limit-failed',
    recoveredFromJobId: job.recoveredFromJobId || null,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.SYSTEM_MAINTENANCE,
    attempt: job.attempt || 1,
    error: errorDetail,
  });
  await logSystem('maintenance-input-limit-failed', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    manifestPath: job.maintenanceManifestPath || null,
    promptChars: error?.promptChars ?? null,
    maxPromptChars: config.maintenance.inputBudgetChars,
    worker: error?.worker || null,
  });
  const content = job.maintenanceIssue
    ? [
        `버그 #${job.maintenanceIssue.number} 미해결`,
        '- worker 입력 제한으로 점검을 완료하지 못해 이슈를 닫지 않았습니다.',
        job.maintenanceIssue.url || '',
      ].filter(Boolean).join('\n')
    : '적용한 개선 없음 — 최소 입력으로 재시도했지만 worker 입력 제한이 다시 발생했습니다.';
  const issueFollowup = job.maintenanceIssue
    ? await recordMaintenanceIssueFollowup({
        issue: compactMaintenanceIssue(job.maintenanceIssue),
        resolved: false,
        blockerCode: 'worker-input-limit',
      })
    : { report: true };
  const delivery = await postJobFinalMessage(job, content, {
    purpose: 'job-final',
    threadOnly: issueFollowup.report === false,
  }).catch((postError) => {
    logSystem('maintenance-input-limit-failed-notify-failed', {
      jobId: job.id,
      error: formatErrorDetail(postError),
    }).catch(() => {});
    return { delivered: false, queued: false };
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: delivery.delivered ? new Date().toISOString() : null,
    status: delivery.delivered ? 'input-limit-failed' : 'delivery-queued',
    delivered: Boolean(delivery.delivered),
    outboxId: delivery.outboxId || null,
  });
  await maybeRestartAfterMaintenanceGroup(job, {
    worker: error?.worker || null,
    attempts: error?.workerAttempts || [],
  });
}

async function enqueueJobIfNotSupersededByNewerThreadEvent(job, options = {}) {
  const supersedingEvent = await supersedingThreadEvent(job);
  if (supersedingEvent) {
    await markJobSuperseded(job, `superseded by newer thread event ${supersedingEvent.id}`, supersedingEvent.id);
    return false;
  }
  enqueueCodexJob(job.event, options);
  return true;
}

async function restartRunningThreadJobsForAccess(event, access = {}) {
  let requeued = 0;
  const accessContext = {
    repoAccess: Boolean(access?.repoAccess),
    repoPath: access?.repoPath || null,
    bridgeRepoAccess: Boolean(access?.bridgeRepoAccess),
    stateAccess: Boolean(access?.stateAccess),
  };
  for (const runningJob of running.values()) {
    if (runningJob.id === event.id) continue;
    if (runningJob.maintenance) continue;
    if (jobThreadKey(runningJob) !== jobThreadKey(event)) continue;
    if (!runningJob.abortController || runningJob.abortController.signal.aborted) continue;
    if (!jobAccessNeedsUpgrade(runningJob, accessContext)) continue;

    const upgraded = upgradedJobAccess(runningJob, accessContext);
    const continuationId = continuationJobId(runningJob.event?.id || runningJob.id);
    enqueueCodexJob(runningJob.event, {
      id: continuationId,
      recoveredFromJobId: runningJob.id,
      maintenance: Boolean(runningJob.maintenance),
      maintenanceIssue: compactMaintenanceIssue(runningJob.maintenanceIssue),
      concurrencyKey: runningJob.concurrencyKey || null,
      maintenanceMode: runningJob.maintenanceMode || null,
      maintenanceInputLimitResume: Boolean(runningJob.maintenanceInputLimitResume),
      maintenanceManifestPath: runningJob.maintenanceManifestPath || null,
      maintenanceRawContextPath: runningJob.maintenanceRawContextPath || null,
      maintenanceSummaryPath: runningJob.maintenanceSummaryPath || null,
      maintenanceGitBaselinePaths: Array.isArray(runningJob.maintenanceGitBaselinePaths)
        ? runningJob.maintenanceGitBaselinePaths
        : null,
      repoAccess: upgraded.repoAccess,
      repoPath: upgraded.repoPath,
      bridgeRepoAccess: upgraded.bridgeRepoAccess,
      stateAccess: upgraded.stateAccess,
      richStyleId: normalizeRichStyleId(runningJob.richStyleId, DEFAULT_RICH_STYLE_ID),
      threadModelOverride: runningJob.threadModelOverride || null,
      search: Boolean(runningJob.search),
      verboseProgress: Boolean(runningJob.verboseProgress),
      priority: runningJob.priority,
      attempt: runningJob.attempt || 1,
      finalChannelId: runningJob.finalChannelId,
      pendingAskAnswer: compactPendingAskAnswer(runningJob.pendingAskAnswer),
    });

    const reason = `${SUPERSEDED_ABORT_REASON_PREFIX}${event.id}`;
    runningJob.abortController.abort(reason);
    await markJobSuperseding(runningJob, event.id);
    await logSystem('job-access-upgrade-requeued', {
      jobId: runningJob.id,
      continuationJobId: continuationId,
      upgradedByJobId: event.id,
      channelId: runningJob.channelId,
      threadId: runningJob.threadId,
      before: compactJobAccess(runningJob),
      after: upgraded,
    });
    requeued += 1;
  }
  return { requeued };
}

async function restartRunningThreadJobsForVerbose(event, verboseProgress = true) {
  let requeued = 0;
  for (const runningJob of running.values()) {
    if (runningJob.id === event.id) continue;
    if (runningJob.maintenance) continue;
    if (jobThreadKey(runningJob) !== jobThreadKey(event)) continue;
    if (!runningJob.abortController || runningJob.abortController.signal.aborted) continue;
    if (Boolean(runningJob.verboseProgress) === Boolean(verboseProgress)) continue;

    const continuationId = continuationJobId(runningJob.event?.id || runningJob.id);
    enqueueCodexJob(runningJob.event, {
      id: continuationId,
      recoveredFromJobId: runningJob.id,
      maintenance: Boolean(runningJob.maintenance),
      maintenanceIssue: compactMaintenanceIssue(runningJob.maintenanceIssue),
      concurrencyKey: runningJob.concurrencyKey || null,
      maintenanceMode: runningJob.maintenanceMode || null,
      maintenanceInputLimitResume: Boolean(runningJob.maintenanceInputLimitResume),
      maintenanceManifestPath: runningJob.maintenanceManifestPath || null,
      maintenanceRawContextPath: runningJob.maintenanceRawContextPath || null,
      maintenanceSummaryPath: runningJob.maintenanceSummaryPath || null,
      maintenanceGitBaselinePaths: Array.isArray(runningJob.maintenanceGitBaselinePaths)
        ? runningJob.maintenanceGitBaselinePaths
        : null,
      repoAccess: Boolean(runningJob.repoAccess),
      repoPath: runningJob.repoPath || null,
      stateAccess: Boolean(runningJob.stateAccess),
      richStyleId: normalizeRichStyleId(runningJob.richStyleId, DEFAULT_RICH_STYLE_ID),
      threadModelOverride: runningJob.threadModelOverride || null,
      search: Boolean(runningJob.search),
      verboseProgress: Boolean(verboseProgress),
      priority: runningJob.priority,
      attempt: runningJob.attempt || 1,
      finalChannelId: runningJob.finalChannelId,
      pendingAskAnswer: compactPendingAskAnswer(runningJob.pendingAskAnswer),
    });

    const reason = `${SUPERSEDED_ABORT_REASON_PREFIX}${event.id}`;
    runningJob.abortController.abort(reason);
    await markJobSuperseding(runningJob, event.id);
    await logSystem('job-verbose-upgrade-requeued', {
      jobId: runningJob.id,
      continuationJobId: continuationId,
      upgradedByJobId: event.id,
      channelId: runningJob.channelId,
      threadId: runningJob.threadId,
      before: { verboseProgress: Boolean(runningJob.verboseProgress) },
      after: { verboseProgress: Boolean(verboseProgress) },
    });
    requeued += 1;
  }
  return { requeued };
}

function jobAccessNeedsUpgrade(job, access) {
  if (access.stateAccess && !job.stateAccess) return true;
  if (access.repoAccess && !job.repoAccess) return true;
  if (access.bridgeRepoAccess && !job.bridgeRepoAccess) return true;
  if (access.repoAccess && access.repoPath && path.resolve(job.repoPath || config.codex.cwd) !== path.resolve(access.repoPath)) {
    return true;
  }
  return false;
}

function upgradedJobAccess(job, access) {
  return {
    repoAccess: Boolean(job.repoAccess || access.repoAccess || access.stateAccess),
    repoPath: access.repoPath || job.repoPath || (job.repoAccess || access.repoAccess || access.stateAccess ? config.codex.cwd : null),
    bridgeRepoAccess: Boolean(job.bridgeRepoAccess || access.bridgeRepoAccess),
    stateAccess: Boolean(job.stateAccess || access.stateAccess),
  };
}

function compactJobAccess(job = {}) {
  return {
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    bridgeRepoAccess: Boolean(job.bridgeRepoAccess),
    stateAccess: Boolean(job.stateAccess),
    threadModelOverride: compactThreadModelOverride(job.threadModelOverride),
    verboseProgress: Boolean(job.verboseProgress),
    codexFastMode: Boolean(job.codexFastMode),
  };
}

function compactMaintenanceIssue(issue = null) {
  if (!issue || typeof issue !== 'object') return null;
  const number = Number.parseInt(issue.number, 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    number,
    title: String(issue.title || '').trim().slice(0, 300),
    url: String(issue.url || '').trim().slice(0, 2_000),
    repository: String(issue.repository || '').trim().slice(0, 300),
    // Carried so the follow-up ledger can tell "nothing changed since the last
    // unresolved attempt" from "the issue was updated, retry now".
    updatedAt: String(issue.updatedAt || '').trim().slice(0, 100),
  };
}

function sameJobAccess(left, right) {
  return Boolean(left?.repoAccess) === Boolean(right?.repoAccess)
    && path.resolve(left?.repoPath || '') === path.resolve(right?.repoPath || '')
    && Boolean(left?.bridgeRepoAccess) === Boolean(right?.bridgeRepoAccess)
    && Boolean(left?.stateAccess) === Boolean(right?.stateAccess)
    && threadModelOverrideKey(left?.threadModelOverride) === threadModelOverrideKey(right?.threadModelOverride)
    && Boolean(left?.verboseProgress) === Boolean(right?.verboseProgress)
    && Boolean(left?.codexFastMode) === Boolean(right?.codexFastMode);
}

function threadModelOverrideKey(override) {
  return override ? JSON.stringify(compactThreadModelOverride(override)) : null;
}

async function abortSupersededRunningThreadJobs(event) {
  const incomingThreadKey = jobThreadKey(event);
  let aborted = 0;
  for (const runningJob of running.values()) {
    if (runningJob.id === event.id) continue;
    if (jobThreadKey(runningJob) !== incomingThreadKey) continue;
    if (!runningJob.abortController || runningJob.abortController.signal.aborted) continue;
    if (!shouldSupersedeLiveJob(event, runningJob)) continue;

    const reason = `${SUPERSEDED_ABORT_REASON_PREFIX}${event.id}`;
    runningJob.abortController.abort(reason);
    await markJobSuperseding(runningJob, event.id);
    aborted += 1;
  }
  return aborted;
}

async function cancelRunningThreadJobs(event) {
  const incomingThreadKey = jobThreadKey(event);
  let cancelled = 0;
  for (const runningJob of running.values()) {
    if (runningJob.id === event.id) continue;
    if (jobThreadKey(runningJob) !== incomingThreadKey) continue;
    if (!runningJob.abortController || runningJob.abortController.signal.aborted) continue;

    runningJob.abortController.abort(`${CANCELLED_ABORT_REASON_PREFIX}${event.id}`);
    await markJobCancelling(runningJob, event.id);
    cancelled += 1;
  }
  return cancelled;
}

async function markJobSuperseding(job, supersededByJobId) {
  await logSystem('job-superseding', {
    jobId: job.id,
    supersededByJobId,
    channelId: job.channelId,
    threadId: job.threadId,
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    status: 'superseding',
    supersededByJobId,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
  });
}

async function markJobCancelling(job, cancelledByMessageId) {
  await logSystem('job-cancelling', {
    jobId: job.id,
    cancelledByMessageId,
    channelId: job.channelId,
    threadId: job.threadId,
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    status: 'cancelling',
    cancelledByMessageId,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
  });
}

async function markJobSuperseded(job, errorDetail, supersededByJobId) {
  await logSystem('job-superseded', {
    jobId: job.id,
    supersededByJobId,
    channelId: job.channelId,
    threadId: job.threadId,
    error: errorDetail,
  });
  let delivery = { delivered: false, queued: false, skipped: true };
  if (await supersededJobNeedsStopNotice(job)) {
    delivery = await postJobStopNotice(job, 'superseded');
  } else {
    await logSystem('job-superseded-notice-suppressed', {
      jobId: job.id,
      supersededByJobId,
      channelId: job.channelId,
      threadId: job.threadId,
      reason: 'worker-not-started-and-no-visible-delivery',
    });
  }
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'superseded',
    delivered: Boolean(delivery.delivered),
    queued: Boolean(delivery.queued),
    skipped: Boolean(delivery.skipped),
    duplicate: Boolean(delivery.duplicate),
    outboxId: delivery.outboxId || null,
    messageIds: Array.isArray(delivery.messageIds) ? delivery.messageIds.filter(Boolean) : [],
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    supersededByJobId,
    error: errorDetail,
  });
}

async function supersededJobNeedsStopNotice(job) {
  if (job?.workerStarted || job?.userVisibleDelivery) return true;
  try {
    const state = threadState(job.channelId, job.threadId);
    const [jobRecords, outboundEvents] = await Promise.all([
      state.readJsonl('jobs/jobs.jsonl', { limit: 10_000 }),
      state.readJsonl('memory/events.jsonl', { limit: 10_000 }),
    ]);
    return shouldPostSupersededNotice({
      jobId: job.id,
      workerStarted: Boolean(job.workerStarted),
      visibleDelivery: Boolean(job.userVisibleDelivery),
      jobRecords,
      outboundEvents,
    });
  } catch (error) {
    // Suppression is a noise optimization, never a reason to hide state when
    // durable evidence cannot be read.
    await logSystem('job-superseded-notice-evidence-read-failed', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      error: formatErrorDetail(error),
    });
    return true;
  }
}

function isSupersededJobError(error) {
  return Boolean(error?.aborted && isSupersededAbortReason(error.abortReason));
}

function isServiceShutdownInterruptedJobError(error) {
  return Boolean(error?.serviceShutdownInterrupted)
    || shouldRecoverJobInterruptedByServiceShutdown(error, shuttingDown);
}

function supersededByJobIdFromError(error) {
  return supersededByJobIdFromReason(error?.abortReason);
}

function supersededByJobIdFromReason(reason) {
  const text = String(reason || '');
  return isSupersededAbortReason(text) ? text.slice(SUPERSEDED_ABORT_REASON_PREFIX.length) : null;
}

function isSupersededAbortReason(reason) {
  return String(reason || '').startsWith(SUPERSEDED_ABORT_REASON_PREFIX);
}

function isCancelledAbortReason(reason) {
  return String(reason || '').startsWith(CANCELLED_ABORT_REASON_PREFIX);
}

function isJobStopAbortReason(reason) {
  return isSupersededAbortReason(reason) || isCancelledAbortReason(reason);
}

function isCancelledJobError(error) {
  return Boolean(error?.aborted && isCancelledAbortReason(error.abortReason));
}

async function finishIfJobSuperseded(job) {
  const reason = job.abortController?.signal?.reason;
  if (!isSupersededAbortReason(reason)) return false;
  const supersededByJobId = supersededByJobIdFromReason(reason);
  await markJobSuperseded(job, `superseded by newer job ${supersededByJobId}`, supersededByJobId);
  return true;
}

async function finishIfJobStopped(job) {
  if (await finishIfJobSuperseded(job)) return true;
  const reason = job.abortController?.signal?.reason;
  if (!isCancelledAbortReason(reason)) return false;
  await markJobCancelled(job, `cancelled by command ${cancelledByMessageIdFromReason(reason)}`);
  return true;
}

function cancelledByMessageIdFromReason(reason) {
  const text = String(reason || '');
  return isCancelledAbortReason(text) ? text.slice(CANCELLED_ABORT_REASON_PREFIX.length) : null;
}

async function markJobCancelled(job, errorDetail) {
  await logSystem('job-cancelled', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    error: errorDetail,
  });
  const delivery = await postJobStopNotice(job, 'cancelled');
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'cancelled',
    delivered: Boolean(delivery.delivered),
    queued: Boolean(delivery.queued),
    skipped: Boolean(delivery.skipped),
    duplicate: Boolean(delivery.duplicate),
    outboxId: delivery.outboxId || null,
    messageIds: Array.isArray(delivery.messageIds) ? delivery.messageIds.filter(Boolean) : [],
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    error: errorDetail,
  });
}

async function postJobStopNotice(job, status) {
  const content = formatJobStopMessage(status);
  if (!content) return { delivered: false, queued: false, skipped: true };
  try {
    return await postJobMessage(job, content, { purpose: `job-${status}` });
  } catch (error) {
    await logSystem(`job-${status}-notify-failed`, {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      error: formatErrorDetail(error),
    });
    return { delivered: false, queued: false, skipped: true };
  }
}

async function markJobInterruptedByServiceShutdown(job, errorDetail) {
  await logSystem('job-interrupted-by-service-shutdown', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    error: errorDetail,
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    status: 'started',
    interruptedByServiceShutdown: true,
    recoveredFromJobId: job.recoveredFromJobId || null,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
      ? job.maintenanceGitBaselinePaths
      : null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.NORMAL_TOP_LEVEL_JOB,
    attempt: job.attempt || 1,
    finalChannelId: job.finalChannelId || null,
    pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    error: errorDetail,
  });
}

async function captureJobRuntimeSourceSnapshot(job) {
  // Most `/repo` jobs can only touch their channel workspace or an external
  // repository. Hashing every bridge runtime file before and after those jobs
  // cannot detect an attributable edit, so reserve the scan for jobs whose
  // actual allowed roots contain the bridge checkout.
  if (!jobCanModifyBridgeSource(config, job)) return null;
  try {
    return await captureRuntimeSourceSnapshot({ cwd: repoRoot });
  } catch (error) {
    await logSystem('runtime-source-snapshot-failed', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      error: formatErrorDetail(error),
    });
    return null;
  }
}

async function runtimeSourceChangesSince(snapshot, job, checkpoint = null) {
  if (!snapshot || !jobCanModifyBridgeSource(config, job)) return [];
  try {
    const detectedPaths = await changedRuntimeSourcePaths({ cwd: repoRoot, before: snapshot });
    const { attributedPaths, ignoredPaths } = attributeRuntimeSourceChanges({
      changedPaths: detectedPaths,
      checkpoint,
      repoRoot,
      trustAll: Boolean(job.maintenance),
    });
    if (ignoredPaths.length > 0) {
      await logSystem('runtime-source-changes-not-attributed-to-job', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        ignoredPaths,
      });
    }
    return attributedPaths;
  } catch (error) {
    await logSystem('runtime-source-change-check-failed', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      error: formatErrorDetail(error),
    });
    return [];
  }
}

async function markJobNeedsRuntimeRestart(job, result, runtimeChangedPaths) {
  await logSystem('runtime-source-restart-required', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    worker: result.worker,
    runtimeChangedPaths,
  });
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    status: 'needs-runtime-restart',
    recoveredFromJobId: job.recoveredFromJobId || null,
    maintenance: Boolean(job.maintenance),
    maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
    concurrencyKey: job.concurrencyKey || null,
    maintenanceMode: job.maintenanceMode || null,
    maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
    maintenanceManifestPath: job.maintenanceManifestPath || null,
    maintenanceRawContextPath: job.maintenanceRawContextPath || null,
    maintenanceSummaryPath: job.maintenanceSummaryPath || null,
    maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
      ? job.maintenanceGitBaselinePaths
      : null,
    repoAccess: Boolean(job.repoAccess),
    repoPath: job.repoPath || null,
    stateAccess: Boolean(job.stateAccess),
    richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    search: Boolean(job.search),
    verboseProgress: Boolean(job.verboseProgress),
    priority: job.priority ?? PRIORITY.NORMAL_TOP_LEVEL_JOB,
    attempt: job.attempt || 1,
    finalChannelId: job.finalChannelId || null,
    pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    worker: result.worker,
    workerAttempts: result.attempts,
    runtimeChangedPaths,
  });
  await updateMaintenanceManifestSafe(job, {
    status: 'needs-runtime-restart',
    mode: job.maintenanceMode || (job.maintenanceInputLimitResume ? 'minimal-resume' : 'sharded'),
  });
}

async function startJobCheckpointSafe(
  job,
  prompt = '',
  { baselineSnapshot = null, workspaceRoots = [] } = {},
) {
  const threadRoot = threadStateDir(config, job.channelId, job.threadId);
  const transcriptRoot = jobTranscriptRoot(threadRoot, job);
  const checkpointPath = path.join(transcriptRoot, 'checkpoint.json');
  try {
    const recorder = await createJobCheckpointRecorder({
      job,
      checkpointPath,
      workingDir: jobWorkingDirectory(config, job),
      workspaceRoots,
      prompt,
      baselineSnapshot,
    });
    const savedAt = new Date().toISOString();
    await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
      id: job.id,
      updatedAt: savedAt,
      status: 'checkpoint-saved',
      checkpointStatus: 'running',
      attempt: job.attempt || 1,
      transcriptRoot: relativeStatePath(threadRoot, transcriptRoot),
      checkpointPath: relativeStatePath(threadRoot, checkpointPath),
    });
    return recorder;
  } catch (error) {
    await logSystem('job-checkpoint-start-failed', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      error: formatErrorDetail(error),
    });
    return null;
  }
}

function jobCheckpointWorkspaceRoots(job, workingDir) {
  const roots = [workingDir];
  if (job.repoPath) roots.push(job.repoPath);
  if ((job.bridgeRepoAccess || job.maintenance) && config.bridgeRepoRoot) {
    roots.push(config.bridgeRepoRoot);
  }
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

async function finishJobCheckpointSafe(job, recorder, options = {}) {
  if (!recorder) return null;
  try {
    const threadRoot = threadStateDir(config, job.channelId, job.threadId);
    const finalOutputPath = path.join(jobTranscriptRoot(threadRoot, job), 'final.md');
    const finalAnswerReady = Boolean(
      options.finalAnswerReady
        && String(options.output || '').trim(),
    );
    if (finalAnswerReady) {
      await writeMaskedTextAtomic(finalOutputPath, options.output);
    }
    return await recorder.finish({
      ...options,
      finalAnswerReady,
      finalAnswerPath: relativeStatePath(threadRoot, finalOutputPath),
    });
  } catch (error) {
    await logSystem('job-checkpoint-finish-failed', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      error: formatErrorDetail(error),
    });
    return recorder.snapshot();
  }
}

async function saveJobTranscript(job, result = {}, prompt = '', {
  status = 'succeeded',
  error = '',
  checkpoint = null,
  checkpointPath = '',
} = {}) {
  try {
    await persistJobTranscript(job, result, prompt, {
      status,
      error,
      checkpoint,
      checkpointPath,
    });
  } catch (saveError) {
    await logSystem('job-transcript-save-failed', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      error: formatErrorDetail(saveError),
    });
  }
}

async function persistJobTranscript(job, result = {}, prompt = '', {
  status = 'succeeded',
  error = '',
  checkpoint = null,
  checkpointPath = '',
} = {}) {
  const threadRoot = threadStateDir(config, job.channelId, job.threadId);
  const transcriptRoot = jobTranscriptRoot(threadRoot, job);
  const savedAt = new Date().toISOString();
  await fs.mkdir(transcriptRoot, { recursive: true });

  const promptPath = path.join(transcriptRoot, 'prompt.md');
  const finalOutputPath = path.join(transcriptRoot, 'final.md');
  const handoffPath = path.join(transcriptRoot, 'handoff.md');
  // Transcript files are durable state and get re-injected into later handoff
  // prompts, so mask secrets in every persisted copy (mirrors events.jsonl).
  await writeMaskedTextAtomic(promptPath, prompt);
  await writeMaskedTextAtomic(finalOutputPath, result.output);

  const workerTranscripts = Array.isArray(result.workerTranscripts) ? result.workerTranscripts : [];
  const transcriptEntries = [];
  for (const [index, transcript] of workerTranscripts.entries()) {
    const attemptDir = path.join(
      transcriptRoot,
      `${String(index + 1).padStart(2, '0')}-${statePathPart(transcript.worker || `worker-${index + 1}`)}`,
    );
    await fs.mkdir(attemptDir, { recursive: true });
    const stdoutPath = path.join(attemptDir, 'stdout.log');
    const stderrPath = path.join(attemptDir, 'stderr.log');
    const outputPath = path.join(attemptDir, 'output.md');
    const metadataPath = path.join(attemptDir, 'metadata.json');
    await writeMaskedTextAtomic(stdoutPath, transcript.stdout);
    await writeMaskedTextAtomic(stderrPath, transcript.stderr);
    await writeMaskedTextAtomic(outputPath, transcript.output);

    const metadata = workerTranscriptMetadata(transcript);
    await writeMaskedTextAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    transcriptEntries.push({
      ...metadata,
      stdoutPath: relativeStatePath(threadRoot, stdoutPath),
      stderrPath: relativeStatePath(threadRoot, stderrPath),
      outputPath: relativeStatePath(threadRoot, outputPath),
      metadataPath: relativeStatePath(threadRoot, metadataPath),
    });
  }

  const handoff = buildJobHandoffMarkdown({
    job,
    result,
    status,
    error,
    savedAt,
    transcriptRoot,
    threadRoot,
    promptPath,
    finalOutputPath,
    workerTranscripts,
    transcriptEntries,
    checkpoint,
    checkpointPath,
  });
  await writeMaskedTextAtomic(handoffPath, handoff);

  const manifestPath = path.join(transcriptRoot, 'manifest.json');
  const manifest = {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    status,
    savedAt,
    worker: result.worker || null,
    workerAttempts: result.attempts || [],
    error: error || result.error || null,
    promptPath: relativeStatePath(threadRoot, promptPath),
    finalOutputPath: relativeStatePath(threadRoot, finalOutputPath),
    handoffPath: relativeStatePath(threadRoot, handoffPath),
    checkpointPath: checkpointPath ? relativeStatePath(threadRoot, checkpointPath) : null,
    workerTranscripts: transcriptEntries,
  };
  await writeMaskedTextAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: savedAt,
    status: 'transcript-saved',
    transcriptStatus: status,
    transcriptRoot: relativeStatePath(threadRoot, transcriptRoot),
    manifestPath: relativeStatePath(threadRoot, manifestPath),
    handoffPath: relativeStatePath(threadRoot, handoffPath),
    checkpointPath: checkpointPath ? relativeStatePath(threadRoot, checkpointPath) : null,
    checkpointStatus: checkpoint?.status || null,
    finalAnswerReady: Boolean(checkpoint?.final_answer_ready),
    worker: result.worker || null,
    workerAttempts: result.attempts || [],
    error: error || result.error || null,
  });
}

async function writeMaskedTextAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, maskSecrets(String(value || '')), { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function workerTranscriptMetadata(transcript = {}) {
  return {
    worker: transcript.worker || null,
    status: transcript.status || null,
    startedAt: transcript.startedAt || null,
    finishedAt: transcript.finishedAt || null,
    code: transcript.code ?? null,
    signal: transcript.signal ?? null,
    timedOut: Boolean(transcript.timedOut),
    aborted: Boolean(transcript.aborted),
    abortReason: transcript.abortReason || '',
    noProgressKilled: Boolean(transcript.noProgressKilled),
    noProgressKillMs: transcript.noProgressKillMs ?? null,
    error: transcript.error || '',
    updateCount: Array.isArray(transcript.updates) ? transcript.updates.length : 0,
  };
}

function relativeStatePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

async function postJobFinalMessage(job, content, { purpose = 'job-final', files = [], threadOnly = false } = {}) {
  // `threadOnly` keeps a report that carries no news out of the parent channel
  // while still recording it in the job's own work thread.
  if (threadOnly || !job.finalChannelId) return postJobMessage(job, content, { purpose, files });
  assertParentChannelDestination(job.channelId, job.finalChannelId);
  return postJobParentChannelMessage(job, content, { purpose, files });
}

// Response markers carry the model and effort that produced the response, e.g.
// "【(codex: gpt-5.6-terra (xhigh)) 응답완료】". Prefer the worker's menu label
// ("provider: model"); fall back to constructing it from the base worker + model.
function jobWorkerDisplay(result, job = {}) {
  const label = String(result?.workerLabel || '').trim();
  if (label.includes(':')) return label;
  const base = String(result?.workerBase || result?.worker || '').trim();
  const provider = base === 'codex-spark' ? 'codex' : base;
  const model = String(result?.workerModel || configuredWorkerModelForJob(base, job) || '').trim();
  if (provider && model) return `${provider}: ${model}`;
  return provider || label;
}

// A detached worker reattached after a restart never re-emits `worker.started`,
// so recover the worker that is actually still running from the job's own
// `worker-started` record. This is exact where the planned chain head is only a
// guess — it survives a fallback worker having taken over before the restart.
async function reattachedWorkerStartInfo(job) {
  if (!v3WorkbenchMode) return null;
  let reattaching = false;
  try {
    reattaching = Boolean(v3WorkbenchRuntime?.hasDurableWorker(job));
  } catch {
    return null;
  }
  if (!reattaching) return null;
  // Deep enough to look past a chatty job's progress-update records back to its
  // own worker-started line. Only a reattach reaches here, so the extra parsing
  // is paid once per recovered job, not per job.
  const records = await threadState(job.channelId, job.threadId)
    .readJsonl('jobs/jobs.jsonl', { limit: 4000 })
    .catch(() => []);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.status !== 'worker-started' || String(record.id || '') !== String(job.id)) continue;
    const worker = String(record.worker || '').trim();
    const workerLabel = String(record.workerLabel || '').trim();
    if (!worker && !workerLabel) return null;
    return {
      worker,
      workerBase: worker,
      workerLabel: workerLabel || worker,
      workerEffort: String(record.workerEffort || '').trim(),
      reattached: true,
    };
  }
  return null;
}

function configuredWorkerModelForJob(base, job = {}) {
  switch (base) {
    case 'codex':
      return job.maintenance ? config.codex?.maintenanceModel || config.codex?.model : config.codex?.model;
    case 'codex-spark':
      return config.codexSpark?.model;
    case 'claude':
      return job.maintenance ? config.claude?.maintenanceModel || config.claude?.model : config.claude?.model;
    case 'gemini':
      return config.gemini?.model;
    case 'antigravity':
      return config.antigravity?.model || config.antigravity?.proModel || config.antigravity?.opusModel;
    default:
      return null;
  }
}

function jobWorkerEffort(result, job = {}) {
  const effort = String(result?.workerEffort || '').trim();
  if (effort) return effort;
  const base = String(result?.workerBase || result?.worker || '').trim();
  return configuredWorkerEffortForJob(base, job);
}

function configuredWorkerEffortForJob(base, job = {}) {
  switch (base) {
    case 'codex':
      return config.codex?.reasoningEffort || 'xhigh';
    case 'codex-spark':
      return config.codexSpark?.reasoningEffort || 'xhigh';
    case 'claude':
      return job.maintenance
        ? config.claude?.maintenanceEffort || 'xhigh'
        : config.claude?.effort || 'xhigh';
    case 'antigravity':
      return config.antigravity?.effort || 'high';
    default:
      return null;
  }
}

// Native Gemini has no CLI effort flag; Antigravity uses low/medium/high.
// The label's "provider: model" colon is flattened to a space so the marker reads
// "codex gpt-5.6-terra" rather than "codex: gpt-5.6-terra".
function jobWorkerProgressDisplay(result, job = {}) {
  const display = jobWorkerDisplay(result, job);
  const effort = jobWorkerEffort(result, job);
  const workerDisplay = display ? display.replace(/:\s*/, ' ') : '';
  if (!workerDisplay) return '';
  return effort ? `${workerDisplay} (${effort})` : workerDisplay;
}

function jobWorkerMarkerDisplay(result, job = {}) {
  const display = jobWorkerDisplay(result, job);
  if (!display) return '';
  const effort = jobWorkerEffort(result, job);
  return effort ? `${display} (${effort})` : display;
}

// User-directed format: "【(codex: gpt-5.6-terra (xhigh)) 응답완료】".
// The start marker mirrors the completion marker.
function jobStartMarker(result, job = {}) {
  const workerDisplay = jobWorkerMarkerDisplay(result, job);
  return workerDisplay ? `【(${workerDisplay}) 응답시작】` : '【응답시작】';
}

function jobCompletionMarker(result, job = {}) {
  const workerDisplay = jobWorkerMarkerDisplay(result, job);
  if (!workerDisplay) return JOB_COMPLETION_MARKER;
  return `【(${workerDisplay}) 응답완료】`;
}

function jobCompletionSummary(result, job = {}) {
  return formatJobCompletionSummary(jobCompletionMarker(result, job), result, {
    previousDurationMs: job.previousWorkerDurationMs,
  });
}

function shouldInlineCompletionMarker(currentConfig = config) {
  return String(currentConfig?.jobCompletionMarkerMode || 'inline') === 'inline';
}

function shouldPostPendingAskCompletionMarker(currentConfig = config) {
  return String(currentConfig?.jobCompletionMarkerMode || 'inline') !== 'off';
}

function appendJobCompletionMarker(content, marker = JOB_COMPLETION_MARKER) {
  const body = stripTrailingJobCompletionMarkers(content);
  if (!marker) return body;
  return body ? `${body}\n\n${marker}` : marker;
}

async function postJobCompletionMarker(job, priorDeliveries = [], {
  marker = JOB_COMPLETION_MARKER,
  threadOnly = false,
} = {}) {
  const afterOutboxIds = queuedOutboxIds(priorDeliveries);
  if (afterOutboxIds.length === 0) {
    return postJobFinalMessage(job, marker, { purpose: 'job-completion-marker', threadOnly });
  }
  // The marker follows its own final message: a thread-only report must not
  // leave a bare completion marker behind in the parent channel.
  return queueJobFinalMessage(job, marker, {
    purpose: 'job-completion-marker',
    afterOutboxIds,
    lastError: 'waiting for previous job response outbox deliveries',
    threadOnly,
  });
}

async function postJobThreadMessageAfter(job, content, priorDeliveries = [], { purpose = 'job-message' } = {}) {
  if (job.finalChannelId) {
    throw new Error('thread message sequencing is only supported for thread-scoped jobs');
  }
  const afterOutboxIds = queuedOutboxIds(priorDeliveries);
  if (afterOutboxIds.length === 0) {
    return postJobMessage(job, content, { purpose });
  }
  return queueJobFinalMessage(job, content, {
    purpose,
    afterOutboxIds,
    lastError: 'waiting for previous pending-ask response outbox deliveries',
  });
}

function queuedOutboxIds(deliveries = []) {
  return [...new Set((Array.isArray(deliveries) ? deliveries : [])
    .flatMap((delivery) => delivery?.outboxId ? [delivery.outboxId] : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
}

async function queueJobFinalMessage(job, content, {
  purpose = 'job-message',
  afterOutboxIds = [],
  lastError = null,
  threadOnly = false,
} = {}) {
  const destinationChannelId = jobFinalDestinationChannelId(job, { threadOnly });
  const formattedContent = formatOutboundMessage(content);
  const duplicateDelivery = await maybeDuplicateJobOutboundDelivery(job, formattedContent, {
    purpose,
    destinationChannelId,
  });
  if (duplicateDelivery) return duplicateDelivery;
  const queued = await queueDestinationOutbox(destinationChannelId, {
    content: formattedContent,
    options: { styleId: jobRichStyleId(job) },
    purpose,
    job,
    afterOutboxIds,
    dedupeKey: jobMessageDedupeKey(job, destinationChannelId, formattedContent, { purpose }),
    lastError,
  });
  await logSystem(`${queued.platform}-outbox-queued`, {
    outboxId: queued.entry.id,
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    destinationChannelId,
    purpose,
    afterOutboxIds,
    deferred: true,
    error: lastError,
  });
  const delivery = { delivered: false, queued: true, outboxId: queued.entry.id, afterOutboxIds };
  rememberJobOutboundForDedupe(job, formattedContent, { purpose, destinationChannelId, delivery });
  await recordJobOutboundMessage(job, formattedContent, delivery, {
    purpose,
    destinationChannelId,
  });
  return delivery;
}

function jobFinalDestinationChannelId(job, { threadOnly = false } = {}) {
  if (threadOnly || !job.finalChannelId) {
    assertThreadDestination(job.channelId, job.threadId);
    return job.threadId;
  }
  assertParentChannelDestination(job.channelId, job.finalChannelId);
  return job.finalChannelId;
}

async function maybeDuplicateJobOutboundDelivery(job, formattedContent, {
  purpose = 'job-message',
  destinationChannelId = '',
  files = [],
} = {}) {
  if (!DEDUPED_JOB_OUTBOUND_PURPOSES.has(String(purpose || ''))) return null;
  const deliveryFingerprint = artifactDeliveryFingerprint(files);
  const duplicate = await durableJobOutboundDuplicate(job, formattedContent, {
    purpose,
    destinationChannelId,
    deliveryFingerprint,
  }) || jobMessageDedupe.duplicateFor(job, formattedContent, {
    destinationChannelId,
    deliveryFingerprint,
  });
  if (!duplicate) return null;
  if (!shouldSuppressDuplicateJobOutbound(purpose, duplicate)) return null;
  logSystem('job-outbound-duplicate-skipped', {
    jobId: job.id,
    rootJobId: rootJobId(job.id),
    channelId: job.channelId,
    threadId: job.threadId,
    destinationChannelId,
    purpose,
    duplicatePurpose: duplicate.purpose || null,
  }).catch(() => {});
  const messageIds = Array.isArray(duplicate.messageIds) ? duplicate.messageIds.filter(Boolean) : [];
  const delivered = Boolean(duplicate.delivered) || (messageIds.length > 0 && !duplicate.queued);
  const delivery = {
    delivered,
    queued: !delivered && Boolean(duplicate.queued),
    skipped: true,
    duplicate: true,
    duplicatePurpose: duplicate.purpose || null,
    outboxId: duplicate.outboxId || null,
    messageIds,
  };
  if (shouldReconcileSuppressedJobFinalToMemory(purpose, duplicate)) {
    await recordJobOutboundMessage(job, formattedContent, delivery, {
      purpose,
      destinationChannelId,
      files,
    });
  }
  return delivery;
}

async function durableJobOutboundDuplicate(job, formattedContent, {
  purpose = 'job-message',
  destinationChannelId = '',
  deliveryFingerprint = '',
} = {}) {
  const comparables = new Set(comparableJobMessageContents(formattedContent));
  if (comparables.size === 0) return null;
  const currentRootJobId = rootJobId(job.id);
  const events = await threadState(job.channelId, job.threadId).readJsonl('memory/events.jsonl', { limit: 1000 });
  for (const event of events.slice().reverse()) {
    if (!isBridgeGeneratedThreadEvent(event)) continue;
    if (rootJobId(event.jobId) !== currentRootJobId) continue;
    if (String(event.destinationChannelId || '') !== String(destinationChannelId || '')) continue;
    if (String(event.deliveryFingerprint || '') !== String(deliveryFingerprint || '')) continue;
    const eventComparables = comparableJobMessageContents(event.content || '');
    if (!eventComparables.some((comparable) => comparables.has(comparable))) continue;
    const duplicate = {
      purpose: event.purpose || null,
      destinationChannelId: event.destinationChannelId || null,
      delivered: Boolean(event.delivered),
      queued: Boolean(event.queued),
      outboxId: event.outboxId || null,
      messageIds: Array.isArray(event.messageIds) ? event.messageIds.filter(Boolean) : [],
    };
    if (shouldSuppressDuplicateJobOutbound(purpose, duplicate)) return duplicate;
  }
  return null;
}

function rememberJobOutboundForDedupe(job, formattedContent, {
  purpose = 'job-message',
  destinationChannelId = '',
  delivery = {},
  files = [],
} = {}) {
  jobMessageDedupe.remember(job, formattedContent, {
    purpose,
    destinationChannelId,
    delivery,
    deliveryFingerprint: artifactDeliveryFingerprint(files),
  });
}

function artifactDeliveryMessageOptions(job, destinationChannelId, content, purpose, files = []) {
  const options = {
    styleId: jobRichStyleId(job),
  };
  if (!Array.isArray(files) || files.length === 0) return options;
  return {
    ...options,
    files,
    verifyFiles: true,
    deliveryNonce: artifactDeliveryNonce({
      jobId: job?.id,
      destinationChannelId,
      purpose,
      content,
      files,
    }),
  };
}

function jobRichStyleId(job = {}) {
  return resolveJobRichStyleIdSync(config, job);
}

function artifactDeliveryRetryOptions(messageOptions, error) {
  const messageId = Array.isArray(error?.discordMessageIds)
    ? String(error.discordMessageIds[0] || '').trim()
    : '';
  if (!error?.discordAttachmentVerificationPending || !messageId) return messageOptions;
  return {
    ...messageOptions,
    reconcileAttachmentMessageId: messageId,
  };
}

async function postJobMessage(job, content, {
  purpose = 'job-message',
  queueOnFailure = true,
  files = [],
} = {}) {
  assertThreadDestination(job.channelId, job.threadId);
  const formattedContent = formatOutboundMessage(content);
  const duplicateDelivery = await maybeDuplicateJobOutboundDelivery(job, formattedContent, {
    purpose,
    destinationChannelId: job.threadId,
    files,
  });
  if (duplicateDelivery) {
    noteJobVisibleDelivery(job, duplicateDelivery);
    return duplicateDelivery;
  }
  const platform = parseSlackThreadStateId(job.threadId) ? 'slack' : 'discord';
  const messageOptions = artifactDeliveryMessageOptions(
    job,
    job.threadId,
    formattedContent,
    purpose,
    files,
  );
  try {
    const messages = await postDestinationMessage(
      job.threadId,
      formattedContent,
      messageOptions,
    );
    const delivery = { delivered: true, messageIds: messages.map((message) => message.id).filter(Boolean) };
    noteJobVisibleDelivery(job, delivery);
    rememberJobOutboundForDedupe(job, formattedContent, {
      purpose,
      destinationChannelId: job.threadId,
      delivery,
      files,
    });
    await recordJobOutboundMessage(job, formattedContent, delivery, {
      purpose,
      destinationChannelId: job.threadId,
      files,
    });
    return delivery;
  } catch (error) {
    if (!queueOnFailure) {
      await logSystem(`${platform}-message-dropped-after-send-failure`, {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        purpose,
        error: formatErrorDetail(error),
      });
      return { delivered: false, queued: false, skipped: true, error: formatErrorDetail(error) };
    }
    const queued = await queueDestinationOutbox(job.threadId, {
      content: formattedContent,
      options: artifactDeliveryRetryOptions(messageOptions, error),
      ...destinationOutboxProgress(platform, error),
      purpose,
      job,
      dedupeKey: jobMessageDedupeKey(job, job.threadId, formattedContent, {
        purpose,
        deliveryFingerprint: artifactDeliveryFingerprint(files),
      }),
      lastError: formatErrorDetail(error),
    });
    await logSystem(`${queued.platform}-outbox-queued`, {
      outboxId: queued.entry.id,
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      purpose,
      error: formatErrorDetail(error),
    });
    const delivery = { delivered: false, queued: true, outboxId: queued.entry.id };
    rememberJobOutboundForDedupe(job, formattedContent, {
      purpose,
      destinationChannelId: job.threadId,
      delivery,
      files,
    });
    await recordJobOutboundMessage(job, formattedContent, delivery, {
      purpose,
      destinationChannelId: job.threadId,
      files,
    });
    return delivery;
  }
}

async function postJobParentChannelMessage(job, content, { purpose = 'job-message', files = [] } = {}) {
  assertParentChannelDestination(job.channelId, job.finalChannelId);
  const formattedContent = formatOutboundMessage(content);
  const duplicateDelivery = await maybeDuplicateJobOutboundDelivery(job, formattedContent, {
    purpose,
    destinationChannelId: job.finalChannelId,
    files,
  });
  if (duplicateDelivery) {
    noteJobVisibleDelivery(job, duplicateDelivery);
    return duplicateDelivery;
  }
  const messageOptions = artifactDeliveryMessageOptions(
    job,
    job.finalChannelId,
    formattedContent,
    purpose,
    files,
  );
  try {
    const messages = await api.postMessage(
      job.finalChannelId,
      formattedContent,
      messageOptions,
    );
    const delivery = { delivered: true, messageIds: messages.map((message) => message.id).filter(Boolean) };
    noteJobVisibleDelivery(job, delivery);
    rememberJobOutboundForDedupe(job, formattedContent, {
      purpose,
      destinationChannelId: job.finalChannelId,
      delivery,
      files,
    });
    await recordJobOutboundMessage(job, formattedContent, delivery, {
      purpose,
      destinationChannelId: job.finalChannelId,
      files,
    });
    return delivery;
  } catch (error) {
    const entry = await queueDiscordOutbox(systemState(), {
      channelId: job.finalChannelId,
      content: formattedContent,
      options: artifactDeliveryRetryOptions(messageOptions, error),
      ...discordOutboxProgressFromError(error),
      purpose,
      job,
      dedupeKey: jobMessageDedupeKey(job, job.finalChannelId, formattedContent, {
        purpose,
        deliveryFingerprint: artifactDeliveryFingerprint(files),
      }),
      lastError: formatErrorDetail(error),
    });
    await logSystem('discord-outbox-queued', {
      outboxId: entry.id,
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      destinationChannelId: job.finalChannelId,
      purpose,
      error: formatErrorDetail(error),
    });
    const delivery = { delivered: false, queued: true, outboxId: entry.id };
    rememberJobOutboundForDedupe(job, formattedContent, {
      purpose,
      destinationChannelId: job.finalChannelId,
      delivery,
      files,
    });
    await recordJobOutboundMessage(job, formattedContent, delivery, {
      purpose,
      destinationChannelId: job.finalChannelId,
      files,
    });
    return delivery;
  }
}

function noteJobVisibleDelivery(job, delivery = {}) {
  if (delivery.delivered || (Array.isArray(delivery.messageIds) && delivery.messageIds.length > 0)) {
    job.userVisibleDelivery = true;
  }
}

async function recordJobOutboundMessage(job, content, delivery = {}, {
  purpose = 'job-message',
  destinationChannelId = null,
  files = [],
} = {}) {
  if (!shouldRecordJobOutboundPurpose(purpose)) return;
  try {
    const now = new Date().toISOString();
    const messageIds = Array.isArray(delivery.messageIds) ? delivery.messageIds.filter(Boolean) : [];
    const id = messageIds[0]
      || (delivery.outboxId ? `outbox_${delivery.outboxId}` : `${job.id}_${purpose}_${Date.now()}`);
    await threadState(job.channelId, job.threadId).appendJsonl('memory/events.jsonl', {
      id,
      timestamp: now,
      authorId: 'bridge-agent',
      authorName: 'Codex bridge',
      channelId: job.channelId,
      threadId: job.threadId,
      content: String(content || ''),
      attachments: compactArtifactDeliveryFiles(files),
      deliveryFingerprint: artifactDeliveryFingerprint(files) || null,
      source: 'bridge-agent',
      jobId: job.id,
      purpose,
      destinationChannelId,
      delivered: Boolean(delivery.delivered),
      queued: Boolean(delivery.queued),
      outboxId: delivery.outboxId || null,
      messageIds,
    });
  } catch (error) {
    await logSystem('job-outbound-memory-record-failed', {
      jobId: job.id,
      channelId: job.channelId,
      threadId: job.threadId,
      purpose,
      error: formatErrorDetail(error),
    });
  }
}

function shouldRecordJobOutboundPurpose(purpose) {
  return !new Set(['job-progress', 'worker-progress']).has(String(purpose || ''));
}

async function postSystemMessage(channelId, content, { purpose = 'system-message', options = {} } = {}) {
  const formattedContent = formatOutboundMessage(content);
  const platform = parseSlackThreadStateId(channelId) ? 'slack' : 'discord';
  try {
    const messages = await postDestinationMessage(channelId, formattedContent, options);
    return { delivered: true, messageIds: messages.map((message) => message.id).filter(Boolean) };
  } catch (error) {
    const queued = await queueDestinationOutbox(channelId, {
      content: formattedContent,
      options,
      ...destinationOutboxProgress(platform, error),
      purpose,
      lastError: formatErrorDetail(error),
    });
    await logSystem(`${platform}-system-outbox-queued`, {
      outboxId: queued.entry.id,
      channelId,
      purpose,
      error: formatErrorDetail(error),
    });
    return { delivered: false, queued: true, outboxId: queued.entry.id };
  }
}

async function postRestartNotice(request, content) {
  const destination = resolveRestartNoticeDestination(request, {
    discordGeneralChannelId: config.discord.generalChannelId,
    slackChannelId: config.slack.channelId,
  });
  if (destination.platform === 'slack') {
    return postSlackChannelSystemMessage(destination, content, {
      purpose: 'service-restart',
    });
  }
  return postSystemMessage(destination.channelId, content, {
    purpose: 'service-restart',
  });
}

async function postSlackChannelSystemMessage(
  destination,
  content,
  { purpose = 'system-message' } = {},
) {
  const formattedContent = formatOutboundMessage(content);
  assertConfiguredSlackDestination(destination);
  try {
    const messages = await slackApi.postMessage(destination.channelId, formattedContent);
    return { delivered: true, messageIds: messages.map((message) => message.id).filter(Boolean) };
  } catch (error) {
    const entry = await queueSlackOutbox(systemState(), {
      channelId: destination.channelId,
      content: formattedContent,
      ...slackOutboxProgressFromError(error),
      purpose,
      lastError: formatErrorDetail(error),
    });
    await logSystem('slack-system-outbox-queued', {
      outboxId: entry.id,
      channelId: destination.channelId,
      purpose,
      error: formatErrorDetail(error),
    });
    return { delivered: false, queued: true, outboxId: entry.id };
  }
}

async function postDestinationMessage(destinationId, content, options = {}) {
  const slackDestination = parseSlackThreadStateId(destinationId);
  if (!slackDestination) return api.postMessage(destinationId, content, options);
  assertConfiguredSlackDestination(slackDestination);
  return slackApi.postMessage(slackDestination.channelId, content, {
    threadTs: slackDestination.threadTs,
    styleId: normalizeRichStyleId(options.styleId),
    includeStylePreview: options.includeStylePreview === true,
  });
}

async function queueDestinationOutbox(destinationId, message) {
  const slackDestination = parseSlackThreadStateId(destinationId);
  if (!slackDestination) {
    return {
      platform: 'discord',
      entry: await queueDiscordOutbox(systemState(), {
        channelId: destinationId,
        ...message,
      }),
    };
  }
  assertConfiguredSlackDestination(slackDestination);
  return {
    platform: 'slack',
    entry: await queueSlackOutbox(systemState(), {
      channelId: slackDestination.channelId,
      threadTs: slackDestination.threadTs,
      destinationId,
      ...message,
    }),
  };
}

function destinationOutboxProgress(platform, error) {
  return platform === 'slack'
    ? slackOutboxProgressFromError(error)
    : discordOutboxProgressFromError(error);
}

function assertConfiguredSlackDestination(destination) {
  if (!config.slack.enabled || !config.slack.botToken) {
    throw new Error('Slack delivery is unavailable because the Slack bridge is disabled');
  }
  if (String(destination.channelId) !== String(config.slack.channelId)) {
    throw new Error(`refusing Slack delivery to an unconfigured channel: ${destination.channelId}`);
  }
  if (slackTeamId && String(destination.teamId) !== String(slackTeamId)) {
    throw new Error(`refusing Slack delivery to an unconfigured workspace: ${destination.teamId}`);
  }
}

function buildPrompt(job, threadContext, todoContext, jobHandoffContext = '', channelMemoryContext = '') {
  const allowedRoots = jobAllowedRoots(config, job);
  return buildBridgePrompt({
    ignoreBefore,
    job,
    threadContext,
    jobHandoffContext,
    activeAsksEnabled: canJobWaitForUser(job),
    todoContext,
    channelMemoryContext,
    projectRoot: config.projectRoot,
    workingDir: jobWorkingDirectory(config, job),
    bridgeRepoRoot: job.bridgeRepoAccess ? config.bridgeRepoRoot : '',
    channelStateRoot: channelStateDir(config, job.channelId),
    channelArtifactRoot: jobArtifactRoot(config, job),
    channelPythonVenvPath: channelPythonVenvPath(config, job.channelId),
    githubCredentialDir: config.github?.preferHostCredential && config.github?.credentialAvailable
      ? config.github.configDir
      : '',
    githubGitConfigGlobal: config.github?.preferHostCredential && config.github?.gitConfigAvailable
      ? config.github.gitConfigGlobal
      : '',
    githubAskPassPath: config.github?.preferHostCredential && config.github?.askPassAvailable
      ? config.github.askPassPath
      : '',
    bugReportRepository: config.maintenance?.bugReportRepository || '',
    threadStateRoot: threadStateDir(config, job.channelId, job.threadId),
    allowedRoots,
    repoAccess: jobNeedsRepoAccess(job),
    bridgeRepoAccess: Boolean(job.bridgeRepoAccess),
    stateAccess: jobNeedsFullStateAccess(job),
  });
}

function maintenanceThreadContextOptions(job = {}) {
  if (job.maintenance) return { maxMessages: 12, maxChars: 6_000 };
  return { maxMessages: 80, maxChars: 30_000 };
}

async function maybeCompactMaintenancePrompt(job, prompt, todoContext, channelMemoryContext = '') {
  if (!job.maintenance) return prompt;
  const budget = maintenancePromptBudget(prompt, {
    maxPromptChars: config.maintenance.inputBudgetChars,
  });
  if (!budget.overBudget) return prompt;
  await logSystem('maintenance-prompt-over-budget', {
    jobId: job.id,
    channelId: job.channelId,
    threadId: job.threadId,
    maintenanceMode: job.maintenanceMode || null,
    promptChars: budget.chars,
    maxPromptChars: budget.maxPromptChars,
    manifestPath: job.maintenanceManifestPath || null,
  });
  if (job.maintenanceInputLimitResume) {
    const error = new Error(`maintenance minimal-resume prompt exceeds input budget: ${budget.chars} > ${budget.maxPromptChars}`);
    error.inputLimit = true;
    error.promptChars = budget.chars;
    throw error;
  }

  const compactJob = {
    ...job,
    maintenanceMode: 'minimal-resume',
    event: {
      ...job.event,
      content: buildDailyMaintenanceMinimalResumeTask({
        manifestPath: job.maintenanceManifestPath,
        rawContextPath: job.maintenanceRawContextPath,
        summaryPath: job.maintenanceSummaryPath,
        reason: 'preflight-input-budget',
        promptChars: budget.chars,
        maxPromptChars: budget.maxPromptChars,
      }),
    },
  };
  const compactThreadContext = buildJobThreadContext(
    [compactJob.event],
    compactJob,
    { maxMessages: 1, maxChars: 6_000 },
  );
  const compactPrompt = buildPrompt(compactJob, compactThreadContext, todoContext, '', channelMemoryContext);
  const compactBudget = maintenancePromptBudget(compactPrompt, {
    maxPromptChars: config.maintenance.inputBudgetChars,
  });
  if (compactBudget.overBudget) {
    const error = new Error(`maintenance compact prompt exceeds input budget: ${compactBudget.chars} > ${compactBudget.maxPromptChars}`);
    error.inputLimit = true;
    error.promptChars = compactBudget.chars;
    throw error;
  }
  return compactPrompt;
}

async function updateMaintenanceManifestSafe(job, patch) {
  if (!job.maintenance || !job.maintenanceManifestPath) return null;
  return updateDailyMaintenanceManifest(job.maintenanceManifestPath, patch)
    .catch((error) => {
      logSystem('maintenance-manifest-update-failed', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        manifestPath: job.maintenanceManifestPath,
        error: formatErrorDetail(error),
      }).catch(() => {});
      return null;
    });
}

function scheduleDailyMaintenance() {
  if (!config.maintenance.enabled) return;
  const runAt = nextDailyMaintenanceAtKst();
  const delayMs = delayUntil(runAt);
  logSystem('daily-maintenance-scheduled', { runAt: runAt.toISOString(), delayMs }).catch(() => {});
  setTimeout(() => {
    runDailyMaintenance()
      .catch((error) => logSystem('daily-maintenance-error', { error: formatErrorDetail(error) }))
      .finally(() => scheduleDailyMaintenance());
  }, delayMs);
}

function scheduleDailyReports() {
  if (!config.dailyReports.enabled) return;
  for (const report of dailyReportDefinitions(config)) scheduleDailyReport(report);
}

function scheduleDailyReport(report) {
  // Morning news reports are delivered only on KST weekdays.
  const runAt = nextDailyReportAtKst(new Date(), config.dailyReports.hourKst);
  const delayMs = delayUntil(runAt);
  logSystem('daily-report-scheduled', {
    key: report.key,
    channelId: report.channelId,
    runAt: runAt.toISOString(),
    hourKst: config.dailyReports.hourKst,
    weekdaysOnly: true,
    delayMs,
  }).catch(() => {});
  setTimeout(() => {
    runDailyReport(report)
      .catch((error) => logSystem('daily-report-error', {
        key: report.key,
        channelId: report.channelId,
        error: formatErrorDetail(error),
      }))
      .finally(() => scheduleDailyReport(report));
  }, delayMs);
}

async function runDailyReport(report) {
  const title = `${report.title} ${kstDateLabel(new Date())}`;
  const [message] = await api.postMessage(report.channelId, [
    `${report.title} 시작`,
    `실행 시각: ${new Date().toISOString()}`,
    '범위: 최신 웹 검색 기반 아침 뉴스 정리',
  ].join('\n'));
  const thread = await api.createThreadFromMessage(
    report.channelId,
    message.id,
    title,
    config.discord.autoArchiveDuration,
  );
  const event = {
    id: `daily_report_${report.key}_${Date.now()}`,
    timestamp: new Date().toISOString(),
    authorId: 'system',
    authorName: report.authorName,
    channelId: report.channelId,
    threadId: thread.id,
    content: report.content,
    attachments: [],
    acknowledged: true,
    acknowledgedAt: new Date().toISOString(),
  };
  await threadState(event.channelId, event.threadId).appendJsonl('memory/events.jsonl', event);
  enqueueCodexJob(event, {
    id: event.id,
    priority: PRIORITY.NORMAL_TOP_LEVEL_JOB,
    search: true,
    // Keep the working thread for execution context, but publish the completed
    // report as a fresh post in its configured channel.
    finalChannelId: report.finalChannelId,
  });
  await logSystem('daily-report-queued', {
    key: report.key,
    channelId: report.channelId,
    threadId: thread.id,
    jobId: event.id,
  });
}

async function initializeBugReportRepository() {
  const configured = String(config.maintenance?.bugReportRepository || '').trim();
  const normalizedConfigured = configured
    ? githubRepositoryFromRemoteUrl(configured)
      || githubRepositoryFromRemoteUrl(`https://github.com/${configured}.git`)
    : '';
  if (normalizedConfigured) {
    config.maintenance.bugReportRepository = normalizedConfigured;
    await logSystem('bug-report-repository-resolved', {
      repository: normalizedConfigured,
      source: 'configuration',
    });
    return normalizedConfigured;
  }

  if (configured) {
    await logSystem('bug-report-repository-invalid', {
      configured,
      source: 'configuration',
    });
  }
  try {
    const remote = config.maintenance?.gitRemote || 'origin';
    const result = await runGit(repoRoot, ['remote', 'get-url', remote]);
    const repository = githubRepositoryFromRemoteUrl(result.stdout);
    if (!repository) throw new Error(`remote ${remote} is not a two-part GitHub repository`);
    config.maintenance.bugReportRepository = repository;
    await logSystem('bug-report-repository-resolved', {
      repository,
      source: `git-remote:${remote}`,
    });
    return repository;
  } catch (error) {
    config.maintenance.bugReportRepository = '';
    await logSystem('bug-report-repository-unavailable', {
      error: formatErrorDetail(error),
    });
    return '';
  }
}

// Evaluated at run time, never at schedule time: the whole point is to read the
// budget as it stands the moment maintenance would start.
async function adaptiveMaintenanceGate() {
  if (config.maintenance.mode !== 'adaptive') return { run: true, reason: 'mode-on' };
  const workerId = maintenanceQuotaWorkerId(config.workers.maintenanceChain);
  let summary = null;
  try {
    summary = await collectCachedUsageSummary(config);
  } catch (error) {
    await logSystem('daily-maintenance-adaptive-probe-failed', {
      workerId,
      error: formatErrorDetail(error),
    });
  }
  const decision = adaptiveMaintenanceDecision({
    window: weeklyQuotaWindow(summary, workerId),
    workerId,
  });
  await logSystem(
    decision.run ? 'daily-maintenance-adaptive-allowed' : 'daily-maintenance-adaptive-skipped',
    {
      workerId,
      reason: decision.reason,
      remainingQuotaFraction: decision.remainingQuotaFraction,
      remainingTimeFraction: decision.remainingTimeFraction,
      resetsAt: Number.isFinite(decision.resetsAtMs)
        ? new Date(decision.resetsAtMs).toISOString()
        : null,
      summary: describeAdaptiveDecision(decision),
    },
  );
  const notice = adaptiveSkipNotice(decision);
  if (notice) {
    await api
      .postMessage(config.discord.generalChannelId, notice)
      .catch((error) => logSystem('daily-maintenance-adaptive-notice-failed', {
        reason: decision.reason,
        error: formatErrorDetail(error),
      }));
  }
  return decision;
}

async function runDailyMaintenance() {
  const decision = await adaptiveMaintenanceGate();
  if (!decision.run) return;
  const gitTarget = await maintenanceGitTarget();
  const maintenanceGitBaselinePaths = await getWorktreeChangedPaths({ cwd: repoRoot })
    .catch(async (error) => {
      await logSystem('daily-maintenance-git-baseline-failed', {
        error: formatErrorDetail(error),
      });
      return null;
    });
  let openIssues = [];
  let issueSnapshotError = null;
  const bugReportRepository = config.maintenance.bugReportRepository;
  if (bugReportRepository) {
    try {
      openIssues = await listOpenGitHubIssues({
        cwd: repoRoot,
        repository: bugReportRepository,
        env: hostGitHubAuthEnv(config),
      });
    } catch (error) {
      issueSnapshotError = formatErrorDetail(error);
      await logSystem('daily-maintenance-github-issues-failed', {
        repository: bugReportRepository,
        error: issueSnapshotError,
      });
    }
  } else {
    issueSnapshotError = 'GitHub repository could not be resolved from configuration or Git remote';
    await logSystem('daily-maintenance-github-issues-failed', {
      repository: null,
      error: issueSnapshotError,
    });
  }
  const context = await collectDailyMaintenanceContext({
    stateRoot: config.stateRoot,
    repoPath: repoRoot,
    gitRemote: gitTarget.remote,
    gitBranch: gitTarget.branch,
    maxItems: 100_000,
  });
  const maintenanceRun = await createDailyMaintenanceRun({
    artifactRoot: path.join(channelStateDir(config, config.discord.generalChannelId), 'artifacts'),
    context,
    inputBudgetChars: config.maintenance.inputBudgetChars,
  });
  const issuePlan = await planGitHubIssueMaintenanceRuns({
    repository: bugReportRepository,
    issues: openIssues,
    snapshotFailed: Boolean(issueSnapshotError),
  });
  const concurrencyKey = `maintenance:${maintenanceRun.runId}`;
  maintenanceGroupsBeingScheduled.add(concurrencyKey);
  try {
    for (const issue of issuePlan.scheduled) {
      await enqueueGitHubIssueMaintenance({
        repository: bugReportRepository,
        issue,
        concurrencyKey,
        maintenanceGitBaselinePaths,
      });
    }

    await enqueueGeneralDailyMaintenance({
      context,
      maintenanceRun,
      maintenanceGitBaselinePaths,
      concurrencyKey,
      issueCount: openIssues.length,
      scheduledIssueCount: issuePlan.scheduled.length,
      deferredIssues: issuePlan.deferred,
      issueSnapshotError,
    });
  } finally {
    maintenanceGroupsBeingScheduled.delete(concurrencyKey);
  }
}

function maintenanceIssueFollowupState() {
  return new JsonState(path.join(config.stateRoot, '_system'));
}

async function readMaintenanceIssueFollowups() {
  const raw = await maintenanceIssueFollowupState().readJson(MAINTENANCE_ISSUE_FOLLOWUP_FILE, null);
  return normalizeFollowupState(raw);
}

async function writeMaintenanceIssueFollowups(next) {
  const state = maintenanceIssueFollowupState();
  await state.init();
  await state.writeJson(MAINTENANCE_ISSUE_FOLLOWUP_FILE, next);
}

// An issue that ended unresolved for the same reason as last night gets a
// backoff instead of another worker run, another channel thread, and another
// identical report. Any change on the issue itself cancels the backoff.
async function planGitHubIssueMaintenanceRuns({ repository, issues = [], snapshotFailed = false }) {
  let state;
  try {
    state = await readMaintenanceIssueFollowups();
  } catch (error) {
    await logSystem('maintenance-issue-followup-read-failed', {
      repository: repository || null,
      error: formatErrorDetail(error),
    });
    return { scheduled: [...issues], deferred: [] };
  }

  const scheduled = [];
  const deferred = [];
  for (const issue of issues) {
    const plan = planIssueMaintenanceRun({ state, repository, issue });
    if (plan.run) {
      scheduled.push(issue);
      continue;
    }
    deferred.push({
      number: issue.number,
      url: issue.url || '',
      blockerCode: plan.blockerCode || '',
      unresolvedStreak: plan.unresolvedStreak || 0,
      nextAttemptAt: plan.nextAttemptAt || '',
    });
    await logSystem('daily-maintenance-github-issue-deferred', {
      repository: repository || null,
      issueNumber: issue.number,
      issueUrl: issue.url || null,
      blockerCode: plan.blockerCode || null,
      unresolvedStreak: plan.unresolvedStreak || 0,
      nextAttemptAt: plan.nextAttemptAt || null,
    });
  }

  if (!snapshotFailed) {
    const pruned = pruneFollowupState(state, {
      openIssueKeys: issues.map((issue) => issueFollowupKey(repository, issue.number)),
    });
    await writeMaintenanceIssueFollowups(pruned).catch((error) => logSystem('maintenance-issue-followup-write-failed', {
      repository: repository || null,
      error: formatErrorDetail(error),
    }));
  }

  return { scheduled, deferred };
}

// Records how one issue job ended and reports whether the outcome still carries
// news. A repeated blocker stays in the work thread instead of the channel.
async function recordMaintenanceIssueFollowup({ issue, resolved, blockerCode }) {
  if (!issue?.number) return { report: true };
  try {
    const state = await readMaintenanceIssueFollowups();
    const outcome = recordIssueMaintenanceOutcome({
      state,
      repository: issue.repository || '',
      issueNumber: issue.number,
      issueUpdatedAt: issue.updatedAt || '',
      resolved,
      blockerCode,
    });
    await writeMaintenanceIssueFollowups(outcome.state);
    await logSystem('daily-maintenance-github-issue-followup', {
      repository: issue.repository || null,
      issueNumber: issue.number,
      resolved: Boolean(resolved),
      blockerCode: blockerCode || null,
      report: outcome.report,
      reason: outcome.reason,
      unresolvedStreak: outcome.unresolvedStreak || 0,
      nextAttemptAt: outcome.record?.nextAttemptAt || null,
    });
    return outcome;
  } catch (error) {
    await logSystem('maintenance-issue-followup-write-failed', {
      repository: issue.repository || null,
      issueNumber: issue.number,
      error: formatErrorDetail(error),
    });
    return { report: true };
  }
}

async function enqueueGitHubIssueMaintenance({
  repository,
  issue,
  concurrencyKey,
  maintenanceGitBaselinePaths,
}) {
  const channelId = config.discord.generalChannelId;
  const [message] = await api.postMessage(
    channelId,
    buildGitHubIssueMaintenanceStartMessage({ issue }),
  );
  const thread = await api.createThreadFromMessage(
    channelId,
    message.id,
    githubIssueMaintenanceThreadTitle(issue, kstDateLabel(new Date())),
    config.discord.autoArchiveDuration,
  );
  const event = {
    id: `daily_maintenance_issue_${issue.number}_${Date.now()}`,
    timestamp: new Date().toISOString(),
    authorId: 'system',
    authorName: 'system-maintenance',
    channelId,
    threadId: thread.id,
    content: buildGitHubIssueMaintenanceTask({ repository, issue }),
    attachments: [],
    acknowledged: true,
    acknowledgedAt: new Date().toISOString(),
  };
  await threadState(event.channelId, event.threadId).appendJsonl('memory/events.jsonl', event);
  enqueueCodexJob(event, {
    id: event.id,
    maintenance: true,
    maintenanceIssue: {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      repository,
      updatedAt: issue.updatedAt || '',
    },
    concurrencyKey,
    maintenanceMode: 'github-issue',
    maintenanceGitBaselinePaths,
    stateAccess: true,
    priority: PRIORITY.SYSTEM_MAINTENANCE,
    finalChannelId: channelId,
  });
  await logSystem('daily-maintenance-github-issue-queued', {
    repository,
    issueNumber: issue.number,
    issueUrl: issue.url || null,
    channelId,
    threadId: thread.id,
    jobId: event.id,
    concurrencyKey,
  });
}

async function enqueueGeneralDailyMaintenance({
  context,
  maintenanceRun,
  maintenanceGitBaselinePaths,
  concurrencyKey,
  issueCount,
  scheduledIssueCount = issueCount,
  deferredIssues = [],
  issueSnapshotError,
}) {
  const title = `새벽유지보수 ${kstDateLabel(new Date())}`;
  const [message] = await api.postMessage(config.discord.generalChannelId, [
    '새벽유지보수 시작',
    `대상 기간: ${context.window.start} - ${context.window.end} (${context.window.timeZone})`,
    '범위: 장애 탐지·재현·복구·전달·저장소 상태 전체 점검',
    formatMaintenanceIssueScheduleLine({
      issueCount,
      scheduledCount: scheduledIssueCount,
      deferred: deferredIssues,
      snapshotFailed: Boolean(issueSnapshotError),
    }),
    '완료 보고: 실제 적용하고 검증한 개선만 일반 채널 신규 메시지로 게시',
  ].join('\n'));
  const thread = await api.createThreadFromMessage(
    config.discord.generalChannelId,
    message.id,
    title,
    config.discord.autoArchiveDuration,
  );
  const event = {
    id: `daily_maintenance_${Date.now()}`,
    timestamp: new Date().toISOString(),
    authorId: 'system',
    authorName: 'system-maintenance',
    channelId: config.discord.generalChannelId,
    threadId: thread.id,
    content: buildDailyMaintenanceTask(context, {
      manifest: maintenanceRun.manifest,
      inlineItems: config.maintenance.inlineItems,
    }),
    attachments: [],
    acknowledged: true,
    acknowledgedAt: new Date().toISOString(),
  };
  await threadState(event.channelId, event.threadId).appendJsonl('memory/events.jsonl', event);
  enqueueCodexJob(event, {
    id: event.id,
    maintenance: true,
    concurrencyKey,
    maintenanceMode: 'sharded',
    maintenanceManifestPath: maintenanceRun.manifestPath,
    maintenanceRawContextPath: maintenanceRun.rawContextPath,
    maintenanceSummaryPath: maintenanceRun.summaryPath,
    maintenanceGitBaselinePaths,
    stateAccess: true,
    priority: PRIORITY.SYSTEM_MAINTENANCE,
    // Keep detailed execution/progress in the maintenance thread, then publish
    // the decision-ready final report as a fresh general-channel message.
    finalChannelId: config.discord.generalChannelId,
  });
  await logSystem('daily-maintenance-queued', {
    channelId: event.channelId,
    threadId: event.threadId,
    jobId: event.id,
    runId: maintenanceRun.runId,
    concurrencyKey,
    issueCount,
    issueSnapshotFailed: Boolean(issueSnapshotError),
  });
}

async function finalizeMaintenanceIssue(job, result, gitSummary) {
  const issue = compactMaintenanceIssue(job.maintenanceIssue);
  const outcome = await computeMaintenanceIssueOutcome(job, issue, result, gitSummary);
  const followup = await recordMaintenanceIssueFollowup({
    issue,
    resolved: outcome.resolved,
    blockerCode: outcome.blockerCode || '',
  });
  if (outcome.resolved) return { ...outcome, suppressChannelPost: false };
  // A repeated blocker is not news. Keep the record in the work thread and stop
  // reposting the identical line to the general channel every night.
  if (followup.report === false) return { ...outcome, suppressChannelPost: true };
  const nextAttemptAt = Date.parse(followup.record?.nextAttemptAt || '');
  const content = Number.isFinite(nextAttemptAt)
    ? [
        outcome.content,
        `- 같은 blocker가 반복되면 이 보고를 다시 게시하지 않습니다. 다음 재시도: ${kstDateLabel(new Date(nextAttemptAt))} 이후`,
      ].join('\n')
    : outcome.content;
  return { ...outcome, content, suppressChannelPost: false };
}

async function computeMaintenanceIssueOutcome(job, issue, result, gitSummary) {
  const issueNumber = issue?.number || 0;
  const issueUrl = issue?.url || (
    issue?.repository && issueNumber
      ? `https://github.com/${issue.repository}/issues/${issueNumber}`
      : ''
  );
  const unresolved = (reason, blockerCode) => ({
    resolved: false,
    head: '',
    blockerCode,
    content: [
      `버그 #${issueNumber || '?'} 미해결`,
      `- ${String(reason || '해결 여부를 검증하지 못했습니다.').replace(/\s+/g, ' ').trim()}`,
      issueUrl,
    ].filter(Boolean).join('\n'),
  });

  if (!issue) return unresolved('유지보수 작업에 연결된 GitHub 이슈 정보가 없습니다.', 'missing-issue-metadata');
  if (!result) {
    return unresolved(
      '작업 결과의 해결 여부를 검증 가능한 형식으로 받지 못해 이슈를 닫지 않았습니다.',
      'missing-result-block',
    );
  }
  if (!result.resolved) return unresolved(result.reason, 'worker-reported-unresolved');

  const head = await verifiedMaintenanceResolutionHead({
    cwd: repoRoot,
    summary: gitSummary,
    reportedHead: result.head,
  });
  if (!head) {
    const blocker = maintenanceIssueGitBlocker(gitSummary, result);
    return unresolved(blocker.reason, blocker.code);
  }

  try {
    const resolution = await resolveGitHubIssueWithCommit({
      cwd: repoRoot,
      repository: issue.repository,
      issueNumber,
      head,
      summary: result.summary,
      env: hostGitHubAuthEnv(config),
    });
    await logSystem('daily-maintenance-github-issue-resolved', {
      repository: issue.repository,
      issueNumber,
      issueUrl: resolution.url || issueUrl,
      head,
      commented: resolution.commented,
      commentAlreadyPresent: resolution.commentAlreadyPresent,
      closed: resolution.closed,
      alreadyClosed: resolution.alreadyClosed,
      jobId: job.id,
    });
    return {
      resolved: true,
      head,
      content: [
        `버그 #${issueNumber} 해결`,
        `- ${result.summary}`,
        resolution.url || issueUrl,
      ].filter(Boolean).join('\n'),
    };
  } catch (error) {
    await logSystem('daily-maintenance-github-issue-resolution-failed', {
      repository: issue.repository,
      issueNumber,
      issueUrl,
      head,
      jobId: job.id,
      error: formatErrorDetail(error),
    });
    return unresolved(
      `수정 커밋은 원격에 반영됐지만 GitHub 이슈 답글·종료 처리를 완료하지 못했습니다: ${conciseError(error)}`,
      'github-resolution-failed',
    );
  }
}

// Returns both the visible Korean reason and a stable code. The code is what the
// follow-up ledger compares, so worker-authored wording drift cannot break the
// "same blocker as last night" check.
function maintenanceIssueGitBlocker(summary = {}, result = {}) {
  const commitAction = String(summary?.commit?.action || '');
  const syncAction = String(summary?.action || summary?.syncBefore?.action || '');
  if (commitAction === 'no-eligible-changes') {
    return result?.head
      ? {
          code: 'git-reported-head-not-in-remote-history',
          reason: '보고된 기존 수정 커밋이 현재 원격 브랜치의 검증된 이력과 연결되지 않아 이슈를 닫지 않았습니다.',
        }
      : {
          code: 'git-no-eligible-changes',
          reason: '새 변경은 없었고 기존 수정으로 검증한 커밋 SHA도 제공되지 않아 이슈를 닫지 않았습니다. 워킹트리에만 있는 수정은 사람이 직접 커밋해야 반영됩니다.',
        };
  }
  if (commitAction === 'baseline-unavailable') {
    return {
      code: 'git-baseline-unavailable',
      reason: '작업 전 변경 기준을 확보하지 못해 수정 커밋을 안전하게 분리하지 못했습니다.',
    };
  }
  if (commitAction === 'blocked-by-pre-sync') {
    return {
      code: 'git-blocked-by-pre-sync',
      reason: '작업 전 원격 동기화를 안전하게 완료하지 못해 수정 커밋을 만들지 않았습니다.',
    };
  }
  if (commitAction === 'commit-error' || commitAction === 'commit-failed') {
    return {
      code: 'git-commit-failed',
      reason: '검증된 변경을 커밋하지 못해 이슈를 닫지 않았습니다.',
    };
  }
  if (syncAction === 'push-failed' || summary?.synced === false) {
    return {
      code: 'git-push-unverified',
      reason: '수정 커밋의 원격 반영을 검증하지 못해 이슈를 닫지 않았습니다.',
    };
  }
  return {
    code: 'git-head-unverified',
    reason: '새 수정 커밋과 원격 HEAD가 일치함을 검증하지 못해 이슈를 닫지 않았습니다.',
  };
}

function generalMaintenanceGitBlocker(summary = {}) {
  const commitAction = String(summary?.commit?.action || '');
  const syncAction = String(summary?.action || summary?.syncBefore?.action || '');
  if (commitAction === 'no-eligible-changes') {
    return '이번 유지보수 실행에서 새로 반영된 변경이 없습니다.';
  }
  if (commitAction === 'baseline-unavailable') {
    return '작업 전 변경 기준을 확보하지 못해 이번 실행의 새 개선을 분리 검증하지 못했습니다.';
  }
  if (commitAction === 'blocked-by-pre-sync') {
    return '작업 전 원격 동기화를 안전하게 완료하지 못해 이번 실행의 변경을 반영하지 않았습니다.';
  }
  if (commitAction === 'commit-error' || commitAction === 'commit-failed') {
    return '이번 유지보수에서 만든 변경을 커밋하지 못해 적용 완료로 보고하지 않습니다.';
  }
  if (syncAction === 'push-failed' || summary?.synced === false) {
    return '이번 유지보수 변경의 원격 반영을 검증하지 못해 적용 완료로 보고하지 않습니다.';
  }
  return '이번 유지보수 실행에서 새로 반영된 변경을 검증하지 못했습니다.';
}

function conciseError(error) {
  const text = String(error?.message || error || 'unknown error')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= 300 ? text : `${text.slice(0, 299).trimEnd()}…`;
}

function recordMaintenanceRuntimeChanges(job, paths = []) {
  const key = jobConcurrencyKey(job);
  const changed = maintenanceRuntimeChanges.get(key) || new Set();
  for (const filePath of paths) {
    const value = String(filePath || '').trim();
    if (value) changed.add(value);
  }
  if (changed.size > 0) maintenanceRuntimeChanges.set(key, changed);
}

async function maybeRestartAfterMaintenanceGroup(job, result = {}) {
  if (!job.maintenance) return;
  const key = jobConcurrencyKey(job);
  if (maintenanceGroupsBeingScheduled.has(key)) return;
  const hasQueued = scheduler.queuedJobs().some((candidate) => jobConcurrencyKey(candidate) === key);
  const hasRunning = [...running.values()].some((candidate) =>
    candidate.id !== job.id && jobConcurrencyKey(candidate) === key,
  );
  if (hasQueued || hasRunning) return;

  const runtimeChangedPaths = [...(maintenanceRuntimeChanges.get(key) || [])];
  maintenanceRuntimeChanges.delete(key);
  if (runtimeChangedPaths.length === 0) return;

  await requestServiceRestart({
    reason: '새벽 유지보수에서 검증한 런타임 동작 변경을 서비스에 반영',
    improvement: '이슈별 수정과 전체 점검 결과가 모두 끝난 뒤 최신 동작으로 재기동',
    channelId: job.channelId,
    threadId: job.threadId,
    messageId: job.id,
    source: 'daily-maintenance',
    runtimeChangedPaths,
    allowRunningJobIds: [job.id],
    workerLabel: jobWorkerDisplay(result, job),
    workerEffort: jobWorkerEffort(result, job),
  });
}

async function runMaintenanceGitSync(job = {}) {
  const { branch, remote } = await maintenanceGitTarget();
  const baselinePaths = Array.isArray(job.maintenanceGitBaselinePaths)
    ? job.maintenanceGitBaselinePaths
    : null;
  const syncBefore = await syncLocalHeadToRemote({
    cwd: repoRoot,
    remote,
    branch,
    allowStoredRemoteFallback: false,
  }).catch((error) => ({ synced: false, action: 'pre-sync-error', error: error.message }));
  const commit = await runMaintenanceGitCommit({ job, baselinePaths, syncBefore });
  const result = await reconcileLocalHeadWithRemote({ cwd: repoRoot, remote, branch })
    .catch((error) => ({ synced: false, action: 'error', error: error.message }));
  await logSystem('daily-maintenance-git-sync', {
    branch,
    remote,
    syncBefore,
    commit,
    ...result,
  });
  return { branch, remote, syncBefore, commit, ...result };
}

async function runMaintenanceGitCommit({ job = {}, baselinePaths, syncBefore }) {
  if (!Array.isArray(baselinePaths)) {
    return {
      committed: false,
      action: 'baseline-unavailable',
    };
  }
  if (!canCommitAfterMaintenanceSync(syncBefore)) {
    return {
      committed: false,
      action: 'blocked-by-pre-sync',
      preSyncAction: syncBefore?.action || 'unknown',
    };
  }
  return commitEligibleWorktreeChanges({
    cwd: repoRoot,
    message: job.maintenanceIssue?.number
      ? `fix: resolve bridge issue #${job.maintenanceIssue.number}`
      : `chore: apply daily maintenance ${kstDateLabel(new Date())}`,
    baselinePaths,
  }).catch((error) => ({
    committed: false,
    action: 'commit-error',
    error: error.message,
  }));
}

function canCommitAfterMaintenanceSync(syncBefore) {
  if (!syncBefore || syncBefore.action === 'pre-sync-error') return false;
  return !['blocked-dirty-worktree', 'blocked-diverged', 'remote-ref-not-writable', 'remote-unavailable'].includes(syncBefore.action);
}

async function maintenanceGitTarget() {
  const branch = await currentGitBranch().catch(() => config.maintenance.gitBranch);
  return {
    branch,
    remote: config.maintenance.gitRemote,
  };
}

async function currentGitBranch() {
  const result = await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.stdout.trim();
}

function kstDateLabel(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

async function completePendingRestart() {
  const pending = await readSystemState('pending-restart.json');
  if (!pending) return;
  await removeSystemState('pending-restart.json');
  await logSystem('restart-completed', pending);
}

function scheduleDiscordOutboxFlush() {
  const flush = () => {
    flushDiscordOutbox(systemState(), api, {
      onDelivered: markOutboxDeliveryDone,
    }).then(async (result) => {
      // Giving up on an outbound message loses it, so it can never be silent.
      if (result?.exhausted?.length > 0) {
        await logSystem('discord-outbox-attempts-exhausted', { exhausted: result.exhausted });
      }
      if (result?.dependencyFailed?.length > 0) {
        await logSystem('discord-outbox-dependencies-failed', {
          dependencyFailed: result.dependencyFailed,
        });
      }
      if (result?.callbackErrors?.length > 0) {
        await logSystem('discord-outbox-delivery-callback-failed', { callbackErrors: result.callbackErrors });
      }
    }).catch((error) => logSystem('discord-outbox-flush-error', { error: formatErrorDetail(error) }));
  };
  setInterval(flush, Number(process.env.DISCORD_OUTBOX_INTERVAL_MS || 10_000)).unref?.();
  flush();
}

function scheduleSlackOutboxFlush() {
  if (!config.slack.enabled || !config.slack.botToken) return;
  const flush = () => {
    flushSlackOutbox(systemState(), slackApi, {
      onDelivered: markOutboxDeliveryDone,
    }).then(async (result) => {
      if (result?.exhausted?.length > 0) {
        await logSystem('slack-outbox-attempts-exhausted', { exhausted: result.exhausted });
      }
      if (result?.dependencyFailed?.length > 0) {
        await logSystem('slack-outbox-dependencies-failed', {
          dependencyFailed: result.dependencyFailed,
        });
      }
      if (result?.callbackErrors?.length > 0) {
        await logSystem('slack-outbox-delivery-callback-failed', { callbackErrors: result.callbackErrors });
      }
    }).catch((error) => logSystem('slack-outbox-flush-error', { error: formatErrorDetail(error) }));
  };
  setInterval(flush, Number(process.env.SLACK_OUTBOX_INTERVAL_MS || 10_000)).unref?.();
  flush();
}

function scheduleTodoAlerts() {
  if (!config.todoAlerts?.enabled) return;
  const intervalMs = Number(config.todoAlerts.intervalMs || 15_000);
  let inFlight = false;
  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await processDueTodoAlerts({
        config,
        api: todoAlertDeliveryApi(),
        systemState: systemState(),
        logSystem,
      });
      if (result.sent || result.queued || result.failed || result.rescheduled || result.completed || result.skipped) {
        await logSystem('todo-alerts-processed', result);
      }
    } catch (error) {
      await logSystem('todo-alerts-error', { error: formatErrorDetail(error) });
    } finally {
      inFlight = false;
    }
  };
  run().catch((error) => logSystem('todo-alerts-error', { error: formatErrorDetail(error) }));
  todoAlertTimer = setInterval(run, intervalMs);
  todoAlertTimer.unref?.();
}

function todoAlertDeliveryApi() {
  return {
    async postMessage(channelId, content, options = {}) {
      const discordDelivery = api.postMessage(channelId, content, options);
      const shouldBroadcastToSlack = config.slack.enabled
        && config.slack.broadcastTodoAlerts
        && String(channelId) === String(config.slack.logicalChannelId);
      if (!shouldBroadcastToSlack) return discordDelivery;

      const [discordResult, slackResult] = await Promise.allSettled([
        discordDelivery,
        slackApi.postMessage(config.slack.channelId, content),
      ]);
      if (slackResult.status === 'rejected') {
        const error = slackResult.reason;
        try {
          const entry = await queueSlackOutbox(systemState(), {
            channelId: config.slack.channelId,
            content,
            ...slackOutboxProgressFromError(error),
            purpose: 'todo-alert',
            lastError: formatErrorDetail(error),
          });
          await logSystem('slack-todo-alert-outbox-queued', {
            outboxId: entry.id,
            channelId: config.slack.channelId,
            error: formatErrorDetail(error),
          });
        } catch (queueError) {
          await logSystem('slack-todo-alert-delivery-failed', {
            channelId: config.slack.channelId,
            error: formatErrorDetail(error),
            queueError: formatErrorDetail(queueError),
          });
        }
      }
      if (discordResult.status === 'rejected') throw discordResult.reason;
      return discordResult.value;
    },
  };
}

async function markOutboxDeliveryDone(entry, messages) {
  if (!entry.job?.id || !entry.job?.channelId || !entry.job?.threadId) return;
  const files = Array.isArray(entry.options?.files) ? entry.options.files : [];
  const delivery = {
    delivered: true,
    messageIds: (messages || []).map((message) => message.id).filter(Boolean),
  };
  await recordJobOutboundMessage(entry.job, entry.content || '', delivery, {
    purpose: entry.purpose || 'message',
    destinationChannelId: entry.destinationId || entry.channelId || null,
    files,
  });
  await threadState(entry.job.channelId, entry.job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: entry.job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: jobStatusAfterOutboundDelivery(entry.purpose),
    delivered: true,
    outboxId: entry.id,
    messageIds: delivery.messageIds,
  });
  await logSystem('discord-outbox-delivered', {
    outboxId: entry.id,
    jobId: entry.job.id,
    channelId: entry.job.channelId,
    threadId: entry.job.threadId,
  });
}

async function recoverInterruptedJobs() {
  const interrupted = await findInterruptedJobs();
  for (const job of interrupted) {
    const lockOwner = await readThreadJobLockOwner(config, job).catch(() => null);
    if (lockOwner?.pid && isThreadJobLockOwnerFromPreviousService(lockOwner, serviceStartedAt)) {
      const released = await releaseThreadJobLock(config, job, { pid: Number(lockOwner.pid) }).catch(() => false);
      await logSystem('job-recovery-cleared-stale-lock', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        owner: compactLockOwner(lockOwner),
        released,
      });
    } else if (lockOwner?.pid && isPidAlive(Number(lockOwner.pid))) {
      await logSystem('job-recovery-skipped-live-lock', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        owner: compactLockOwner(lockOwner),
      });
      continue;
    }

    const terminalOutbound = await deliveredTerminalJobOutbound(job);
    if (terminalOutbound) {
      await markRecoveredJobAlreadyDelivered(job, terminalOutbound);
      continue;
    }
    const event = await findEventForJob(job);
    if (!event) {
      await logSystem('job-recovery-skipped', { jobId: job.id, channelId: job.channelId, threadId: job.threadId });
      continue;
    }
    const supersedingEvent = await supersedingThreadEvent({ ...job, event });
    if (supersedingEvent) {
      await markJobSuperseded(
        { ...job, event },
        `superseded by newer thread event ${supersedingEvent.id}`,
        supersedingEvent.id,
      );
      continue;
    }

    const durableWorker = v3WorkbenchMode
      ? v3WorkbenchRuntime?.durableWorker(job)
      : null;
    if (durableWorker) {
      await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
        id: job.id,
        recoveredAt: new Date().toISOString(),
        status: 'detached-worker-reattached',
        detachedWorkerStatus: durableWorker.status,
        detachedWorkerPid: durableWorker.workerPid || durableWorker.lastSpawnPid || null,
        richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
      });
      await logSystem('job-recovery-detached-worker-reattached', {
        jobId: job.id,
        channelId: job.channelId,
        threadId: job.threadId,
        detachedWorkerStatus: durableWorker.status,
        detachedWorkerPid: durableWorker.workerPid || durableWorker.lastSpawnPid || null,
      });
      enqueueCodexJob(event, {
        id: job.id,
        recoveredFromJobId: job.recoveredFromJobId || null,
        maintenance: Boolean(job.maintenance),
        maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
        concurrencyKey: job.concurrencyKey || null,
        maintenanceMode: job.maintenanceMode || null,
        maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
        maintenanceManifestPath: job.maintenanceManifestPath || null,
        maintenanceRawContextPath: job.maintenanceRawContextPath || null,
        maintenanceSummaryPath: job.maintenanceSummaryPath || null,
        maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
          ? job.maintenanceGitBaselinePaths
          : null,
        repoAccess: Boolean(job.repoAccess),
        repoPath: job.repoPath || null,
        stateAccess: Boolean(job.stateAccess),
        threadModelOverride: job.preserveThreadModelOverride
          ? job.threadModelOverride || null
          : null,
        preserveThreadModelOverride: Boolean(job.preserveThreadModelOverride),
        search: Boolean(job.search),
        verboseProgress: Boolean(job.verboseProgress),
        priority: job.priority,
        attempt: Number(job.nextAttempt || job.attempt || 1),
        finalChannelId: job.finalChannelId || null,
        pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
        workerMode: job.workerMode || durableWorker.spec?.workerMode || null,
        mockPlan: job.mockPlan || durableWorker.spec?.mockPlan || null,
        runtimeSourceBaseline: job.runtimeSourceBaseline
          || durableWorker.spec?.job?.runtimeSourceBaseline
          || null,
        artifactDeliveryBaseline: job.artifactDeliveryBaseline
          || durableWorker.spec?.job?.artifactDeliveryBaseline
          || null,
        richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
      });
      continue;
    }

    const continuationId = continuationJobId(event.id);
    await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
      id: job.id,
      recoveredAt: new Date().toISOString(),
      status: 'interrupted-recovered',
      continuationJobId: continuationId,
      repoAccess: Boolean(job.repoAccess),
      repoPath: job.repoPath || null,
      stateAccess: Boolean(job.stateAccess),
      richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
      maintenance: Boolean(job.maintenance),
      maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
      concurrencyKey: job.concurrencyKey || null,
      maintenanceMode: job.maintenanceMode || null,
      threadModelOverride: compactThreadModelOverride(job.threadModelOverride),
      preserveThreadModelOverride: Boolean(job.preserveThreadModelOverride),
      maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
      maintenanceManifestPath: job.maintenanceManifestPath || null,
      maintenanceRawContextPath: job.maintenanceRawContextPath || null,
      maintenanceSummaryPath: job.maintenanceSummaryPath || null,
      maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
        ? job.maintenanceGitBaselinePaths
        : null,
      pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
    });
    await logSystem('job-recovery-queued', {
      jobId: job.id,
      continuationJobId: continuationId,
      channelId: job.channelId,
      threadId: job.threadId,
    });
    enqueueCodexJob(event, {
      id: continuationId,
      recoveredFromJobId: job.id,
      maintenance: Boolean(job.maintenance),
      maintenanceIssue: compactMaintenanceIssue(job.maintenanceIssue),
      concurrencyKey: job.concurrencyKey || null,
      maintenanceMode: job.maintenanceMode || null,
      maintenanceInputLimitResume: Boolean(job.maintenanceInputLimitResume),
      maintenanceManifestPath: job.maintenanceManifestPath || null,
      maintenanceRawContextPath: job.maintenanceRawContextPath || null,
      maintenanceSummaryPath: job.maintenanceSummaryPath || null,
      maintenanceGitBaselinePaths: Array.isArray(job.maintenanceGitBaselinePaths)
        ? job.maintenanceGitBaselinePaths
        : null,
      repoAccess: Boolean(job.repoAccess),
      repoPath: job.repoPath || null,
      stateAccess: Boolean(job.stateAccess),
      threadModelOverride: job.preserveThreadModelOverride ? job.threadModelOverride || null : null,
      preserveThreadModelOverride: Boolean(job.preserveThreadModelOverride),
      search: Boolean(job.search),
      verboseProgress: Boolean(job.verboseProgress),
      priority: job.priority,
      attempt: Number(job.nextAttempt || job.attempt || 1),
      finalChannelId: job.finalChannelId || null,
      pendingAskAnswer: compactPendingAskAnswer(job.pendingAskAnswer),
      artifactDeliveryBaseline: job.artifactDeliveryBaseline || null,
      richStyleId: normalizeRichStyleId(job.richStyleId, DEFAULT_RICH_STYLE_ID),
    });
  }
}

async function deliveredTerminalJobOutbound(job) {
  const currentRootJobId = rootJobId(job.id);
  const events = await threadState(job.channelId, job.threadId).readJsonl('memory/events.jsonl', { limit: 1000 });
  return events.slice().reverse().find((event) =>
    isBridgeGeneratedThreadEvent(event)
      && rootJobId(event.jobId) === currentRootJobId
      && isTerminalJobOutboundPurpose(event.purpose)
      && (Boolean(event.delivered) || (Array.isArray(event.messageIds) && event.messageIds.length > 0)),
  ) || null;
}

async function markRecoveredJobAlreadyDelivered(job, outboundEvent) {
  await threadState(job.channelId, job.threadId).appendJsonl('jobs/jobs.jsonl', {
    id: job.id,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'done',
    delivered: true,
    recoveredFromAlreadyDelivered: true,
    outboundEventId: outboundEvent.id || null,
    outboundPurpose: outboundEvent.purpose || null,
    messageIds: Array.isArray(outboundEvent.messageIds) ? outboundEvent.messageIds.filter(Boolean) : [],
  });
  await logSystem('job-recovery-skipped-already-delivered', {
    jobId: job.id,
    rootJobId: rootJobId(job.id),
    channelId: job.channelId,
    threadId: job.threadId,
    outboundEventId: outboundEvent.id || null,
    outboundPurpose: outboundEvent.purpose || null,
  });
}

async function supersedingThreadEvent(job) {
  const baseEvent = job.event || await findEventForJob(job);
  if (!baseEvent) return null;
  const events = await threadState(job.channelId, job.threadId).readJsonl('memory/events.jsonl', { limit: 1000 });
  return newestRecoverySupersedingThreadEventAfter(events, job, baseEvent, {
    isControlEvent: isNonSupersedingThreadEvent,
  });
}

function isNonSupersedingThreadEvent(event = {}) {
  return (
    isControlOnlyCommandRequest(event?.content)
    && !isCancelCommandRequest(event?.content)
  ) || isBridgeGeneratedThreadEvent(event);
}

function isBridgeGeneratedThreadEvent(event = {}) {
  return event?.source === 'bridge-agent'
    || event?.authorId === 'bridge-agent'
    || (botUserId && String(event?.authorId || '') === String(botUserId));
}

async function recoverPendingThreadCreations() {
  for (const file of await findJobsFiles()) {
    if (!file.includes(`${path.sep}pending-thread${path.sep}`)) continue;
    const latestById = new Map();
    for (const entry of await readJsonlFile(file)) latestById.set(entry.id, entry);
    for (const entry of latestById.values()) {
      if (entry.status !== 'retry-scheduled') continue;
      const pending = {
        ...entry,
        message: entry.message,
        attempt: Number(entry.attempt || 1),
        acknowledgement: entry.acknowledgement || { ok: false },
      };
      const channelId = entry.scope?.channelId || channelIdFromCommonStateFile(file);
      await logSystem('thread-create-recovery-queued', {
        messageId: entry.id,
        channelId,
        attempt: pending.attempt,
      });
      setTimeout(() => retryThreadCreation(pending).catch((error) =>
        logSystem('thread-create-recovery-error', {
          messageId: entry.id,
          channelId,
          error: formatErrorDetail(error),
        }),
      ), 1000);
    }
  }
}

async function recoverGitPolls() {
  const latestById = new Map();
  for (const file of await findGitPollFiles()) {
    const scope = threadScopeFromGitPollFile(file);
    for (const entry of await readJsonlFile(file)) {
      if (!entry?.id) continue;
      latestById.set(entry.id, {
        ...entry,
        channelId: entry.channelId || scope?.channelId,
        threadId: entry.threadId || scope?.threadId,
      });
    }
  }

  let recovered = 0;
  for (const poll of latestById.values()) {
    if (poll.status !== 'active') continue;
    if (!poll.channelId || !poll.threadId || !poll.repoPath) continue;
    if (Date.parse(poll.timeoutAt || '') <= Date.now()) {
      await expireGitPoll(poll);
      continue;
    }
    scheduleGitPoll(poll);
    recovered += 1;
  }
  if (recovered > 0) await logSystem('git-poll-recovered', { recovered });
}

async function recoverReservedCommands() {
  const latestById = new Map();
  for (const file of await findReservedCommandFiles()) {
    const scope = threadScopeFromReservedCommandFile(file);
    for (const entry of await readJsonlFile(file)) {
      if (!entry?.id) continue;
      latestById.set(entry.id, {
        ...entry,
        channelId: entry.channelId || scope?.channelId,
        threadId: entry.threadId || scope?.threadId,
      });
    }
  }

  const active = activeReservationsFromEntries([...latestById.values()]);
  let recovered = 0;
  let triggered = 0;
  for (const reservation of active) {
    if (!reservation.channelId || !reservation.threadId || !reservation.order) continue;
    if (Date.parse(reservation.scheduledAt || '') <= Date.now()) {
      await triggerReservedCommand(reservation);
      triggered += 1;
      continue;
    }
    scheduleReservedCommand(reservation);
    recovered += 1;
  }
  if (recovered > 0 || triggered > 0) await logSystem('reserve-command-recovered', { recovered, triggered });
}

async function findInterruptedJobs() {
  const jobsFiles = await findJobsFiles();
  const interrupted = [];
  for (const file of jobsFiles) {
    const scope = threadScopeFromJobsFile(file);
    if (!scope) continue;

    interrupted.push(...interruptedJobCandidatesFromEntries(await readJsonlFile(file), scope));
  }
  return interrupted;
}

function channelIdFromCommonStateFile(file) {
  const relative = path.relative(config.stateRoot, file);
  const [first] = relative.split(path.sep);
  if (first?.endsWith('_common')) return first.slice(0, -'_common'.length);
  return first || '';
}

function threadScopeFromJobsFile(file) {
  const relative = path.relative(config.stateRoot, file);
  const parts = relative.split(path.sep);

  if (parts.length >= 5 && parts[1] === 'threads' && parts[3] === 'jobs') {
    return { channelId: parts[0], threadId: parts[2] };
  }

  if (parts.length >= 4 && parts[2] === 'jobs' && !parts[0].endsWith('_common') && !parts[0].startsWith('_')) {
    return { channelId: parts[0], threadId: parts[1] };
  }

  return null;
}

function threadScopeFromGitPollFile(file) {
  const relative = path.relative(config.stateRoot, file);
  const parts = relative.split(path.sep);
  if (parts.length >= 4 && parts[2] === 'git-polls' && !parts[0].endsWith('_common') && !parts[0].startsWith('_')) {
    return { channelId: parts[0], threadId: parts[1] };
  }
  return null;
}

function threadScopeFromReservedCommandFile(file) {
  const relative = path.relative(config.stateRoot, file);
  const parts = relative.split(path.sep);
  if (parts.length >= 4 && parts[2] === 'reserved-commands' && !parts[0].endsWith('_common') && !parts[0].startsWith('_')) {
    return { channelId: parts[0], threadId: parts[1] };
  }
  return null;
}

async function findEventForJob(job) {
  const events = await threadState(job.channelId, job.threadId).readJsonl('memory/events.jsonl', { limit: 1000 });
  return eventForRecoverableJob(events, job);
}

// Jobs files only live at <channel>/<thread>/jobs/jobs.jsonl (or the legacy
// <channel>/threads/<thread>/jobs/jobs.jsonl) and <x>_common/pending-thread/
// jobs.jsonl. A blind recursive walk of the state root used to traverse
// worker-tools/node_modules, auth-backups, and the worker home dirs on every
// startup, which dominated restart latency on the WSL2 mount.
async function findJobsFiles() {
  const files = [];
  for (const entry of await readdirSafe(config.stateRoot)) {
    if (!entry.isDirectory()) continue;
    const topDir = path.join(config.stateRoot, entry.name);
    if (entry.name.endsWith('_common')) {
      const pendingFile = path.join(topDir, 'pending-thread', 'jobs.jsonl');
      if (await fileExists(pendingFile)) files.push(pendingFile);
      continue;
    }
    if (!/^\d+$/.test(entry.name)) continue;
    for (const threadEntry of await readdirSafe(topDir)) {
      if (!threadEntry.isDirectory()) continue;
      if (threadEntry.name === 'threads') {
        for (const legacyEntry of await readdirSafe(path.join(topDir, 'threads'))) {
          if (!legacyEntry.isDirectory()) continue;
          const legacyFile = path.join(topDir, 'threads', legacyEntry.name, 'jobs', 'jobs.jsonl');
          if (await fileExists(legacyFile)) files.push(legacyFile);
        }
        continue;
      }
      const file = path.join(topDir, threadEntry.name, 'jobs', 'jobs.jsonl');
      if (await fileExists(file)) files.push(file);
    }
  }
  return files;
}

async function findGitPollFiles() {
  const files = [];
  for (const entry of await readdirSafe(config.stateRoot)) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const topDir = path.join(config.stateRoot, entry.name);
    for (const threadEntry of await readdirSafe(topDir)) {
      if (!threadEntry.isDirectory()) continue;
      const file = path.join(topDir, threadEntry.name, 'git-polls', 'git-polls.jsonl');
      if (await fileExists(file)) files.push(file);
    }
  }
  return files;
}

async function findReservedCommandFiles() {
  const files = [];
  for (const entry of await readdirSafe(config.stateRoot)) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const topDir = path.join(config.stateRoot, entry.name);
    for (const threadEntry of await readdirSafe(topDir)) {
      if (!threadEntry.isDirectory()) continue;
      const file = path.join(topDir, threadEntry.name, RESERVED_COMMANDS_FILE);
      if (await fileExists(file)) files.push(file);
    }
  }
  return files;
}

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonlFile(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function threadState(channelId, threadId) {
  return new JsonState(threadStateDir(config, channelId, threadId));
}

function channelState(channelId) {
  return new JsonState(channelStateDir(config, channelId));
}

function systemState() {
  return new JsonState(path.join(config.stateRoot, '_system'));
}

function isFreshMessage(message) {
  const timestamp = Date.parse(message.timestamp || '');
  return Number.isFinite(timestamp) && timestamp >= ignoreBefore.getTime();
}

function isAllowedUser(userId) {
  return config.discord.allowAllUsers || config.discord.allowedUserIds.has(String(userId || ''));
}

function isAllowedSlackUser(userId) {
  return config.slack.allowAllUsers || config.slack.allowedUserIds.has(String(userId || ''));
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeSystemState(name, value) {
  const state = new JsonState(path.join(config.stateRoot, '_system'));
  await state.writeJson(name, value);
}

async function readSystemState(name) {
  const state = new JsonState(path.join(config.stateRoot, '_system'));
  return state.readJson(name, null);
}

async function removeSystemState(name) {
  await fs.rm(path.join(config.stateRoot, '_system', name), { force: true });
}

async function logSystem(type, payload = {}) {
  const state = new JsonState(path.join(config.stateRoot, '_system'));
  await state.appendJsonl('events.jsonl', {
    timestamp: new Date().toISOString(),
    type,
    ...payload,
  });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function clearHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  heartbeatMonitor.reset();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdownService(signal).catch(() => process.exit(1));
  });
}

process.on('exit', () => {
  if (v3WorkbenchMode) {
    // process.exit(75) is the normal patch handoff. Releasing the synchronous
    // SQLite lease here lets the next Workbench generation start immediately;
    // detached Workers are intentionally outside this process registry.
    v3WorkbenchRuntime?.releaseLeaseOnExit();
  } else {
    terminateActiveProcesses('SIGTERM');
  }
});

// A fatal error anywhere (timer callbacks, fire-and-forget promises) would
// otherwise kill the process with no system-log record. Log it and exit
// non-zero so the supervisor restarts the service with backoff.
let fatalErrorHandled = false;
for (const [signal, type] of [['unhandledRejection', 'unhandled-rejection'], ['uncaughtException', 'uncaught-exception']]) {
  process.on(signal, (error) => {
    if (fatalErrorHandled) return;
    fatalErrorHandled = true;
    logSystem(type, { error: formatErrorDetail(error) })
      .catch(() => {})
      .finally(() => process.exit(1));
  });
}

async function shutdownService(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  reconnect = false;
  clearHeartbeat();
  slackSocketClient?.stop();
  if (todoAlertTimer) clearInterval(todoAlertTimer);
  clearGitPollTimers();
  clearReservedCommandTimers();
  if (v3WorkbenchMode) {
    v3WorkbenchInitialized = false;
    await v3WorkbenchRuntime?.stop().catch(() => {});
    await v3HealthReporter?.stop({ signal }).catch(() => {});
  }
  const childProcesses = v3WorkbenchMode
    ? []
    : await terminateActiveProcessesGracefully();
  const runningJobs = await waitForRunningJobsToSettle();
  await logSystem('stopped', { signal, childProcesses, runningJobs }).catch(() => {});
  if (v3WorkbenchMode) {
    await v3PlatformRpc?.stop().catch(() => {});
    v3Bus?.close();
  }
  process.exit(0);
}

function v3WorkbenchHealthStatus() {
  const status = v3WorkbenchRuntime?.status?.() || {};
  const broker = status.broker || {};
  const internalReady = Boolean(
    status.running
    && status.lease
    && broker.running
    && broker.address,
  );
  const ready = Boolean(
    v3WorkbenchInitialized
    && internalReady
    && !status.paused
    && status.receptionConnected,
  );
  return {
    ready,
    phase: !internalReady
      ? 'starting'
      : !v3WorkbenchInitialized
        ? 'recovering'
        : status.paused
          ? 'waiting-for-admission'
        : status.receptionConnected
          ? 'ready'
          : 'waiting-for-reception',
    initialized: v3WorkbenchInitialized,
    admissionEnabled: v3AdmissionEnabled,
    instanceId: status.instanceId || null,
    lease: status.lease
      ? {
          role: status.lease.role,
          ownerId: status.lease.ownerId,
          epoch: status.lease.epoch,
          expiresAtMs: status.lease.expiresAtMs,
        }
      : null,
    receptionConnected: Boolean(status.receptionConnected),
    pendingWork: Number(status.pendingWork || 0),
    broker: {
      running: Boolean(broker.running),
      instanceId: broker.instanceId || null,
      address: broker.address || null,
      attachedJobs: Number(broker.attachedJobs || 0),
      durableActiveJobs: Number(broker.durableActiveJobs || 0),
    },
  };
}

async function waitForRunningJobsToSettle(timeoutMs = 8_000) {
  const promises = [...runningJobPromises.values()];
  if (promises.length === 0) {
    return { count: 0, timedOut: false, settled: 0, remaining: running.size };
  }

  const result = await Promise.race([
    Promise.allSettled(promises).then((settled) => ({ timedOut: false, settled })),
    delay(timeoutMs).then(() => ({ timedOut: true, settled: [] })),
  ]);

  return {
    count: promises.length,
    timedOut: result.timedOut,
    settled: result.settled.length,
    remaining: running.size,
  };
}

async function scheduleRequestedV3Promotion() {
  try {
    const promotion = await maybeScheduleV3Promotion({
      repoRoot,
      stateRoot: config.stateRoot,
      env: process.env,
    });
    if (promotion.scheduled) {
      await logSystem('v3-promotion-scheduled', {
        requestId: promotion.requestId,
        coordinatorPid: promotion.state?.coordinatorPid || null,
      });
    }
  } catch (error) {
    await logSystem('v3-promotion-schedule-failed', {
      error: formatErrorDetail(error),
    }).catch(() => {});
  }
}

await main().catch(async (error) => {
  const detail = maskSecrets(formatErrorDetail(error));
  console.error(`[bridge] startup failed: ${detail}`);
  await logSystem('main-error', { error: detail }).catch(() => {});
  process.exit(1);
});
