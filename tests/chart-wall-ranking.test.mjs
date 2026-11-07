import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const {
  WALL_REFRESH_MS,
  WALL_SLOT_COUNT,
  WALL_USER_PINNED_SLOT_COUNT,
  sameMarketLayout,
  selectWallMarkets,
  wallRefreshDelay,
} = await loadLib("chart-wall-ranking");

function candidates(count = WALL_SLOT_COUNT, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    market: `KRW-C${index + 1}`,
    recommendationRank: index + 1,
    rankingScore: 100 - index,
    quoteVolume: (count - index) * 1_000_000,
    lastPrice: 1_000 + index,
    ...overrides[index],
  }));
}

test("고정 슬롯을 지키고 나머지를 거래대금 순으로 채운다", () => {
  const markets = selectWallMarkets(candidates(), WALL_SLOT_COUNT, ["KRW-BTC", "KRW-ETH"]);
  assert.equal(markets.length, WALL_SLOT_COUNT);
  assert.deepEqual(markets.slice(0, WALL_USER_PINNED_SLOT_COUNT), ["KRW-BTC", "KRW-ETH"]);
  assert.deepEqual(markets.slice(WALL_USER_PINNED_SLOT_COUNT), [
    "KRW-C1",
    "KRW-C2",
    "KRW-C3",
    "KRW-C4",
    "KRW-C5",
    "KRW-C6",
    "KRW-C7",
    "KRW-C8",
    "KRW-C9",
    "KRW-C10",
  ]);
});

test("고정 종목이 순위 안에 있으면 자동 슬롯에서 빠진다", () => {
  const markets = selectWallMarkets(candidates(), WALL_SLOT_COUNT, ["KRW-C1", "KRW-C3"]);
  assert.deepEqual(markets.slice(0, 2), ["KRW-C1", "KRW-C3"]);
  assert.equal(markets.includes("KRW-C1", 2), false);
  assert.equal(markets.includes("KRW-C3", 2), false);
  assert.equal(new Set(markets).size, WALL_SLOT_COUNT, "중복 배치가 없어야 합니다.");
});

test("비어 있는 고정 슬롯도 자리를 유지한다", () => {
  const markets = selectWallMarkets(candidates(), WALL_SLOT_COUNT, ["", ""]);
  assert.deepEqual(markets.slice(0, 2), ["", ""]);
  assert.equal(markets.length, WALL_SLOT_COUNT);
});

test("순위 1~12가 완전하지 않으면 자동 배열을 포기한다", () => {
  // 순위 구멍
  assert.deepEqual(
    selectWallMarkets(candidates(WALL_SLOT_COUNT, { 4: { recommendationRank: 99 } })),
    [],
  );
  // 후보 부족
  assert.deepEqual(selectWallMarkets(candidates(8)), []);
  // 시세 없음
  assert.deepEqual(
    selectWallMarkets(candidates(WALL_SLOT_COUNT, { 2: { lastPrice: 0 } })),
    [],
  );
  // 점수 없음
  assert.deepEqual(
    selectWallMarkets(candidates(WALL_SLOT_COUNT, { 6: { rankingScore: undefined } })),
    [],
  );
  // KRW 마켓이 아님
  assert.deepEqual(
    selectWallMarkets(candidates(WALL_SLOT_COUNT, { 1: { market: "BTC-ETH" } })),
    [],
  );
});

test("자동 재배열은 한 시간 주기로만 열린다", () => {
  const now = Date.UTC(2026, 8, 18, 9, 0);
  assert.equal(wallRefreshDelay(0, now), 0);
  assert.equal(wallRefreshDelay(now, now), WALL_REFRESH_MS);
  assert.equal(wallRefreshDelay(now - WALL_REFRESH_MS, now), 0);
  // 미래 시각이 저장돼 있으면 신뢰하지 않고 즉시 갱신을 허용합니다.
  assert.equal(wallRefreshDelay(now + 60_000, now), 0);
});

test("레이아웃 비교는 순서까지 본다", () => {
  assert.equal(sameMarketLayout(["KRW-BTC", "KRW-ETH"], ["KRW-BTC", "KRW-ETH"]), true);
  assert.equal(sameMarketLayout(["KRW-BTC", "KRW-ETH"], ["KRW-ETH", "KRW-BTC"]), false);
  assert.equal(sameMarketLayout(["KRW-BTC"], ["KRW-BTC", "KRW-ETH"]), false);
});
