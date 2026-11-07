import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const { UPBIT_CATALOG_NEUTRAL_SCORE, rankUpbitCatalog } = await loadLib(
  "upbit-catalog-ranking",
);

test("추천 순위는 24시간 거래대금 내림차순 그대로다", () => {
  const ranked = rankUpbitCatalog([
    { market: "KRW-A", quoteVolume: 10, changeRate: -50 },
    { market: "KRW-B", quoteVolume: 30, changeRate: 0 },
    { market: "KRW-C", quoteVolume: 20, changeRate: 90 },
  ]);
  // 반환 순서도 거래대금순이고, recommendationRank도 같은 순서입니다.
  assert.deepEqual(ranked.map((item) => item.market), ["KRW-B", "KRW-C", "KRW-A"]);
  assert.deepEqual(ranked.map((item) => item.recommendationRank), [1, 2, 3]);
  // 등락률 가중치가 0이므로 큰 상승률이 순위를 끌어올리지 못합니다.
  assert.equal(ranked.find((item) => item.market === "KRW-C").recommendationRank, 2);
});

test("백분위는 최저 0 · 최고 100이고 동점은 중간 순위를 나눠 가진다", () => {
  const ranked = rankUpbitCatalog([
    { market: "KRW-A", quoteVolume: 10, changeRate: 1 },
    { market: "KRW-B", quoteVolume: 10, changeRate: 2 },
    { market: "KRW-C", quoteVolume: 30, changeRate: 3 },
  ]);
  const byMarket = new Map(ranked.map((item) => [item.market, item]));
  // 동점 두 종목은 0·50 자리를 나눠 각각 25점입니다.
  assert.equal(byMarket.get("KRW-A").volumeScore, 25);
  assert.equal(byMarket.get("KRW-B").volumeScore, 25);
  assert.equal(byMarket.get("KRW-C").volumeScore, 100);
});

test("등락률이 없으면 중립 50점을 주고 백분위 모집단에서 뺀다", () => {
  const ranked = rankUpbitCatalog([
    { market: "KRW-A", quoteVolume: 30, changeRate: null },
    { market: "KRW-B", quoteVolume: 20, changeRate: 10 },
    { market: "KRW-C", quoteVolume: 10, changeRate: 20 },
  ]);
  const byMarket = new Map(ranked.map((item) => [item.market, item]));
  assert.equal(byMarket.get("KRW-A").changeScore, UPBIT_CATALOG_NEUTRAL_SCORE);
  // 남은 두 종목만으로 0 / 100이 나뉩니다.
  assert.equal(byMarket.get("KRW-B").changeScore, 0);
  assert.equal(byMarket.get("KRW-C").changeScore, 100);
});

test("음수·NaN 거래대금은 0으로 눌러 순위 계산을 깨뜨리지 않는다", () => {
  const ranked = rankUpbitCatalog([
    { market: "KRW-A", quoteVolume: Number.NaN, changeRate: 0 },
    { market: "KRW-B", quoteVolume: -5, changeRate: 0 },
    { market: "KRW-C", quoteVolume: 5, changeRate: 0 },
  ]);
  const byMarket = new Map(ranked.map((item) => [item.market, item]));
  assert.equal(byMarket.get("KRW-A").quoteVolume, 0);
  assert.equal(byMarket.get("KRW-B").quoteVolume, 0);
  assert.equal(byMarket.get("KRW-C").recommendationRank, 1);
});

test("종목이 하나뿐이면 중립 점수를 준다", () => {
  const [only] = rankUpbitCatalog([{ market: "KRW-A", quoteVolume: 1, changeRate: 1 }]);
  assert.equal(only.volumeScore, UPBIT_CATALOG_NEUTRAL_SCORE);
  assert.equal(only.recommendationRank, 1);
});
