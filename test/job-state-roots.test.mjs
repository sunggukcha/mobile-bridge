import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  contentNeedsFullStateAccess,
  contentNeedsRepoAccess,
  jobAllowedRoots,
  jobArtifactRoot,
  jobCanModifyBridgeSource,
  jobNeedsFullStateAccess,
  jobNeedsRepoAccess,
  jobWorkingDirectory,
} from '../lib/job-state-roots.mjs';

const config = {
  stateRoot: '/tmp/projects/.bridge_state',
  repositoriesRoot: '/tmp/projects/.bridge_state/repositories',
  allowedRoots: ['/tmp/projects/mobile-codex-bridge'],
  bridgeRepoRoot: '/tmp/projects/mobile-codex-bridge',
  codex: {
    cwd: '/tmp/projects/.bridge_state/workspace',
  },
};

test('contentNeedsRepoAccess grants repo access only for explicit access directives', () => {
  assert.equal(contentNeedsRepoAccess('명언 366개 찾아서 매일 아침 보내줘'), false);
  assert.equal(contentNeedsRepoAccess('리포트 산출물 정리해줘'), false);
  assert.equal(contentNeedsRepoAccess('그렇게 구현해둬'), false);
  assert.equal(contentNeedsRepoAccess('서비스 상태 알려줘'), false);
  assert.equal(contentNeedsRepoAccess('테스트 결과 요약해줘'), false);
  assert.equal(contentNeedsRepoAccess('lib 기능 구현해줘'), false);
  assert.equal(contentNeedsRepoAccess('브릿지 코드 고쳐라'), false);
  assert.equal(contentNeedsRepoAccess('lib/job-state-roots.mjs 수정해줘'), false);
  assert.equal(contentNeedsRepoAccess('git clone https://github.com/example/repo'), false);
  assert.equal(contentNeedsRepoAccess('새 브랜치 fetch 해서 체크아웃해줘'), false);
  assert.equal(contentNeedsRepoAccess('npm test 돌려줘'), false);
  assert.equal(contentNeedsRepoAccess('테스트 실행해줘'), false);
  assert.equal(contentNeedsRepoAccess('/yolo 브릿지 코드 고쳐라'), true);
  assert.equal(contentNeedsRepoAccess('/god 전체 state 확인해'), true);
  assert.equal(contentNeedsRepoAccess('/repo ixiparser 봐줘'), true);
  assert.equal(contentNeedsFullStateAccess('/yolo 브릿지 코드 고쳐라'), false);
  assert.equal(contentNeedsFullStateAccess('/god 전체 state 확인해'), true);
});

test('job roots keep non-repo jobs in channel common and thread state', () => {
  const job = { channelId: 'channel-1', threadId: 'thread-1', event: { content: '명언 정리해줘' } };

  assert.equal(jobNeedsRepoAccess(job), false);
  assert.equal(jobWorkingDirectory(config, job), path.join('/tmp/projects/.bridge_state', 'channel-1_common'));
  assert.equal(jobArtifactRoot(config, job), path.join('/tmp/projects/.bridge_state', 'channel-1_common', 'artifacts'));
  assert.deepEqual(jobAllowedRoots(config, job), [
    path.join('/tmp/projects/.bridge_state', 'channel-1_common'),
    path.join('/tmp/projects/.bridge_state', 'channel-1', 'thread-1'),
  ]);
});

test('/yolo job roots include the bridge source for direct modification', () => {
  const job = { channelId: 'channel-1', threadId: 'thread-1', event: { content: '/yolo 소스 패치해줘' } };

  assert.equal(jobNeedsRepoAccess(job), true);
  assert.equal(jobCanModifyBridgeSource(config, job), true);
  assert.equal(jobWorkingDirectory(config, job), path.join('/tmp/projects/.bridge_state', 'channel-1_common', 'workspace'));
  assert.deepEqual(jobAllowedRoots(config, job), [
    path.join('/tmp/projects/.bridge_state', 'channel-1_common', 'workspace'),
    '/tmp/projects/mobile-codex-bridge',
    path.join('/tmp/projects/.bridge_state', 'channel-1_common'),
    path.join('/tmp/projects/.bridge_state', 'channel-1', 'thread-1'),
  ]);
});

test('job roots use the thread repository root when provided', () => {
  const job = {
    channelId: 'channel-1',
    threadId: 'thread-1',
    repoAccess: true,
    repoPath: '/tmp/projects/.bridge_state/repositories',
    event: { content: '/repo 소스 확인해줘' },
  };

  assert.equal(jobNeedsRepoAccess(job), true);
  assert.equal(jobCanModifyBridgeSource(config, job), false);
  assert.equal(jobWorkingDirectory(config, job), '/tmp/projects/.bridge_state/repositories');
  assert.deepEqual(jobAllowedRoots(config, job), [
    '/tmp/projects/.bridge_state/repositories',
    path.join('/tmp/projects/.bridge_state', 'channel-1_common'),
    path.join('/tmp/projects/.bridge_state', 'channel-1', 'thread-1'),
  ]);
});

test('job roots include all bridge state for god jobs', () => {
  const job = { channelId: 'channel-1', threadId: 'thread-1', event: { content: '/god 전체 state 확인해줘' } };

  assert.equal(jobNeedsRepoAccess(job), true);
  assert.equal(jobNeedsFullStateAccess(job), true);
  assert.equal(jobCanModifyBridgeSource(config, job), true);
  assert.equal(jobWorkingDirectory(config, job), path.join('/tmp/projects/.bridge_state', 'channel-1_common', 'workspace'));
  assert.deepEqual(jobAllowedRoots(config, job), [
    path.join('/tmp/projects/.bridge_state', 'channel-1_common', 'workspace'),
    '/tmp/projects/mobile-codex-bridge',
    '/tmp/projects/.bridge_state',
  ]);
});

test('maintenance jobs target the bridge repository explicitly', () => {
  const job = { maintenance: true, channelId: 'channel-1', threadId: 'thread-1', event: { content: 'maintenance' } };

  assert.equal(jobWorkingDirectory(config, job), '/tmp/projects/mobile-codex-bridge');
  assert.equal(jobCanModifyBridgeSource(config, job), true);
  assert.deepEqual(jobAllowedRoots(config, job), [
    '/tmp/projects/mobile-codex-bridge',
    path.join('/tmp/projects/.bridge_state', 'channel-1_common'),
    path.join('/tmp/projects/.bridge_state', 'channel-1', 'thread-1'),
  ]);
});

test('maintenance jobs can be explicitly authorized to inspect all bridge state', () => {
  const job = {
    maintenance: true,
    stateAccess: true,
    channelId: 'channel-1',
    threadId: 'thread-1',
    event: { content: 'maintenance' },
  };

  assert.deepEqual(jobAllowedRoots(config, job), [
    '/tmp/projects/mobile-codex-bridge',
    '/tmp/projects/.bridge_state',
  ]);
});
