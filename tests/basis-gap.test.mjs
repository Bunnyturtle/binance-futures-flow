import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const basis = await loadLib("basis-gap");

const book = (entries) => new Map(entries.map(([coin, price, volumeUsdt]) => [coin, { price, volumeUsdt }]));
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);

test("심볼에서 USDT 마켓의 코인 이름만 떼어 낸다", () => {
  assert.equal(basis.baseOf("BTCUSDT", "USDT"), "BTC");
  assert.equal(basis.baseOf("BTC-USDT-SWAP", "-USDT-SWAP"), "BTC");
  assert.equal(basis.baseOf("ETHBTC", "USDT"), null);
  assert.equal(basis.baseOf("USDT", "USDT"), null);
});

test("숫자로 못 바꾸는 값은 0으로 본다", () => {
  assert.equal(basis.num("1.5"), 1.5);
  assert.equal(basis.num(undefined), 0);
  assert.equal(basis.num(null), 0);
  assert.equal(basis.num("abc"), 0);
});

test("현선갭은 (현물 - 선물) / 선물이고, 배수 단위 선물은 1코인 가격으로 맞춘다", () => {
  const spot = book([
    ["BTC", 101, 5e6],
    ["PEPE", 0.00001, 5e6],
    ["BABYDOGE", 2e-9, 5e6],
    ["THIN", 1, 50_000],
    ["WILD", 10, 5e6],
    ["QUIET", 1, 5e6],
  ]);
  const perp = book([
    ["BTC", 100, 5e7],
    ["1000PEPE", 0.0099, 5e7],
    ["1MBABYDOGE", 0.002, 5e7],
    ["THIN", 1.1, 5e7],
    ["WILD", 1, 5e7],
    ["QUIET", 1.01, 500_000],
    ["NOSPOT", 1, 5e7],
  ]);
  const gaps = basis.calcBasisGaps(spot, perp);
  const byCoin = new Map(gaps.map((row) => [row.coin, row]));

  assert.deepEqual([...byCoin.keys()].sort(), ["BABYDOGE", "BTC", "PEPE"]);
  close(byCoin.get("BTC").gapPct, 1, "BTC");
  assert.equal(byCoin.get("BTC").multiplier, 1);
  close(byCoin.get("PEPE").perpPrice, 0.0000099, "PEPE 선물 1코인 가격");
  close(byCoin.get("PEPE").gapPct, ((0.00001 - 0.0000099) / 0.0000099) * 100, "PEPE");
  assert.equal(byCoin.get("PEPE").multiplier, 1000);
  assert.equal(byCoin.get("BABYDOGE").multiplier, 1_000_000);
  close(byCoin.get("BABYDOGE").gapPct, 0, "BABYDOGE");
});

test("감시 목록이 있으면 그 코인만 본다", () => {
  const spot = book([["BTC", 101, 5e6], ["ETH", 10, 5e6]]);
  const perp = book([["BTC", 100, 5e7], ["ETH", 9.9, 5e7]]);
  assert.deepEqual(basis.calcBasisGaps(spot, perp, basis.BASIS_LIMITS, ["ETH"]).map((row) => row.coin), ["ETH"]);
});

test("거래소 결과를 합쳐 |갭| 큰 순으로 정렬하고 실패한 거래소도 상태에 남긴다", () => {
  const row = (coin, gapPct) => ({
    coin, gapPct, spotPrice: 1, perpPrice: 1, spotVolumeUsdt: 1e6, perpVolumeUsdt: 1e7, multiplier: 1,
  });
  const snapshot = basis.mergeBasisResults(
    [
      { exchange: "Binance", gaps: [row("AAA", 1), row("BBB", -5)], error: null },
      { exchange: "OKX", gaps: null, error: "HTTP 500 (www.okx.com)" },
      { exchange: "Bybit", gaps: [row("CCC", 3)], error: null },
    ],
    basis.BASIS_LIMITS,
    2,
    1_700_000_000_000,
  );
  assert.deepEqual(snapshot.rows.map((item) => `${item.exchange}:${item.coin}`), ["Binance:BBB", "Bybit:CCC"]);
  assert.equal(snapshot.totalRows, 3);
  assert.equal(snapshot.updated, 1_700_000_000);
  assert.deepEqual(snapshot.exchanges, [
    { exchange: "Binance", ok: true, error: null, monitored: 2 },
    { exchange: "OKX", ok: false, error: "HTTP 500 (www.okx.com)", monitored: 0 },
    { exchange: "Bybit", ok: true, error: null, monitored: 1 },
  ]);
});
