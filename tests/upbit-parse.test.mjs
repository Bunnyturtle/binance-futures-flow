import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const { normalizeCandleList, numeric, parseUpbitUtc, record, text } = await loadLib(
  "upbit-parse",
);

// 실제 GET /v1/candles/minutes/1 응답에서 가져온 형태입니다.
const restCandle = (utc, close) => ({
  market: "KRW-BTC",
  candle_date_time_utc: utc,
  candle_date_time_kst: utc,
  opening_price: close - 1_000,
  high_price: close + 2_000,
  low_price: close - 3_000,
  trade_price: close,
  timestamp: 1_789_723_496_583,
  candle_acc_trade_price: 8_341_825.6,
  candle_acc_trade_volume: 0.077,
});

test("Z 없는 UTC 문자열을 UTC로 읽는다", () => {
  assert.equal(
    parseUpbitUtc("2026-09-18T09:24:00"),
    Date.UTC(2026, 8, 18, 9, 24),
  );
  assert.equal(parseUpbitUtc("2026-09-18T09:24:00Z"), Date.UTC(2026, 8, 18, 9, 24));
  assert.ok(Number.isNaN(parseUpbitUtc("")));
});

test("최신 봉이 먼저 오는 응답을 오름차순으로 되돌린다", () => {
  const candles = normalizeCandleList([
    restCandle("2026-09-18T09:24:00", 107_686_000),
    restCandle("2026-09-18T09:23:00", 107_600_000),
    restCandle("2026-09-18T09:22:00", 107_500_000),
  ]);
  assert.deepEqual(
    candles.map((candle) => candle.closePrice),
    [107_500_000, 107_600_000, 107_686_000],
  );
  assert.equal(candles[0].openTime, Date.UTC(2026, 8, 18, 9, 22));
  assert.equal(candles[0].timestamp, new Date(candles[0].openTime).toISOString());
  assert.equal(candles[2].quoteVolume, 8_341_825.6);
});

test("같은 시각 봉은 마지막 값으로 합쳐진다", () => {
  const candles = normalizeCandleList([
    restCandle("2026-09-18T09:24:00", 107_686_000),
    restCandle("2026-09-18T09:24:00", 107_700_000),
  ]);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].closePrice, 107_700_000);
});

test("값이 깨진 봉은 버리고 고가·저가를 시·종가로 보정한다", () => {
  const candles = normalizeCandleList([
    { candle_date_time_utc: "2026-09-18T09:24:00" },
    { ...restCandle("2026-09-18T09:25:00", 5_000), trade_price: 0 },
    { ...restCandle("2026-09-18T09:26:00", 5_000), opening_price: -1 },
    // 시가 4,000 · 종가 5,000인데 고가·저가가 뒤집혀 들어온 경우
    { ...restCandle("2026-09-18T09:27:00", 5_000), high_price: 10, low_price: 99_999 },
    "not an object",
  ]);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].openTime, Date.UTC(2026, 8, 18, 9, 27));
  assert.equal(candles[0].highPrice, 5_000);
  assert.equal(candles[0].lowPrice, 4_000);
});

test("WebSocket candle 프레임도 같은 파서를 통과한다", () => {
  // wss://api.upbit.com/websocket/v1 의 candle.1m 프레임에서 가져온 형태입니다.
  const [candle] = normalizeCandleList([{
    type: "candle.1m",
    code: "KRW-BTC",
    candle_date_time_utc: "2026-09-18T09:24:00",
    candle_date_time_kst: "2026-09-18T18:24:00",
    opening_price: 107_685_000,
    high_price: 107_686_000,
    low_price: 107_671_000,
    trade_price: 107_686_000,
    candle_acc_trade_volume: 0.07746794,
    candle_acc_trade_price: 8_341_825.60295,
    timestamp: 1_789_723_496_583,
    stream_type: "SNAPSHOT",
  }]);
  assert.equal(candle.openTime, Date.UTC(2026, 8, 18, 9, 24));
  assert.equal(candle.closePrice, 107_686_000);
  assert.equal(candle.volume, 0.07746794);
});

test("숫자·문자 헬퍼가 업비트의 문자열 숫자를 흡수한다", () => {
  const source = record({ balance: "12.5", currency: " KRW ", empty: "  " });
  assert.equal(numeric(source, "balance"), 12.5);
  assert.ok(Number.isNaN(numeric(source, "missing")));
  assert.equal(text(source, "currency"), "KRW");
  assert.equal(text(source, "empty", "fallback"), "fallback");
  assert.deepEqual(record(null), {});
});
