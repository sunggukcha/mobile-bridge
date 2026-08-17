import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAntigravityStreamObserver,
  runAgentJob,
  salvagePartialWorkerOutput,
} from '../lib/agent-runner.mjs';
import { loadConfig } from '../lib/config.mjs';

const ANSWER = `## 결과\n\n${'허깅페이스 저장소 업데이트를 확인했습니다. '.repeat(12)}\n\n### 아직 미해결`;
const REPORTED_STYLE_OUTPUT = [
  '`example_project` 디렉토리가 있습니다. HF repo를 pull하겠습니다.',
  'HF API 호출이 백그라운드로 넘어갔습니다. 기다리겠습니다.',
  '새 결과가 있습니다. 자세히 확인하겠습니다.',
  '',
  'HF 풀 결과, 새 run이 1건 업로드됐습니다. 요약:',
  '',
  '## HF `example-owner/example-project` 업데이트',
  '',
  '### 변경사항',
  '새 결과가 정상적으로 완료됐습니다. '.repeat(20),
  '',
  '### 아직 미해결',
].join('\n');

test('salvagePartialWorkerOutput keeps a streamed answer from a non-zero exit', () => {
  const salvaged = salvagePartialWorkerOutput({ code: 1, aborted: false, stdout: ANSWER });

  assert.ok(salvaged.startsWith('## 결과'));
  assert.match(salvaged, /답변을 끝내기 전에 종료/);
});

test('salvagePartialWorkerOutput discards aborted runs, empty stdout and stray banner lines', () => {
  // An abort is a supersede or an explicit cancel; the user asked for this run
  // to stop, so its half-written answer must not be posted.
  assert.equal(salvagePartialWorkerOutput({ code: 1, aborted: true, stdout: ANSWER }), null);
  assert.equal(salvagePartialWorkerOutput({ code: 1, aborted: false, stdout: '' }), null);
  assert.equal(salvagePartialWorkerOutput({ code: 1, aborted: false, stdout: 'Thinking...' }), null);
  assert.equal(salvagePartialWorkerOutput({
    code: 1,
    aborted: false,
    stdout: '저장소를 확인하는 중입니다.\n'.repeat(20),
  }), null);
  assert.equal(salvagePartialWorkerOutput(null), null);
});

test('salvagePartialWorkerOutput keeps the structured answer and drops leading narration', () => {
  const salvaged = salvagePartialWorkerOutput({ code: 1, aborted: false, stdout: REPORTED_STYLE_OUTPUT });

  assert.ok(salvaged.startsWith('HF 풀 결과'));
  assert.match(salvaged, /HF `example-owner\/example-project` 업데이트/);
  assert.doesNotMatch(salvaged, /백그라운드로 넘어갔습니다/);
  assert.match(salvaged, /답변을 끝내기 전에 종료/);
});

test('runAgentJob delivers an Antigravity answer that was streamed before a non-zero exit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-antigravity-partial-'));
  const projectRoot = path.join(root, 'projects');
  const cwd = path.join(projectRoot, 'mobile-codex-bridge');
  const agyBin = path.join(root, 'fake-agy.mjs');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(agyBin, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args[0] === "models") process.exit(0);',
    `console.log(${JSON.stringify(ANSWER)});`,
    'console.error("Error: timeout waiting for response");',
    'process.exit(1);',
    '',
  ].join('\n'));
  await fs.chmod(agyBin, 0o755);

  try {
    const result = await runAgentJob({
      config: loadConfig({
        PROJECT_ROOT: projectRoot,
        BRIDGE_CODEX_PROJECT: 'mobile-codex-bridge',
        DEFAULT_WORKER_CHAIN: 'antigravity',
        WORKER_FALLBACK_ENABLED: 'false',
        ANTIGRAVITY_BIN: agyBin,
      }),
      job: {
        id: 'antigravity-partial-answer',
        attempt: 1,
        channelId: 'personal',
        event: { content: '작업' },
      },
      prompt: 'do it',
    });

    assert.match(result.output, /허깅페이스 저장소 업데이트/);
    assert.match(result.output, /답변을 끝내기 전에 종료/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('createAntigravityStreamObserver reports plain-text narration without replaying the answer', () => {
  const updates = [];
  let clock = 0;
  const observer = createAntigravityStreamObserver((update) => updates.push(update), {
    intervalMs: 45_000,
    now: () => clock,
  });

  observer.write('저장소를 확인하는 중입니다\n');
  clock += 10_000;
  // Inside the throttle window, so this line must not become its own message.
  observer.write('메트릭을 비교하는 중입니다\n');
  clock += 40_000;
  observer.write('오염 여부를 점검하는 중입니다\n');
  clock += 60_000;
  observer.write('{"type":"call","tool":"grep"}\n');
  observer.write(`${ANSWER}`);
  observer.flush();

  assert.deepEqual(updates.map((update) => update.text), [
    '저장소를 확인하는 중입니다',
    '메트릭을 비교하는 중입니다\n오염 여부를 점검하는 중입니다',
    '[grep]',
  ]);
  assert.ok(updates.every((update) => update.type === 'response_text'));
});

test('createAntigravityStreamObserver caps a single progress update', () => {
  const updates = [];
  const observer = createAntigravityStreamObserver((update) => updates.push(update), {
    intervalMs: 0,
    now: () => 0,
  });

  observer.write(`${'가'.repeat(2_000)}\n`);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].text.length, 400);
});

test('createAntigravityStreamObserver stops after final-answer structure begins', () => {
  const updates = [];
  let clock = 0;
  const observer = createAntigravityStreamObserver((update) => updates.push(update), {
    intervalMs: 45_000,
    now: () => clock,
  });

  observer.write('저장소를 확인하는 중입니다\n');
  clock += 50_000;
  observer.write('\nHF 풀 결과, 새 run이 있습니다.\n');
  clock += 50_000;
  observer.write('\n## 최종 결과\n');
  clock += 50_000;
  observer.write('첫 번째 최종 문단입니다.\n');
  clock += 50_000;
  observer.write('두 번째 최종 문단입니다.\n');
  observer.flush();

  assert.deepEqual(updates.map((update) => update.text), ['저장소를 확인하는 중입니다']);
});
