import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const alerts = await loadLib("basis-alerts");

const settings = { thresholdPct: 3, cooldownSec: 600, realertStepPct: 2, exchanges: ["Binance", "OKX"] };
const row = (exchange, coin, gapPct) => ({ exchange, coin, gapPct, spotPrice: 1, perpPrice: 1 });
const coins = (result) => result.events.map((event) => `${event.exchange}:${event.coin}`);

test("기준 이상인 종목만 알리고, 쿨다운 동안은 더 벌어질 때만 다시 알린다", () => {
  const first = alerts.collectBasisAlerts(
    [row("Binance", "AAA", 3.2), row("Binance", "BBB", 2.9), row("OKX", "CCC", -4)],
    {},
    settings,
    0,
  );
  assert.deepEqual(coins(first), ["Binance:AAA", "OKX:CCC"]);

  const quiet = alerts.collectBasisAlerts([row("Binance", "AAA", 4)], first.memory, settings, 60_000);
  assert.deepEqual(coins(quiet), [], "3.2%에서 2%p 더 벌어지기 전에는 조용합니다");

  const wider = alerts.collectBasisAlerts([row("Binance", "AAA", -5.3)], first.memory, settings, 120_000);
  assert.deepEqual(coins(wider), ["Binance:AAA"], "|갭|이 5.2% 이상이면 쿨다운 중에도 알립니다");

  const later = alerts.collectBasisAlerts([row("Binance", "AAA", 3.1)], wider.memory, settings, 120_000 + 600_000);
  assert.deepEqual(coins(later), ["Binance:AAA"], "쿨다운이 지나면 다시 알립니다");
});

test("꺼 둔 거래소는 알리지 않는다", () => {
  const result = alerts.collectBasisAlerts([row("Bybit", "AAA", 9)], {}, settings, 0);
  assert.deepEqual(result.events, []);
});

test("원래 기록은 바꾸지 않고 새 기록을 돌려준다", () => {
  const memory = Object.freeze({});
  const result = alerts.collectBasisAlerts([row("Binance", "AAA", 3)], memory, settings, 5);
  assert.deepEqual(memory, {});
  assert.deepEqual(result.memory, { "Binance:AAA": { at: 5, absGap: 3 } });
});

test("쿨다운이 지난 기록은 정리한다", () => {
  const memory = { "Binance:OLD": { at: 0, absGap: 4 }, "Binance:NEW": { at: 500_000, absGap: 4 } };
  assert.deepEqual(Object.keys(alerts.pruneBasisAlertMemory(memory, 600, 700_000)), ["Binance:NEW"]);
});

test("갭 부호로 방향을 적는다", () => {
  assert.equal(alerts.describeBasisDirection(1.2), "현물 > 선물");
  assert.equal(alerts.describeBasisDirection(-1.2), "선물 > 현물");
});
