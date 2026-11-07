import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const {
  UPBIT_RADAR_ANALYSIS_LIMIT,
  UPBIT_RADAR_HISTORY_DAYS,
  UpbitRadarService,
  buildUpbitRadarResult,
  selectUpbitRadarAnalysisCandidates,
} = await loadLib("upbit-radar");

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 8, 18, 9, 30);
const TODAY_START = Date.UTC(2026, 8, 18);

function candidate(index, overrides = {}) {
  return {
    market: `KRW-C${index}`,
    name: `코인${index}`,
    baseAsset: `C${index}`,
    lastPrice: 1_000,
    changeRate: 1,
    quoteVolume24h: (100 - index) * 1_000_000_000,
    tickSize: "1",
    warning: false,
    ...overrides,
  };
}

/** 30일치 완료 일봉. dailyVolume(day)로 요일별 거래대금을 바꿀 수 있습니다. */
function history(dailyVolume = () => 1_000_000_000, closePrice = 1_000) {
  return Array.from({ length: UPBIT_RADAR_HISTORY_DAYS }, (_, index) => {
    const openTime = TODAY_START - (UPBIT_RADAR_HISTORY_DAYS - index) * DAY_MS;
    return {
      openTime,
      closeTime: openTime + DAY_MS - 1,
      closePrice,
      quoteVolume: dailyVolume(UPBIT_RADAR_HISTORY_DAYS - index),
    };
  });
}

test("분석군은 거래대금 상위 40개로 잘린다", () => {
  const all = Array.from({ length: 60 }, (_, index) => candidate(index + 1));
  const analyzed = selectUpbitRadarAnalysisCandidates(all);
  assert.equal(analyzed.length, UPBIT_RADAR_ANALYSIS_LIMIT);
  assert.equal(analyzed[0].market, "KRW-C1");
  assert.equal(analyzed.at(-1).market, "KRW-C40");
});

test("KRW 마켓이 아니거나 값이 깨진 후보는 제외한다", () => {
  const analyzed = selectUpbitRadarAnalysisCandidates([
    candidate(1),
    candidate(2, { market: "BTC-ETH" }),
    candidate(3, { lastPrice: 0 }),
    candidate(4, { tickSize: "0" }),
    candidate(5, { quoteVolume24h: Number.NaN }),
    candidate(6, { changeRate: Number.NaN }),
    candidate(1), // 중복
  ]);
  assert.deepEqual(analyzed.map((item) => item.market), ["KRW-C1"]);
});

test("점수는 규모 50 · 7일/30일 30 · 전일대비 20으로 합산된다", () => {
  const candidates = [candidate(1), candidate(2), candidate(3)];
  const histories = new Map([
    // 최근 7일 거래대금이 3배인 종목
    ["KRW-C1", history((day) => (day <= 7 ? 3_000_000_000 : 1_000_000_000))],
    ["KRW-C2", history()],
    ["KRW-C3", history((day) => (day <= 7 ? 500_000_000 : 1_000_000_000))],
  ]);
  const result = buildUpbitRadarResult(candidates, histories, { now: NOW });

  assert.equal(result.coverage.eligible, 3);
  assert.equal(result.coverage.analyzed, 3);
  assert.equal(result.coverage.historyReady, 3);
  assert.equal(result.coverage.provisional, 0);
  assert.equal(result.historyAsOf, "2026-09-17");

  const byMarket = new Map(result.items.map((item) => [item.market, item]));
  // 규모는 C1 > C2 > C3, 주간 강도도 C1 > C2 > C3이므로 순위가 그대로 갑니다.
  assert.deepEqual(result.items.map((item) => item.market), [
    "KRW-C1",
    "KRW-C2",
    "KRW-C3",
  ]);
  assert.deepEqual(result.items.map((item) => item.rank), [1, 2, 3]);
  // 30일 평균에도 몰린 한 주가 섞이므로 비율은 3배가 아니라 3 ÷ (44/30)입니다.
  assert.equal(byMarket.get("KRW-C1").weekVsMonthRatio, 2.045455);
  assert.equal(byMarket.get("KRW-C2").weekVsMonthRatio, 1);
  assert.equal(byMarket.get("KRW-C3").weekVsMonthRatio, 0.566038);
  // 세 종목 모두 종가 1,000원 = 현재가이므로 전일대비는 0%입니다.
  assert.equal(byMarket.get("KRW-C1").dayChangePercent, 0);

  const top = byMarket.get("KRW-C1");
  assert.equal(
    top.score,
    Math.round((0.5 * top.sizeScore + 0.3 * top.weekScore + 0.2 * top.dayScore) * 100) / 100,
  );
});

test("전일대비는 마지막 완료 일봉 종가 대비로 계산한다", () => {
  const result = buildUpbitRadarResult(
    [candidate(1, { lastPrice: 1_100 })],
    new Map([["KRW-C1", history(() => 1_000_000_000, 1_000)]]),
    { now: NOW },
  );
  assert.equal(result.items[0].dayChangePercent, 10);
  assert.equal(result.items[0].dayMetricReady, true);
});

test("이력이 모자란 종목은 잠정 순위로 남는다", () => {
  const short = history().slice(-3);
  const result = buildUpbitRadarResult(
    [candidate(1), candidate(2)],
    new Map([["KRW-C1", history()], ["KRW-C2", short]]),
    { now: NOW },
  );
  const byMarket = new Map(result.items.map((item) => [item.market, item]));
  assert.equal(byMarket.get("KRW-C1").provisional, false);
  assert.equal(byMarket.get("KRW-C2").provisional, true);
  assert.equal(byMarket.get("KRW-C2").weekMetricReady, false);
  assert.equal(byMarket.get("KRW-C2").weekScore, 50, "빠진 지표는 중립 50점입니다.");
  assert.equal(result.coverage.provisional, 1);
});

test("오늘 캔들과 창 밖 캔들은 계산에서 빠진다", () => {
  const withToday = [
    ...history(),
    {
      openTime: TODAY_START,
      closeTime: TODAY_START + DAY_MS - 1,
      closePrice: 9_999,
      quoteVolume: 99_000_000_000,
    },
  ];
  const result = buildUpbitRadarResult(
    [candidate(1, { lastPrice: 1_000 })],
    new Map([["KRW-C1", withToday]]),
    { now: NOW },
  );
  // 오늘 캔들이 섞여 들어갔다면 전일대비가 1000/9999-1이 됐을 것입니다.
  assert.equal(result.items[0].dayChangePercent, 0);
  assert.equal(result.items[0].weekVsMonthRatio, 1);
});

test("limit은 순위를 다시 매겨 자른다", () => {
  const candidates = [candidate(1), candidate(2), candidate(3)];
  const histories = new Map(candidates.map((item) => [item.market, history()]));
  const result = buildUpbitRadarResult(candidates, histories, { now: NOW, limit: 2 });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.rank), [1, 2]);
  assert.equal(result.methodology.resultLimit, 2);
});

test("서비스는 결과를 TTL 동안 캐시하고 이력 실패를 흡수한다", async () => {
  let candidateLoads = 0;
  let historyLoads = 0;
  let clock = NOW;
  const candidates = [candidate(1), candidate(2)];
  const service = new UpbitRadarService({
    loadCandidates: async () => {
      candidateLoads += 1;
      return candidates;
    },
    loadHistory: async (item) => {
      historyLoads += 1;
      if (item.market === "KRW-C2") throw new Error("일시적 오류");
      return history();
    },
  }, { clock: () => clock, resultTtlMs: 60_000 });

  const first = await service.getRadar();
  assert.equal(candidateLoads, 1);
  assert.equal(historyLoads, 2);
  assert.equal(first.coverage.historyReady, 1);
  assert.equal(first.coverage.failed, 1);

  await service.getRadar();
  assert.equal(candidateLoads, 1, "TTL 안에서는 다시 조회하지 않습니다.");

  clock = NOW + 61_000;
  await service.getRadar();
  assert.equal(candidateLoads, 2, "TTL이 지나면 다시 계산합니다.");
});

test("429는 치명적 오류로 보고 남은 이력 요청을 멈춘다", async () => {
  let historyLoads = 0;
  const rateLimited = Object.assign(new Error("too many requests"), { status: 429 });
  const service = new UpbitRadarService({
    loadCandidates: async () => Array.from({ length: 20 }, (_, i) => candidate(i + 1)),
    loadHistory: async () => {
      historyLoads += 1;
      throw rateLimited;
    },
  }, { clock: () => NOW, concurrency: 4 });

  await assert.rejects(() => service.getRadar());
  assert.ok(
    historyLoads <= 8,
    `429 이후 요청이 멈춰야 합니다. 실제 ${historyLoads}회`,
  );
});
