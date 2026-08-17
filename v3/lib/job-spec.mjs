import { buildBridgePrompt } from '../../lib/bridge-prompt.mjs';
import { readChannelPreferences, formatChannelPreferencesForPrompt } from '../../lib/channel-memory.mjs';
import { channelStateDir, threadStateDir } from '../../lib/config.mjs';
import { buildJobThreadContext } from '../../lib/discord-thread-context.mjs';
import {
  jobAllowedRoots,
  jobArtifactRoot,
  jobNeedsFullStateAccess,
  jobNeedsRepoAccess,
  jobWorkingDirectory,
} from '../../lib/job-state-roots.mjs';
import { channelPythonVenvPath } from '../../lib/python-env.mjs';
import { JsonState } from '../../lib/state.mjs';
import { readChannelTodoState, formatTodoStateForPrompt } from '../../lib/todo-state.mjs';

export async function createJobSpec({
  bridgeConfig,
  inbound,
  ignoreBefore = new Date(),
  workerMode = 'agent',
}) {
  if (!bridgeConfig) throw new Error('bridgeConfig is required');
  const event = normalizeEvent(inbound?.event);
  const options = inbound?.options && typeof inbound.options === 'object'
    ? inbound.options
    : {};
  const reply = normalizeReply(inbound?.reply, event);
  const job = normalizeJob(bridgeConfig, event, options);
  const state = new JsonState(threadStateDir(
    bridgeConfig,
    job.channelId,
    job.threadId,
  ));
  await state.init();
  const existingEvents = await state.readJsonl('memory/events.jsonl', { limit: 1_000 });
  if (!existingEvents.some((entry) => String(entry?.id || '') === event.id)) {
    await state.appendJsonl('memory/events.jsonl', event);
    existingEvents.push(event);
  }

  const [todoState, channelPreferences] = await Promise.all([
    readChannelTodoState(bridgeConfig, job.channelId),
    readChannelPreferences(bridgeConfig, job.channelId),
  ]);
  const todoContext = formatTodoStateForPrompt(todoState);
  const channelMemoryContext = formatChannelPreferencesForPrompt(channelPreferences);
  const threadContext = buildJobThreadContext(existingEvents.slice(-80), job, {
    maxMessages: 80,
    maxChars: 30_000,
  });
  const allowedRoots = jobAllowedRoots(bridgeConfig, job);
  const prompt = buildBridgePrompt({
    ignoreBefore,
    job,
    threadContext,
    activeAsksEnabled: Boolean(bridgeConfig.activeAsks?.enabled),
    todoContext,
    channelMemoryContext,
    projectRoot: bridgeConfig.projectRoot,
    workingDir: jobWorkingDirectory(bridgeConfig, job),
    bridgeRepoRoot: job.bridgeRepoAccess ? bridgeConfig.bridgeRepoRoot : '',
    channelStateRoot: channelStateDir(bridgeConfig, job.channelId),
    channelArtifactRoot: jobArtifactRoot(bridgeConfig, job),
    channelPythonVenvPath: channelPythonVenvPath(bridgeConfig, job.channelId),
    githubCredentialDir: bridgeConfig.github?.credentialAvailable
      ? bridgeConfig.github.configDir
      : '',
    githubGitConfigGlobal: bridgeConfig.github?.gitConfigAvailable
      ? bridgeConfig.github.gitConfigGlobal
      : '',
    githubAskPassPath: bridgeConfig.github?.askPassAvailable
      ? bridgeConfig.github.askPassPath
      : '',
    bugReportRepository: bridgeConfig.maintenance?.bugReportRepository || '',
    threadStateRoot: threadStateDir(bridgeConfig, job.channelId, job.threadId),
    allowedRoots,
    repoAccess: jobNeedsRepoAccess(job),
    bridgeRepoAccess: Boolean(job.bridgeRepoAccess),
    stateAccess: jobNeedsFullStateAccess(job),
  });

  return {
    protocolVersion: 1,
    job,
    prompt,
    reply,
    workerMode: normalizeWorkerMode(options.workerMode || workerMode),
    mockPlan: normalizeMockPlan(options.mockPlan),
  };
}

function normalizeEvent(event = {}) {
  if (!event || typeof event !== 'object') throw new Error('inbound event is required');
  const id = requiredText(event.id, 'event.id');
  const channelId = requiredText(event.channelId, 'event.channelId');
  const threadId = requiredText(event.threadId || event.channelId, 'event.threadId');
  const platform = event.platform === 'slack' ? 'slack' : 'discord';
  return {
    ...event,
    id,
    timestamp: validTimestamp(event.timestamp) || new Date().toISOString(),
    authorId: String(event.authorId || ''),
    authorName: String(event.authorName || event.authorId || 'user'),
    channelId,
    threadId,
    content: String(event.content || ''),
    platform,
    source: platform,
    attachments: Array.isArray(event.attachments) ? event.attachments : [],
    embeds: Array.isArray(event.embeds) ? event.embeds : [],
  };
}

function normalizeReply(reply = {}, event) {
  const platform = reply?.platform === 'slack' || event.platform === 'slack'
    ? 'slack'
    : 'discord';
  const destination = reply?.destination && typeof reply.destination === 'object'
    ? reply.destination
    : {};
  if (platform === 'slack') {
    return {
      platform,
      destination: {
        channelId: requiredText(
          destination.channelId || event.sourceChannelId,
          'reply.destination.channelId',
        ),
        threadTs: requiredText(
          destination.threadTs || event.sourceThreadId,
          'reply.destination.threadTs',
        ),
      },
    };
  }
  return {
    platform,
    destination: {
      channelId: requiredText(
        destination.channelId || event.threadId,
        'reply.destination.channelId',
      ),
    },
  };
}

function normalizeJob(config, event, options) {
  const content = String(event.content || '');
  const repoAccess = typeof options.repoAccess === 'boolean'
    ? options.repoAccess
    : jobNeedsRepoAccess({ event });
  const stateAccess = typeof options.stateAccess === 'boolean'
    ? options.stateAccess
    : jobNeedsFullStateAccess({ event });
  const bridgeRepoAccess = typeof options.bridgeRepoAccess === 'boolean'
    ? options.bridgeRepoAccess
    : repoAccess && /(^|\s)\/yolo(?=$|\s|[.,!?;:])/i.test(content);
  return {
    id: event.id,
    channelId: event.channelId,
    threadId: event.threadId,
    event,
    priority: Number.isFinite(Number(options.priority))
      ? Number(options.priority)
      : 1,
    concurrencyKey: String(
      options.concurrencyKey || `${event.channelId}:${event.threadId}`,
    ),
    maintenance: Boolean(options.maintenance),
    repoAccess,
    repoPath: options.repoPath ? String(options.repoPath) : null,
    bridgeRepoAccess,
    stateAccess,
    threadModelOverride: options.threadModelOverride || null,
    preserveThreadModelOverride: Boolean(options.threadModelOverride),
    codexFastMode: Boolean(options.codexFastMode)
      || /(^|\s)\/fast(?=$|\s|[.,!?;:])/i.test(content),
    search: Boolean(options.search),
    verboseProgress: Boolean(options.verboseProgress)
      || /(^|\s)\/verbose(?=$|\s|[.,!?;:])/i.test(content),
    attempt: Math.max(1, Number(options.attempt) || 1),
    finalChannelId: options.finalChannelId || null,
    pendingAskAnswer: options.pendingAskAnswer || null,
  };
}

function normalizeWorkerMode(value) {
  return String(value || '').toLowerCase() === 'mock' ? 'mock' : 'agent';
}

function normalizeMockPlan(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    startDelayMs: nonNegative(value.startDelayMs, 20),
    updateDelayMs: nonNegative(value.updateDelayMs, 100),
    updates: Array.isArray(value.updates)
      ? value.updates.map(String)
      : ['mock worker progress'],
    finalDelayMs: nonNegative(value.finalDelayMs, 100),
    output: String(value.output || 'mock worker completed'),
    fail: Boolean(value.fail),
  };
}

function validTimestamp(value) {
  const timestamp = String(value || '');
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : '';
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}
