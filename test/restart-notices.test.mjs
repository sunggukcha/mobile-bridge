import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  formatRestartRequestNotice,
  resolveRestartNoticeDestination,
  restartSourceLabel,
} from '../lib/restart-notices.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('restartSourceLabel separates manual and automatic restart sources', () => {
  assert.equal(restartSourceLabel('manual'), '명시적 사용자 재시작 명령');
  assert.equal(restartSourceLabel('manual-understood'), '사용자 지시 이해 기반 재시작 요청');
  assert.equal(restartSourceLabel('runtime-source-change'), '브리지 런타임 소스 변경 적용');
  assert.equal(restartSourceLabel('daily-maintenance'), '새벽 유지보수 완료 후 반영');
});

test('restart notices from Slack threads target the configured Discord general channel', () => {
  assert.deepEqual(resolveRestartNoticeDestination({
    channelId: 'logical-channel',
    threadId: 'slack-T0000000001-C0000000001-1700000000.000001',
  }, {
    discordGeneralChannelId: 'discord-general',
    slackChannelId: 'C0000000001',
  }), {
    platform: 'discord',
    channelId: 'discord-general',
  });
});

test('restart notices from Discord threads target the configured general channel', () => {
  assert.deepEqual(resolveRestartNoticeDestination({
    channelId: 'discord-source',
    threadId: 'discord-thread',
  }, {
    discordGeneralChannelId: 'discord-general',
    slackChannelId: 'C0000000001',
  }), {
    platform: 'discord',
    channelId: 'discord-general',
  });
});

test('runtime source changes do not post a restart pre-notice into the active work thread', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'bridge-service.mjs'), 'utf8');
  const start = source.indexOf('async function markJobNeedsRuntimeRestart(');
  const end = source.indexOf('\nasync function startJobCheckpointSafe(', start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const functionSource = source.slice(start, end);
  assert.doesNotMatch(functionSource, /postJobMessage\s*\(/);
  assert.doesNotMatch(functionSource, /서비스 재시작 후 계속 진행/);
});

test('formatRestartRequestNotice shows the model-authored runtime change and effect', () => {
  const notice = formatRestartRequestNotice({
    reason: '재시작 알림이 파일 목록 대신 모델이 작성한 동작 변경 내용을 표시하도록 수정',
    improvement: '운영 채널에서 재시작으로 적용되는 기능을 즉시 파악할 수 있음',
    source: 'runtime-source-change',
    workerLabel: 'codex: gpt-5.6-terra',
    workerEffort: 'xhigh',
  });

  assert.equal(notice, [
    '【codex gpt-5.6-terra xhigh: 서비스 재시작】',
    '사유: 재시작 알림이 파일 목록 대신 모델이 작성한 동작 변경 내용을 표시하도록 수정',
    '효과: 운영 채널에서 재시작으로 적용되는 기능을 즉시 파악할 수 있음',
  ].join('\n'));
  assert.doesNotMatch(notice, /사용자 요청/);
  assert.doesNotMatch(notice, /재부팅 시도/);
  assert.doesNotMatch(notice, /channel=/);
  assert.doesNotMatch(notice, /thread=/);
});

test('formatRestartRequestNotice drops boilerplate for a fileless runtime restart', () => {
  const notice = formatRestartRequestNotice({
    reason: '런타임 소스 변경 반영',
    improvement: '변경된 소스를 반영',
    source: 'runtime-source-change',
  });

  assert.equal(notice, '【서비스 재시작】');
});

test('formatRestartRequestNotice includes blockers for deferred restarts', () => {
  const notice = formatRestartRequestNotice({
    reason: '서버 재부팅 해줘',
    improvement: 'idle 이후 재시작',
    channelId: 'c1',
    threadId: 't1',
    source: 'manual',
    deferred: true,
    blockers: [
      { id: 'job-a', channelId: 'c1', threadId: 't1' },
      { id: 'job-b', channelId: 'c2', threadId: 't2' },
    ],
  });

  assert.match(notice, /서비스 재시작 대기/);
  assert.match(notice, /실행 중 작업 2개 완료 후 재시작/);
  assert.doesNotMatch(notice, /channel=/);
  assert.doesNotMatch(notice, /thread=/);
  assert.doesNotMatch(notice, /job=job-a/);
});

test('formatRestartRequestNotice collapses maintenance defaults to a worker title', () => {
  const notice = formatRestartRequestNotice({
    reason: '새벽유지보수 완료 후 변경사항 및 동기화 결과를 service에 반영',
    improvement: '이전 새벽유지보수 이후 시스템 로그/채팅 기록/작업 기록 전수조사 결과, git push/sync 결과, 중단 작업 복구 정책을 최신 service 프로세스에 반영',
    source: 'daily-maintenance',
    workerLabel: 'claude: claude-fable-5',
    workerEffort: 'low',
  });

  assert.equal(notice, '【claude claude-fable-5 low: 서비스 재시작】');
});
