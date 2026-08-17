import assert from 'node:assert/strict';
import test from 'node:test';
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
  isStyleCommandRequest,
  parseStyleCommand,
  isCancelCommandRequest,
  formatThreadStatusSummary,
  formatBridgeHelpSummary,
  isQueueCommandRequest,
  isSupersedeCommandRequest,
  isSupersedeTaskRequest,
  isRebootRequest,
  isGitPollCommandRequest,
  isTodoListRequest,
  isVerboseCommandRequest,
  isUnfastCommandRequest,
  isYoloCommandRequest,
  isWebSearchRequest,
  formatUsageSummary,
  effortCommandSelectionFromContent,
  effortCommandSelectionSequenceFromContent,
  effortSelectionFromContent,
  effortSelectionSequenceFromContent,
  modelCommandSelectionSequenceFromContent,
  modelSelectionNumberFromContent,
  modelSelectionSequenceFromContent,
  parseJobStartCommands,
  parseModelEffortCommand,
  parseGitPollCommand,
  rebootReasonFromMessage,
  repoAccessDirectiveFromContent,
  repoRootDirectiveFromContent,
  stateAccessDirectiveFromContent,
  verboseDirectiveFromContent,
  yoloAccessDirectiveFromContent,
  isEffortCommandRequest,
  unknownBridgeCommandFromContent,
  BRIDGE_COMMAND_NAMES,
  BRIDGE_COMMAND_HELP,
  UNKNOWN_COMMAND_MESSAGE,
} from '../lib/bridge-commands.mjs';

test('isRebootRequest recognizes exact slash service reboot commands', () => {
  assert.equal(isRebootRequest('/reboot'), true);
  assert.equal(isRebootRequest('/restart'), true);
  assert.equal(isRebootRequest('/재부팅'), true);
  assert.equal(isRebootRequest('/재시작'), true);
});

test('isRebootRequest recognizes complete natural-language restart imperatives', () => {
  assert.equal(isRebootRequest('서버 재부팅 해줘'), true);
  assert.equal(isRebootRequest('bridge restart please'), true);
  assert.equal(isRebootRequest('please restart bridge'), true);
  assert.equal(isRebootRequest('서비스 재시작하자'), true);
  assert.equal(isRebootRequest('브릿지 재부팅 시도해줘'), true);
  assert.equal(isRebootRequest('/reboot now'), false);
  assert.equal(isRebootRequest('/restart please'), false);
});

test('isRebootRequest recognizes an explicit planned-restart title posted by a user', () => {
  assert.equal(isRebootRequest('【서비스 재시작】'), true);
  assert.equal(isRebootRequest('【codex gpt-5.6-terra xhigh: 서비스 재시작】'), true);
  assert.equal(isRebootRequest('【서비스 재시작 정책】'), false);
});

test('isRebootRequest ignores incidental mentions', () => {
  assert.equal(isRebootRequest('어제 재부팅 문제가 있었어'), false);
  assert.equal(isRebootRequest('재시작 됐으니까 고쳐라 큰 문제다'), false);
  assert.equal(isRebootRequest('일반 작업 해줘'), false);
  assert.equal(isRebootRequest('브릿지 재부팅이 필요한 경우, 모든 스레드 워커가 idle 할 때만 진행해'), false);
  assert.equal(isRebootRequest('reboot only if no worker is working'), false);
  assert.equal(isRebootRequest('서비스 재시작 정책을 고쳐줘'), false);
  assert.equal(isRebootRequest('재부팅 시도\n사유: 작업 중간 진행 업데이트가 안 보임'), false);
  assert.equal(isRebootRequest([
    '재부팅 시도',
    '사유: /yolo codex 로 호출했을 때, 중간에 뭘 하고 있는지 너무 감감무소식이다.',
    '중간중간 결과를 받을 수 있으면 클로드처럼 전달하게 해라.',
    '브릿지 재부팅이 필요한 경우, 모든 스레드 워커가 idle 할 때만 진행해',
    '개선: 사용자 요청에 따른 서비스 재시작 및 중단 작업 복구',
  ].join('\n')), false);
});

test('isTodoListRequest recognizes exact todo list commands', () => {
  assert.equal(isTodoListRequest('/할일'), true);
  assert.equal(isTodoListRequest(' /todo '), true);
  assert.equal(isTodoListRequest('/TODO'), true);
});

test('isTodoListRequest ignores non-command todo mentions', () => {
  assert.equal(isTodoListRequest('/todo 추가해'), false);
  assert.equal(isTodoListRequest('명령어 /todo 추가해'), false);
  assert.equal(isTodoListRequest('todo'), false);
});

test('isHelpCommandRequest recognizes only the exact help command', () => {
  assert.equal(isHelpCommandRequest('/help'), true);
  assert.equal(isHelpCommandRequest(' /HELP '), true);
  assert.equal(isHelpCommandRequest('/help commands'), false);
  assert.equal(isHelpCommandRequest('document /help'), false);
});

test('style command recognizes listing and direct number-or-id selection only', () => {
  assert.deepEqual(parseStyleCommand('/style'), { selector: null });
  assert.deepEqual(parseStyleCommand(' /STYLE 2 '), { selector: '2' });
  assert.deepEqual(parseStyleCommand('/style minimal-light'), { selector: 'minimal-light' });
  assert.deepEqual(parseStyleCommand('/style not a valid selector'), { selector: 'not a valid selector' });
  assert.equal(parseStyleCommand('please use /style 2'), null);
  assert.equal(isStyleCommandRequest('/style cyberpunk'), true);
  assert.equal(isControlOnlyCommandRequest('/style cyberpunk'), true);
  assert.equal(unknownBridgeCommandFromContent('/style'), null);
});

test('help catalog describes every registered command and adapts its prefix', () => {
  const documented = new Set(BRIDGE_COMMAND_HELP.flatMap((entry) => entry.names));
  assert.deepEqual([...documented].sort(), [...BRIDGE_COMMAND_NAMES].sort());

  const discordHelp = formatBridgeHelpSummary();
  assert.match(discordHelp, /^Bridge commands$/m);
  assert.match(discordHelp, /`\/help` — Show this command reference\./);
  assert.match(discordHelp, /`\/queue <task>` — Keep a task after earlier work/);
  assert.match(discordHelp, /`\/cancel` \(`\/stop`\) — Stop this thread/);
  assert.match(discordHelp, /`\/supersede <task>` — Explicitly mark a replacement task/);
  assert.match(discordHelp, /`\/style \[number-or-id\]` — Preview rendering themes/);

  const slackHelp = formatBridgeHelpSummary({ commandPrefix: '!' });
  assert.match(slackHelp, /`!help`/);
  assert.match(slackHelp, /`!stop`/);
  assert.ok(!slackHelp.includes('`/help`'));
});

test('isYoloCommandRequest recognizes only the exact yolo command', () => {
  assert.equal(isYoloCommandRequest('/yolo'), true);
  assert.equal(isYoloCommandRequest(' /YOLO '), true);
  assert.equal(isYoloCommandRequest('/yolo 작업해'), false);
  assert.equal(isYoloCommandRequest('명령어 /yolo 추가해'), false);
});

test('isGodCommandRequest recognizes only the exact god command', () => {
  assert.equal(isGodCommandRequest('/god'), true);
  assert.equal(isGodCommandRequest(' /GOD '), true);
  assert.equal(isGodCommandRequest('/god 작업해'), false);
  assert.equal(isGodCommandRequest('명령어 /god 추가해'), false);
});

test('isRepoCommandRequest recognizes only the exact repo command', () => {
  assert.equal(isRepoCommandRequest('/repo'), true);
  assert.equal(isRepoCommandRequest(' /REPO '), true);
  assert.equal(isRepoCommandRequest('/repo 작업해'), false);
  assert.equal(isRepoCommandRequest('명령어 /repo 추가해'), false);
});

test('isVerboseCommandRequest recognizes only the exact verbose command', () => {
  assert.equal(isVerboseCommandRequest('/verbose'), true);
  assert.equal(isVerboseCommandRequest(' /VERBOSE '), true);
  assert.equal(isVerboseCommandRequest('/verbose 작업해'), false);
  assert.equal(isVerboseCommandRequest('명령어 /verbose 추가해'), false);
});

test('isQuietCommandRequest recognizes only the exact quiet command', () => {
  assert.equal(isQuietCommandRequest('/quiet'), true);
  assert.equal(isQuietCommandRequest(' /QUIET '), true);
  assert.equal(isQuietCommandRequest('/quiet 작업해'), false);
  assert.equal(isQuietCommandRequest('명령어 /quiet 추가해'), false);
});

test('fast mode commands recognize only exact enable and disable controls', () => {
  assert.equal(isFastCommandRequest('/fast'), true);
  assert.equal(isFastCommandRequest(' /FAST '), true);
  assert.equal(isFastCommandRequest('/fast 작업해'), false);
  assert.equal(isFastCommandRequest('명령어 /fast 추가해'), false);
  assert.equal(isUnfastCommandRequest('/unfast'), true);
  assert.equal(isUnfastCommandRequest(' /UNFAST '), true);
  assert.equal(isUnfastCommandRequest('/unfast now'), false);
  assert.equal(isUnfastCommandRequest('명령어 /unfast 추가해'), false);
});

test('isModelCommandRequest recognizes bare, numeric, and named model commands', () => {
  assert.equal(isModelCommandRequest('/model'), true);
  assert.equal(isModelCommandRequest(' /MODEL '), true);
  assert.equal(isModelCommandRequest('/model 1'), true);
  assert.equal(isModelCommandRequest('/model 2 1 3'), true);
  assert.equal(isModelCommandRequest('/model 2, 1, 3'), true);
  assert.equal(isModelCommandRequest('/model sol'), true);
  assert.equal(isModelCommandRequest('/model sol opus terra'), true);
  assert.equal(isModelCommandRequest('/model abc'), true);
  assert.equal(isModelCommandRequest('명령어 /model 추가해'), false);
});

test('model selectors accept an explicit Claude account as part of the same selection', () => {
  assert.deepEqual(modelCommandSelectionSequenceFromContent('/model opus:primary'), ['opus:primary']);
  assert.deepEqual(modelSelectionSequenceFromContent('fable:primary opus:secondary'), ['fable:primary', 'opus:secondary']);
  assert.equal(isControlOnlyCommandRequest('/model opus:secondary'), true);
  assert.equal(isControlOnlyCommandRequest('/claude 0'), false);
});

test('a lone mistyped command is recognized instead of being dispatched as a task', () => {
  assert.equal(UNKNOWN_COMMAND_MESSAGE, 'No such command available.');
  assert.equal(unknownBridgeCommandFromContent('!yola'), '!yola');
  assert.equal(unknownBridgeCommandFromContent(' /yola '), '/yola');
  assert.equal(unknownBridgeCommandFromContent('!/yola'), '!/yola');
  assert.equal(unknownBridgeCommandFromContent('/YOLA'), '/YOLA');
  assert.equal(unknownBridgeCommandFromContent('/할일추가'), '/할일추가');
  assert.equal(isControlOnlyCommandRequest('!yola'), true);
});

test('unknown-command detection leaves real commands, tasks, and plain text alone', () => {
  for (const name of BRIDGE_COMMAND_NAMES) {
    assert.equal(unknownBridgeCommandFromContent(`/${name}`), null);
    assert.equal(unknownBridgeCommandFromContent(`!${name}`), null);
  }
  assert.equal(unknownBridgeCommandFromContent('/yola 버그 고쳐줘'), null);
  assert.equal(unknownBridgeCommandFromContent('!yola !yolo'), null);
  assert.equal(unknownBridgeCommandFromContent('`!yola`'), null);
  assert.equal(unknownBridgeCommandFromContent('/mnt/c/Users'), null);
  assert.equal(unknownBridgeCommandFromContent('!!!'), null);
  assert.equal(unknownBridgeCommandFromContent('버그 고쳐줘'), null);
  assert.equal(unknownBridgeCommandFromContent('2'), null);
  assert.equal(unknownBridgeCommandFromContent(''), null);
  assert.equal(isControlOnlyCommandRequest('/yola 버그 고쳐줘'), false);
});

test('isUsageCommandRequest recognizes the exact usage command and its shortened alias', () => {
  assert.equal(isUsageCommandRequest('/usage'), true);
  assert.equal(isUsageCommandRequest(' /USAGE '), true);
  assert.equal(isUsageCommandRequest('/u'), true);
  assert.equal(isUsageCommandRequest(' /U '), true);
  assert.equal(isUsageCommandRequest('/usage codex'), false);
  assert.equal(isUsageCommandRequest('/u codex'), false);
  assert.equal(isUsageCommandRequest('명령어 /usage 확인해'), false);
  assert.equal(isUsageCommandRequest('명령어 /u 확인해'), false);
});

test('isStatusCommandRequest recognizes the exact status command and its Korean alias', () => {
  assert.equal(isStatusCommandRequest('/status'), true);
  assert.equal(isStatusCommandRequest(' /STATUS '), true);
  assert.equal(isStatusCommandRequest('/상태'), true);
  assert.equal(isStatusCommandRequest('/status thread'), false);
  assert.equal(isStatusCommandRequest('/statusline'), false);
  assert.equal(isStatusCommandRequest('명령어 /status 확인해'), false);
  assert.equal(isControlOnlyCommandRequest('/status'), true);
  assert.equal(isControlOnlyCommandRequest('/상태'), true);
});

test('formatThreadStatusSummary lists only the controls this thread switched on', () => {
  const summary = formatThreadStatusSummary({
    repoAccess: true,
    repoPath: '/srv/workspace',
    bridgeRepoAccess: true,
    stateAccess: false,
    storedRepoAccess: true,
    globalRepoAccess: true,
    verboseProgress: false,
    codexFastMode: true,
    modelChain: [
      { label: 'Opus 5', effort: 'xhigh' },
      { label: 'Sol', effort: null },
    ],
    modelPinned: true,
    activeReservationCount: 2,
    activeGitPollLabel: 'origin/main (1m 간격)',
    pendingAsk: true,
  });

  assert.match(summary, /^이 스레드에 켜진 명령$/m);
  assert.match(summary, /`\/repo` 저장소 접근 — \/srv\/workspace — 이 스레드에서 지정/);
  assert.match(summary, /`\/yolo` 브리지 소스 직접 수정 — 전역 적용/);
  assert.match(summary, /`\/fast` Codex Fast service tier/);
  assert.match(summary, /`\/model` 실행 순서: Opus 5 \(xhigh\) → Sol/);
  assert.match(summary, /`\/reserve` 활성 예약 2건/);
  assert.match(summary, /`\/gitpoll` 활성 폴링: origin\/main \(1m 간격\)/);
  assert.match(summary, /답변 대기 중인 질문 있음/);

  // Controls left at their default must not appear at all: `/status` is this
  // thread's configuration, not a command catalog.
  for (const absent of ['`/god`', '`/verbose`', '`/quiet`', '`/effort`', '`/unfast`',
    '`/status`', '`/usage`', '`/todo`', '`/reserve list`', '`/gitpoll cancel`', '`/reboot`']) {
    assert.ok(!summary.includes(absent), `expected ${absent} to stay out of the status summary`);
  }
});

test('formatThreadStatusSummary reports an untouched thread as having nothing switched on', () => {
  const summary = formatThreadStatusSummary({}, { commandPrefix: '!' });

  assert.match(summary, /명시적으로 켠 명령이 없습니다/);
  assert.ok(!summary.includes('`!'), 'expected no command rows for a default thread');
  assert.ok(!summary.includes('꺼짐'), 'expected disabled controls to be omitted, not listed as off');
});

test('formatThreadStatusSummary renders Slack bang prefixes for enabled controls', () => {
  const summary = formatThreadStatusSummary({
    repoAccess: true,
    bridgeRepoAccess: true,
    storedRepoAccess: true,
    verboseProgress: true,
  }, { commandPrefix: '!' });

  assert.ok(summary.includes('`!yolo`'), 'expected bang-prefixed commands on Slack');
  assert.ok(summary.includes('`!verbose`'), 'expected bang-prefixed commands on Slack');
  assert.ok(!summary.includes('`/yolo`'), 'expected no slash-prefixed commands on Slack');
});

test('formatThreadStatusSummary omits an unpinned model chain but keeps a pinned one', () => {
  const chain = Array.from({ length: 8 }, (_, index) => ({ label: `m${index}`, effort: null }));

  const unpinned = formatThreadStatusSummary({ modelChain: chain });
  assert.ok(!unpinned.includes('m0'), 'expected the default fallback chain to be omitted');
  assert.match(unpinned, /명시적으로 켠 명령이 없습니다/);

  const pinned = formatThreadStatusSummary({ modelChain: chain, modelPinned: true });
  assert.match(pinned, /m0 → m1 → m2 → m3 → m4 … 외 3개/);
  assert.ok(!pinned.includes('m5 →'), 'expected chain entries past the limit to be omitted');
});

test('formatThreadStatusSummary labels an effort-only pin with the effort command', () => {
  const summary = formatThreadStatusSummary({
    modelChain: [{ label: 'Opus 5', effort: 'max' }],
    effortPinned: true,
  });

  assert.match(summary, /`\/effort` 실행 순서: Opus 5 \(max\)/);
  assert.ok(!summary.includes('`/model`'), 'expected no model row when only effort is pinned');
});

test('formatThreadStatusSummary distinguishes globally inherited repo access', () => {
  const inherited = formatThreadStatusSummary({
    repoAccess: true,
    repoPath: '/srv/workspace',
    globalRepoAccess: true,
    storedRepoAccess: false,
  });
  assert.match(inherited, /저장소 접근 — \/srv\/workspace — 전역 설정 상속/);

  const directive = formatThreadStatusSummary({ repoAccess: true, repoPath: '/srv/workspace' });
  assert.match(directive, /저장소 접근 — \/srv\/workspace — 이번 요청 지시/);
});

test('isReserveCommandRequest recognizes reserve control commands', () => {
  assert.equal(isReserveCommandRequest('/reserve --time 2607062130 --model 0 --order "continue"'), true);
  assert.equal(isReserveCommandRequest('/예약 --time 2607062130 --order "continue"'), true);
  assert.equal(isReserveCommandRequest('명령어 /reserve 추가해'), false);
});

test('modelSelectionNumberFromContent accepts numeric replies only', () => {
  assert.equal(modelSelectionNumberFromContent('1'), '1');
  assert.equal(modelSelectionNumberFromContent(' 12 '), '12');
  assert.equal(modelSelectionNumberFromContent('1번'), null);
  assert.equal(modelSelectionNumberFromContent('/model'), null);
});

test('modelSelectionSequenceFromContent parses numeric and named fallback sequences', () => {
  assert.deepEqual(modelSelectionSequenceFromContent('0'), ['0']);
  assert.deepEqual(modelSelectionSequenceFromContent('2'), ['2']);
  assert.deepEqual(modelSelectionSequenceFromContent('3 4 1'), ['3', '4', '1']);
  assert.deepEqual(modelSelectionSequenceFromContent(' 3,4 , 1 '), ['3', '4', '1']);
  assert.deepEqual(modelSelectionSequenceFromContent('sol terra'), ['sol', 'terra']);
  assert.deepEqual(modelSelectionSequenceFromContent('3 opus abc'), ['3', 'opus', 'abc']);
  assert.equal(modelSelectionSequenceFromContent('1번'), null);
  assert.equal(modelSelectionSequenceFromContent('/model'), null);
});

test('modelCommandSelectionSequenceFromContent parses inline model fallback sequences', () => {
  assert.deepEqual(modelCommandSelectionSequenceFromContent('/model 0'), ['0']);
  assert.deepEqual(modelCommandSelectionSequenceFromContent('/model 2'), ['2']);
  assert.deepEqual(modelCommandSelectionSequenceFromContent('/model 2 1 3'), ['2', '1', '3']);
  assert.deepEqual(modelCommandSelectionSequenceFromContent(' /MODEL 2, 1, 3 '), ['2', '1', '3']);
  assert.equal(modelCommandSelectionSequenceFromContent('/model'), null);
  assert.deepEqual(modelCommandSelectionSequenceFromContent('/model sol opus terra'), ['sol', 'opus', 'terra']);
  assert.deepEqual(modelCommandSelectionSequenceFromContent('/model abc'), ['abc']);
  assert.equal(modelCommandSelectionSequenceFromContent('명령어 /model 1 추가해'), null);
});

test('parseModelEffortCommand accepts only a complete, whole-message command pair', () => {
  assert.deepEqual(parseModelEffortCommand('/model sol /effort max'), {
    modelSelectors: ['sol'],
    effortSelectors: ['max'],
  });
  assert.deepEqual(parseModelEffortCommand('/model sol terra opus /effort max xhigh low'), {
    modelSelectors: ['sol', 'terra', 'opus'],
    effortSelectors: ['max', 'xhigh', 'low'],
  });
  assert.deepEqual(parseModelEffortCommand(' /MODEL sol, terra, opus /EFFORT max, xhigh, low '), {
    modelSelectors: ['sol', 'terra', 'opus'],
    effortSelectors: ['max', 'xhigh', 'low'],
  });
  assert.equal(parseModelEffortCommand('we have `/model` function and blah blah...'), null);
  assert.equal(parseModelEffortCommand('설명: /model sol /effort max'), null);
  assert.equal(parseModelEffortCommand('/model sol /effort'), null);
  assert.equal(parseModelEffortCommand('/model /effort max'), null);
  assert.equal(parseModelEffortCommand('/model sol /effort max /usage'), null);
});

test('parseJobStartCommands extracts complete controls from a task before it starts', () => {
  assert.deepEqual(
    parseJobStartCommands(
      'Fix the bridge race /yolo /model sol terra opus /effort max xhigh low /repo',
    ),
    {
      commands: ['yolo', 'model', 'effort', 'repo'],
      modelSelectors: ['sol', 'terra', 'opus'],
      effortSelectors: ['max', 'xhigh', 'low'],
      parameterCommandsComplete: true,
      taskContent: 'Fix the bridge race',
      contentWithoutAccessCommands:
        'Fix the bridge race /model sol terra opus /effort max xhigh low',
    },
  );
  assert.deepEqual(
    parseJobStartCommands('/supersede Rework the parser /yolo'),
    {
      commands: ['supersede', 'yolo'],
      modelSelectors: null,
      effortSelectors: null,
      parameterCommandsComplete: true,
      taskContent: 'Rework the parser',
      contentWithoutAccessCommands: 'Rework the parser',
    },
  );
  assert.deepEqual(
    parseJobStartCommands('Run tests /effort max /model sol /repo mobile-codex-bridge'),
    {
      commands: ['effort', 'model', 'repo'],
      modelSelectors: ['sol'],
      effortSelectors: ['max'],
      parameterCommandsComplete: true,
      taskContent: 'Run tests mobile-codex-bridge',
      contentWithoutAccessCommands: 'Run tests /effort max /model sol mobile-codex-bridge',
    },
  );
  assert.deepEqual(
    parseJobStartCommands(
      'Review it /yolo /model sol /model terra opus /effort max /effort xhigh low /yolo',
    ),
    {
      commands: ['yolo', 'model', 'model', 'effort', 'effort', 'yolo'],
      modelSelectors: ['sol', 'terra', 'opus'],
      effortSelectors: ['max', 'xhigh', 'low'],
      parameterCommandsComplete: true,
      taskContent: 'Review it',
      contentWithoutAccessCommands:
        'Review it /model sol /model terra opus /effort max /effort xhigh low',
    },
  );
  assert.deepEqual(
    parseJobStartCommands('/queue Publish the command help'),
    {
      commands: ['queue'],
      modelSelectors: null,
      effortSelectors: null,
      parameterCommandsComplete: true,
      taskContent: 'Publish the command help',
      contentWithoutAccessCommands: 'Publish the command help',
    },
  );
});

test('parseJobStartCommands keeps incomplete pairs inert and ignores quoted command names', () => {
  assert.deepEqual(
    parseJobStartCommands('Fix the bridge /yolo /model sol /effort /repo'),
    {
      commands: ['yolo', 'model', 'effort', 'repo'],
      modelSelectors: null,
      effortSelectors: null,
      parameterCommandsComplete: false,
      taskContent: 'Fix the bridge /model sol /effort',
      contentWithoutAccessCommands: 'Fix the bridge /model sol /effort',
    },
  );
  assert.equal(
    parseJobStartCommands('we have `/model` function and blah blah...'),
    null,
  );
  assert.equal(
    parseJobStartCommands('document this:\n```\n/model sol /effort max\n```'),
    null,
  );
});

test('isQueueCommandRequest recognizes queue directives on slash commands', () => {
  assert.equal(isQueueCommandRequest('/queue 이어서 처리해'), true);
  assert.equal(isQueueCommandRequest('/QUEUE'), true);
  assert.equal(isQueueCommandRequest('/enqueue after current job'), true);
  assert.equal(isQueueCommandRequest('/yolo queue 이어서 처리해'), true);
  assert.equal(isQueueCommandRequest('명령어 /queue 추가해'), true);
});

test('isQueueCommandRequest ignores non-command queue mentions', () => {
  assert.equal(isQueueCommandRequest('queue 구조 설명해줘'), false);
  assert.equal(isQueueCommandRequest('현재 작업 큐 상태 알려줘'), false);
  assert.equal(isQueueCommandRequest('/yolo 이어서 처리해'), false);
});

test('isSupersedeCommandRequest recognizes explicit directives outside Markdown code', () => {
  assert.equal(isSupersedeCommandRequest('/supersede Rework the parser'), true);
  assert.equal(isSupersedeCommandRequest('/yolo /supersede Rework the parser'), true);
  assert.equal(isSupersedeCommandRequest('document `/supersede` without running it'), false);
  assert.equal(isSupersedeCommandRequest('keep earlier work queued'), false);
});

test('isSupersedeTaskRequest recognizes a directive paired with a task', () => {
  assert.equal(isSupersedeTaskRequest('/supersede Rework the parser'), true);
  assert.equal(isSupersedeTaskRequest('Rework the parser /supersede'), true);
  assert.equal(isSupersedeTaskRequest('/supersede'), false);
  assert.equal(isSupersedeTaskRequest('document `/supersede`'), false);
});

test('isCancelCommandRequest recognizes only the dedicated queue-clearing controls', () => {
  assert.equal(isCancelCommandRequest('/cancel'), true);
  assert.equal(isCancelCommandRequest(' /STOP '), true);
  assert.equal(isCancelCommandRequest('/cancel the parser'), false);
  assert.equal(isCancelCommandRequest('mention /stop in docs'), false);
});

test('verboseDirectiveFromContent recognizes explicit verbose requests only', () => {
  assert.equal(verboseDirectiveFromContent('/verbose'), true);
  assert.equal(verboseDirectiveFromContent('/yolo /verbose 브릿지 고쳐줘'), true);
  assert.equal(verboseDirectiveFromContent('/verbose, 브릿지 고쳐줘'), true);
  assert.equal(verboseDirectiveFromContent('verbose하게 설명해줘'), false);
  assert.equal(verboseDirectiveFromContent('명령어 /verbose 추가해'), false);
  assert.equal(verboseDirectiveFromContent('`/verbose` 없으면 요약해'), false);
});

test('parseGitPollCommand parses polling options and continuation task', () => {
  assert.deepEqual(parseGitPollCommand('/gitpoll interval=1m timeout=6h path=example-repo -- 검증 이어서'), {
    action: 'start',
    intervalMs: 60_000,
    timeoutMs: 6 * 60 * 60_000,
    startAfterMs: null,
    repoPath: 'example-repo',
    remote: null,
    branch: null,
    task: '검증 이어서',
  });
  assert.deepEqual(parseGitPollCommand('/깃폴링 주기=30초 기간=2시간 레포=repo-a -- pull 뒤 테스트'), {
    action: 'start',
    intervalMs: 30_000,
    timeoutMs: 2 * 60 * 60_000,
    startAfterMs: null,
    repoPath: 'repo-a',
    remote: null,
    branch: null,
    task: 'pull 뒤 테스트',
  });
  assert.deepEqual(parseGitPollCommand('/gitpoll cancel'), { action: 'cancel' });
  assert.equal(parseGitPollCommand('gitpoll interval=1m'), null);
});

test('parseGitPollCommand parses edit and natural timing instructions', () => {
  assert.deepEqual(parseGitPollCommand('/gitpoll -e 6시간 후부터 폴링 시작해서 6시간 timeout'), {
    action: 'edit',
    intervalMs: null,
    timeoutMs: 6 * 60 * 60_000,
    startAfterMs: 6 * 60 * 60_000,
    repoPath: null,
    remote: null,
    branch: null,
    task: '',
  });
  assert.deepEqual(parseGitPollCommand('/gitpoll start=30m interval=1m timeout=6h path=repo-a -- continue work'), {
    action: 'start',
    intervalMs: 60_000,
    timeoutMs: 6 * 60 * 60_000,
    startAfterMs: 30 * 60_000,
    repoPath: 'repo-a',
    remote: null,
    branch: null,
    task: 'continue work',
  });
});

test('isGitPollCommandRequest recognizes git polling control commands', () => {
  assert.equal(isGitPollCommandRequest('/gitpoll interval=1m -- continue'), true);
  assert.equal(isGitPollCommandRequest('/gitpoll -e 6시간 후부터 6시간 timeout'), true);
  assert.equal(isGitPollCommandRequest('/git-poll cancel'), true);
  assert.equal(isGitPollCommandRequest('git polling 해줘'), false);
});

test('isControlOnlyCommandRequest treats controls and direct reboot requests as non-job actions', () => {
  assert.equal(isControlOnlyCommandRequest('/yolo'), true);
  assert.equal(isControlOnlyCommandRequest('/god'), true);
  assert.equal(isControlOnlyCommandRequest('/repo'), true);
  assert.equal(isControlOnlyCommandRequest('/verbose'), true);
  assert.equal(isControlOnlyCommandRequest('/quiet'), true);
  assert.equal(isControlOnlyCommandRequest('/fast'), true);
  assert.equal(isControlOnlyCommandRequest('/unfast'), true);
  assert.equal(isControlOnlyCommandRequest('/model'), true);
  assert.equal(isControlOnlyCommandRequest('/model 2 1 3'), true);
  assert.equal(isControlOnlyCommandRequest('/model sol opus terra'), true);
  assert.equal(isControlOnlyCommandRequest('/model sol /effort max'), true);
  assert.equal(isControlOnlyCommandRequest('/model sol terra opus /effort max xhigh low'), true);
  assert.equal(isControlOnlyCommandRequest('/yolo /model sol /effort max /repo'), true);
  assert.equal(isControlOnlyCommandRequest('작업해 /yolo /model sol /effort max /repo'), false);
  assert.equal(isControlOnlyCommandRequest('/yolo /model sol /effort /repo'), false);
  assert.equal(isControlOnlyCommandRequest('/usage'), true);
  assert.equal(isControlOnlyCommandRequest('/u'), true);
  assert.equal(isControlOnlyCommandRequest('/help'), true);
  assert.equal(isControlOnlyCommandRequest('/effort'), true);
  assert.equal(isControlOnlyCommandRequest('/effort max'), true);
  assert.equal(isControlOnlyCommandRequest('/effort max xhigh low'), true);
  assert.equal(isControlOnlyCommandRequest('/gitpoll interval=1m -- continue'), true);
  assert.equal(isControlOnlyCommandRequest('/reserve --time 2607062130 --model 0 --order "continue"'), true);
  assert.equal(isControlOnlyCommandRequest('/cancel'), true);
  assert.equal(isControlOnlyCommandRequest('/stop'), true);
  assert.equal(isControlOnlyCommandRequest('/supersede'), true);
  assert.equal(isControlOnlyCommandRequest('/queue'), true);
  assert.equal(isControlOnlyCommandRequest('/queue 이어서 진행해'), false);
  assert.equal(isControlOnlyCommandRequest('/god 이어서 진행해'), false);
  assert.equal(isControlOnlyCommandRequest('/repo 이어서 진행해'), false);
  assert.equal(isControlOnlyCommandRequest('서버 재부팅 해줘'), true);
  assert.equal(isControlOnlyCommandRequest([
    '재부팅 시도',
    '사유: /yolo codex 로 호출했을 때 진행 상황을 중간중간 전달하게 해라.',
    '브릿지 재부팅이 필요한 경우 모든 스레드 워커가 idle 할 때만 진행해',
  ].join('\n')), false);
});

test('formatUsageSummary prints quota for each account', () => {
  const text = formatUsageSummary({
    usage: {
      codexRemainingQuota: 120,
      claudeRemainingQuota: 0,
      geminiRemainingQuota: null,
    },
  });

  assert.ok(text.includes('- CODEX: 120회 (환경변수 CODEX_QUOTA_REMAINING)'));
  assert.ok(text.includes('- CLAUDE: 0회 (환경변수 CLAUDE_QUOTA_REMAINING)'));
  assert.ok(text.includes('- GEMINI: 미설정 (환경변수 GEMINI_QUOTA_REMAINING)'));
});

test('isWebSearchRequest recognizes quote and verification work', () => {
  assert.equal(isWebSearchRequest('명언을 366개 찾아. 반드시 존재해야해.'), true);
  assert.equal(isWebSearchRequest('latest AI news with sources'), true);
  assert.equal(isWebSearchRequest('이 로컬 테스트 실패 원인 분석해'), false);
});

test('rebootReasonFromMessage returns bounded reason text', () => {
  const reason = rebootReasonFromMessage({ content: 'x'.repeat(300) });

  assert.equal(reason.length, 180);
  assert.match(reason, /\.\.\.$/);
});

test('access directives grant repo access for yolo and god, state access only for god', () => {
  assert.equal(repoAccessDirectiveFromContent('/yolo'), true);
  assert.equal(repoAccessDirectiveFromContent('/yolo 브릿지 코드 고쳐줘'), true);
  assert.equal(repoAccessDirectiveFromContent('/god bridge state 확인해줘'), true);
  assert.equal(repoAccessDirectiveFromContent('/repo ixiparser 확인해줘'), true);
  assert.equal(yoloAccessDirectiveFromContent('/yolo 브릿지 코드 고쳐줘'), true);
  assert.equal(yoloAccessDirectiveFromContent('/god bridge state 확인해줘'), null);
  assert.equal(yoloAccessDirectiveFromContent('/repo ixiparser 확인해줘'), null);
  assert.equal(repoRootDirectiveFromContent('/repo ixiparser 확인해줘'), true);
  assert.equal(repoRootDirectiveFromContent('/yolo ixiparser 확인해줘'), null);
  assert.equal(stateAccessDirectiveFromContent('/yolo 브릿지 코드 고쳐줘'), null);
  assert.equal(stateAccessDirectiveFromContent('/god bridge state 확인해줘'), true);
  assert.equal(repoAccessDirectiveFromContent('repoaccess=True, 이어서'), null);
  assert.equal(repoAccessDirectiveFromContent('repo access: enabled'), null);
  assert.equal(repoAccessDirectiveFromContent('브릿지 코드 고쳐줘'), null);
  assert.equal(stateAccessDirectiveFromContent('bridge state 확인해줘'), null);
});

test('effort commands accept direct numeric and named selections', () => {
  assert.equal(isEffortCommandRequest('/effort'), true);
  assert.equal(isEffortCommandRequest(' /EFFORT '), true);
  assert.equal(isEffortCommandRequest('/effort 6'), true);
  assert.equal(isEffortCommandRequest('/effort high'), true);
  assert.equal(isEffortCommandRequest('/effort max'), true);
  assert.equal(isEffortCommandRequest('/effort max xhigh low'), true);
  assert.equal(isEffortCommandRequest('/effort max now'), false);
  assert.equal(effortCommandSelectionFromContent('/effort 6'), '6');
  assert.equal(effortCommandSelectionFromContent('/EFFORT MAX'), 'max');
  assert.equal(effortCommandSelectionFromContent('/effort max xhigh'), null);
  assert.equal(effortCommandSelectionFromContent('/effort'), null);
  assert.deepEqual(effortCommandSelectionSequenceFromContent('/effort max xhigh low'), ['max', 'xhigh', 'low']);
  assert.equal(effortCommandSelectionSequenceFromContent('/effort max now'), null);
  assert.deepEqual(effortSelectionSequenceFromContent(' MAX, xhigh, low '), ['max', 'xhigh', 'low']);
  assert.equal(effortSelectionFromContent(' XHIGH '), 'xhigh');
  assert.equal(effortSelectionFromContent('max now'), null);
});
