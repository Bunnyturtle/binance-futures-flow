import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypescript(relativeUrl) {
  const sourceUrl = new URL(relativeUrl, import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourceUrl.pathname,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    reportDiagnostics: true,
  });
  const errors = output.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length) {
    throw new Error(errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    ).join("\n"));
  }
  const encoded = Buffer.from(`${output.outputText}\n//# sourceURL=${sourceUrl.href}`).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const radar = await importTypescript("../lib/binance-radar.ts");
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 7, 22, 12);
const TODAY = Date.UTC(2026, 7, 22);

function candidate(symbol, options = {}) {
  return {
    symbol,
    name: `${symbol.replace(/USDT$/, "")}/USDT`,
    baseAsset: symbol.replace(/USDT$/, ""),
    segment: options.segment ?? "crypto",
    lastPrice: options.lastPrice ?? 110,
    changeRate: options.changeRate ?? 3,
    quoteVolume24h: options.quoteVolume24h ?? 100,
    tickSize: options.tickSize ?? "0.01",
    onboardDate: options.onboardDate ?? TODAY - 100 * DAY_MS,
  };
}

function dailyHistory({ monthVolume = 100, weekVolume = monthVolume, closePrice = 100 } = {}) {
  return Array.from({ length: 30 }, (_, index) => {
    const openTime = TODAY - (30 - index) * DAY_MS;
    return {
      openTime,
      closeTime: openTime + DAY_MS - 1,
      closePrice,
      quoteVolume: index >= 23 ? weekVolume : monthVolume,
    };
  });
}

test("scores the combined crypto and TradFi population with exact 50:30:20 percentiles", () => {
  const candidates = [
    candidate("AAAUSDT", { quoteVolume24h: 300, lastPrice: 110 }),
    candidate("BBBUSDT", { quoteVolume24h: 200, lastPrice: 100, segment: "tradfi" }),
    candidate("CCCUSDT", { quoteVolume24h: 100, lastPrice: 120 }),
  ];
  const histories = new Map([
    ["AAAUSDT", dailyHistory({ monthVolume: 100, weekVolume: 50 })],
    ["BBBUSDT", dailyHistory({ monthVolume: 100, weekVolume: 300 })],
    ["CCCUSDT", dailyHistory({ monthVolume: 100, weekVolume: 150 })],
  ]);
  const result = radar.buildBinanceRadarResult(candidates, histories, { now: NOW });
  const bySymbol = new Map(result.items.map((item) => [item.symbol, item]));

  assert.equal(result.coverage.eligible, 3);
  assert.equal(result.coverage.analyzed, 3);
  assert.equal(result.coverage.historyReady, 3);
  assert.equal(bySymbol.get("AAAUSDT").sizeScore, 100);
  assert.equal(bySymbol.get("AAAUSDT").weekScore, 0);
  assert.equal(bySymbol.get("AAAUSDT").dayScore, 50);
  assert.equal(bySymbol.get("AAAUSDT").score, 60);
  assert.equal(bySymbol.get("BBBUSDT").sizeScore, 50);
  assert.equal(bySymbol.get("BBBUSDT").weekScore, 100);
  assert.equal(bySymbol.get("BBBUSDT").dayScore, 0);
  assert.equal(bySymbol.get("BBBUSDT").score, 55);
  assert.equal(bySymbol.get("CCCUSDT").score, 35);
  assert.equal(result.items[0].symbol, "AAAUSDT");
  assert.ok(result.items.some((item) => item.segment === "tradfi"));
});

test("uses calendar-day averages and the latest completed session close", () => {
  const source = candidate("SESSIONUSDT", { lastPrice: 150, quoteVolume24h: 1_000 });
  const history = dailyHistory({ monthVolume: 10, weekVolume: 20, closePrice: 100 });
  history.splice(-2, 1);
  const result = radar.buildBinanceRadarResult([source], new Map([[source.symbol, history]]), {
    now: NOW,
  });
  const item = result.items[0];

  assert.equal(item.weekAverageQuoteVolume, 17.1429);
  assert.equal(item.monthAverageQuoteVolume, 11.6667);
  assert.equal(item.dayChangePercent, 50);
  assert.equal(item.weekMetricReady, true);
  assert.equal(item.dayMetricReady, true);
  assert.equal(result.historyAsOf, "2026-08-21");
});

test("marks stale history provisional instead of labeling an old close as yesterday", () => {
  const source = candidate("STALEUSDT", { lastPrice: 150, quoteVolume24h: 1_000 });
  const history = dailyHistory({ monthVolume: 10, weekVolume: 20, closePrice: 100 });
  history.pop();
  const result = radar.buildBinanceRadarResult(
    [source],
    new Map([[source.symbol, history]]),
    { now: NOW },
  );
  const item = result.items[0];

  assert.equal(item.weekMetricReady, false);
  assert.equal(item.dayMetricReady, false);
  assert.equal(item.weekScore, 50);
  assert.equal(item.dayScore, 50);
  assert.equal(item.provisional, true);
});

test("does not treat a sparse two-candle response as a complete 30-day history", () => {
  const source = candidate("SPARSEUSDT", { quoteVolume24h: 1_000 });
  const full = dailyHistory();
  const sparse = [full[0], full.at(-1)];
  const result = radar.buildBinanceRadarResult(
    [source],
    new Map([[source.symbol, sparse]]),
    { now: NOW },
  );
  const item = result.items[0];

  assert.equal(item.weekMetricReady, false);
  assert.equal(item.dayMetricReady, true);
  assert.equal(item.weekScore, 50);
  assert.equal(item.provisional, true);
});

test("service rejects a snapshot when no symbol has a current completed daily window", async () => {
  const stale = dailyHistory();
  stale.pop();
  const service = new radar.BinanceRadarService({
    loadCandidates: async () => [candidate("STALESERVICEUSDT")],
    loadHistory: async () => stale,
  }, { clock: () => NOW });

  await assert.rejects(
    service.getRadar(),
    /did not contain a current completed daily history window/,
  );
});

test("analyzes only the top 40 by 24h quote volume and returns at most 20", () => {
  const candidates = Array.from({ length: 45 }, (_, index) =>
    candidate(`C${String(index).padStart(2, "0")}USDT`, {
      quoteVolume24h: 45 - index,
    })
  );
  const result = radar.buildBinanceRadarResult(candidates, new Map(), { now: NOW });

  assert.equal(result.coverage.eligible, 45);
  assert.equal(result.coverage.analyzed, 40);
  assert.equal(result.coverage.historyReady, 0);
  assert.equal(result.coverage.provisional, 40);
  assert.equal(result.coverage.failed, 40);
  assert.equal(radar.BINANCE_RADAR_RESULT_LIMIT, 20);
  assert.equal(result.items.length, radar.BINANCE_RADAR_RESULT_LIMIT);
  assert.ok(result.items.every((item) => Number(item.symbol.slice(1, 3)) < 40));
  assert.ok(result.items.every((item) => item.weekScore === 50 && item.dayScore === 50));
  assert.ok(result.items.every((item) => item.sizeScore > 0));
});

test("assigns neutral growth scores to missing history without hiding the symbol", () => {
  const withHistory = candidate("READYUSDT", { quoteVolume24h: 200 });
  const missing = candidate("MISSUSDT", { quoteVolume24h: 100 });
  const result = radar.buildBinanceRadarResult(
    [withHistory, missing],
    new Map([[withHistory.symbol, dailyHistory()]]),
    { now: NOW },
  );
  const item = result.items.find(({ symbol }) => symbol === missing.symbol);

  assert.equal(item.weekScore, 50);
  assert.equal(item.dayScore, 50);
  assert.equal(item.weekMetricReady, false);
  assert.equal(item.dayMetricReady, false);
  assert.equal(item.provisional, true);
  assert.equal(result.coverage.historyReady, 1);
  assert.equal(result.coverage.failed, 1);
});

test("uses midranks for tied component values", () => {
  const candidates = [
    candidate("AAAUSDT", { quoteVolume24h: 100 }),
    candidate("BBBUSDT", { quoteVolume24h: 100 }),
    candidate("CCCUSDT", { quoteVolume24h: 200 }),
  ];
  const result = radar.buildBinanceRadarResult(candidates, new Map(), { now: NOW });
  const bySymbol = new Map(result.items.map((item) => [item.symbol, item]));

  assert.equal(bySymbol.get("AAAUSDT").sizeScore, 25);
  assert.equal(bySymbol.get("BBBUSDT").sizeScore, 25);
  assert.equal(bySymbol.get("CCCUSDT").sizeScore, 100);
});

test("coalesces concurrent builds, caps history concurrency at six, and caches results", async () => {
  let now = NOW;
  let candidateCalls = 0;
  let historyCalls = 0;
  let active = 0;
  let maximumActive = 0;
  const candidates = Array.from({ length: 45 }, (_, index) =>
    candidate(`R${String(index).padStart(2, "0")}USDT`, { quoteVolume24h: 45 - index })
  );
  const service = new radar.BinanceRadarService({
    async loadCandidates() {
      candidateCalls += 1;
      return candidates;
    },
    async loadHistory() {
      historyCalls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return dailyHistory();
    },
  }, { clock: () => now, resultTtlMs: 1_000, concurrency: 6 });

  const [first, concurrent] = await Promise.all([service.getRadar(), service.getRadar()]);
  assert.deepEqual(first, concurrent);
  assert.equal(candidateCalls, 1);
  assert.equal(historyCalls, 40);
  assert.equal(maximumActive, 6);

  assert.deepEqual(await service.getRadar(), first);
  assert.equal(candidateCalls, 1);
  now += 1_001;
  await service.getRadar();
  assert.equal(candidateCalls, 2);
  assert.equal(historyCalls, 80);
});

test("can reuse a settled radar result without sharing a pending build", async () => {
  let candidateCalls = 0;
  let historyCalls = 0;
  const buildGates = [];
  const candidates = [candidate("BTCUSDT")];
  const service = new radar.BinanceRadarService({
    async loadCandidates() {
      candidateCalls += 1;
      await new Promise((resolve) => buildGates.push(resolve));
      return candidates;
    },
    async loadHistory() {
      historyCalls += 1;
      return dailyHistory();
    },
  }, { clock: () => NOW, coalesceInFlight: false, resultTtlMs: 1_000 });

  const first = service.getRadar();
  const second = service.getRadar();
  assert.equal(candidateCalls, 2);
  buildGates.splice(0).forEach((resolve) => resolve());
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(historyCalls, 2);

  assert.deepEqual(await service.getRadar(), secondResult);
  assert.equal(candidateCalls, 2);
  assert.equal(historyCalls, 2);
});

test("rejects and does not cache a build when every daily history request fails", async () => {
  let candidateCalls = 0;
  let historyCalls = 0;
  const service = new radar.BinanceRadarService({
    async loadCandidates() {
      candidateCalls += 1;
      return [candidate("BTCUSDT"), candidate("ETHUSDT")];
    },
    async loadHistory() {
      historyCalls += 1;
      throw new Error("upstream history unavailable");
    },
  });

  await assert.rejects(
    service.getRadar(),
    /could not load any completed daily history/,
  );
  await assert.rejects(
    service.getRadar(),
    /could not load any completed daily history/,
  );
  assert.equal(candidateCalls, 2);
  assert.equal(historyCalls, 4);
});

test("stops dispatching history after a fatal rate-limit response", async () => {
  let historyCalls = 0;
  const rateLimit = Object.assign(new Error("rate limited"), {
    status: 429,
    code: "-1003",
  });
  const candidates = Array.from({ length: 20 }, (_, index) =>
    candidate(`LIMIT${index}USDT`, { quoteVolume24h: 20 - index })
  );
  const service = new radar.BinanceRadarService({
    loadCandidates: async () => candidates,
    async loadHistory() {
      historyCalls += 1;
      throw rateLimit;
    },
  }, { concurrency: 6 });

  await assert.rejects(service.getRadar(), (error) => error === rateLimit);
  assert.ok(historyCalls <= 6, `expected at most six in-flight calls, received ${historyCalls}`);

  const banned = Object.assign(new Error("IP auto-banned"), {
    status: 418,
    code: "-1003",
  });
  const bannedService = new radar.BinanceRadarService({
    loadCandidates: async () => candidates,
    loadHistory: async () => { throw banned; },
  });
  await assert.rejects(bannedService.getRadar(), (error) => error === banned);

  const timeout = Object.assign(new Error("request timed out"), {
    status: 504,
    code: "request-timeout",
  });
  historyCalls = 0;
  const timeoutService = new radar.BinanceRadarService({
    loadCandidates: async () => candidates,
    loadHistory: async () => {
      historyCalls += 1;
      throw timeout;
    },
  }, { concurrency: 6 });
  await assert.rejects(timeoutService.getRadar(), (error) => error === timeout);
  assert.ok(historyCalls <= 6, `expected at most six timed-out calls, received ${historyCalls}`);
});

test("validates the public result limit", async () => {
  assert.throws(
    () => radar.buildBinanceRadarResult([], new Map(), { now: NOW, limit: 21 }),
    /between 1 and 20/,
  );
  const service = new radar.BinanceRadarService({
    loadCandidates: async () => [candidate("BTCUSDT")],
    loadHistory: async () => dailyHistory(),
  });
  await assert.rejects(service.getRadar(0), /between 1 and 20/);
});

test("same-origin radar route exposes the cached unified USD-M contract", async () => {
  const source = await readFile(new URL("../app/api/radar/route.ts", import.meta.url), "utf8");

  assert.match(source, /getBinanceMarketDataServiceFromEnv/);
  assert.match(source, /getRadarSourceCandidates/);
  assert.match(source, /getRadarDailyHistory/);
  assert.match(source, /coalesceInFlight:\s*false/);
  assert.match(source, /scope:\s*"USDT_PERPETUAL"/);
  assert.match(source, /source:\s*"same-origin"/);
  assert.match(source, /evaluatedCount:\s*result\.coverage\.analyzed/);
  assert.match(source, /s-maxage=840/);
  assert.doesNotMatch(source, /stale-while-revalidate/);
  assert.match(source, /parseLimit\(request\)/);
  assert.match(source, /headers:\s*NO_STORE_HEADERS/);
});
