import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('bridge service starts main after runtime state and handlers are initialized', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const mainCall = source.indexOf('await main().catch');

  assert.notEqual(mainCall, -1);
  for (const marker of [
    'const threadStarterVerified = new Set();',
    'const threadParentCache = new Map();',
    "for (const signal of ['SIGINT', 'SIGTERM'])",
    "process.on('exit'",
    'let fatalErrorHandled = false;',
  ]) {
    const markerIndex = source.indexOf(marker);
    assert.notEqual(markerIndex, -1, `missing marker: ${marker}`);
    assert.ok(markerIndex < mainCall, `${marker} must be initialized before main starts`);
  }
});

test('worker-emitted restart blocks cannot authorize a manual service restart', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const parseStart = source.indexOf('const modelRestartRequest = parseServiceRestartRequestFromOutput(result.output);');
  const runtimeCheck = source.indexOf('const runtimeChangedPaths = await runtimeSourceChangesSince', parseStart);

  assert.notEqual(parseStart, -1, 'worker restart blocks must be parsed only as untrusted metadata');
  assert.notEqual(runtimeCheck, -1);
  assert.match(source, /model-restart-marker-ignored/);
  assert.match(
    source,
    /runtimeSourceChangesSince\(\s*runtimeSourceBeforeJob,\s*job,\s*checkpointSnapshot,\s*\)/,
  );
  assert.match(source, /runtime-source-changes-not-attributed-to-job/);
  assert.doesNotMatch(source, /source:\s*'manual-understood'/);
  assert.doesNotMatch(source.slice(parseStart, runtimeCheck), /requestServiceRestart\s*\(/);
});

test('terminal worker responses bypass progress and dedupe fallback preserves final memory', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  // The dispatch call is wrapped in a step deadline, so anchor on the call
  // itself rather than on the assignment that precedes it.
  const runStart = [
    source.indexOf('runAgentJob({'),
    source.indexOf('executeAgentJob({'),
  ].find((index) => index !== -1) ?? -1;
  const parseStart = source.indexOf('const modelRestartRequest = parseServiceRestartRequestFromOutput(result.output);', runStart);
  const runSource = source.slice(runStart, parseStart);

  assert.notEqual(runStart, -1);
  assert.notEqual(parseStart, -1);
  assert.match(runSource, /progressUpdateGate\?\.add\(update\)/);
  assert.doesNotMatch(runSource, /progressForwarder\?\.add\(update\)/);
  assert.match(runSource, /progressUpdateGate\?\.complete\(\);/);

  const dedupeStart = source.indexOf('async function maybeDuplicateJobOutboundDelivery');
  const dedupeEnd = source.indexOf('async function durableJobOutboundDuplicate', dedupeStart);
  const dedupeSource = source.slice(dedupeStart, dedupeEnd);

  assert.notEqual(dedupeStart, -1);
  assert.notEqual(dedupeEnd, -1);
  assert.match(dedupeSource, /shouldReconcileSuppressedJobFinalToMemory\(purpose, duplicate\)/);
  assert.match(dedupeSource, /await recordJobOutboundMessage\(job, formattedContent, delivery/);
});

test('running job supersede and cancel paths deliver explicit closing notices', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const supersededStart = source.indexOf('async function markJobSuperseded(');
  const supersededEnd = source.indexOf('\nfunction isSupersededJobError(', supersededStart);
  const cancelledStart = source.indexOf('async function markJobCancelled(');
  const cancelledEnd = source.indexOf('\nasync function postJobStopNotice(', cancelledStart);
  const noticeStart = cancelledEnd + 1;
  const noticeEnd = source.indexOf('\nasync function markJobInterruptedByServiceShutdown(', noticeStart);

  assert.ok(supersededStart >= 0 && supersededEnd > supersededStart);
  assert.ok(cancelledStart >= 0 && cancelledEnd > cancelledStart);
  assert.ok(noticeStart > 0 && noticeEnd > noticeStart);

  for (const [section, status] of [
    [source.slice(supersededStart, supersededEnd), 'superseded'],
    [source.slice(cancelledStart, cancelledEnd), 'cancelled'],
  ]) {
    assert.match(section, new RegExp(`postJobStopNotice\\(job, '${status}'\\)`));
    assert.match(section, /delivered:\s*Boolean\(delivery\.delivered\)/);
    assert.match(section, /queued:\s*Boolean\(delivery\.queued\)/);
    assert.match(section, /outboxId:\s*delivery\.outboxId/);
  }

  const noticeSource = source.slice(noticeStart, noticeEnd);
  assert.match(noticeSource, /formatJobStopMessage\(status\)/);
  assert.match(noticeSource, /postJobMessage\(job, content, \{ purpose: `job-\$\{status\}` \}\)/);
  assert.match(source, /status:\s*jobStatusAfterOutboundDelivery\(entry\.purpose\)/);
});

test('/style routing cannot fall through to worker admission and preserves preview and selection wiring', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const dispatchStart = source.indexOf('async function recordAndDispatchEvent(');
  const dispatchEnd = source.indexOf('\nasync function scheduleThreadCreationRetry(', dispatchStart);
  const dispatchSource = source.slice(dispatchStart, dispatchEnd);
  const styleRouteStart = dispatchSource.indexOf('const styleCommand = parseStyleCommand(message.content);');
  const nextControlRoute = dispatchSource.indexOf('if (isYoloCommandRequest(', styleRouteStart);
  const styleRouteSource = dispatchSource.slice(styleRouteStart, nextControlRoute);
  const enqueueStart = dispatchSource.indexOf('enqueueCodexJob(event');

  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
  assert.ok(styleRouteStart >= 0 && nextControlRoute > styleRouteStart);
  assert.ok(enqueueStart > styleRouteStart, '/style must route before ordinary job admission');
  assert.match(styleRouteSource, /await handleStyleCommandRequest\(event, styleCommand\);/);
  assert.match(styleRouteSource, /return;/, '/style handling must not fall through to enqueue');

  const handlerStart = source.indexOf('async function handleStyleCommandRequest(');
  const handlerEnd = source.indexOf('\nasync function handleYoloCommandRequest(', handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);
  const selectorLookup = handlerSource.indexOf('const selected = richStyleBySelector(command.selector);');
  const invalidStart = handlerSource.indexOf('if (!selected)', selectorLookup);
  const persistenceStart = handlerSource.indexOf('const status = writeThreadRichStyleSync(', invalidStart);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.ok(selectorLookup > 0 && invalidStart > selectorLookup && persistenceStart > invalidStart);

  const listingSource = handlerSource.slice(0, selectorLookup);
  assert.match(listingSource, /purpose:\s*'style-command'/);
  assert.match(listingSource, /includeStylePreview:\s*true/);

  const invalidSource = handlerSource.slice(invalidStart, persistenceStart);
  assert.match(invalidSource, /purpose:\s*'style-command-invalid'/);
  assert.match(invalidSource, /return;/, 'an invalid selector must terminate command handling');

  const selectedSource = handlerSource.slice(persistenceStart);
  assert.match(
    selectedSource,
    /writeThreadRichStyleSync\(config,\s*event,\s*selected\.id\)/,
  );
  assert.match(selectedSource, /selected\.name/);
  assert.match(selectedSource, /purpose:\s*'style-command-selected'/);
  assert.match(selectedSource, /options:\s*\{\s*styleId\s*\}/);
  assert.doesNotMatch(handlerSource, /enqueueCodexJob|abortSupersededRunningThreadJobs/);
});

test('Slack API preflight cannot delay Discord gateway recovery', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const mainStart = source.indexOf('async function main()');
  const mainEnd = source.indexOf('async function runSlackBridge()', mainStart);
  const mainSource = source.slice(mainStart, mainEnd);

  assert.notEqual(mainStart, -1);
  assert.notEqual(mainEnd, -1);
  assert.doesNotMatch(mainSource, /await initializeSlackBridge\(\)/);
  assert.match(mainSource, /const gatewayPromises = \[gatewayLoop\(\)\]/);
  assert.match(
    mainSource,
    /const slackGatewayPromise = config\.slack\.enabled[\s\S]*?: runSlackBridge\(\)[\s\S]*?: null;/,
  );
  assert.match(mainSource, /gatewayPromises\.push\(slackGatewayPromise\)/);
  assert.match(source.slice(mainEnd), /slack-initialization-failed/);
  assert.match(source.slice(mainEnd), /retryInMs/);
});

test('the persisted-secret sweep never delays the gateways', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const mainStart = source.indexOf('async function main()');
  const mainEnd = source.indexOf('async function runSlackBridge()', mainStart);
  const mainSource = source.slice(mainStart, mainEnd);
  const slackStart = mainSource.indexOf('const slackGatewayPromise = config.slack.enabled');
  const sweep = mainSource.indexOf('sweepPersistedStateSecretsInBackground();');

  assert.notEqual(sweep, -1, 'the sweep must still run at startup');
  assert.ok(slackStart < sweep, 'Slack must connect before the state sweep starts');
  // A full pass reads the whole state tree; awaiting it is what turned a restart
  // into a ~90s window with no Slack acknowledgement.
  assert.doesNotMatch(mainSource, /await\s+(?:sweepPersistedStateSecrets|redactPersistedStateSecrets)\s*\(/);
  assert.doesNotMatch(mainSource, /await\s+sweepPersistedStateSecretsInBackground\s*\(/);
});

test('maintenance prompt compaction uses the imported job-aware thread context builder', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const compactStart = source.indexOf('async function maybeCompactMaintenancePrompt(');
  const compactEnd = source.indexOf('\nasync function updateMaintenanceManifestSafe(', compactStart);
  const compactSource = source.slice(compactStart, compactEnd);

  assert.notEqual(compactStart, -1);
  assert.notEqual(compactEnd, -1);
  assert.match(
    compactSource,
    /buildJobThreadContext\(\s*\[compactJob\.event\],\s*compactJob,\s*\{\s*maxMessages:\s*1,\s*maxChars:\s*6_000\s*\},\s*\)/,
  );
  assert.doesNotMatch(compactSource, /\bbuildThreadContext\(/);
});

test('Slack socket startup and acknowledgement precede sequential recovery and user lookup', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const mainStart = source.indexOf('async function main()');
  const mainEnd = source.indexOf('async function runSlackBridge()', mainStart);
  const mainSource = source.slice(mainStart, mainEnd);
  const slackStart = mainSource.indexOf('const slackGatewayPromise = config.slack.enabled');
  const restartRecovery = mainSource.indexOf('await completePendingRestart();');

  assert.notEqual(slackStart, -1);
  assert.notEqual(restartRecovery, -1);
  assert.ok(slackStart < restartRecovery, 'Slack must connect before sequential restart recovery');
  assert.match(mainSource, /gatewayPromises\.push\(slackGatewayPromise\)/);

  const handlerStart = source.indexOf('async function handleSlackMessage(');
  const handlerEnd = source.indexOf('async function slackUserDisplayName(', handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);
  const acknowledgement = handlerSource.indexOf('await acknowledgeSlackMessage(event.channel, event.ts)');
  const userLookup = handlerSource.indexOf('await slackUserDisplayName(event.user)');

  assert.notEqual(acknowledgement, -1);
  assert.notEqual(userLookup, -1);
  assert.ok(acknowledgement < userLookup, 'Slack reaction must not wait for user profile lookup');
});

test('durable /reboot events complete before the restart coordinator runs', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const dispatchStart = source.indexOf('async function recordAndDispatchEvent(');
  const rebootStart = source.indexOf('if (isRebootRequest(message.content))', dispatchStart);
  const rebootEnd = source.indexOf('\n  }', rebootStart);
  const rebootSource = source.slice(rebootStart, rebootEnd);
  const durableCompletion = rebootSource.indexOf('await completeDurableMessageProcessing(');
  const restart = rebootSource.indexOf('await handleRebootRequest(');

  assert.notEqual(dispatchStart, -1);
  assert.notEqual(rebootStart, -1);
  assert.notEqual(rebootEnd, -1);
  assert.notEqual(durableCompletion, -1, 'durable /reboot events must be completed');
  assert.notEqual(restart, -1, 'the restart coordinator must still run');
  assert.ok(durableCompletion < restart, 'the inbox row must be complete before process exit');
  assert.match(rebootSource, /if \(durableEnvelope\)/);
});

// A reattached detached worker never re-emits `worker.started`, so the progress
// timer would otherwise run with no worker info and print the raw job id
// ("1000000000000000010 working for 1 minute."). The notice must always resolve a
// worker identity: the one recovered from the job's own `worker-started` record,
// or the planned chain head.
test('progress notices name a worker even when the running worker never reports its start', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');

  assert.match(source, /let currentWorkerInfo = await reattachedWorkerStartInfo\(job\);/);
  assert.match(source, /plannedWorkerInfo = plannedWorkerStartInfo\(config, job\);/);
  assert.match(
    source,
    /workerDisplay: jobWorkerProgressDisplay\(currentWorkerInfo \|\| plannedWorkerInfo, job\),/,
    'the progress details callback must fall back instead of degrading to the job id',
  );

  const helperStart = source.indexOf('async function reattachedWorkerStartInfo(');
  const helperEnd = source.indexOf('\nfunction configuredWorkerModelForJob(', helperStart);
  const helperSource = source.slice(helperStart, helperEnd);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  assert.match(helperSource, /hasDurableWorker\(job\)/, 'only a reattached job may replay a recorded start');
  assert.match(helperSource, /record\?\.status !== 'worker-started'/);
  assert.match(helperSource, /String\(record\.id \|\| ''\) !== String\(job\.id\)/);
});
