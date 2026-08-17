import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  globalRepoAccessPath,
  mergeThreadRepoContextIntoJobSync,
  readGlobalRepoAccessSync,
  readThreadStatusSync,
  readThreadRichStyleIdSync,
  resolveJobRichStyleIdSync,
  requestThreadEffortSelectionSync,
  requestThreadModelSelectionSync,
  resolveThreadRepoContextSync,
  threadStatusPath,
  writeInheritedThreadStatusSync,
  writeThreadCodexFastModeSync,
  writeThreadEffortOverrideSync,
  writeThreadModelOverrideSync,
  writeThreadRepoAccessSync,
  writeThreadRepositoryRootSync,
  writeThreadVerboseProgressSync,
  writeThreadRichStyleSync,
} from '../lib/thread-repo-context.mjs';
import { modelOptionByNumber, modelOptionBySelector } from '../lib/thread-models.mjs';

test('resolveThreadRepoContextSync honors explicit full-state access for maintenance jobs', async () => {
  const config = await tempConfig();
  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    maintenance: true,
    stateAccess: true,
  });

  assert.equal(resolved.repoAccess, true);
  assert.equal(resolved.repoPath, config.bridgeRepoRoot);
  assert.equal(resolved.stateAccess, true);
});

test('resolveThreadRepoContextSync ignores legacy repo access in thread/status.json', async () => {
  const config = await tempConfig();
  await writeLegacyThreadStatus(config, {
    repoAccess: true,
    repoPath: '/tmp/projects/repo-a',
    source: 'legacy-repo-access',
  });
  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: false,
  });

  assert.equal(resolved.repoAccess, false);
  assert.equal(resolved.repoPath, null);
  assert.equal(resolved.storedRepoAccess, true);
  assert.equal(resolved.storedRepoPath, '/tmp/projects/repo-a');
  await assert.doesNotReject(fs.stat(threadStatusPath(config, 'channel-1', 'thread-1')));
});

test('resolveThreadRepoContextSync does not reuse stored repo access for follow-up jobs', async () => {
  const config = await tempConfig();
  await writeLegacyThreadStatus(config, {
    repoAccess: true,
    repoPath: '/tmp/projects/repo-a',
  });

  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: false,
  });

  assert.equal(resolved.repoAccess, false);
  assert.equal(resolved.repoPath, null);
  assert.equal(resolved.storedRepoAccess, true);
  assert.equal(resolved.storedRepoPath, '/tmp/projects/repo-a');
});

test('resolveThreadRepoContextSync reuses repo access only when /repo stores thread scope', async () => {
  const config = await tempConfig();
  const stored = writeThreadRepositoryRootSync(config, {
    id: 'repo-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  });

  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: false,
  });

  assert.equal(stored.repoAccessScope, 'thread');
  assert.equal(resolved.repoAccess, true);
  assert.equal(resolved.bridgeRepoAccess, false);
  assert.equal(resolved.repoPath, path.join(config.stateRoot, 'repositories'));
  assert.equal(resolved.storedRepoAccessScope, 'thread');
});

test('resolveThreadRepoContextSync reuses repo access globally when /yolo stores global scope', async () => {
  const config = await tempConfig();
  const stored = writeThreadRepoAccessSync(config, {
    id: 'yolo-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  });

  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: false,
  });
  const otherThread = resolveThreadRepoContextSync(config, {
    channelId: 'channel-2',
    threadId: 'thread-2',
    repoAccess: false,
  });
  const globalAccess = readGlobalRepoAccessSync(config);

  assert.equal(stored.repoAccessScope, 'global');
  assert.equal(stored.repoPath, path.join(config.stateRoot, 'channel-1_common', 'workspace'));
  assert.equal(resolved.repoAccess, true);
  assert.equal(resolved.bridgeRepoAccess, true);
  assert.equal(resolved.repoPath, path.join(config.stateRoot, 'channel-1_common', 'workspace'));
  assert.equal(resolved.storedRepoAccessScope, 'global');
  assert.equal(resolved.globalRepoAccess, true);
  assert.equal(resolved.globalRepoAccessScope, 'global');
  assert.equal(otherThread.repoAccess, true);
  assert.equal(otherThread.bridgeRepoAccess, true);
  assert.equal(otherThread.repoPath, path.join(config.stateRoot, 'channel-2_common', 'workspace'));
  assert.equal(otherThread.globalRepoAccess, true);
  assert.equal(globalAccess.repoAccessScope, 'global');
  assert.equal(globalAccess.bridgeRepoAccess, true);
  await assert.doesNotReject(fs.stat(globalRepoAccessPath(config)));
});

test('resolveThreadRepoContextSync lets explicit false disable global /yolo repo access', async () => {
  const config = await tempConfig();
  writeThreadRepoAccessSync(config, {
    id: 'yolo-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  });

  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-2',
    threadId: 'thread-2',
    repoAccessDirective: false,
  });

  assert.equal(resolved.repoAccess, false);
  assert.equal(resolved.repoPath, null);
  assert.equal(resolved.globalRepoAccess, true);
});

test('resolveThreadRepoContextSync lets explicit false disable stored repo access', async () => {
  const config = await tempConfig();
  await writeLegacyThreadStatus(config, {
    repoAccess: true,
    repoPath: '/tmp/projects/repo-a',
  });

  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccessDirective: false,
  });

  assert.equal(resolved.repoAccess, false);
  assert.equal(resolved.repoPath, null);
});

test('thread repo context does not persist god state access for follow-up jobs', async () => {
  const config = await tempConfig();
  await writeLegacyThreadStatus(config, {
    repoAccess: true,
    stateAccess: true,
    repoPath: '/tmp/projects/repo-a',
    source: 'god-command',
  });

  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: false,
    stateAccess: false,
  });

  assert.equal(resolved.stateAccess, false);
  assert.equal(resolved.repoAccess, false);
  assert.equal(resolved.repoPath, null);
  assert.equal(resolved.storedStateAccess, true);
});

test('mergeThreadRepoContextIntoJobSync does not upgrade queued jobs from stored god access', async () => {
  const config = await tempConfig();
  await writeLegacyThreadStatus(config, {
    repoAccess: true,
    stateAccess: true,
    repoPath: '/tmp/projects/repo-a',
    source: 'god-command',
  });

  const merged = mergeThreadRepoContextIntoJobSync(config, {
    id: 'queued-before-god',
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: false,
    stateAccess: false,
  });

  assert.equal(merged.repoAccess, false);
  assert.equal(merged.stateAccess, false);
  assert.equal(merged.repoPath, null);
});

test('thread status persists pending and selected model state', async () => {
  const config = await tempConfig();
  const job = {
    id: 'model-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  };

  const pending = requestThreadModelSelectionSync(config, job);

  assert.equal(pending.pendingModelSelection.messageId, 'model-command');
  assert.equal(readThreadStatusSync(config, 'channel-1', 'thread-1').pendingModelSelection.messageId, 'model-command');

  const selected = writeThreadModelOverrideSync(config, {
    ...job,
    id: 'model-choice',
  }, modelOptionByNumber(config, 1));
  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
  });
  const merged = mergeThreadRepoContextIntoJobSync(config, {
    id: 'queued-before-model',
    channelId: 'channel-1',
    threadId: 'thread-1',
  });

  assert.equal(selected.pendingModelSelection, null);
  assert.equal(selected.threadModelOverride.label, 'codex: gpt-5.6-terra');
  assert.equal(selected.threadModelOverride.selectedByMessageId, 'model-choice');
  assert.equal(resolved.threadModelOverride.label, 'codex: gpt-5.6-terra');
  assert.equal(merged.threadModelOverride.label, 'codex: gpt-5.6-terra');
});

test('thread status persists a "5 6 1" fallback chain selection', async () => {
  const config = await tempConfig();
  const job = { id: 'model-command', channelId: 'channel-1', threadId: 'thread-1' };

  const selected = writeThreadModelOverrideSync(
    config,
    { ...job, id: 'chain-choice' },
    [5, 6, 1].map((number) => modelOptionByNumber(config, number)),
  );
  const merged = mergeThreadRepoContextIntoJobSync(config, {
    id: 'queued-before-chain',
    channelId: 'channel-1',
    threadId: 'thread-1',
  });

  const chain = selected.threadModelOverride.chain;
  assert.equal(chain.length, 3, 'all three picks survive');
  assert.deepEqual(chain.map((entry) => entry.label), [
    'antigravity: claude-opus-4.6',
    'antigravity: gemini-3.7-flash',
    'codex: gpt-5.6-terra',
  ]);
  // The primary fields mirror the first pick so single-model consumers keep working.
  assert.equal(selected.threadModelOverride.label, 'antigravity: claude-opus-4.6');
  assert.equal(merged.threadModelOverride.chain.length, 3);
});

test('thread model state preserves the selected Claude account for every fallback entry', async () => {
  const config = await tempConfig();
  config.claude = {
    accounts: [
      { id: 'primary', label: '개인', home: '/tmp/claude-personal' },
      { id: 'secondary', label: '업무', home: '/tmp/claude-work' },
    ],
  };
  const job = { id: 'model-command', channelId: 'channel-1', threadId: 'thread-1' };
  const selected = writeThreadModelOverrideSync(config, { ...job, id: 'account-chain' }, [
    modelOptionBySelector(config, 'fable:primary'),
    modelOptionBySelector(config, 'opus:secondary'),
  ]);
  const restored = readThreadStatusSync(config, job.channelId, job.threadId);

  assert.deepEqual(selected.threadModelOverride.chain.map((entry) => entry.claudeAccount.id), ['primary', 'secondary']);
  assert.deepEqual(restored.threadModelOverride.chain.map((entry) => entry.claudeAccount.label), ['개인', '업무']);
});

test('mergeThreadRepoContextIntoJobSync preserves explicit continuation model override', async () => {
  const config = await tempConfig();
  const merged = mergeThreadRepoContextIntoJobSync(config, {
    id: 'ask-continuation',
    channelId: 'channel-1',
    threadId: 'thread-1',
    threadModelOverride: {
      id: 'claude',
      label: 'claude: Opus 5',
      worker: 'claude',
      model: 'opus',
    },
  });

  assert.equal(merged.threadModelOverride.label, 'claude: Opus 5');
  assert.equal(merged.threadModelOverride.worker, 'claude');
});

test('writeThreadVerboseProgressSync stores sticky verbose progress without repo access', async () => {
  const config = await tempConfig();
  const stored = writeThreadVerboseProgressSync(config, {
    id: 'verbose-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  });
  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: false,
  });
  const merged = mergeThreadRepoContextIntoJobSync(config, {
    id: 'follow-up',
    channelId: 'channel-1',
    threadId: 'thread-1',
    verboseProgress: false,
  });

  assert.equal(stored.verboseProgress, true);
  assert.equal(resolved.verboseProgress, true);
  assert.equal(resolved.repoAccess, false);
  assert.equal(resolved.repoPath, null);
  assert.equal(merged.verboseProgress, true);
});

test('rendering style persists in thread/status.json and remains isolated per thread', async () => {
  const config = await tempConfig();
  const selected = writeThreadRichStyleSync(config, {
    id: 'style-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  }, 'minimal-light');

  assert.equal(selected.richStyleId, 'minimal-light');
  assert.equal(readThreadRichStyleIdSync(config, 'channel-1', 'thread-1'), 'minimal-light');
  assert.equal(readThreadRichStyleIdSync(config, 'channel-1', 'thread-2'), 'warm-noir');
  assert.equal(readThreadStatusSync(config, 'channel-1', 'thread-1').richStyleId, 'minimal-light');
  assert.equal(mergeThreadRepoContextIntoJobSync(config, {
    id: 'next-job',
    channelId: 'channel-1',
    threadId: 'thread-1',
  }).richStyleId, 'minimal-light');
  assert.equal(writeThreadRichStyleSync(config, {
    id: 'invalid',
    channelId: 'channel-1',
    threadId: 'thread-1',
  }, 'does-not-exist'), null);
});

test('resolveJobRichStyleIdSync prefers valid thread state and falls back to the job snapshot', async () => {
  const config = await tempConfig();
  const job = {
    channelId: 'channel-1',
    threadId: 'thread-1',
    richStyleId: 'minimal-light',
  };

  assert.equal(resolveJobRichStyleIdSync(config, job), 'minimal-light');
  writeThreadRichStyleSync(config, job, 'synthwave');
  assert.equal(resolveJobRichStyleIdSync(config, job), 'synthwave');

  await fs.writeFile(threadStatusPath(config, job.channelId, job.threadId), '{invalid json');
  assert.equal(resolveJobRichStyleIdSync(config, job), 'minimal-light');
  assert.equal(resolveJobRichStyleIdSync(config, {
    ...job,
    richStyleId: 'does-not-exist',
  }), 'warm-noir');
});

test('resolveJobRichStyleIdSync absorbs status I/O errors during delivery lookup', async () => {
  const config = await tempConfig();
  const job = {
    channelId: 'channel-1',
    threadId: 'thread-1',
    richStyleId: 'arctic-neon',
  };

  for (const code of ['EIO', 'EACCES']) {
    assert.equal(resolveJobRichStyleIdSync(config, job, {
      readStatusSync() {
        const error = new Error(`status unavailable: ${code}`);
        error.code = code;
        throw error;
      },
    }), 'arctic-neon');
  }
});

test('writeThreadVerboseProgressSync disables sticky verbose progress', async () => {
  const config = await tempConfig();
  const job = {
    id: 'quiet-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  };

  writeThreadVerboseProgressSync(config, job, true);
  const stored = writeThreadVerboseProgressSync(config, job, false, { source: 'quiet-command' });
  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: false,
  });
  const merged = mergeThreadRepoContextIntoJobSync(config, {
    id: 'follow-up',
    channelId: 'channel-1',
    threadId: 'thread-1',
    verboseProgress: false,
  });

  assert.equal(stored.verboseProgress, false);
  assert.equal(resolved.verboseProgress, false);
  assert.equal(readThreadStatusSync(config, 'channel-1', 'thread-1'), null);
  assert.equal(merged.verboseProgress, false);
});

test('Codex fast mode is sticky per thread and /unfast restores the standard tier', async () => {
  const config = await tempConfig();
  const job = {
    id: 'fast-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  };

  const enabled = writeThreadCodexFastModeSync(config, job, true);
  const resolvedEnabled = resolveThreadRepoContextSync(config, job);
  const mergedEnabled = mergeThreadRepoContextIntoJobSync(config, {
    ...job,
    id: 'queued-fast-job',
  });

  assert.equal(enabled.codexFastMode, true);
  assert.equal(resolvedEnabled.codexFastMode, true);
  assert.equal(mergedEnabled.codexFastMode, true);
  assert.equal(readThreadStatusSync(config, job.channelId, job.threadId).codexFastMode, true);

  const disabled = writeThreadCodexFastModeSync(config, {
    ...job,
    id: 'unfast-command',
  }, false);
  const resolvedDisabled = resolveThreadRepoContextSync(config, job);
  const mergedDisabled = mergeThreadRepoContextIntoJobSync(config, {
    ...job,
    id: 'queued-standard-job',
    codexFastMode: true,
  });

  assert.equal(disabled.codexFastMode, false);
  assert.equal(resolvedDisabled.codexFastMode, false);
  assert.equal(mergedDisabled.codexFastMode, false);
  assert.equal(readThreadStatusSync(config, job.channelId, job.threadId), null);
});

test('writeThreadModelOverrideSync collapses a duplicate single pick to a plain pin', async () => {
  const config = await tempConfig();
  const job = { id: 'model-command', channelId: 'channel-1', threadId: 'thread-1' };

  const selected = writeThreadModelOverrideSync(
    config,
    { ...job, id: 'dup-choice' },
    [1, 1].map((number) => modelOptionByNumber(config, number)),
  );

  assert.equal(selected.threadModelOverride.label, 'codex: gpt-5.6-terra');
  assert.equal(selected.threadModelOverride.chain, undefined, 'no chain for a single distinct model');
});

test('thread status persists pending and selected effort state', async () => {
  const config = await tempConfig();
  const job = {
    id: 'effort-command',
    channelId: 'channel-1',
    threadId: 'thread-1',
  };

  const pending = requestThreadEffortSelectionSync(config, job);
  assert.equal(pending.pendingEffortSelection.messageId, 'effort-command');
  assert.equal(readThreadStatusSync(config, 'channel-1', 'thread-1').pendingEffortSelection.messageId, 'effort-command');

  const selected = writeThreadEffortOverrideSync(config, {
    ...job,
    id: 'effort-choice',
  }, 'low');
  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-1',
  });

  assert.equal(selected.pendingEffortSelection, null);
  assert.equal(selected.threadModelOverride.label, 'codex: gpt-5.6-terra');
  assert.equal(selected.threadModelOverride.reasoningEffort, 'low');
  assert.equal(selected.threadEffortOverride, 'low');
  assert.equal(resolved.threadModelOverride.reasoningEffort, 'low');
  assert.equal(resolved.threadEffortOverride, 'low');
});

test('explicit effort remains sticky when /model is selected again', async () => {
  const config = await tempConfig();
  const job = { id: 'selection', channelId: 'channel-1', threadId: 'thread-1' };

  writeThreadModelOverrideSync(config, { ...job, id: 'model-sol' }, modelOptionByNumber(config, 0));
  writeThreadEffortOverrideSync(config, { ...job, id: 'effort-max' }, 'max');

  const solAgain = writeThreadModelOverrideSync(
    config,
    { ...job, id: 'model-sol-again' },
    modelOptionByNumber(config, 0),
  );
  assert.equal(solAgain.threadEffortOverride, 'max');
  assert.equal(solAgain.threadModelOverride.reasoningEffort, 'max');

  const opus = writeThreadModelOverrideSync(
    config,
    { ...job, id: 'model-opus' },
    modelOptionByNumber(config, 4),
  );
  assert.equal(opus.threadEffortOverride, 'max');
  assert.equal(opus.threadModelOverride.effort, 'xhigh');

  const terra = writeThreadModelOverrideSync(
    config,
    { ...job, id: 'model-terra' },
    modelOptionByNumber(config, 1),
  );
  assert.equal(terra.threadEffortOverride, 'max');
  assert.equal(terra.threadModelOverride.reasoningEffort, 'max');
});

test('max effort persists across a mixed fallback chain without invalid Claude effort', async () => {
  const config = await tempConfig();
  const job = { id: 'model-choice', channelId: 'channel-1', threadId: 'thread-1' };
  writeThreadModelOverrideSync(
    config,
    job,
    [0, 4, 5, 1].map((number) => modelOptionByNumber(config, number)),
  );

  const selected = writeThreadEffortOverrideSync(config, { ...job, id: 'effort-max' }, 'max');
  const chain = selected.threadModelOverride.chain;

  assert.deepEqual(chain.map((entry) => entry.label), [
    'codex: gpt-5.6-sol',
    'claude: Opus 5',
    'antigravity: claude-opus-4.6',
    'codex: gpt-5.6-terra',
  ]);
  assert.equal(chain[0].reasoningEffort, 'max');
  assert.equal(chain[1].effort, 'xhigh');
  assert.equal(chain[2].effort, 'high');
  assert.equal(chain[2].reasoningEffort, null);
  assert.equal(chain[3].reasoningEffort, 'max');
  assert.equal(selected.threadEffortOverride, 'max');
  assert.equal(readThreadStatusSync(config, 'channel-1', 'thread-1').threadModelOverride.chain[0].reasoningEffort, 'max');
});

test('positional effort selections are stored on the matching fallback models', async () => {
  const config = await tempConfig();
  const job = { id: 'model-choice', channelId: 'channel-1', threadId: 'thread-1' };
  writeThreadModelOverrideSync(config, job, ['sol', 'terra', 'opus'].map((selector) =>
    modelOptionBySelector(config, selector)));

  const selected = writeThreadEffortOverrideSync(
    config,
    { ...job, id: 'effort-choices' },
    ['max', 'xhigh', 'low'],
  );
  const chain = selected.threadModelOverride.chain;

  assert.deepEqual(chain.map((entry) => entry.label), [
    'codex: gpt-5.6-sol',
    'codex: gpt-5.6-terra',
    'claude: Opus 5',
  ]);
  assert.deepEqual(chain.map((entry) => entry.reasoningEffort), ['max', 'xhigh', 'low']);
  assert.deepEqual(chain.map((entry) => entry.effort), ['max', 'xhigh', 'low']);
  assert.equal(selected.threadEffortOverride, null);

  const luna = writeThreadModelOverrideSync(
    config,
    { ...job, id: 'model-luna' },
    modelOptionBySelector(config, 'luna'),
  );
  assert.equal(luna.threadModelOverride.reasoningEffort, 'xhigh', 'positional effort does not become sticky');
});

test('combined model and positional effort selection is atomic', async () => {
  const config = await tempConfig();
  const job = { id: 'combined-choice', channelId: 'channel-1', threadId: 'thread-1' };
  const options = ['sol', 'terra', 'opus'].map((selector) => modelOptionBySelector(config, selector));

  const invalid = writeThreadModelOverrideSync(config, job, options, {
    source: 'model-effort-command',
    effortOverrides: ['max', 'xhigh'],
  });
  assert.equal(invalid, null);
  assert.equal(readThreadStatusSync(config, 'channel-1', 'thread-1'), null);

  const selected = writeThreadModelOverrideSync(config, job, options, {
    source: 'model-effort-command',
    effortOverrides: ['max', 'xhigh', 'low'],
  });
  assert.deepEqual(
    selected.threadModelOverride.chain.map((entry) => entry.effort || entry.reasoningEffort),
    ['max', 'xhigh', 'low'],
  );
  assert.equal(selected.source, 'model-effort-command');
});

test('combined model selection applies one effort across compatible fallback models', async () => {
  const config = await tempConfig();
  const job = { id: 'combined-shared-effort', channelId: 'channel-1', threadId: 'thread-1' };
  const options = ['sol', 'terra', 'opus'].map((selector) => modelOptionBySelector(config, selector));

  const selected = writeThreadModelOverrideSync(config, job, options, {
    source: 'model-effort-command',
    effortOverrides: ['max'],
  });
  const chain = selected.threadModelOverride.chain;

  assert.deepEqual(chain.map((entry) => entry.label), [
    'codex: gpt-5.6-sol',
    'codex: gpt-5.6-terra',
    'claude: Opus 5',
  ]);
  assert.deepEqual(
    chain.map((entry) => entry.reasoningEffort || entry.effort),
    ['max', 'max', 'xhigh'],
  );
  assert.equal(selected.threadEffortOverride, 'max');
});

test('model and effort menus replace each other as the active selection prompt', async () => {
  const config = await tempConfig();
  const job = { id: 'selection', channelId: 'channel-1', threadId: 'thread-1' };

  requestThreadEffortSelectionSync(config, job);
  const modelPending = requestThreadModelSelectionSync(config, { ...job, id: 'model-menu' });
  assert.equal(modelPending.pendingEffortSelection, null);
  assert.equal(modelPending.pendingModelSelection.messageId, 'model-menu');

  const effortPending = requestThreadEffortSelectionSync(config, { ...job, id: 'effort-menu' });
  assert.equal(effortPending.pendingModelSelection, null);
  assert.equal(effortPending.pendingEffortSelection.messageId, 'effort-menu');
});

test('writeInheritedThreadStatusSync carries repo, state, and model state into a new thread', async () => {
  const config = await tempConfig();
  await writeLegacyThreadStatus(config, {
    repoAccess: true,
    repoAccessScope: 'thread',
    repoPath: '/tmp/projects/source-repo',
    stateAccess: true,
    threadModelOverride: {
      id: 'codex-gpt-5.6-terra',
      label: 'codex: gpt-5.6-terra',
      worker: 'codex',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      reasoningSummary: 'none',
    },
  });

  const inherited = writeInheritedThreadStatusSync(config, {
    sourceChannelId: 'channel-1',
    sourceThreadId: 'thread-1',
    targetChannelId: 'channel-1',
    targetThreadId: 'thread-gitpoll',
    sourceMessageId: 'message-1',
    repoPath: '/tmp/projects/polled-repo',
    repoAccess: true,
  }, { source: 'git-poll-thread-inherit' });
  const resolved = resolveThreadRepoContextSync(config, {
    channelId: 'channel-1',
    threadId: 'thread-gitpoll',
    repoAccess: false,
    stateAccess: true,
  });

  assert.equal(inherited.channelId, 'channel-1');
  assert.equal(inherited.threadId, 'thread-gitpoll');
  assert.equal(inherited.repoAccess, true);
  assert.equal(inherited.repoAccessScope, 'thread');
  assert.equal(inherited.repoPath, '/tmp/projects/polled-repo');
  assert.equal(inherited.stateAccess, true);
  assert.equal(inherited.threadModelOverride.label, 'codex: gpt-5.6-terra');
  assert.deepEqual(inherited.inheritedFrom, {
    channelId: 'channel-1',
    threadId: 'thread-1',
    messageId: 'message-1',
  });
  assert.equal(resolved.repoPath, '/tmp/projects/polled-repo');
  assert.equal(resolved.threadModelOverride.label, 'codex: gpt-5.6-terra');
});

async function writeLegacyThreadStatus(config, patch = {}) {
  const channelId = patch.channelId || 'channel-1';
  const threadId = patch.threadId || 'thread-1';
  const now = '2026-06-29T00:00:00.000Z';
  const status = {
    channelId,
    threadId,
    firstJobId: patch.firstJobId || 'legacy-job',
    createdAt: patch.createdAt || now,
    updatedAt: patch.updatedAt || now,
    source: patch.source || 'legacy',
    ...patch,
  };
  const file = threadStatusPath(config, channelId, threadId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

async function tempConfig() {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-thread-repo-context-'));
  return {
    stateRoot,
    repositoriesRoot: path.join(stateRoot, 'repositories'),
    bridgeRepoRoot: '/tmp/projects/mobile-codex-bridge',
    codex: {
      cwd: path.join(stateRoot, 'workspace'),
    },
    workers: {
      companyChannelIds: new Set(),
    },
  };
}
