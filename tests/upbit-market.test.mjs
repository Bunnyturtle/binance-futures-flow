import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const {
  UPBIT_CHART_TIMEFRAMES,
  isUpbitChartTimeframe,
  isUpbitKrwMarket,
  normalizeUpbitMarket,
  upbitBaseAsset,
  upbitCandlePath,
  upbitCandleStreamType,
  upbitKrwTickSize,
  upbitNextCandleOpen,
  upbitPriceDecimals,
  upbitTimeframeDurationMs,
} = await loadLib("upbit-market");

test("KRW 마켓 코드만 통과시킨다", () => {
  for (const market of ["KRW-BTC", "KRW-ETH", "KRW-SHIB", "KRW-1INCH"]) {
    assert.equal(isUpbitKrwMarket(market), true, market);
  }
  for (const value of ["BTC-KRW", "BTC", "krw-btc", "USDT-BTC", "BTC-ETH", "", null, 7]) {
    assert.equal(isUpbitKrwMarket(value), false, String(value));
  }
  assert.equal(normalizeUpbitMarket(" krw-btc "), "KRW-BTC");
  assert.equal(normalizeUpbitMarket(undefined), "");
  assert.equal(upbitBaseAsset("KRW-BTC"), "BTC");
});

test("모든 봉 주기가 REST 경로와 짝을 이룬다", () => {
  assert.equal(UPBIT_CHART_TIMEFRAMES.length, 10);
  const paths = UPBIT_CHART_TIMEFRAMES.map(upbitCandlePath);
  assert.equal(new Set(paths).size, paths.length, "경로가 중복되면 안 됩니다.");
  assert.deepEqual(paths, [
    "minutes/1",
    "minutes/3",
    "minutes/5",
    "minutes/15",
    "minutes/30",
    "minutes/60",
    "minutes/240",
    "days",
    "weeks",
    "months",
  ]);
  assert.equal(isUpbitChartTimeframe("1m"), true);
  assert.equal(isUpbitChartTimeframe("7m"), false);
  assert.equal(isUpbitChartTimeframe("10m"), false);
});

test("일·주·월봉만 WebSocket 캔들 스트림이 없다", () => {
  const streamless = UPBIT_CHART_TIMEFRAMES.filter((timeframe) =>
    upbitCandleStreamType(timeframe) === null
  );
  assert.deepEqual(streamless, ["1d", "1w", "1M"]);
  assert.equal(upbitCandleStreamType("1h"), "candle.60m");
  assert.equal(upbitCandleStreamType("4h"), "candle.240m");
  assert.equal(upbitCandleStreamType("30m"), "candle.30m");
});

test("봉 경계는 달력 월까지 맞춘다", () => {
  const minuteOpen = Date.UTC(2026, 8, 18, 9, 24);
  assert.equal(upbitNextCandleOpen(minuteOpen, "1m"), minuteOpen + 60_000);
  assert.equal(upbitNextCandleOpen(minuteOpen, "15m"), minuteOpen + 15 * 60_000);
  assert.equal(upbitTimeframeDurationMs("1M"), null);
  // 길이가 다른 달을 건너뛸 때도 다음 달 1일 00:00 UTC로 떨어져야 합니다.
  assert.equal(
    upbitNextCandleOpen(Date.UTC(2026, 0, 1), "1M"),
    Date.UTC(2026, 1, 1),
  );
  assert.equal(
    upbitNextCandleOpen(Date.UTC(2026, 11, 1), "1M"),
    Date.UTC(2027, 0, 1),
  );
});

test("KRW 호가 단위가 실측한 구간과 일치한다", () => {
  // 2026-09-18 업비트 호가창에서 확인한 값입니다.
  const observed = [
    [107_783_000, 1_000], // BTC
    [3_453_000, 1_000], // ETH
    [146_100, 100], // SOL
    [343_900, 100], // BCH
    [10_920, 10], // AVAX
    [1_839, 1], // XRP
    [117, 0.1], // DOGE
    [8.92, 0.001], // JPYC
    [0.00741, 0.000001], // SHIB
    [0.000448, 0.0000001], // BTT
  ];
  for (const [price, tick] of observed) {
    assert.equal(upbitKrwTickSize(price), tick, `가격 ${price}`);
  }
  assert.equal(upbitKrwTickSize(0), 0.00000001);
  assert.equal(upbitKrwTickSize(Number.NaN), 0.00000001);
});

test("호가 단위가 정수라도 실제 가격의 소수 자릿수를 살린다", () => {
  assert.equal(upbitPriceDecimals(107_783_000), 0);
  assert.equal(upbitPriceDecimals(117), 1);
  // KRW-USDT처럼 표에 없는 0.5 호가를 쓰는 마켓은 가격 쪽 자릿수가 이깁니다.
  assert.equal(upbitPriceDecimals(1_375.5), 1);
  // 호가 단위가 가격보다 잘면 호가 쪽 자릿수를 씁니다(0.000448 → 호가 1e-7).
  assert.equal(upbitPriceDecimals(0.000448), 7);
  assert.equal(upbitPriceDecimals(0.000448, 0.000001), 6);
});
