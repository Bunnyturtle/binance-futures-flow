import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

function transpileTypescript(source, sourceUrl) {
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
  return `${output.outputText}\n//# sourceURL=${sourceUrl.href}`;
}

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function importTypescript(relativeUrl) {
  const sourceUrl = new URL(relativeUrl, import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  let output = transpileTypescript(source, sourceUrl);
  if (output.includes("../../lib/binance-radar")) {
    const radarUrl = new URL("../lib/binance-radar.ts", import.meta.url);
    const radarModule = dataModule(transpileTypescript(
      await readFile(radarUrl, "utf8"),
      radarUrl,
    ));
    output = output
      .replaceAll('"../../lib/binance-radar"', JSON.stringify(radarModule))
      .replaceAll("'../../lib/binance-radar'", JSON.stringify(radarModule));
  }
  if (output.includes("../../lib/binance-catalog-ranking")) {
    const rankingUrl = new URL("../lib/binance-catalog-ranking.ts", import.meta.url);
    const rankingModule = dataModule(transpileTypescript(
      await readFile(rankingUrl, "utf8"),
      rankingUrl,
    ));
    output = output
      .replaceAll('"../../lib/binance-catalog-ranking"', JSON.stringify(rankingModule))
      .replaceAll("'../../lib/binance-catalog-ranking'", JSON.stringify(rankingModule));
  }
  const encoded = Buffer.from(output).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const client = await importTypescript("../app/components/BinancePublicClient.tsx");

const APP_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M",
];

const REMOVED_TIMEFRAMES = ["30m", "2h", "6h", "8h", "12h", "3d"];

function exchangeSymbol(symbol, options = {}) {
  return {
    symbol,
    baseAsset: options.baseAsset ?? symbol.replace(/USDT$/, ""),
    quoteAsset: options.quoteAsset ?? "USDT",
    marginAsset: options.marginAsset ?? "USDT",
    contractType: options.contractType ?? "PERPETUAL",
    status: options.status ?? "TRADING",
    filters: [{ filterType: "PRICE_FILTER", tickSize: options.tickSize ?? "0.001" }],
    ...(options.onboardDate === undefined ? {} : { onboardDate: options.onboardDate }),
  };
}

test("browser exchange parsing preserves onboardDate for Radar history parity", () => {
  const onboardDate = Date.UTC(2026, 7, 10);
  const parsed = client.parsePublicExchangeInfo({
    symbols: [exchangeSymbol("NEWUSDT", { onboardDate })],
  });
  assert.equal(parsed[0].onboardDate, onboardDate);
});

function ticker24hr(symbol, quoteVolume, options = {}) {
  return {
    symbol,
    lastPrice: String(options.lastPrice ?? 100),
    priceChangePercent: String(options.changeRate ?? 0),
    quoteVolume: String(quoteVolume),
    closeTime: options.closeTime ?? 1_700_000_000_000,
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function dailyKlines(url, options = {}) {
  const startTime = Number(url.searchParams.get("startTime"));
  const symbol = url.searchParams.get("symbol") ?? "";
  const symbolIndex = Number(symbol.match(/(\d+)USDT$/)?.[1] ?? 0);
  return Array.from({ length: 32 }, (_, index) => {
    const openTime = startTime + index * DAY_MS;
    const recentMultiplier = index >= 25
      ? (options.recentMultiplier ?? 1 + symbolIndex / 50)
      : 1;
    const quoteVolume = (options.baseVolume ?? 10_000 + symbolIndex * 100) * recentMultiplier;
    const closePrice = options.closePrice ?? 100 + symbolIndex / 10;
    return [
      openTime,
      String(closePrice),
      String(closePrice + 1),
      String(closePrice - 1),
      String(closePrice),
      "10",
      openTime + DAY_MS - 1,
      String(quoteVolume),
    ];
  });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function assertPublicRequest(input, init) {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://fapi.binance.com");
  assert.equal(init.method, "GET");
  assert.equal(init.mode, "cors");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.equal(init.referrerPolicy, "no-referrer");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("X-MBX-APIKEY"), null);
  assert.equal(headers.get("Authorization"), null);
}

test("browser CRYPTO catalog keeps every eligible perpetual and mirrors volume-only scoring", async () => {
  client.clearBinancePublicClientCache();
  const eligible = Array.from({ length: 14 }, (_, index) =>
    exchangeSymbol(`COIN${index}USDT`, {
      baseAsset: `COIN${index}`,
      tickSize: index === 13 ? "0.0001" : "0.01",
    })
  ).reverse();
  const exchangeInfo = {
    symbols: [
      ...eligible,
      exchangeSymbol("QUARTERUSDT", { contractType: "CURRENT_QUARTER" }),
      exchangeSymbol("PAUSEDUSDT", { status: "SETTLING" }),
      exchangeSymbol("USDCONLY", { quoteAsset: "USDC" }),
    ],
  };
  const tickers = eligible
    .filter(({ symbol }) => symbol !== "COIN0USDT" && symbol !== "COIN1USDT")
    .map(({ symbol }) => {
      const index = Number(symbol.match(/COIN(\d+)USDT/)?.[1]);
      return ticker24hr(symbol, index >= 12 ? 100_000 : index * 100, {
        lastPrice: 100 + index,
        changeRate: index / 10,
        closeTime: 1_700_000_000_000 + index,
      });
    });
  const calls = [];
  const fetch = async (input, init) => {
    calls.push([input, init]);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exchangeInfo")) return json(exchangeInfo);
    if (url.pathname.endsWith("/ticker/24hr")) return json(tickers);
    return json({ msg: "unexpected" }, 404);
  };

  const items = await client.loadPublicFuturesCatalog(undefined, { fetch });
  assert.equal(items.length, 14);
  assert.deepEqual(items.slice(0, 2).map(({ symbol }) => symbol), [
    "COIN12USDT",
    "COIN13USDT",
  ]);
  assert.deepEqual(items.slice(-2).map(({ symbol }) => symbol), [
    "COIN0USDT",
    "COIN1USDT",
  ]);
  assert.deepEqual(items.find(({ symbol }) => symbol === "COIN13USDT"), {
    rank: 2,
    symbol: "COIN13USDT",
    name: "COIN13/USDT",
    baseAsset: "COIN13",
    quoteAsset: "USDT",
    currency: "USDT",
    lastPrice: 113,
    changeRate: 1.3,
    quoteVolume: 100_000,
    priceTimestamp: new Date(1_700_000_000_013).toISOString(),
    tickSize: "0.0001",
    rankingScore: 96.15,
    volumeScore: 96.15,
    changeScore: 100,
    recommendationRank: 2,
  });
  const missingTicker = items.find(({ symbol }) => symbol === "COIN0USDT");
  assert.deepEqual(
    (({ lastPrice, changeRate, quoteVolume, changeScore }) => ({
      lastPrice,
      changeRate,
      quoteVolume,
      changeScore,
    }))(missingTicker),
    { lastPrice: 0, changeRate: 0, quoteVolume: 0, changeScore: 50 },
  );
  assert.equal(missingTicker.rank, items.findIndex(({ symbol }) => symbol === "COIN0USDT") + 1);
  assert.ok(items.every((item) => item.currency === "USDT"));
  const universe = await client.loadPublicFuturesUniverse(undefined, { fetch });
  assert.equal(universe.length, 12);
  assert.deepEqual(
    universe.slice(0, 2).map(({ symbol }) => symbol),
    ["COIN12USDT", "COIN13USDT"],
  );
  assert.ok(universe.every((item) => !("rankingScore" in item)));
  assert.equal(calls.length, 2);
  assert.equal(
    calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/ticker/24hr")).length,
    1,
  );
  for (const [input, init] of calls) assertPublicRequest(input, init);
});

test("browser CRYPTO recommendation TOP12 matches its volume-ordered catalog TOP12", async () => {
  client.clearBinancePublicClientCache();
  const specifications = Array.from({ length: 13 }, (_, index) => ({
    symbol: `ORDER${String(index).padStart(2, "0")}USDT`,
    quoteVolume: (13 - index) * 100,
    changeRate: index === 12 ? 100 : index === 11 ? -100 : 0,
  }));
  const exchangeInfo = {
    symbols: specifications.map(({ symbol }) => exchangeSymbol(symbol)).reverse(),
  };
  const tickers = specifications.map(({ symbol, quoteVolume, changeRate }) =>
    ticker24hr(symbol, quoteVolume, { changeRate })
  );
  const fetch = async (input) =>
    new URL(String(input)).pathname.endsWith("/exchangeInfo")
      ? json(exchangeInfo)
      : json(tickers);

  const catalog = await client.loadPublicFuturesCatalog(undefined, { fetch });
  assert.deepEqual(
    catalog.map(({ symbol, rank }) => ({ symbol, rank })),
    specifications.map(({ symbol }, index) => ({ symbol, rank: index + 1 })),
  );
  const recommendationTop12 = catalog
    .filter(({ recommendationRank }) => recommendationRank <= 12)
    .sort((left, right) => left.recommendationRank - right.recommendationRank);
  assert.deepEqual(
    recommendationTop12.map(({ symbol }) => symbol),
    catalog.slice(0, 12).map(({ symbol }) => symbol),
  );
  assert.equal(recommendationTop12.some(({ symbol }) => symbol === "ORDER12USDT"), false);
  assert.equal(recommendationTop12.some(({ symbol }) => symbol === "ORDER11USDT"), true);
  assert.ok(catalog.every(({ rankingScore, volumeScore, changeScore, recommendationRank }) =>
    Number.isFinite(rankingScore) &&
    Number.isFinite(volumeScore) &&
    Number.isFinite(changeScore) &&
    Number.isInteger(recommendationRank)
  ));
});

test("browser CRYPTO catalog keeps invalid change-rate tickers with a neutral change score", async () => {
  client.clearBinancePublicClientCache();
  const exchangeInfo = {
    symbols: ["HIGHUSDT", "UNKNOWNUSDT", "BOTTOMUSDT"].map((symbol) => exchangeSymbol(symbol)),
  };
  const tickers = [
    ticker24hr("HIGHUSDT", 300, { changeRate: -1 }),
    { ...ticker24hr("UNKNOWNUSDT", 200), priceChangePercent: "   " },
    ticker24hr("BOTTOMUSDT", 100, { changeRate: 1 }),
  ];
  const parsed = client.parsePublicTickers(tickers);
  assert.deepEqual(
    parsed.find(({ symbol }) => symbol === "UNKNOWNUSDT"),
    {
      symbol: "UNKNOWNUSDT",
      lastPrice: 100,
      changeRate: null,
      quoteVolume: 200,
      closeTime: 1_700_000_000_000,
    },
  );
  const fetch = async (input) =>
    new URL(String(input)).pathname.endsWith("/exchangeInfo")
      ? json(exchangeInfo)
      : json(tickers);
  const catalog = await client.loadPublicFuturesCatalog(undefined, { fetch });
  const unknown = catalog.find(({ symbol }) => symbol === "UNKNOWNUSDT");
  assert.deepEqual(
    (({ changeRate, rankingScore, volumeScore, changeScore }) => ({
      changeRate,
      rankingScore,
      volumeScore,
      changeScore,
    }))(unknown),
    { changeRate: 0, rankingScore: 50, volumeScore: 50, changeScore: 50 },
  );
});

test("browser catalogs separate segments and share cold exchangeInfo and 24h ticker flights", async () => {
  client.clearBinancePublicClientCache();
  const crypto = Array.from({ length: 2 }, (_, index) =>
    exchangeSymbol(`CRYPTO${index}USDT`, { baseAsset: `CRYPTO${index}` })
  );
  const tradfi = Array.from({ length: 13 }, (_, index) =>
    exchangeSymbol(`STOCK${index}USDT`, {
      baseAsset: `STOCK${index}`,
      contractType: "TRADIFI_PERPETUAL",
      tickSize: index === 12 ? "0.0001" : "0.01",
    })
  );
  const exchangeInfo = {
    symbols: [
      ...crypto,
      ...tradfi,
      exchangeSymbol("WRONGMARGINUSDT", {
        contractType: "TRADIFI_PERPETUAL",
        marginAsset: "USDC",
      }),
      exchangeSymbol("MISSPELLEDUSDT", { contractType: "TRADFI_PERPETUAL" }),
      exchangeSymbol("PAUSEDSTOCKUSDT", {
        contractType: "TRADIFI_PERPETUAL",
        status: "SETTLING",
      }),
    ],
  };
  const tickerPayload = [
    ...crypto.map(({ symbol }, index) => ticker24hr(symbol, 2_000 - index * 1_000)),
    ...tradfi.map(({ symbol }, index) =>
      ticker24hr(symbol, index >= 11 ? 5_000 : index * 100, {
        lastPrice: 10 + index,
        changeRate: index,
        closeTime: 1_700_000_100_000 + index,
      })
    ),
  ];
  let exchangeInfoCalls = 0;
  let tickerCalls = 0;
  const fetch = async (input, init) => {
    assertPublicRequest(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exchangeInfo")) {
      exchangeInfoCalls += 1;
      return json(exchangeInfo);
    }
    if (url.pathname.endsWith("/ticker/24hr")) {
      tickerCalls += 1;
      return json(tickerPayload);
    }
    return json({ msg: "unexpected" }, 404);
  };

  const parsedSymbols = client.parsePublicExchangeInfo(exchangeInfo);
  assert.equal(parsedSymbols.length, crypto.length + tradfi.length);
  assert.deepEqual(
    parsedSymbols.find((item) => item.symbol === "STOCK12USDT"),
    {
      symbol: "STOCK12USDT",
      baseAsset: "STOCK12",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      contractType: "TRADIFI_PERPETUAL",
      tickSize: "0.0001",
    },
  );
  assert.ok(!parsedSymbols.some((item) => item.symbol === "WRONGMARGINUSDT"));
  assert.ok(!parsedSymbols.some((item) => item.symbol === "MISSPELLEDUSDT"));

  const [cryptoItems, tradfiItems] = await Promise.all([
    client.loadPublicFuturesCatalog(undefined, { fetch }),
    client.loadPublicFuturesCatalog(undefined, { fetch, segment: "tradfi" }),
  ]);

  assert.equal(exchangeInfoCalls, 1, "cold catalog requests should share one exchangeInfo flight");
  assert.equal(tickerCalls, 1, "cold catalog requests should share one 24h ticker flight");
  assert.equal(cryptoItems.length, 2);
  assert.ok(cryptoItems.every((item) => item.symbol.startsWith("CRYPTO")));
  assert.equal(tradfiItems.length, 13);
  assert.deepEqual(tradfiItems.slice(0, 2).map(({ symbol }) => symbol), [
    "STOCK11USDT",
    "STOCK12USDT",
  ]);
  assert.ok(
    tradfiItems.every((item, index) =>
      index === 0 || tradfiItems[index - 1].quoteVolume >= item.quoteVolume
    ),
  );
  assert.equal(
    tradfiItems.find(({ symbol }) => symbol === "STOCK12USDT").tickSize,
    "0.0001",
  );
  assert.ok(tradfiItems.every((item) => item.symbol.startsWith("STOCK")));

  await Promise.all([
    client.loadPublicFuturesCatalog(undefined, { fetch }),
    client.loadPublicFuturesCatalog(undefined, { fetch, segment: "tradfi" }),
  ]);
  assert.equal(exchangeInfoCalls, 1, "warm catalogs should reuse exchangeInfo for five minutes");
  assert.equal(tickerCalls, 1, "warm catalogs should reuse 24h tickers for five minutes");

  client.clearBinancePublicClientCache();
  await assert.rejects(
    client.loadPublicFuturesCatalog(undefined, {
      segment: "tradfi",
      fetch: async (input) => new URL(String(input)).pathname.endsWith("/exchangeInfo")
        ? json({ symbols: [exchangeSymbol("BTCUSDT")] })
        : json([ticker24hr("BTCUSDT", 1_000)]),
    }),
    /TRADFI.*없습니다/,
  );
});

test("empty or wholly invalid 24h ticker responses fail and are not cached", async () => {
  client.clearBinancePublicClientCache();
  const exchangeInfo = {
    symbols: [exchangeSymbol("BTCUSDT", { baseAsset: "BTC" })],
  };
  let exchangeInfoCalls = 0;
  let tickerCalls = 0;
  const fetch = async (input, init) => {
    assertPublicRequest(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exchangeInfo")) {
      exchangeInfoCalls += 1;
      return json(exchangeInfo);
    }
    if (url.pathname.endsWith("/ticker/24hr")) {
      tickerCalls += 1;
      return json(tickerCalls === 1 ? [] : [ticker24hr("BTCUSDT", 10_000)]);
    }
    return json({ msg: "unexpected" }, 404);
  };

  await assert.rejects(
    client.loadPublicFuturesCatalog(undefined, { fetch }),
    (error) => error.code === "invalid-response" && /사용 가능한 ticker가 없습니다/.test(error.message),
  );
  const recovered = await client.loadPublicFuturesCatalog(undefined, { fetch });
  assert.equal(recovered[0].symbol, "BTCUSDT");
  assert.equal(recovered[0].quoteVolume, 10_000);
  assert.equal(exchangeInfoCalls, 1, "a ticker parse failure should not discard valid exchangeInfo");
  assert.equal(tickerCalls, 2, "an empty ticker response must not enter the five-minute cache");

  assert.throws(
    () => client.parsePublicTickers([
      ticker24hr("BTCUSDT", 1_000, { lastPrice: 0 }),
      { symbol: "ETHUSDT", lastPrice: "100", quoteVolume: "bad" },
    ]),
    (error) => error.code === "invalid-response" && /사용 가능한 ticker가 없습니다/.test(error.message),
  );
});

test("a segment-mismatched ticker response fails and is evicted before retry", async () => {
  client.clearBinancePublicClientCache();
  const exchangeInfo = {
    symbols: [
      exchangeSymbol("BTCUSDT", { baseAsset: "BTC" }),
      exchangeSymbol("STOCKUSDT", {
        baseAsset: "STOCK",
        contractType: "TRADIFI_PERPETUAL",
      }),
    ],
  };
  let exchangeInfoCalls = 0;
  let tickerCalls = 0;
  const fetch = async (input, init) => {
    assertPublicRequest(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exchangeInfo")) {
      exchangeInfoCalls += 1;
      return json(exchangeInfo);
    }
    if (url.pathname.endsWith("/ticker/24hr")) {
      tickerCalls += 1;
      return json(tickerCalls === 1
        ? [ticker24hr("BTCUSDT", 20_000)]
        : [ticker24hr("STOCKUSDT", 30_000)]);
    }
    return json({ msg: "unexpected" }, 404);
  };

  await assert.rejects(
    client.loadPublicFuturesCatalog(undefined, { fetch, segment: "tradfi" }),
    (error) => error.code === "invalid-response" && /일치하는 24시간 ticker가 없습니다/.test(error.message),
  );
  const recovered = await client.loadPublicFuturesCatalog(undefined, { fetch, segment: "tradfi" });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].symbol, "STOCKUSDT");
  assert.equal(recovered[0].quoteVolume, 30_000);
  assert.equal(exchangeInfoCalls, 1);
  assert.equal(tickerCalls, 2, "a segment-mismatched ticker payload must be evicted before retry");
});

test("browser radar combines exact crypto and tradfi candidates, limits history concurrency, and shares one UTC snapshot", async () => {
  client.clearBinancePublicClientCache();
  const eligible = Array.from({ length: 45 }, (_, index) =>
    exchangeSymbol(`RADAR${index}USDT`, {
      baseAsset: `RADAR${index}`,
      contractType: index % 3 === 0 ? "TRADIFI_PERPETUAL" : "PERPETUAL",
      tickSize: index % 2 === 0 ? "0.01" : "0.001",
    })
  );
  const exchangeInfo = {
    symbols: [
      ...eligible,
      exchangeSymbol("USDCONLY", { quoteAsset: "USDC", marginAsset: "USDC" }),
      exchangeSymbol("DELIVERYUSDT", { contractType: "CURRENT_QUARTER" }),
      exchangeSymbol("TYPOUSDT", { contractType: "TRADFI_PERPETUAL" }),
      exchangeSymbol("HALTEDUSDT", { status: "SETTLING" }),
    ],
  };
  const tickers = eligible.map(({ symbol }, index) =>
    ticker24hr(symbol, 1_000_000 + index * 10_000, {
      lastPrice: 120 + index,
      changeRate: index / 10,
    })
  );
  let exchangeCalls = 0;
  let tickerCalls = 0;
  let klineCalls = 0;
  let activeKlines = 0;
  let maximumConcurrentKlines = 0;
  const requestedSymbols = [];
  const fetch = async (input, init) => {
    assertPublicRequest(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exchangeInfo")) {
      exchangeCalls += 1;
      return json(exchangeInfo);
    }
    if (url.pathname.endsWith("/ticker/24hr")) {
      tickerCalls += 1;
      return json(tickers);
    }
    if (url.pathname.endsWith("/klines")) {
      klineCalls += 1;
      activeKlines += 1;
      maximumConcurrentKlines = Math.max(maximumConcurrentKlines, activeKlines);
      requestedSymbols.push(url.searchParams.get("symbol"));
      assert.equal(url.searchParams.get("interval"), "1d");
      assert.equal(url.searchParams.get("limit"), "32");
      const startTime = Number(url.searchParams.get("startTime"));
      const endTime = Number(url.searchParams.get("endTime"));
      assert.ok(Number.isFinite(startTime) && Number.isFinite(endTime));
      assert.equal(endTime - startTime + 1, 32 * DAY_MS);
      assert.equal((endTime + 1) % DAY_MS, 0);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeKlines -= 1;
      return json(dailyKlines(url));
    }
    return json({ msg: "unexpected" }, 404);
  };

  const [first, shared] = await Promise.all([
    client.loadPublicFuturesRadar(undefined, { fetch }),
    client.loadPublicFuturesRadar(undefined, { fetch }),
  ]);
  assert.equal(exchangeCalls, 1);
  assert.equal(tickerCalls, 1);
  assert.equal(klineCalls, 40);
  assert.ok(maximumConcurrentKlines <= 6);
  assert.ok(maximumConcurrentKlines >= 2);
  assert.deepEqual(
    [...new Set(requestedSymbols)].sort(),
    eligible.slice(5).map(({ symbol }) => symbol).sort(),
    "only the combined-universe top 40 by 24h quote volume receive history requests",
  );
  assert.equal(first.mode, "LIVE");
  assert.equal(first.source, "browser-public-rest");
  assert.equal(first.market, "USD-M");
  assert.equal(first.scope, "USDT_PERPETUAL");
  assert.equal(first.timestamp, first.computedAt);
  assert.equal(first.items.length, 20);
  assert.equal(first.coverage.eligible, 45);
  assert.equal(first.coverage.analyzed, 40);
  assert.equal(first.coverage.historyReady, 40);
  assert.equal(first.coverage.failed, 0);
  assert.equal(first.eligibleCount, 45);
  assert.equal(first.evaluatedCount, 40);
  assert.equal(first.historyReadyCount, 40);
  assert.ok(first.items.some((item) => item.segment === "crypto"));
  assert.ok(first.items.some((item) => item.segment === "tradfi"));
  assert.ok(first.items.every((item) =>
    Number.isFinite(item.sizeScore) &&
    Number.isFinite(item.weekScore) &&
    Number.isFinite(item.dayScore) &&
    Number.isFinite(item.score)
  ));
  assert.deepEqual(
    shared.items.map(({ symbol, score }) => ({ symbol, score })),
    first.items.map(({ symbol, score }) => ({ symbol, score })),
    "concurrent Radar callers share market-data flights and the same business ranking",
  );

  const warm = await client.loadPublicFuturesRadar(undefined, { fetch });
  assert.deepEqual(
    warm.items.map(({ symbol, score }) => ({ symbol, score })),
    first.items.map(({ symbol, score }) => ({ symbol, score })),
  );
  assert.equal(klineCalls, 40, "the completed UTC history snapshot should stay warm");

  client.clearBinancePublicClientCache();
  await client.loadPublicFuturesRadar(undefined, { fetch });
  assert.equal(exchangeCalls, 2);
  assert.equal(tickerCalls, 2);
  assert.equal(klineCalls, 80, "clearing the public client also clears radar histories");
});

test("browser radar scores partial history failures provisionally and retries uncached misses", async () => {
  client.clearBinancePublicClientCache();
  const eligible = Array.from({ length: 16 }, (_, index) =>
    exchangeSymbol(`PARTIAL${index}USDT`, {
      baseAsset: `PARTIAL${index}`,
      contractType: index % 2 ? "TRADIFI_PERPETUAL" : "PERPETUAL",
    })
  );
  const failedSymbols = new Set(eligible.slice(-3).map(({ symbol }) => symbol));
  let recoverFailures = false;
  let failedHistoryCalls = 0;
  const fetch = async (input, init) => {
    assertPublicRequest(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exchangeInfo")) {
      return json({ symbols: eligible });
    }
    if (url.pathname.endsWith("/ticker/24hr")) {
      return json(eligible.map(({ symbol }, index) =>
        ticker24hr(symbol, 10_000 + index * 10_000, { lastPrice: 100 + index })
      ));
    }
    if (url.pathname.endsWith("/klines")) {
      const symbol = url.searchParams.get("symbol");
      if (failedSymbols.has(symbol) && !recoverFailures) {
        failedHistoryCalls += 1;
        return json([]);
      }
      return json(dailyKlines(url));
    }
    return json({ msg: "unexpected" }, 404);
  };

  const partial = await client.loadPublicFuturesRadar(undefined, { fetch });
  assert.equal(partial.coverage.analyzed, 16);
  assert.equal(partial.coverage.historyReady, 13);
  assert.equal(partial.coverage.provisional, 3);
  assert.equal(partial.coverage.failed, 3);
  assert.ok(partial.items.some((item) => item.provisional));
  assert.equal(failedHistoryCalls, 3);

  recoverFailures = true;
  const recovered = await client.loadPublicFuturesRadar(undefined, { fetch });
  assert.equal(recovered.coverage.historyReady, 16);
  assert.equal(recovered.coverage.provisional, 0);
  assert.equal(recovered.coverage.failed, 0);
  assert.equal(failedHistoryCalls, 3, "only successful histories are cached; misses are retried");
});

test("browser radar rejects rate limits and an entirely empty history snapshot", async () => {
  const eligible = Array.from({ length: 8 }, (_, index) =>
    exchangeSymbol(`FAIL${index}USDT`, { baseAsset: `FAIL${index}` })
  );
  const tickerPayload = eligible.map(({ symbol }, index) =>
    ticker24hr(symbol, 10_000 + index * 1_000)
  );

  client.clearBinancePublicClientCache();
  await assert.rejects(
    client.loadPublicFuturesRadar(undefined, {
      fetch: async (input, init) => {
        assertPublicRequest(input, init);
        const url = new URL(String(input));
        if (url.pathname.endsWith("/exchangeInfo")) return json({ symbols: eligible });
        if (url.pathname.endsWith("/ticker/24hr")) return json(tickerPayload);
        if (url.pathname.endsWith("/klines")) {
          return url.searchParams.get("symbol") === "FAIL7USDT"
            ? json({ msg: "Too many requests" }, 429)
            : json(dailyKlines(url));
        }
        return json({ msg: "unexpected" }, 404);
      },
    }),
    (error) => error.code === "http" && error.status === 429,
  );

  client.clearBinancePublicClientCache();
  await assert.rejects(
    client.loadPublicFuturesRadar(undefined, {
      fetch: async (input, init) => {
        assertPublicRequest(input, init);
        const url = new URL(String(input));
        if (url.pathname.endsWith("/exchangeInfo")) return json({ symbols: eligible });
        if (url.pathname.endsWith("/ticker/24hr")) return json(tickerPayload);
        if (url.pathname.endsWith("/klines")) {
          return url.searchParams.get("symbol") === "FAIL7USDT"
            ? json({ msg: "Unavailable for legal reasons" }, 451)
            : json(dailyKlines(url));
        }
        return json({ msg: "unexpected" }, 404);
      },
    }),
    (error) => error.code === "http" && error.status === 451,
  );

  client.clearBinancePublicClientCache();
  let unavailableHistoryCalls = 0;
  await assert.rejects(
    client.loadPublicFuturesRadar(undefined, {
      fetch: async (input, init) => {
        assertPublicRequest(input, init);
        const url = new URL(String(input));
        if (url.pathname.endsWith("/exchangeInfo")) return json({ symbols: eligible });
        if (url.pathname.endsWith("/ticker/24hr")) return json(tickerPayload);
        if (url.pathname.endsWith("/klines")) {
          unavailableHistoryCalls += 1;
          return json({ msg: "Service unavailable" }, 503);
        }
        return json({ msg: "unexpected" }, 404);
      },
    }),
    (error) => error.code === "http" && error.status === 503,
  );
  assert.ok(
    unavailableHistoryCalls <= 6,
    `expected at most six in-flight history calls, received ${unavailableHistoryCalls}`,
  );

  client.clearBinancePublicClientCache();
  let corsHistoryCalls = 0;
  await assert.rejects(
    client.loadPublicFuturesRadar(undefined, {
      fetch: async (input, init) => {
        assertPublicRequest(input, init);
        const url = new URL(String(input));
        if (url.pathname.endsWith("/exchangeInfo")) return json({ symbols: eligible });
        if (url.pathname.endsWith("/ticker/24hr")) return json(tickerPayload);
        if (url.pathname.endsWith("/klines")) {
          corsHistoryCalls += 1;
          throw new TypeError("Failed to fetch");
        }
        return json({ msg: "unexpected" }, 404);
      },
    }),
    (error) => error.code === "cors-network",
  );
  assert.ok(
    corsHistoryCalls <= 6,
    `expected at most six CORS-failed history calls, received ${corsHistoryCalls}`,
  );

  client.clearBinancePublicClientCache();
  let timedOutHistoryCalls = 0;
  const radarTimeoutFetch = async (input, init) => {
    assertPublicRequest(input, init);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exchangeInfo")) return json({ symbols: eligible });
    if (url.pathname.endsWith("/ticker/24hr")) return json(tickerPayload);
    if (url.pathname.endsWith("/klines")) {
      timedOutHistoryCalls += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return json({ msg: "unexpected" }, 404);
  };
  await assert.rejects(
    client.loadPublicFuturesRadar(undefined, {
      fetch: radarTimeoutFetch,
      timeoutMs: 10,
    }),
    (error) => error.code === "timeout",
  );
  assert.ok(
    timedOutHistoryCalls <= 6,
    `expected at most six timed-out history calls, received ${timedOutHistoryCalls}`,
  );

  client.clearBinancePublicClientCache();
  await assert.rejects(
    client.loadPublicFuturesRadar(undefined, {
      fetch: async (input, init) => {
        assertPublicRequest(input, init);
        const url = new URL(String(input));
        if (url.pathname.endsWith("/exchangeInfo")) return json({ symbols: eligible });
        if (url.pathname.endsWith("/ticker/24hr")) return json(tickerPayload);
        if (url.pathname.endsWith("/klines")) return json([]);
        return json({ msg: "unexpected" }, 404);
      },
    }),
    (error) => error.code === "invalid-response" && /일봉 이력을 확인하지 못했습니다/.test(error.message),
  );
});

test("browser chart fallback validates selections and returns the latest 84 quote-volume candles", async () => {
  client.clearBinancePublicClientCache();
  const calls = [];
  const rows = Array.from({ length: 90 }, (_, index) => [
    1_700_000_000_000 + index * 60_000,
    String(100 + index),
    String(102 + index),
    String(99 + index),
    String(101 + index),
    String(5 + index),
    0,
    String(500 + index),
  ]);
  const fetch = async (input, init) => {
    calls.push([input, init]);
    const url = new URL(String(input));
    if (url.pathname.endsWith("/exchangeInfo")) {
      return json({ symbols: [
        exchangeSymbol("BTCUSDT", { baseAsset: "BTC", tickSize: "0.10" }),
        exchangeSymbol("ETHUSDT", {
          baseAsset: "ETH",
          contractType: "TRADIFI_PERPETUAL",
          tickSize: "0.01",
        }),
      ] });
    }
    if (url.pathname.endsWith("/klines")) return json(rows);
    return json({ msg: "unexpected" }, 404);
  };

  const series = await client.loadPublicFuturesChartSeries([
    { symbol: "BTCUSDT", timeframe: "1m" },
    { symbol: "ETHUSDT", timeframe: "5m" },
    { symbol: "BTCUSDT", timeframe: "1M" },
  ], undefined, { fetch });
  assert.equal(series.length, 3);
  assert.equal(series[0].tickSize, "0.10");
  assert.equal(series[0].candles.length, 84);
  assert.equal(series[0].candles[0].quoteVolume, 506);
  assert.equal(series[0].candles.at(-1).quoteVolume, 589);
  assert.equal(series[0].price.lastPrice, 190);
  const klineCalls = calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/klines"));
  assert.equal(klineCalls.length, 3);
  assert.deepEqual(
    klineCalls.map(([input]) => {
      const url = new URL(String(input));
      return [url.searchParams.get("symbol"), url.searchParams.get("interval"), url.searchParams.get("limit")];
    }),
    [
      ["BTCUSDT", "1m", "84"],
      ["ETHUSDT", "5m", "84"],
      ["BTCUSDT", "1M", "84"],
    ],
  );
  for (const [input, init] of calls) assertPublicRequest(input, init);

  let invalidCalls = 0;
  await assert.rejects(
    client.loadPublicFuturesChartSeries(
      [{ symbol: "https://evil.example", timeframe: "1m" }],
      undefined,
      { fetch: async () => { invalidCalls += 1; return json([]); } },
    ),
    /허용되지 않은 Binance 공개 차트 요청/,
  );
  assert.equal(invalidCalls, 0);
});

test("only app-supported futures intervals are exposed and monthly REST/WS casing stays exact", async () => {
  assert.deepEqual([...client.BINANCE_PUBLIC_TIMEFRAMES], APP_TIMEFRAMES);
  for (const timeframe of REMOVED_TIMEFRAMES) {
    let requestCount = 0;
    await assert.rejects(
      client.loadPublicFuturesChartSeries(
        [{ symbol: "BTCUSDT", timeframe }],
        undefined,
        { fetch: async () => { requestCount += 1; return json([]); } },
      ),
      /허용되지 않은 Binance 공개 차트 요청/,
    );
    assert.equal(requestCount, 0, `${timeframe} is rejected before fetch`);
  }

  const workspaceSource = await readFile(
    new URL("../app/components/MultiChartWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    workspaceSource,
    /\$\{symbol\.toLowerCase\(\)\}@kline_\$\{timeframe\}/,
  );
  assert.doesNotMatch(workspaceSource, /timeframe\.toLowerCase\(/);

  const chartSource = await readFile(
    new URL("../app/components/CandlestickChart.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    chartSource,
    /Date\.UTC\(openDate\.getUTCFullYear\(\), openDate\.getUTCMonth\(\) \+ 1, 1\)/,
  );
  assert.match(
    chartSource,
    /Date\.UTC\(quoteDate\.getUTCFullYear\(\), quoteDate\.getUTCMonth\(\), 1\)/,
  );

  const dashboardSource = await readFile(
    new URL("../app/components/BinanceDashboard.tsx", import.meta.url),
    "utf8",
  );
  const exactRestore = dashboardSource.indexOf("VALID_TIMEFRAMES.has(exactValue");
  const legacyMigration = dashboardSource.indexOf("exactValue.toLowerCase()");
  assert.ok(exactRestore >= 0 && legacyMigration > exactRestore);
  for (const [removed, replacement] of [
    ["30m", "15m"],
    ["2h", "1h"],
    ["6h", "4h"],
    ["8h", "4h"],
    ["12h", "4h"],
    ["3d", "1d"],
  ]) {
    assert.match(
      dashboardSource,
      new RegExp(`"${removed}"\\s*:\\s*"${replacement}"`),
      `${removed} stored layouts migrate to ${replacement}`,
    );
  }
});

test("browser fallback distinguishes CORS/network errors and request timeouts", async () => {
  client.clearBinancePublicClientCache();
  await assert.rejects(
    client.loadPublicFuturesCatalog(undefined, {
      fetch: async () => { throw new TypeError("Failed to fetch"); },
    }),
    (error) => error.code === "cors-network" && /CORS 또는 네트워크/.test(error.message),
  );

  client.clearBinancePublicClientCache();
  const hangingFetch = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });
  await assert.rejects(
    client.loadPublicFuturesCatalog(undefined, { fetch: hangingFetch, timeoutMs: 10 }),
    (error) => error.code === "timeout" && /응답하지 않았습니다/.test(error.message),
  );
});

test("client fallback source contains no server secret or API-key access path", async () => {
  const source = await readFile(
    new URL("../app/components/BinancePublicClient.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /process\.env|BINANCE_API_KEY|X-MBX-APIKEY|Authorization/);
  assert.match(source, /credentials:\s*"omit"/);
  assert.match(source, /https:\/\/fapi\.binance\.com/);
});
