// Every control the bridge understands, in both spellings a user can type: the
// Slack bang form and the Discord slash form. Single source of truth for two
// consumers — the Slack bang-to-slash translation in slack-message, and the
// unknown-command guard below. A new command must be listed here, or it stays
// untranslated on Slack and gets answered as a typo.
//
// Command catalog contract: whenever a command is added here, add every one of
// its spellings and a user-facing description to BRIDGE_COMMAND_HELP below.
// `/help` renders that catalog, and its coverage is enforced by tests.
export const BRIDGE_COMMAND_NAMES = new Set([
  'cancel',
  'effort',
  'fast',
  'git-poll',
  'git_poll',
  'gitpoll',
  'god',
  'help',
  'model',
  'queue',
  'quiet',
  'reboot',
  'repo',
  'reserve',
  'restart',
  'status',
  'stop',
  'style',
  'supersede',
  'todo',
  'todoadd',
  'tododone',
  'todoremove',
  'u',
  'unfast',
  'usage',
  'verbose',
  'yolo',
  '깃폴',
  '깃폴링',
  '상태',
  '예약',
  '재부팅',
  '재시작',
  '할일',
]);

export const UNKNOWN_COMMAND_MESSAGE = 'No such command available.';

// Keep the descriptions concise enough for a Discord/Slack message. The
// `names` field contains every spelling registered above, while `usage` is the
// primary form shown in `/help`.
export const BRIDGE_COMMAND_HELP = Object.freeze([
  {
    usage: 'help',
    names: ['help'],
    description: 'Show this command reference.',
  },
  {
    usage: 'queue <task>',
    names: ['queue'],
    description: 'Keep a task after earlier work in this thread. Without it, a new task replaces earlier work.',
  },
  {
    usage: 'supersede <task>',
    names: ['supersede'],
    description: 'Explicitly mark a replacement task. This is the default behavior without `/queue`. Alone, it does nothing.',
  },
  {
    usage: 'cancel',
    names: ['cancel', 'stop'],
    aliases: ['stop'],
    description: 'Stop this thread\'s running workers and clear its queue.',
  },
  {
    usage: 'status',
    names: ['status', '상태'],
    aliases: ['상태'],
    description: 'Show controls currently enabled for this thread.',
  },
  {
    usage: 'model [selector ...]',
    names: ['model'],
    description: 'List models or pin a model/fallback chain for this thread.',
  },
  {
    usage: 'effort [level ...]',
    names: ['effort'],
    description: 'Set reasoning effort for the selected model chain.',
  },
  {
    usage: 'style [number-or-id]',
    names: ['style'],
    description: 'Preview rendering themes or select one for this thread.',
  },
  {
    usage: 'fast',
    names: ['fast'],
    description: 'Use the Codex Fast service tier in this thread.',
  },
  {
    usage: 'unfast',
    names: ['unfast'],
    description: 'Return this thread to the standard Codex service tier.',
  },
  {
    usage: 'verbose',
    names: ['verbose'],
    description: 'Include raw command progress in worker updates.',
  },
  {
    usage: 'quiet',
    names: ['quiet'],
    description: 'Hide raw command progress and keep updates concise.',
  },
  {
    usage: 'repo',
    names: ['repo'],
    description: 'Set this thread\'s repository root under the bridge repository area.',
  },
  {
    usage: 'yolo',
    names: ['yolo'],
    description: 'Enable persistent direct write access to the bridge repository.',
  },
  {
    usage: 'god <task>',
    names: ['god'],
    description: 'Give one task full channel and thread state access.',
  },
  {
    usage: 'usage',
    names: ['usage', 'u'],
    aliases: ['u'],
    description: 'Show cached worker quota and availability information.',
  },
  {
    usage: 'todo',
    names: ['todo', 'todoadd', 'tododone', 'todoremove', '할일'],
    aliases: ['할일', 'todoadd', 'tododone', 'todoremove'],
    description: 'List TODOs, or add, complete, and remove TODOs with its subcommands.',
  },
  {
    usage: 'reserve [options]',
    names: ['reserve', '예약'],
    aliases: ['예약'],
    description: 'Schedule a future bridge command; it also supports list and cancel.',
  },
  {
    usage: 'gitpoll [options] -- <task>',
    names: ['gitpoll', 'git-poll', 'git_poll', '깃폴', '깃폴링'],
    aliases: ['git-poll', 'git_poll', '깃폴', '깃폴링'],
    description: 'Wait for a remote branch update, pull it, then run the continuation task.',
  },
  {
    usage: 'reboot',
    names: ['reboot', 'restart', '재부팅', '재시작'],
    aliases: ['restart', '재부팅', '재시작'],
    description: 'Request a bridge service restart.',
  },
]);

export function formatBridgeHelpSummary({ commandPrefix = '/' } = {}) {
  const prefix = commandPrefix === '!' ? '!' : '/';
  const command = (usage) => `\`${prefix}${usage}\``;
  const lines = ['Bridge commands', ''];
  for (const entry of BRIDGE_COMMAND_HELP) {
    const aliases = (entry.aliases || []).map((alias) => command(alias));
    lines.push(`- ${command(entry.usage)}${aliases.length ? ` (${aliases.join(', ')})` : ''} — ${entry.description}`);
  }
  lines.push('', 'Use the command prefix at the start or end of a task where its description allows it.');
  return lines.join('\n');
}

const LONE_COMMAND_PATTERN = /^[!/]\/?([\p{L}\p{N}][\p{L}\p{N}_-]*)$/u;

// A message that is nothing but a mistyped control (`!yola`) used to reach a
// worker as if it were a task, spending a whole job on a typo. Recognize it here
// so dispatch can answer with one fixed line instead. Only a lone token counts:
// `/yola fix the bug` still runs as a task, because the words after the typo are
// real work. Punctuation-only text (`!!!`) and paths (`/tmp/x`) are not commands.
export function unknownBridgeCommandFromContent(content) {
  const text = normalize(content);
  const match = text.match(LONE_COMMAND_PATTERN);
  if (!match) return null;
  return BRIDGE_COMMAND_NAMES.has(match[1].toLowerCase()) ? null : text;
}

export function isRebootRequest(content) {
  const text = normalize(content);
  if (!text) return false;

  if (/^\/(?:reboot|restart|재부팅|재시작)$/i.test(text)) return true;
  return isExplicitNaturalLanguageRebootRequest(text);
}

// Restarting the bridge is disruptive, so natural-language handling deliberately
// accepts only a complete, unambiguous imperative.  This reads the whole
// message rather than treating an incidental "restart" word as authorization.
function isExplicitNaturalLanguageRebootRequest(text) {
  // The planned-restart notice is also a concise, unambiguous command when a
  // Discord user posts it directly (for example after copying the visible
  // title).  Message authorship is already checked before this command router
  // runs, so bridge-authored notices cannot recursively request a restart.
  const restartTitle = /^【(?:(?:[^【】\n:]+?)\s*:\s*)?서비스\s*(?:재시작|재부팅)】$/u;
  if (restartTitle.test(text)) return true;

  const koreanRequest = /^(?:(?:지금|즉시|바로)\s*)?(?:(?:디스코드\s*)?(?:브리지|브릿지|서비스|서버)\s*(?:를|을)?\s*)?(?:재시작|재부팅)\s*(?:해\s*줘|해\s*주세요|해주세요|해라|해\s*라|해\s*주십시오|해주십시오|해\s*주시겠어요|해주시겠어요|해\s*줄래|해줄래|부탁(?:해|드립니다)|진행(?:해|해주세요)|실행(?:해|해주세요)|시도해줘|시도\s*해줘|하자)\s*[.!]?$/iu;
  if (koreanRequest.test(text)) return true;

  return /^(?:please\s+)?(?:restart|reboot)\s+(?:the\s+)?(?:discord\s+)?(?:bridge|service|server)(?:\s+(?:now|please))?[.!]?$/i.test(text)
    || /^(?:please\s+)?(?:the\s+)?(?:discord\s+)?(?:bridge|service|server)\s+(?:restart|reboot)(?:\s+(?:now|please))?[.!]?$/i.test(text);
}

export function isTodoListRequest(content) {
  const text = normalize(content);
  return /^\/(?:todo|할일)$/i.test(text);
}

export function isYoloCommandRequest(content) {
  const text = normalize(content);
  return /^\/yolo$/i.test(text);
}

export function isGodCommandRequest(content) {
  const text = normalize(content);
  return /^\/god$/i.test(text);
}

export function isRepoCommandRequest(content) {
  const text = normalize(content);
  return /^\/repo$/i.test(text);
}

export function isVerboseCommandRequest(content) {
  const text = normalize(content);
  return /^\/verbose$/i.test(text);
}

export function isQuietCommandRequest(content) {
  const text = normalize(content);
  return /^\/quiet$/i.test(text);
}

export function isFastCommandRequest(content) {
  const text = normalize(content);
  return /^\/fast$/i.test(text);
}

export function isUnfastCommandRequest(content) {
  const text = normalize(content);
  return /^\/unfast$/i.test(text);
}

export function isModelCommandRequest(content) {
  const text = normalize(content);
  return /^\/model$/i.test(text) || modelCommandSelectionSequenceFromContent(text) !== null;
}

export function isUsageCommandRequest(content) {
  const text = normalize(content);
  return /^\/(?:usage|u)$/i.test(text);
}

export function parseStyleCommand(content) {
  const text = normalize(content);
  const match = text.match(/^\/style(?:\s+(.*))?$/i);
  if (!match) return null;
  return {
    selector: String(match[1] || '').trim() || null,
  };
}

export function isStyleCommandRequest(content) {
  return parseStyleCommand(content) !== null;
}

export function isHelpCommandRequest(content) {
  const text = normalize(content);
  return /^\/help$/i.test(text);
}

export function isStatusCommandRequest(content) {
  const text = normalize(content);
  return /^\/(?:status|상태)$/i.test(text);
}

// These commands intentionally have no arguments. A cancellation should be a
// deliberate control action, not an incidental `/stop` word inside a task.
export function isCancelCommandRequest(content) {
  const text = normalize(content);
  return /^\/(?:cancel|stop)$/i.test(text);
}

export function isGitPollCommandRequest(content) {
  return parseGitPollCommand(content) !== null;
}

export function isReserveCommandRequest(content) {
  const text = normalize(content);
  return /^\/(?:reserve|예약)(?:\s|$)/i.test(text);
}

export function parseGitPollCommand(content) {
  const text = normalize(content);
  const match = text.match(/^\/(?:gitpoll|git-poll|git_poll|깃폴|깃폴링)(?:\s+(.+))?$/i);
  if (!match) return null;

  let body = String(match[1] || '').trim();
  if (/^(?:cancel|stop|취소|중지)$/i.test(body)) return { action: 'cancel' };
  let action = 'start';
  const editMatch = body.match(/^(?:-e|--edit|edit|수정)(?:\s+(.+))?$/i);
  if (editMatch) {
    action = 'edit';
    body = String(editMatch[1] || '').trim();
  }

  const separatorIndex = body.indexOf('--');
  const optionsText = separatorIndex === -1 ? body : body.slice(0, separatorIndex).trim();
  const taskText = separatorIndex === -1 ? '' : body.slice(separatorIndex + 2).trim();
  const options = {};
  const taskTokens = [];

  for (const token of optionsText.split(/\s+/).filter(Boolean)) {
    const option = parseGitPollOption(token);
    if (option) options[option.key] = option.value;
    else taskTokens.push(token);
  }

  const natural = parseGitPollNaturalOptions(taskTokens.join(' '));
  for (const [key, value] of Object.entries(natural.options)) {
    if (options[key] == null) options[key] = value;
  }

  return {
    action,
    intervalMs: options.intervalMs ?? null,
    timeoutMs: options.timeoutMs ?? null,
    startAfterMs: options.startAfterMs ?? null,
    repoPath: options.repoPath || null,
    remote: options.remote || null,
    branch: options.branch || null,
    task: (taskText || natural.taskText).trim(),
  };
}

function parseGitPollOption(token) {
  const match = String(token || '').match(/^([A-Za-z가-힣_-]+)=(.+)$/);
  if (!match) return null;
  const key = match[1].toLowerCase();
  const rawValue = match[2].trim();
  if (!rawValue) return null;

  if (['interval', 'every', '주기'].includes(key)) {
    const intervalMs = parseHumanDurationMs(rawValue);
    return intervalMs ? { key: 'intervalMs', value: intervalMs } : null;
  }
  if (['timeout', 'for', '대기', '기간'].includes(key)) {
    const timeoutMs = parseHumanDurationMs(rawValue);
    return timeoutMs ? { key: 'timeoutMs', value: timeoutMs } : null;
  }
  if (['start', 'startafter', 'start-after', 'delay', 'after', '시작', '지연', '후'].includes(key)) {
    const startAfterMs = parseHumanDurationMs(rawValue);
    return startAfterMs ? { key: 'startAfterMs', value: startAfterMs } : null;
  }
  if (['path', 'repo', 'repository', '레포'].includes(key)) {
    return { key: 'repoPath', value: rawValue };
  }
  if (key === 'remote') return { key: 'remote', value: rawValue };
  if (key === 'branch') return { key: 'branch', value: rawValue };
  return null;
}

function parseGitPollNaturalOptions(text) {
  let taskText = String(text || '').trim();
  const options = {};
  const duration = '(\\d+(?:\\.\\d+)?\\s*(?:ms|s|sec|secs|second|seconds|초|m|min|mins|minute|minutes|분|h|hr|hrs|hour|hours|시간|d|day|days|일))';
  const consume = (pattern, key, valueIndex = 1) => {
    taskText = taskText.replace(pattern, (...args) => {
      const rawValue = args[valueIndex];
      const parsed = parseHumanDurationMs(rawValue);
      if (parsed && options[key] == null) options[key] = parsed;
      return ' ';
    });
  };

  consume(new RegExp(`${duration}\\s*(?:후|뒤)(?:부터)?`, 'ig'), 'startAfterMs');
  consume(new RegExp(`${duration}\\s*(?:timeout|타임아웃)`, 'ig'), 'timeoutMs');
  consume(new RegExp(`(?:timeout|타임아웃|대기|기간)\\s*(?:=|:)?\\s*${duration}`, 'ig'), 'timeoutMs');
  consume(new RegExp(`${duration}\\s*(?:마다|간격|주기)`, 'ig'), 'intervalMs');
  consume(new RegExp(`(?:interval|every|주기|간격)\\s*(?:=|:)?\\s*${duration}`, 'ig'), 'intervalMs');

  taskText = taskText
    .replace(/\b(?:polling|start|after|timeout|interval|every)\b/ig, ' ')
    .replace(/(?:폴링|시작해서|시작|부터|후|뒤|타임아웃|대기|기간|주기|간격|마다|으로|로|해서|하고)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { options, taskText };
}

function parseHumanDurationMs(value) {
  const match = String(value || '').trim().replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)(ms|s|sec|secs|second|seconds|초|m|min|mins|minute|minutes|분|h|hr|hrs|hour|hours|시간|d|day|days|일)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'ms') return Math.round(amount);
  if (['s', 'sec', 'secs', 'second', 'seconds', '초'].includes(unit)) return Math.round(amount * 1_000);
  if (['m', 'min', 'mins', 'minute', 'minutes', '분'].includes(unit)) return Math.round(amount * 60_000);
  if (['h', 'hr', 'hrs', 'hour', 'hours', '시간'].includes(unit)) return Math.round(amount * 60 * 60_000);
  if (['d', 'day', 'days', '일'].includes(unit)) return Math.round(amount * 24 * 60 * 60_000);
  return null;
}

export function formatUsageSummary(config = {}) {
  const usage = config?.usage || {};
  const entries = [
    ['CODEX', usage.codexRemainingQuota, 'CODEX_QUOTA_REMAINING'],
    ['CLAUDE', usage.claudeRemainingQuota, 'CLAUDE_QUOTA_REMAINING'],
    ['GEMINI', usage.geminiRemainingQuota, 'GEMINI_QUOTA_REMAINING'],
  ];
  const lines = ['남은 쿼터 요약 (API 호출 없음):'];
  for (const [label, value, envVar] of entries) {
    lines.push(`- ${label}: ${formatUsageValue(value)} (환경변수 ${envVar})`);
  }
  lines.push('환경변수값만 수동으로 갱신됩니다.');
  return lines.join('\n');
}

function formatUsageValue(value) {
  return Number.isFinite(value) ? `${value}회` : '미설정';
}

const THREAD_STATUS_MODEL_CHAIN_LIMIT = 5;

// `/status` reports only the controls this thread actually has switched on.
// Anything still at its default is omitted on purpose: the answer is this
// thread's own configuration, not a catalog of every bridge command. Row labels
// carry no platform prefix so the same row renders as `!model` on Slack (where a
// leading slash is eaten by the platform) and `/model` on Discord.
export function formatThreadStatusSummary(status = {}, { commandPrefix = '/' } = {}) {
  const command = (text) => `\`${commandPrefix}${text}\``;
  const rows = enabledThreadControlRows(status, command);
  const lines = ['이 스레드에 켜진 명령', ''];
  if (rows.length === 0) {
    lines.push('명시적으로 켠 명령이 없습니다 — 전부 기본값으로 동작 중입니다.');
    return lines.join('\n');
  }
  for (const row of rows) lines.push(`- ${row}`);
  return lines.join('\n');
}

function enabledThreadControlRows(status = {}, command = (text) => `/${text}`) {
  const rows = [];
  if (status.repoAccess) {
    rows.push(`${command('repo')} 저장소 접근${detailSuffix(status.repoPath)}${detailSuffix(threadStatusRepoOrigin(status))}`);
  }
  if (status.repoAccess && status.bridgeRepoAccess) {
    rows.push(`${command('yolo')} 브리지 소스 직접 수정${detailSuffix(threadStatusBridgeOrigin(status))}`);
  }
  if (status.stateAccess) {
    rows.push(`${command('god')} 채널·스레드 교차 상태 접근`);
  }
  if (status.verboseProgress) {
    rows.push(`${command('verbose')} 진행 업데이트에 원시 출력 포함`);
  }
  if (status.codexFastMode) {
    rows.push(`${command('fast')} Codex Fast service tier`);
  }
  const pinnedChain = threadStatusPinnedModelChain(status);
  if (pinnedChain) {
    rows.push(`${command(threadStatusModelCommandLabel(status))} 실행 순서: ${pinnedChain}`);
  }
  const reservations = Number(status.activeReservationCount);
  if (Number.isFinite(reservations) && reservations > 0) {
    rows.push(`${command('reserve')} 활성 예약 ${reservations}건`);
  }
  if (status.activeGitPollLabel) {
    rows.push(`${command('gitpoll')} 활성 폴링: ${status.activeGitPollLabel}`);
  }
  if (status.pendingAsk) {
    rows.push('답변 대기 중인 질문 있음 — 스레드에 그대로 답장하면 전달됩니다');
  }
  return rows;
}

function detailSuffix(value) {
  return value ? ` — ${value}` : '';
}

// Repo access reaches a thread two ways: a control used in this thread, or a
// prior `/yolo` that flipped the global switch. The row says which, because only
// the first is something the user turned on *here*.
function threadStatusRepoOrigin(status = {}) {
  if (status.storedRepoAccess) return '이 스레드에서 지정';
  if (status.globalRepoAccess) return '전역 설정 상속';
  return '이번 요청 지시';
}

function threadStatusBridgeOrigin(status = {}) {
  return status.globalRepoAccess ? '전역 적용' : '이 스레드 한정';
}

function threadStatusModelCommandLabel(status = {}) {
  return !status.modelPinned && status.effortPinned ? 'effort' : 'model';
}

// Only a pinned chain counts as switched on; the default fallback chain is not
// something this thread chose, so it stays out of the summary.
function threadStatusPinnedModelChain(status = {}) {
  if (!status.modelPinned && !status.effortPinned) return null;
  const chain = (Array.isArray(status.modelChain) ? status.modelChain : []).filter(Boolean);
  if (chain.length === 0) return null;
  const shown = chain.slice(0, THREAD_STATUS_MODEL_CHAIN_LIMIT)
    .map((entry) => (entry.effort ? `${entry.label} (${entry.effort})` : entry.label))
    .join(' → ');
  const omitted = chain.length - THREAD_STATUS_MODEL_CHAIN_LIMIT;
  return `${shown}${omitted > 0 ? ` … 외 ${omitted}개` : ''}`;
}

export function modelSelectionNumberFromContent(content) {
  const text = normalize(content);
  return /^\d+$/.test(text) ? text : null;
}

// A `/model` reply may be a single number/name ("2", "sol") or a
// whitespace/comma-separated sequence ("sol opus terra"). A sequence pins the
// thread to that exact fallback order. Resolution against the configured menu
// happens in thread-models; this parser only validates the selector grammar.
export function modelSelectionSequenceFromContent(content) {
  const text = normalize(content);
  if (!/^[a-z0-9][a-z0-9._:-]*(?:[\s,]+[a-z0-9][a-z0-9._:-]*)*$/i.test(text)) return null;
  return text.split(/[\s,]+/).filter(Boolean);
}

export function modelCommandSelectionSequenceFromContent(content) {
  const text = normalize(content);
  const match = text.match(/^\/model\s+(.+)$/i);
  if (!match) return null;
  return modelSelectionSequenceFromContent(match[1]);
}

// A combined model/effort control is valid only when the entire message is the
// two complete commands. This prevents prose that merely mentions `/model`
// from changing thread state, and makes the pair all-or-nothing at dispatch.
export function parseModelEffortCommand(content) {
  const text = normalize(content);
  const match = text.match(/^\/model\s+(.+?)\s+\/effort\s+(.+)$/i);
  if (!match) return null;

  const modelSelectors = modelSelectionSequenceFromContent(match[1]);
  const effortSelectors = effortSelectionSequenceFromContent(match[2]);
  if (!modelSelectors || !effortSelectors) return null;
  return { modelSelectors, effortSelectors };
}

// Extract controls that should be applied before a task from the same message.
// Only commands outside Markdown code spans are considered. `/model` and
// `/effort` are an atomic parameter group: if either occurrence is incomplete,
// neither parameterized control is removed or applied. Access controls remain
// independently usable, matching the existing `/yolo task` and `/repo task`
// directive behavior.
export function parseJobStartCommands(content) {
  const text = String(content || '');
  const codeRanges = markdownCodeRanges(text);
  const tokens = [];
  const pattern = /(^|\s)\/(yolo|repo|model|effort|queue|supersede)(?=$|\s)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[1].length;
    if (indexInRanges(start, codeRanges)) continue;
    tokens.push({
      name: match[2].toLowerCase(),
      start,
      end: pattern.lastIndex,
    });
  }
  if (tokens.length === 0) return null;

  const accessRanges = tokens
    .filter((token) => token.name === 'yolo' || token.name === 'repo' || token.name === 'queue' || token.name === 'supersede')
    .map((token) => [token.start, token.end]);
  const parameterRanges = [];
  const modelSelectors = [];
  const effortSelectors = [];
  let hasModelCommand = false;
  let hasEffortCommand = false;
  let parameterCommandsComplete = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.name !== 'model' && token.name !== 'effort') continue;
    const end = tokens[index + 1]?.start ?? text.length;
    const rawSelectors = text.slice(token.end, end);
    const selectors = token.name === 'model'
      ? modelSelectionSequenceFromContent(rawSelectors)
      : effortSelectionSequenceFromContent(rawSelectors);
    if (token.name === 'model') hasModelCommand = true;
    else hasEffortCommand = true;
    if (!selectors) {
      parameterCommandsComplete = false;
      continue;
    }
    if (token.name === 'model') modelSelectors.push(...selectors);
    else effortSelectors.push(...selectors);
    parameterRanges.push([token.start, end]);
  }

  const hasParameterizedCommands = hasModelCommand || hasEffortCommand;
  if (!parameterCommandsComplete) {
    modelSelectors.length = 0;
    effortSelectors.length = 0;
  }
  const contentWithoutAccessCommands = removeTextRanges(text, accessRanges);
  const taskContent = removeTextRanges(
    text,
    parameterCommandsComplete
      ? [...accessRanges, ...parameterRanges]
      : accessRanges,
  );

  return {
    commands: tokens.map((token) => token.name),
    modelSelectors: hasParameterizedCommands && parameterCommandsComplete && hasModelCommand
      ? modelSelectors
      : null,
    effortSelectors: hasParameterizedCommands && parameterCommandsComplete && hasEffortCommand
      ? effortSelectors
      : null,
    parameterCommandsComplete,
    taskContent,
    contentWithoutAccessCommands,
  };
}

export function isQueueCommandRequest(content) {
  const text = normalize(content);
  if (!text) return false;

  return containsQueueCommand(text);
}

// `/queue` explicitly preserves earlier work in this thread. New task messages
// supersede earlier work by default; `/supersede` remains a readable alias and
// is parsed so it is not passed through to the worker task.
export function isSupersedeCommandRequest(content) {
  const text = String(content || '');
  if (!text.trim()) return false;

  const codeRanges = markdownCodeRanges(text);
  const pattern = /(^|\s)\/supersede(?=$|\s|[.,!?;:])/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[1].length;
    if (!indexInRanges(start, codeRanges)) return true;
  }
  return false;
}

// A lone `/supersede` is inert. Use this when a caller needs to distinguish a
// directive paired with a replacement task from documentation or a bare command.
export function isSupersedeTaskRequest(content) {
  if (!isSupersedeCommandRequest(content)) return false;
  const command = parseJobStartCommands(content);
  return Boolean(command?.taskContent);
}

export function verboseDirectiveFromContent(content) {
  const text = normalize(content);
  if (!text) return false;

  return leadingSlashDirectives(text).includes('/verbose');
}

// Instant rule-based todo mutations, so common add/complete/remove requests
// do not pay the multi-minute round-trip of a full LLM worker job.
export function parseTodoCommand(content) {
  const text = normalize(content);
  let match = text.match(/^\/(?:할일|todo)\s*추가\s+(.+)$/i) || text.match(/^\/todoadd\s+(.+)$/i);
  if (match) return { action: 'add', title: match[1].trim() };
  match = text.match(/^\/(?:할일|todo)\s*완료\s+(.+)$/i) || text.match(/^\/tododone\s+(.+)$/i);
  if (match) return { action: 'complete', target: match[1].trim() };
  match = text.match(/^\/(?:할일|todo)\s*삭제\s+(.+)$/i) || text.match(/^\/todoremove\s+(.+)$/i);
  if (match) return { action: 'remove', target: match[1].trim() };
  return null;
}

export function isEffortCommandRequest(content) {
  const text = normalize(content);
  return /^\/effort$/i.test(text)
    || effortCommandSelectionFromContent(text) !== null
    || effortCommandSelectionSequenceFromContent(text) !== null;
}

export function effortSelectionFromContent(content) {
  const text = normalize(content);
  return /^[a-z0-9_-]+$/i.test(text) ? text.toLowerCase() : null;
}

export function effortSelectionSequenceFromContent(content) {
  const text = normalize(content);
  if (!/^(?:\d+|none|low|medium|high|xhigh|max|ultra)(?:[\s,]+(?:\d+|none|low|medium|high|xhigh|max|ultra))*$/i.test(text)) {
    return null;
  }
  return text.toLowerCase().split(/[\s,]+/).filter(Boolean);
}

export function effortCommandSelectionFromContent(content) {
  const text = normalize(content);
  const match = text.match(/^\/effort\s+([a-z0-9_-]+)$/i);
  return match ? match[1].toLowerCase() : null;
}

export function effortCommandSelectionSequenceFromContent(content) {
  const text = normalize(content);
  const match = text.match(/^\/effort\s+(.+)$/i);
  if (!match) return null;
  return effortSelectionSequenceFromContent(match[1]);
}

export function isControlOnlyCommandRequest(content) {
  const jobStartCommands = parseJobStartCommands(content);
  return isTodoListRequest(content)
    || parseTodoCommand(content) !== null
    || isHelpCommandRequest(content)
    || isUsageCommandRequest(content)
    || isStatusCommandRequest(content)
    || isCancelCommandRequest(content)
    || isYoloCommandRequest(content)
    || isGodCommandRequest(content)
    || isRepoCommandRequest(content)
    || isVerboseCommandRequest(content)
    || isQuietCommandRequest(content)
    || isFastCommandRequest(content)
    || isUnfastCommandRequest(content)
    || isStyleCommandRequest(content)
    || isModelCommandRequest(content)
    || isEffortCommandRequest(content)
    || parseModelEffortCommand(content) !== null
    || Boolean(
      jobStartCommands
      && jobStartCommands.parameterCommandsComplete
      && !jobStartCommands.taskContent,
    )
    || isGitPollCommandRequest(content)
    || isReserveCommandRequest(content)
    || isRebootRequest(content)
    || unknownBridgeCommandFromContent(content) !== null;
}

export function isWebSearchRequest(content) {
  const text = normalize(content).toLowerCase();
  if (!text) return false;

  if (/(명언|quote|quotation|인용문)/i.test(text)) return true;

  return [
    /검색/,
    /웹|인터넷/,
    /찾아\s*(봐|줘|라|주세요)?/,
    /최신|최근|오늘|어제|뉴스/,
    /가격|시세|환율|일정/,
    /법|규정|정책|표준/,
    /출처|레퍼런스|citation|cite|source/,
    /검증|확인|존재|실존/,
    /\b(search|web|internet|look\s*up|latest|recent|today|news|price|schedule|verify|fact[- ]?check)\b/i,
  ].some((pattern) => pattern.test(text));
}

export function repoAccessDirectiveFromContent(content) {
  const text = normalize(content);
  if (!text) return null;

  return containsYoloCommand(text) || containsGodCommand(text) || containsRepoCommand(text) ? true : null;
}

export function yoloAccessDirectiveFromContent(content) {
  const text = normalize(content);
  if (!text) return null;

  return containsYoloCommand(text) ? true : null;
}

export function stateAccessDirectiveFromContent(content) {
  const text = normalize(content);
  if (!text) return null;

  return containsGodCommand(text) ? true : null;
}

export function repoRootDirectiveFromContent(content) {
  const text = normalize(content);
  if (!text) return null;

  return containsRepoCommand(text) ? true : null;
}

export function rebootReasonFromMessage(message) {
  const content = normalize(message.content);
  if (!content) return '사용자 요청';
  return content.length > 180 ? `${content.slice(0, 177)}...` : content;
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function containsYoloCommand(value) {
  return /(^|\s)\/yolo(?=$|\s|[.,!?;:])/i.test(String(value || ''));
}

function containsGodCommand(value) {
  return /(^|\s)\/god(?=$|\s|[.,!?;:])/i.test(String(value || ''));
}

function containsRepoCommand(value) {
  return /(^|\s)\/repo(?=$|\s|[.,!?;:])/i.test(String(value || ''));
}

function containsQueueCommand(value) {
  const text = String(value || '');
  return /(^|\s)\/[^\s]*queue[^\s]*(?=$|\s|[.,!?;:])/i.test(text)
    || /(^|\s)\/[^\s]+\s+.*\bqueue\b/i.test(text);
}

function leadingSlashDirectives(value) {
  const directives = [];
  for (const token of String(value || '').trim().split(/\s+/)) {
    if (!token.startsWith('/')) break;
    const directive = token.replace(/[.,!?;:]+$/g, '').toLowerCase();
    if (!/^\/[a-z0-9_-]+$/i.test(directive)) break;
    directives.push(directive);
  }
  return directives;
}

function markdownCodeRanges(text) {
  const ranges = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('`', cursor);
    if (start < 0) break;
    let delimiterLength = 1;
    while (text[start + delimiterLength] === '`') delimiterLength += 1;
    const delimiter = '`'.repeat(delimiterLength);
    const close = text.indexOf(delimiter, start + delimiterLength);
    if (close < 0) {
      ranges.push([start, text.length]);
      break;
    }
    const end = close + delimiterLength;
    ranges.push([start, end]);
    cursor = end;
  }
  return ranges;
}

function indexInRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function removeTextRanges(text, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return cleanCommandWhitespace(text);
  const sorted = [...ranges]
    .sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const range of sorted) {
    const start = Math.max(0, Number(range[0]) || 0);
    const end = Math.min(text.length, Number(range[1]) || 0);
    if (end <= start) continue;
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  const parts = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    parts.push(text.slice(cursor, start), ' ');
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return cleanCommandWhitespace(parts.join(''));
}

function cleanCommandWhitespace(value) {
  return String(value || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
