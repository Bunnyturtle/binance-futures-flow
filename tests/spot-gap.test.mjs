import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const gap = await loadLib("spot-gap");

test("김프 조회 조건은 기본값을 채우고 코인을 대문자로 맞춘다", () => {
  assert.deepEqual(gap.parseSpotGapQuery(new URLSearchParams()), { coin: "XRP", interval: 15, days: 7 });
  assert.deepEqual(
    gap.parseSpotGapQuery(new URLSearchParams("coin= btc &interval=60&days=99")),
    { coin: "BTC", interval: 60, days: 60 },
  );
  assert.equal(gap.parseSpotGapQuery(new URLSearchParams("days=0")).days, 1);
});

test("잘못된 코인·분봉·기간은 입력 오류로 막는다", () => {
  for (const query of ["coin=BTC-USD", "coin=", "coin=ABCDEFGHIJKLMNOP", "interval=7", "interval=abc", "days=1.5", "days=x"]) {
    assert.throws(
      () => gap.parseSpotGapQuery(new URLSearchParams(query)),
      (error) => error instanceof gap.SpotGapInputError,
      query,
    );
  }
});

test("한 번에 받는 봉은 1,000개로 제한한다", () => {
  assert.equal(gap.spotGapCandleCount(1, 1), 1000);
  assert.equal(gap.spotGapCandleCount(15, 7), 672);
  assert.equal(gap.spotGapCandleCount(60, 30), 720);
});

test("같은 봉의 업비트 환산가와 해외 가격으로 갭을 계산하고 쓸 수 없는 거래소는 이유를 남긴다", () => {
  const t0 = 1_700_000_000;
  const result = gap.computeSpotGap({
    coin: "XRP",
    interval: 15,
    period: 7,
    count: 672,
    now: (t0 + 1000) * 1000,
    coinKrw: new Map([[t0, 1500], [t0 + 900, 1530], [t0 + 1800, 1600]]),
    // t0+1800 봉은 KRW-USDT 체결이 없어 업비트 환산가가 없습니다.
    usdtKrw: new Map([[t0, 1500], [t0 + 900, 1500]]),
    venues: [
      { name: "Binance", symbol: "XRPUSDT", result: { ok: true, closes: new Map([[t0 + 900, 1], [t0, 0.98], [t0 + 1800, 1.1]]) } },
      { name: "Bybit", symbol: "XRPUSDT", result: { ok: false, error: new gap.SpotGapLookupError("Not supported symbols") } },
      { name: "Bitget", symbol: "XRPUSDT", result: { ok: false, error: new gap.SpotGapHttpError(400, "https://api.bitget.com/x") } },
      { name: "Gate", symbol: "XRP_USDT", result: { ok: false, error: new Error("socket hang up") } },
      { name: "OKX", symbol: "XRP-USDT", result: { ok: true, closes: new Map([[t0, 0.0001], [t0 + 900, 0.0001]]) } },
      { name: "Late", symbol: "XRPUSDT", result: { ok: true, closes: new Map([[t0 + 1800, 1]]) } },
    ],
  });

  assert.deepEqual(result.price, [[t0, 1, 1500], [t0 + 900, 1.02, 1530]]);
  assert.equal(result.days, 7);
  assert.equal(result.period, 7);
  assert.equal(result.updated, t0 + 1000);

  const [binance, bybit, bitget, gate, okx, late] = result.venues;
  assert.deepEqual(binance.gap, [[t0, 2.0408, 0.98], [t0 + 900, 2, 1]]);
  assert.equal(binance.error, null);
  assert.equal(bybit.error, "미상장 (이 거래소 현물에 없는 심볼)");
  assert.equal(bitget.error, "미상장 (이 거래소 현물에 없는 심볼)");
  assert.equal(gate.error, "조회 실패 (socket hang up)");
  assert.deepEqual(okx.gap, []);
  assert.equal(okx.error, "티커만 같은 다른 코인 (이 거래소 0.0001 USDT, 업비트 환산 1.02 USDT)");
  assert.equal(late.error, "업비트와 겹치는 봉이 없음");
});

test("상장 직후처럼 업비트가 크게 비싸도 300% 안쪽이면 같은 코인으로 본다", () => {
  const t0 = 1_700_000_000;
  const result = gap.computeSpotGap({
    coin: "NEW",
    interval: 1,
    period: 1,
    count: 1000,
    coinKrw: new Map([[t0, 3000]]),
    usdtKrw: new Map([[t0, 1000]]),
    venues: [{ name: "Binance", symbol: "NEWUSDT", result: { ok: true, closes: new Map([[t0, 1]]) } }],
  });
  assert.deepEqual(result.venues[0].gap, [[t0, 200, 1]]);
});
