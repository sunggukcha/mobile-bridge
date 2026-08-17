import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAiMorningReportTask,
  buildEconomyMorningReportTask,
  dailyReportDefinitions,
  nextDailyReportAtKst,
} from '../lib/daily-reports.mjs';

test('dailyReportDefinitions publish completed reports as new posts in their configured channels', () => {
  const definitions = dailyReportDefinitions({
    dailyReports: {
      economyChannelId: 'economy-channel',
      aiChannelId: 'ai-channel',
    },
  });

  assert.deepEqual(definitions.map((definition) => [
    definition.key,
    definition.channelId,
    definition.finalChannelId,
  ]), [
    ['economy', 'economy-channel', 'economy-channel'],
    ['ai', 'ai-channel', 'ai-channel'],
  ]);
});

test('daily report prompts require current web search and channel-specific topics', () => {
  const economy = buildEconomyMorningReportTask();
  const ai = buildAiMorningReportTask();

  assert.match(economy, /최신 웹 검색/);
  assert.match(economy, /독립적으로 읽을 수 있는 경제 뉴스 요약/);
  assert.match(economy, /금리\/환율/);
  assert.match(economy, /private-use citation marker/);
  assert.match(economy, /Markdown 링크/);

  assert.match(ai, /최신 웹 검색/);
  assert.match(ai, /전일 09:00:00 KST부터 당일 08:59:59 KST/);
  assert.match(ai, /고정 업체 목록이나 공식 사이트 순회로 시작하지 않는다/);
  assert.match(ai, /글로벌·한국·미국·일본 트렌드/);
  assert.match(ai, /X API 자격증명이 없다/);
  assert.match(ai, /영어·한국어·중국어·일본어/);
  assert.match(ai, /비공식 스크래핑으로 대체하지 않는다/);
  assert.match(ai, /Hacker News, Hugging Face Trending 및 Daily Papers, GitHub/);
  assert.match(ai, /소스 접근 상태/);
  assert.match(ai, /왜 어제 화제였는지/);
  assert.match(ai, /Hugging Face/);
  assert.match(ai, /논문 섹션은 매일 반드시 포함/);
  assert.match(ai, /탑티어 AI\/ML 학회 감시 목록/);
  assert.match(ai, /ICML, NeurIPS, ICLR/);
  assert.match(ai, /best\/outstanding\/test-of-time awards/);
  assert.match(ai, /memory\/ai-conference-reports\.jsonl/);
  assert.match(ai, /개발자/);
  assert.match(ai, /private-use citation marker/);
  assert.match(ai, /Markdown 링크/);
});

test('AI daily report prompt marks X API access truthfully', () => {
  const ai = buildAiMorningReportTask({ xApiAvailable: true });

  assert.match(ai, /X API 자격증명이 있다/);
  assert.doesNotMatch(ai, /X API 자격증명이 없다/);
});

test('daily reports skip Saturday and Sunday in KST', () => {
  assert.equal(
    nextDailyReportAtKst(new Date('2026-07-17T23:59:00.000Z'), 9).toISOString(),
    '2026-07-20T00:00:00.000Z',
  );
  assert.equal(
    nextDailyReportAtKst(new Date('2026-07-19T00:00:01.000Z'), 9).toISOString(),
    '2026-07-20T00:00:00.000Z',
  );
});
