import { nextWeekdayDailyRunAtKst } from './maintenance-schedule.mjs';

export function dailyReportDefinitions(config) {
  return [
    {
      key: 'economy',
      channelId: config.dailyReports.economyChannelId,
      // The worker gets an execution thread so its context and progress are
      // contained, but a completed report is published as a new channel post.
      finalChannelId: config.dailyReports.economyChannelId,
      title: '경제 아침 리포트',
      authorName: 'economy-daily-report',
      content: buildEconomyMorningReportTask(),
    },
    {
      key: 'ai',
      channelId: config.dailyReports.aiChannelId,
      // See the economy report above: do not publish the finished report as
      // a reply inside the execution thread.
      finalChannelId: config.dailyReports.aiChannelId,
      title: 'AI 아침 리포트',
      authorName: 'ai-daily-report',
      content: buildAiMorningReportTask({ xApiAvailable: Boolean(config.dailyReports.xApiAvailable) }),
    },
  ].filter((definition) => definition.channelId);
}

// Morning news reports run only on KST weekdays, so nothing is sent over
// the weekend.
export function nextDailyReportAtKst(now = new Date(), hourKst = 9) {
  return nextWeekdayDailyRunAtKst(now, hourKst);
}

export function buildEconomyMorningReportTask() {
  return [
    '경제 채널에 매일 아침 올릴 한국어 경제 뉴스 리포트를 작성해라.',
    '',
    '필수 조건:',
    '- 반드시 최신 웹 검색으로 확인하고, 날짜가 오래된 내용은 제외한다.',
    '- 독립적으로 읽을 수 있는 경제 뉴스 요약으로 작성한다.',
    '- 글로벌 증시, 한국 증시, 금리/환율, 원자재, 암호화폐, 주요 경제지표와 정책 이슈를 다룬다.',
    '- 각 항목은 왜 중요한지와 오늘 확인할 포인트를 함께 적는다.',
    '- 과장하지 말고 불확실한 내용은 불확실하다고 표시한다.',
    '- 핵심 출처 링크를 포함한다.',
    '- Discord에 그대로 게시되므로 private-use citation marker나 turn/search 내부 인용 표기는 쓰지 말고, 출처는 일반 URL 또는 Markdown 링크로만 적는다.',
    '',
    '출력 형식:',
    '- 제목은 "경제 아침 리포트 - YYYY-MM-DD" 형식',
    '- 짧은 요약 3줄',
    '- 핵심 뉴스 5-8개',
    '- 오늘의 체크포인트',
  ].join('\n');
}

export function buildAiMorningReportTask({ xApiAvailable = false } = {}) {
  return [
    'ai 채널에 매일 아침 올릴 한국어 AI 뉴스 리포트를 작성해라.',
    '',
    '작업 범위와 원칙:',
    '- 리포트 시점 기준 전일 09:00:00 KST부터 당일 08:59:59 KST까지의 사건만 조사한다. 이전 보도 재탕은 제외하고, 채널 common state와 이 스레드의 기존 리포트에서 이미 다룬 사건은 실제 업데이트가 있을 때만 다시 다룬다.',
    '- 고정 업체 목록이나 공식 사이트 순회로 시작하지 않는다. 먼저 전 세계에서 어제 새로 화제가 된 AI 사건을 발견하고, 그 뒤에만 1차 출처로 사실·사용 가능 여부를 확인한다.',
    '- AI 모델, 에이전트, 개발자 도구, 오픈소스, 제품 출시, 규제/산업 이슈를 다룬다.',
    '',
    '발견 레인 — 반드시 아래 순서로 수행:',
    '- X: 글로벌·한국·미국·일본 트렌드에서 AI 후보를 찾고, 최근 24시간의 영어·한국어·중국어·일본어 AI/모델/오픈소스/에이전트/벤치마크/칩/투자/규제 검색을 살핀다. 이어 Techmeme, The Decoder, Will Knight, Alex Heath, Cade Metz, Kevin Roose, Parmy Olson, Latent Space, swyx, Artificial Analysis, LMArena, Hugging Face, EleutherAI, vLLM, Ollama 등 발견용 큐레이션 계정·채널의 원글을 확인한다. 이 목록은 회사 공식계정 순회 목록이 아니다.',
    xApiAvailable
      ? '- 이 실행에는 X API 자격증명이 있다. 공식 API의 트렌드·최근 24시간 검색·리스트 조회를 실제로 시도하고, 실패한 세부 레인은 실패로 표시한다. 토큰 값은 절대 출력·파일 기록·외부 전송하지 않는다.'
      : '- 이 실행에는 X API 자격증명이 없다. X 트렌드·최근 24시간 검색·리스트 조회를 실제로 조회하지 않았다고 “소스 접근 상태”에 표시한다. 검색 결과의 단편이나 비공식 스크래핑을 X 데이터 조회로 바꾸어 적지 않는다.',
    '- X의 공식 API·허용된 공개 접근이 현재 작업에서 불가능하면 비공식 스크래핑으로 대체하지 않는다. 그때는 X 트렌드/검색/리스트를 “미확인”으로 명시하고, 공개적으로 접근 가능한 원문·다른 독립 센서로 계속 조사한다. X 데이터를 실제로 보지 못했는데 본 것처럼 쓰지 않는다.',
    '- 교차 센서: Hacker News, Hugging Face Trending 및 Daily Papers, GitHub의 새 저장소·release·급성장 프로젝트, Reddit AI 커뮤니티, Bluesky, Techmeme, arXiv/OpenReview을 함께 확인한다. 새 회사·새 모델명·새 링크는 이 신호들에서 먼저 발견한다.',
    '- URL, 저장소/모델/논문 ID, 제목과 다국어 별칭을 기준으로 같은 사건을 하나로 묶는다. 리포스트, 기사 재인용, 동일 보도는 독립 신호 하나로 중복 계산하지 않는다.',
    '',
    '선별과 검증:',
    '- 각 후보를 (1) 독립 반응 축 수, (2) 24시간 반응 증가/화제성, (3) 최초 원글 또는 실물 아티팩트 존재, (4) 제품·연구·산업에 주는 변화로 평가한다.',
    '- 핵심 뉴스에는 “X에서 강한 화제 + 독립 커뮤니티/아티팩트 확인”, 또는 “1차 릴리스·모델 카드·논문·저장소 + 실질적 반응”, 또는 “산업 구조를 바꾸는 사건” 중 하나를 충족한 것만 넣는다.',
    '- 기사·소셜 게시물은 발견·화제성 근거이고, 출시·성능·가격·사용 가능 여부의 확정 근거는 공식 문서, 모델 카드, release, 논문, 저장소 등 1차 링크여야 한다. 원문 확인 전에는 출시로 단정하지 말고 “관측/확인 중”으로 분리한다.',
    '- 각 핵심 항목에 반드시 ① 왜 어제 화제였는지 ② 최초 원글 또는 대표 화제성 신호 ③ 독립 반응/실물 아티팩트 ④ 사실 확인 1차 링크 ⑤ 개발자·사업 관점의 의미를 적는다.',
    '- 맨 위에 “소스 접근 상태”를 한 줄로 적어 X 트렌드·X 24시간 검색·신뢰 리스트·교차 센서 중 실제 조회한 것과 미조회한 것을 구분한다.',
    '',
    '기존 필수 조건:',
    '- 반드시 최신 웹 검색으로 확인하고, 날짜가 오래된 내용은 제외한다.',
    '- 논문 섹션은 매일 반드시 포함한다. 블로그/뉴스 재요약이 아니라 arXiv, OpenReview, 학회/저널 공식 페이지, 저자 GitHub/프로젝트, Semantic Scholar, Papers with Code, Hugging Face Papers 등 1차 출처와 실제 급상승 신호 중심으로 선별한다.',
    '- 탑티어 AI/ML 학회 감시 목록: ICML, NeurIPS, ICLR, CVPR, ICCV/ECCV, ACL, EMNLP, NAACL, KDD, AAAI, IJCAI. 이 중 새 학회가 시작/진행 중이거나 수상/오럴/스포트라이트/프로시딩 통계가 발표됐으면 최소 1회 별도 "학회 하이라이트" 섹션으로 보고한다.',
    '- 학회 하이라이트에는 전체 일정/장소, 제출/채택/acceptance rate, oral/spotlight 같은 구분 통계, best/outstanding/test-of-time awards, 주목 논문 하이라이트와 왜 중요한지를 포함한다.',
    '- 컨퍼런스 중복 방지를 위해 현재 채널 common state의 memory/ai-conference-reports.jsonl을 확인하고, 새로 보고한 컨퍼런스/연도/event_type은 같은 파일에 JSONL로 기록한다. 이미 보고한 항목은 새 수상/통계/프로그램 업데이트가 있을 때만 다시 다룬다.',
    '- 개발자와 사업 관점에서 바로 볼 가치가 있는 내용 위주로 선별한다.',
    '- GitHub/Hugging Face/arXiv/공식 블로그 같은 1차 출처가 있으면 우선한다.',
    '- 과장하지 말고 불확실한 내용은 불확실하다고 표시한다.',
    '- 핵심 출처 링크를 포함한다.',
    '- Discord에 그대로 게시되므로 private-use citation marker나 turn/search 내부 인용 표기는 쓰지 말고, 출처는 일반 URL 또는 Markdown 링크로만 적는다.',
    '',
    '출력 형식:',
    '- 제목은 "AI 아침 리포트 - YYYY-MM-DD" 형식',
    '- 조사 창: 전일 09:00~당일 08:59 KST',
    '- 소스 접근 상태',
    '- 짧은 요약 3줄',
    '- 핵심 뉴스 5-8개',
    '- 논문 섹션',
    '- 학회 하이라이트 섹션(해당될 때)',
    '- 오늘의 체크포인트',
  ].join('\n');
}
