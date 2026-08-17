import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBridgePrompt } from '../lib/bridge-prompt.mjs';

test('buildBridgePrompt allows local state and repo inspection for operational work', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: 완료된 todo 알려줘',
    todoContext: 'Channel TODO state:\n- active item',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    channelPythonVenvPath: '/tmp/projects/.bridge_state/channel-1_common/.venv',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
  });

  assert.match(prompt, /autonomous coding and operations agent/);
  assert.match(prompt, /actively inspect and operate on the allowed local roots/);
  assert.match(prompt, /For every `exec_command` call, pass `login:false`/);
  assert.match(prompt, /Bridge-only credentials are removed from worker environments/);
  assert.match(prompt, /WORKER_ENV_ALLOWLIST/);
  assert.match(prompt, /use the available Git or GitHub CLI credential/);
  assert.match(prompt, /never ask the user to paste a token/);
  assert.match(prompt, /attempt the requested push promptly with WSL\/Linux Git/);
  assert.match(prompt, /Do not use `git ls-remote` as an authentication preflight/);
  assert.match(prompt, /Windows Git or Windows Credential Manager/);
  assert.doesNotMatch(prompt, /Host GitHub credential directory/);
  assert.doesNotMatch(prompt, /Host Git global config/);
  assert.doesNotMatch(prompt, /Host GitHub askpass helper/);
  assert.match(prompt, /channel common \.env as the default source for secrets/);
  assert.match(prompt, /Do not inspect sibling thread directories/);
  assert.doesNotMatch(prompt, /Bridge state root:/);
  assert.match(prompt, /explicit job option or command directive/);
  assert.match(prompt, /Working directory: \/tmp\/projects\/\.bridge_state\/channel-1_common\/workspace/);
  assert.match(prompt, /Current channel common state root: \/tmp\/projects\/\.bridge_state\/channel-1_common/);
  assert.match(prompt, /Current channel artifacts root: \/tmp\/projects\/\.bridge_state\/channel-1_common\/artifacts/);
  assert.match(prompt, /channel-shared Python virtualenv/);
  assert.match(prompt, /Configured channel Python virtualenv: \/tmp\/projects\/\.bridge_state\/channel-1_common\/\.venv/);
  assert.match(prompt, /BRIDGE_KOREAN_FONT_FILE/);
  assert.match(prompt, /tofu boxes/);
  assert.match(prompt, /Current thread state root: \/tmp\/projects\/\.bridge_state\/channel-1\/thread-1/);
  assert.match(prompt, /Repository access: enabled/);
  assert.match(prompt, /store non-source channel deliverables under the channel artifacts root/);
  assert.match(prompt, /name every intended attachment.*exact path starting with `artifacts\/`/);
  assert.match(prompt, /bare filename or local file existence does not upload anything/);
  assert.match(prompt, /Do not claim that an image or file was sent/);
  assert.match(prompt, /omitted from the final response.*visible not-uploaded warning/);
  assert.match(prompt, /do not seek `DISCORD_BOT_TOKEN`/);
  assert.match(prompt, /The channel TODO state below is authoritative/);
  assert.match(prompt, /directly update the current channel common JSONL state files/);
  assert.match(prompt, /append to todo\.jsonl with the next unused todo-NNN id/);
  assert.match(prompt, /search both alerts\.jsonl and alerts-completed\.jsonl/);
  assert.match(prompt, /concrete intermediate results as they become available/);
  assert.match(prompt, /do not include raw command output in progress updates/);
  assert.match(prompt, /Do not run a separate summarization step just to create progress updates/);
  assert.doesNotMatch(prompt, /Global memory:/);
});

test('buildBridgePrompt identifies Slack jobs and their shared logical channel', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: {
      channelId: '1000000000000000001',
      threadId: 'slack-T123-C123-1785218400.123456',
      event: {
        platform: 'slack',
        sourceChannelId: 'C123',
        sourceThreadId: '1785218400.123456',
      },
    },
    threadContext: 'user: !model sol',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/1000000000000000001_common/workspace',
    bridgeRepoRoot: '/tmp/projects/mobile-codex-bridge',
    channelStateRoot: '/tmp/projects/.bridge_state/1000000000000000001_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/1000000000000000001_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/1000000000000000001/slack-T123-C123-1785218400.123456',
    allowedRoots: ['/tmp/projects/mobile-codex-bridge'],
    repoAccess: true,
    bridgeRepoAccess: true,
  });

  assert.match(prompt, /responding through the Slack bridge/);
  assert.match(prompt, /authorized by `!yolo`/);
  assert.match(prompt, /Slack channel: C123/);
  assert.match(prompt, /Slack thread: 1785218400\.123456/);
  assert.match(prompt, /Logical shared channel: 1000000000000000001/);
  assert.match(prompt, /Slack thread context:/);
  assert.match(prompt, /post back to this Slack thread/);
  assert.doesNotMatch(prompt, /Discord thread context:/);
  assert.doesNotMatch(prompt, /exact path starting with `artifacts\/`/);
  assert.doesNotMatch(prompt, /DISCORD_BOT_TOKEN/);
});

test('buildBridgePrompt allows verbose progress when requested for the job', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1', verboseProgress: true },
    threadContext: 'user: /verbose 작업해줘',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
  });

  assert.match(prompt, /explicitly enabled \/verbose progress/);
});

test('buildBridgePrompt explicitly authorizes direct bridge source changes for /yolo jobs', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: bridge code fix',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    bridgeRepoRoot: '/tmp/projects/mobile-codex-bridge',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects/mobile-codex-bridge'],
    repoAccess: true,
    bridgeRepoAccess: true,
  });

  assert.match(prompt, /bridge repository is explicitly authorized by `\/yolo`/);
  assert.match(prompt, /directly modify its source files/);
  assert.match(prompt, /use the exact Bridge repository root below as the command workdir/);
  assert.match(prompt, /bridge has already resolved this path/);
  assert.match(prompt, /For every `exec_command` call, pass `login:false`/);
  assert.match(prompt, /Login-shell startup files on this host change the current directory/);
  assert.match(prompt, /Bridge repository root: \/tmp\/projects\/mobile-codex-bridge/);
});

test('buildBridgePrompt includes channel memory preferences when provided', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: 뉴스 정리해줘',
    todoContext: 'No channel TODO state.',
    channelMemoryContext: 'Channel memory preferences:\n- [pref-001] news: 논문 섹션 포함',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
  });

  assert.match(prompt, /Channel memory preferences:/);
  assert.match(prompt, /논문 섹션 포함/);
  assert.doesNotMatch(prompt, /Global memory:/);
});

test('buildBridgePrompt can direct final output to a parent channel message', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1', finalChannelId: 'channel-1' },
    threadContext: 'system: AI 아침 리포트',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects/.bridge_state/channel-1_common', '/tmp/projects/.bridge_state/channel-1/thread-1'],
    repoAccess: false,
  });

  assert.match(prompt, /post as a new message in Discord channel channel-1/);
  assert.match(prompt, /Repository access: disabled/);
  assert.match(prompt, /State access: current channel\/thread only/);
  assert.match(prompt, /Run non-code work from the current channel common state root/);
  assert.doesNotMatch(prompt, /post back to this Discord thread/);
});

test('buildBridgePrompt includes previous worker handoff context when provided', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1', id: 'job-a_continue_20260610100000' },
    threadContext: 'user: 계속해줘',
    jobHandoffContext: '# Previous Worker Handoff\n\nchecking files',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
  });

  assert.match(prompt, /Previous worker handoff context:/);
  assert.match(prompt, /checking files/);
  assert.match(prompt, /prior worker state/);
});

test('buildBridgePrompt includes active ask protocol when enabled', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: 구현해줘',
    activeAsksEnabled: true,
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
  });

  assert.match(prompt, /<bridge_wait_for_user>/);
  assert.match(prompt, /"question":"one concise question"/);
  assert.match(prompt, /Only use this when the task cannot proceed safely/);
});

test('buildBridgePrompt limits restart control blocks to runtime source changes', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: 서버 재부팅 해줘',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
  });

  assert.match(prompt, /authorizes explicit direct Discord restart requests from the original user message/);
  assert.match(prompt, /Never run kill, pkill, systemctl, a restart helper/);
  assert.match(prompt, /let the bridge restart coordinator perform the restart/);
  assert.match(prompt, /<bridge_restart_service>/);
  assert.match(prompt, /changed bridge runtime source files that the bridge will auto-restart to load/);
  assert.match(prompt, /reason and improvement must be written by you/);
  assert.match(prompt, /what behavior changed/);
  assert.match(prompt, /Never use a generic reason/);
  assert.match(prompt, /Include a normal user-facing completion summary before the final restart block/);
  assert.match(prompt, /stripped and ignored for manual restarts/);
});

test('buildBridgePrompt includes pending ask answer continuation context', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: {
      channelId: 'channel-1',
      threadId: 'thread-1',
      pendingAskAnswer: {
        askId: 'job-a_ask',
        askedJobId: 'job-a',
        answerMessageId: 'message-b',
        worker: 'claude',
        question: '배포 환경은?',
        answer: 'staging',
      },
    },
    threadContext: 'user: staging',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
  });

  assert.match(prompt, /Pending ask continuation context:/);
  assert.match(prompt, /askId: job-a_ask/);
  assert.match(prompt, /Question:\n배포 환경은\?/);
  assert.match(prompt, /User answer:\nstaging/);
});

test('buildBridgePrompt explains god state access when enabled', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: /god 전체 state 확인해줘',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects/.bridge_state/channel-1_common/workspace', '/tmp/projects/.bridge_state'],
    repoAccess: true,
    stateAccess: true,
  });

  assert.match(prompt, /God state access is enabled/);
  assert.match(prompt, /broader bridge state under the allowed local roots is available/);
  assert.match(prompt, /State access: all bridge state enabled/);
  assert.doesNotMatch(prompt, /Do not inspect sibling thread directories/);
});

test('buildBridgePrompt points workers at the host GitHub credential directory', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: 이 브랜치 푸시해줘',
    todoContext: 'Channel TODO state:\n- active item',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    githubCredentialDir: '/home/example-user/.config/gh',
    githubGitConfigGlobal: '/home/example-user/.gitconfig',
    githubAskPassPath: '/tmp/projects/mobile-codex-bridge/scripts/github-gh-askpass.sh',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
  });

  assert.match(prompt, /Host GitHub credential directory \(GH_CONFIG_DIR\): \/home\/example-user\/\.config\/gh/);
  assert.match(prompt, /Host Git global config \(GIT_CONFIG_GLOBAL\): \/home\/example-user\/\.gitconfig/);
  assert.match(prompt, /Host GitHub askpass helper \(GIT_ASKPASS\): \/tmp\/projects\/mobile-codex-bridge\/scripts\/github-gh-askpass\.sh/);
  assert.match(prompt, /bridge already exposes the host `gh` CLI login and a GitHub-only GIT_ASKPASS compatibility helper/);
  assert.match(prompt, /retry that same push exactly once/);
  assert.match(prompt, /Only if this retry also fails, run one `gh auth status` check/);
  assert.match(prompt, /do not start another credential-discovery path/);
});

test('buildBridgePrompt registers instruction-driven GitHub bug reporting', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: 이거 버그리포트해라',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects/.bridge_state/channel-1_common'],
    bugReportRepository: 'owner/mobile-codex-bridge',
  });

  assert.match(prompt, /bug reports are instruction-driven/);
  assert.match(prompt, /do not add or depend on a keyword\/regex detector/);
  assert.match(prompt, /create it as a GitHub issue in owner\/mobile-codex-bridge/);
  assert.match(prompt, /inspect open issues for a real duplicate/);
  assert.match(prompt, /return the issue URL/);
  assert.match(prompt, /Bridge bug-report GitHub repository: owner\/mobile-codex-bridge/);
  assert.doesNotMatch(prompt, /gh issue close/);
});

test('buildBridgePrompt requires pushed-commit link and issue close for repo issue work', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1' },
    threadContext: 'user: 이슈 #12 처리해라',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
    bugReportRepository: 'owner/mobile-codex-bridge',
  });

  assert.match(prompt, /the issue is the unit of work/);
  assert.match(prompt, /Never close an issue on intent alone/);
  assert.match(prompt, /pushed to its remote tracking branch/);
  assert.match(prompt, /https:\/\/github\.com\/owner\/mobile-codex-bridge\/commit\/<full-sha>/);
  assert.match(prompt, /gh issue close <number> --repo owner\/mobile-codex-bridge --reason completed/);
  assert.match(prompt, /leave the issue open and comment the concrete blocker/);
});

test('buildBridgePrompt leaves issue commit/close finalization to the bridge for maintenance jobs', () => {
  const prompt = buildBridgePrompt({
    ignoreBefore: new Date('2026-06-02T17:30:00.000Z'),
    job: { channelId: 'channel-1', threadId: 'thread-1', maintenance: true },
    threadContext: 'GitHub issue maintenance task.',
    todoContext: 'No channel TODO state.',
    projectRoot: '/tmp/projects',
    workingDir: '/tmp/projects/.bridge_state/channel-1_common/workspace',
    channelStateRoot: '/tmp/projects/.bridge_state/channel-1_common',
    channelArtifactRoot: '/tmp/projects/.bridge_state/channel-1_common/artifacts',
    threadStateRoot: '/tmp/projects/.bridge_state/channel-1/thread-1',
    allowedRoots: ['/tmp/projects'],
    repoAccess: true,
    bugReportRepository: 'owner/mobile-codex-bridge',
  });

  assert.match(prompt, /the bridge itself commits, pushes, comments the verified commit HEAD, and closes the issue/);
  assert.doesNotMatch(prompt, /gh issue close/);
});
