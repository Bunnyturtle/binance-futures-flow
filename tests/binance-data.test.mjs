import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function transpileTypescript(relativeUrl, replacements = new Map()) {
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
  let javascript = output.outputText;
  for (const [specifier, replacement] of replacements) {
    javascript = javascript
      .replaceAll(`"${specifier}"`, `"${replacement}"`)
      .replaceAll(`'${specifier}'`, `'${replacement}'`);
  }
  const encoded = Buffer.from(`${javascript}\n//# sourceURL=${sourceUrl.href}`).toString("base64");
  return `data:text/javascript;base64,${encoded}`;
}

async function importTypescript(relativeUrl, replacements) {
  return import(await transpileTypescript(relativeUrl, replacements));
}

const catalogRankingUrl = await transpileTypescript("../lib/binance-catalog-ranking.ts");
const cryptoWallRankingUrl = await transpileTypescript("../lib/crypto-wall-ranking.ts");
const cryptoWallRanking = await import(cryptoWallRankingUrl);
const binance = await importTypescript(
  "../lib/binance-client.ts",
  new Map([
    ["./binance-catalog-ranking", catalogRankingUrl],
    ["./crypto-wall-ranking", cryptoWallRankingUrl],
  ]),
);

function exchangeSymbol(symbol, {
  baseAsset = symbol.replace(/USDT$/, ""),
  quoteAsset = "USDT",
  marginAsset = "USDT",
  contractType = "PERPETUAL",
  status = "TRADING",
  tickSize = "0.00100000",
} = {}) {
  return {
    symbol,
    baseAsset,
    quoteAsset,
    marginAsset,
    contractType,
    status,
    filters: [{ filterType: "PRICE_FILTER", tickSize }],
  };
}

function ticker(symbol, quoteVolume, lastPrice = 100, closeTime = 1_700_000_000_000) {
  return {
    symbol,
    lastPrice: String(lastPrice),
    priceChangePercent: "1.25",
    quoteVolume: String(quoteVolume),
    closeTime,
  };
}

test("ranks only TRADING crypto USD-M perpetual USDT symbols by numeric quoteVolume", () => {
  const symbols = binance.parseExchangeInfo({
    symbols: [
      exchangeSymbol("LOWUSDT", { baseAsset: "LOW", tickSize: "0.01" }),
      exchangeSymbol("1000PEPEUSDT", { baseAsset: "1000PEPE", tickSize: "0.0000001" }),
      exchangeSymbol("MSTRUSDT", { contractType: "TRADIFI_PERPETUAL" }),
      exchangeSymbol("DELIVERYUSDT", { contractType: "CURRENT_QUARTER" }),
      exchangeSymbol("PAUSEDUSDT", { status: "SETTLING" }),
      exchangeSymbol("BTCUSDC", { quoteAsset: "USDC" }),
      exchangeSymbol("WRONGMARGINUSDT", { marginAsset: "USDC" }),
    ],
  });
  const tickers = binance.parse24hrTickers([
    ticker("LOWUSDT", "900"),
    ticker("1000PEPEUSDT", "10000", 0.0000075),
    ticker("MSTRUSDT", "1000000"),
    ticker("DELIVERYUSDT", "999999"),
    ticker("PAUSEDUSDT", "999998"),
    ticker("BTCUSDC", "999997"),
    ticker("WRONGMARGINUSDT", "999996"),
  ]);

  const result = binance.rankUsdtPerpetualUniverse(symbols, tickers, 2, 1_700_000_000_100);
  assert.deepEqual(result.map(({ symbol, rank }) => ({ symbol, rank })), [
    { symbol: "1000PEPEUSDT", rank: 1 },
    { symbol: "LOWUSDT", rank: 2 },
  ]);
  assert.equal(result[0].name, "1000PEPE/USDT");
  assert.equal(result[0].currency, "USDT");
  assert.equal(result[0].quoteVolume, 10_000);
  assert.equal(result[0].tickSize, "0.0000001");
  assert.equal(result[0].lastPrice, 0.0000075);
  assert.equal(result[0].priceTimestamp, "2023-11-14T22:13:20.000Z");
  assert.equal(symbols[0].marginAsset, "USDT");
});

test("keeps crypto and TradFi universes separate and ranks TradFi by quoteVolume", () => {
  const symbols = binance.parseExchangeInfo({
    symbols: [
      exchangeSymbol("BTCUSDT"),
      exchangeSymbol("ETHUSDT"),
      exchangeSymbol("MSTRUSDT", { contractType: "TRADIFI_PERPETUAL" }),
      exchangeSymbol("COINUSDT", { contractType: "TRADIFI_PERPETUAL" }),
      exchangeSymbol("PAUSEDSTOCKUSDT", {
        contractType: "TRADIFI_PERPETUAL",
        status: "SETTLING",
      }),
      exchangeSymbol("STOCKUSDC", {
        quoteAsset: "USDC",
        marginAsset: "USDC",
        contractType: "TRADIFI_PERPETUAL",
      }),
      exchangeSymbol("WRONGMARGINUSDT", {
        marginAsset: "USDC",
        contractType: "TRADIFI_PERPETUAL",
      }),
    ],
  });
  const tickers = binance.parse24hrTickers([
    ticker("BTCUSDT", "500000"),
    ticker("ETHUSDT", "400000"),
    ticker("MSTRUSDT", "1200"),
    ticker("COINUSDT", "9500"),
    ticker("PAUSEDSTOCKUSDT", "999999"),
    ticker("STOCKUSDC", "999998"),
    ticker("WRONGMARGINUSDT", "999997"),
  ]);

  const crypto = binance.rankUsdtPerpetualUniverse(
    symbols,
    tickers,
    2,
    1_700_000_000_100,
    "crypto",
  );
  const tradfi = binance.rankUsdtPerpetualUniverse(
    symbols,
    tickers,
    2,
    1_700_000_000_100,
    "tradfi",
  );

  assert.deepEqual(crypto.map(({ symbol }) => symbol), ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(tradfi.map(({ symbol, rank }) => ({ symbol, rank })), [
    { symbol: "COINUSDT", rank: 1 },
    { symbol: "MSTRUSDT", rank: 2 },
  ]);
  assert.equal(binance.parseBinanceMarketSegment(null), "crypto");
  assert.equal(binance.parseBinanceMarketSegment(" TRADFI "), "tradfi");
  assert.throws(() => binance.parseBinanceMarketSegment("stocks"), /crypto or tradfi/);
});

test("ranks every eligible catalog symbol without the chart TOP12 cap", () => {
  const cryptoSymbols = Array.from({ length: 14 }, (_, index) =>
    exchangeSymbol(`COIN${index}USDT`, {
      baseAsset: `COIN${index}`,
      tickSize: index === 13 ? "0.0001" : "0.01",
    })
  );
  const symbols = binance.parseExchangeInfo({
    symbols: [
      ...cryptoSymbols,
      exchangeSymbol("MSTRUSDT", {
        baseAsset: "MSTR",
        contractType: "TRADIFI_PERPETUAL",
        tickSize: "0.001",
      }),
      exchangeSymbol("COINUSDT", {
        baseAsset: "COIN",
        contractType: "TRADIFI_PERPETUAL",
        tickSize: "0.01",
      }),
      exchangeSymbol("PAUSEDUSDT", { status: "SETTLING" }),
      exchangeSymbol("QUARTERUSDT", { contractType: "CURRENT_QUARTER" }),
      exchangeSymbol("WRONGMARGINUSDT", { marginAsset: "USDC" }),
      exchangeSymbol("MISSPELLEDUSDT", { contractType: "TRADFI_PERPETUAL" }),
    ],
  });
  const tickers = binance.parse24hrTickers([
    ...cryptoSymbols.slice(0, -1).map((symbol, index) =>
      ticker(symbol.symbol, index === 0 ? 1_000 : index, 100 + index)
    ),
    ticker("COINUSDT", 900, 190),
    ticker("MSTRUSDT", 1_200, 180),
  ]);

  const crypto = binance.rankUsdtPerpetualSymbolCatalog(
    symbols,
    tickers,
    1_700_000_000_100,
    "crypto",
  );
  assert.equal(crypto.length, 14);
  assert.deepEqual(
    crypto.slice(0, 2).map(({ symbol, rank, quoteVolume }) => ({ symbol, rank, quoteVolume })),
    [
      { symbol: "COIN0USDT", rank: 1, quoteVolume: 1_000 },
      { symbol: "COIN12USDT", rank: 2, quoteVolume: 12 },
    ],
  );
  assert.deepEqual(crypto.at(-1), {
    rank: 14,
    symbol: "COIN13USDT",
    name: "COIN13/USDT",
    baseAsset: "COIN13",
    quoteAsset: "USDT",
    currency: "USDT",
    lastPrice: 0,
    changeRate: 0,
    quoteVolume: 0,
    priceTimestamp: "2023-11-14T22:13:20.100Z",
    tickSize: "0.0001",
    rankingScore: 0,
    volumeScore: 0,
    changeScore: 50,
    recommendationRank: 14,
  });
  assert.deepEqual(
    binance.rankUsdtPerpetualSymbolCatalog(
      symbols,
      tickers,
      1_700_000_000_100,
      "tradfi",
    ).map(({ symbol, rank, quoteVolume }) => ({ symbol, rank, quoteVolume })),
    [
      { symbol: "MSTRUSDT", rank: 1, quoteVolume: 1_200 },
      { symbol: "COINUSDT", rank: 2, quoteVolume: 900 },
    ],
  );
});

test("volume-orders the CRYPTO catalog with pure quote-volume recommendation scores", () => {
  const specifications = [
    ["VOLTOPUSDT", 600, -100],
    ["MOMENTUMUSDT", 500, 100],
    ["MIDUSDT", 400, 20],
    ["FLATUSDT", 300, 0],
    ["LOWUSDT", 200, -20],
    ["TAILUSDT", 100, -50],
  ];
  const symbols = binance.parseExchangeInfo({
    symbols: specifications.map(([symbol]) => exchangeSymbol(symbol)),
  });
  const tickers = binance.parse24hrTickers(specifications.map(([symbol, volume, changeRate]) => ({
    ...ticker(symbol, volume),
    priceChangePercent: String(changeRate),
  })));
  const ranked = binance.rankUsdtPerpetualSymbolCatalog(symbols, tickers);

  assert.deepEqual(ranked.map(({ symbol }) => symbol), [
    "VOLTOPUSDT",
    "MOMENTUMUSDT",
    "MIDUSDT",
    "FLATUSDT",
    "LOWUSDT",
    "TAILUSDT",
  ]);
  assert.deepEqual(
    ranked.slice(0, 2).map(({
      symbol,
      rankingScore,
      volumeScore,
      changeScore,
      recommendationRank,
    }) => ({
      symbol,
      rankingScore,
      volumeScore,
      changeScore,
      recommendationRank,
    })),
    [
      {
        symbol: "VOLTOPUSDT",
        rankingScore: 100,
        volumeScore: 100,
        changeScore: 0,
        recommendationRank: 1,
      },
      {
        symbol: "MOMENTUMUSDT",
        rankingScore: 80,
        volumeScore: 80,
        changeScore: 100,
        recommendationRank: 2,
      },
    ],
  );

  const neutralSymbols = binance.parseExchangeInfo({
    symbols: ["HIGHUSDT", "UNKNOWNUSDT", "BOTTOMUSDT"].map((symbol) => exchangeSymbol(symbol)),
  });
  const neutralTickers = binance.parse24hrTickers([
    { ...ticker("HIGHUSDT", 300), priceChangePercent: "-1" },
    { ...ticker("UNKNOWNUSDT", 200), priceChangePercent: null },
    { ...ticker("BOTTOMUSDT", 100), priceChangePercent: "1" },
  ]);
  const neutralRanked = binance.rankUsdtPerpetualSymbolCatalog(neutralSymbols, neutralTickers);
  const unknown = neutralRanked.find(({ symbol }) => symbol === "UNKNOWNUSDT");
  assert.deepEqual(
    (({ changeRate, rankingScore, volumeScore, changeScore, recommendationRank }) => ({
      changeRate,
      rankingScore,
      volumeScore,
      changeScore,
      recommendationRank,
    }))(unknown),
    {
      changeRate: 0,
      rankingScore: 50,
      volumeScore: 50,
      changeScore: 50,
      recommendationRank: 2,
    },
  );
});

test("volume-orders the TRADFI catalog with pure quote-volume recommendation scores", () => {
  const specifications = [
    ["VOLTOPUSDT", 600, -100],
    ["MOMENTUMUSDT", 500, 100],
    ["MIDUSDT", 400, 20],
    ["FLATUSDT", 300, 0],
    ["LOWUSDT", 200, -20],
    ["TAILUSDT", 100, -50],
  ];
  const symbols = binance.parseExchangeInfo({
    symbols: specifications.map(([symbol]) => exchangeSymbol(symbol, {
      contractType: "TRADIFI_PERPETUAL",
    })),
  });
  const tickers = binance.parse24hrTickers(specifications.map(([
    symbol,
    quoteVolume,
    changeRate,
  ]) => ({
    ...ticker(symbol, quoteVolume),
    priceChangePercent: String(changeRate),
  })));
  const ranked = binance.rankUsdtPerpetualSymbolCatalog(
    symbols,
    tickers,
    Date.now(),
    "tradfi",
  );

  assert.deepEqual(ranked.map(({ symbol }) => symbol), specifications.map(([symbol]) => symbol));
  assert.deepEqual(
    ranked.slice(0, 2).map(({
      symbol,
      rankingScore,
      volumeScore,
      changeScore,
      recommendationRank,
    }) => ({
      symbol,
      rankingScore,
      volumeScore,
      changeScore,
      recommendationRank,
    })),
    [
      {
        symbol: "VOLTOPUSDT",
        rankingScore: 100,
        volumeScore: 100,
        changeScore: 0,
        recommendationRank: 1,
      },
      {
        symbol: "MOMENTUMUSDT",
        rankingScore: 80,
        volumeScore: 80,
        changeScore: 100,
        recommendationRank: 2,
      },
    ],
  );
});

test("accepts a complete exact twelve-rank TRADFI recommendation contract", () => {
  const specifications = Array.from({ length: 12 }, (_, index) => ({
    symbol: `TF${String(index).padStart(2, "0")}USDT`,
    quoteVolume: (12 - index) * 100,
    changeRate: index % 2 === 0 ? index : -index,
  }));
  const catalog = binance.rankUsdtPerpetualSymbolCatalog(
    binance.parseExchangeInfo({
      symbols: specifications.map(({ symbol }) => exchangeSymbol(symbol, {
        contractType: "TRADIFI_PERPETUAL",
      })),
    }),
    binance.parse24hrTickers(specifications.map(({
      symbol,
      quoteVolume,
      changeRate,
    }) => ({
      ...ticker(symbol, quoteVolume),
      priceChangePercent: String(changeRate),
    }))),
    Date.now(),
    "tradfi",
  );

  assert.deepEqual(
    catalog.map(({ symbol }) => symbol),
    specifications.map(({ symbol }) => symbol),
  );
  assert.equal(binance.usableChartWallRecommendationRankCount(catalog), 12);
  assert.doesNotThrow(() => binance.assertExactChartWallRecommendation(catalog));
});

test("keeps recommendation ranks aligned with deterministic catalog volume ranks", () => {
  const volumeRankSpecs = [
    ["AONEUSDT", 500, -100],
    ["BTWOUSDT", 400, 100],
    ["CTHREEUSDT", 350, 80],
    ["DFOURUSDT", 300, 60],
    ["EFIVEUSDT", 250, 40],
    ["FSIXUSDT", 200, 20],
    ["GSEVENUSDT", 150, 0],
    ["HEIGHTUSDT", 100, -20],
    ["ININEUSDT", 50, -40],
    ["JTENUSDT", 25, -60],
  ];
  const volumeRanked = binance.rankUsdtPerpetualSymbolCatalog(
    binance.parseExchangeInfo({ symbols: volumeRankSpecs.map(([symbol]) => exchangeSymbol(symbol)) }),
    binance.parse24hrTickers(volumeRankSpecs.map(([symbol, volume, changeRate]) => ({
      ...ticker(symbol, volume),
      priceChangePercent: String(changeRate),
    }))),
  );
  assert.deepEqual(
    volumeRanked.slice(0, 2).map(({ symbol, rankingScore, recommendationRank }) => ({
      symbol,
      rankingScore,
      recommendationRank,
    })),
    [
      { symbol: "AONEUSDT", rankingScore: 100, recommendationRank: 1 },
      { symbol: "BTWOUSDT", rankingScore: 88.89, recommendationRank: 2 },
    ],
  );

  const symbolTie = binance.rankUsdtPerpetualSymbolCatalog(
    binance.parseExchangeInfo({
      symbols: [exchangeSymbol("ZZZUSDT"), exchangeSymbol("AAAUSDT")],
    }),
    binance.parse24hrTickers([
      ticker("ZZZUSDT", 100),
      ticker("AAAUSDT", 100),
    ]),
  );
  assert.deepEqual(symbolTie.map(({ symbol, rankingScore, recommendationRank }) => ({
    symbol,
    rankingScore,
    recommendationRank,
  })), [
    { symbol: "AAAUSDT", rankingScore: 50, recommendationRank: 1 },
    { symbol: "ZZZUSDT", rankingScore: 50, recommendationRank: 2 },
  ]);
});

test("recommendation TOP12 exactly matches the volume-ordered catalog TOP12", () => {
  const specifications = Array.from({ length: 13 }, (_, index) => ({
    symbol: `ORDER${String(index).padStart(2, "0")}USDT`,
    quoteVolume: (13 - index) * 100,
    changeRate: index === 12 ? 100 : index === 11 ? -100 : 0,
  }));
  const catalog = binance.rankUsdtPerpetualSymbolCatalog(
    binance.parseExchangeInfo({
      symbols: specifications.map(({ symbol }) => exchangeSymbol(symbol)),
    }),
    binance.parse24hrTickers(specifications.map(({ symbol, quoteVolume, changeRate }) => ({
      ...ticker(symbol, quoteVolume),
      priceChangePercent: String(changeRate),
    }))),
  );

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
});

test("requires exact usable chart recommendation ranks independently of pinned defaults", () => {
  const valid = Array.from({ length: 12 }, (_, index) => ({
    symbol: `COIN${index}USDT`,
    recommendationRank: index + 1,
    lastPrice: 100 + index,
    quoteVolume: 1_000 - index,
    tickSize: "0.01",
    rankingScore: 100 - index,
  }));
  assert.equal(
    binance.BINANCE_CRYPTO_DEFAULT_CHART_SYMBOLS,
    cryptoWallRanking.CRYPTO_WALL_DEFAULT_SYMBOLS,
  );
  assert.equal(
    binance.BINANCE_RANKED_CHART_SLOT_COUNT,
    cryptoWallRanking.AUTO_WALL_RANKED_SLOT_COUNT,
  );
  assert.equal(
    binance.BINANCE_USER_PINNED_CHART_SLOT_COUNT,
    cryptoWallRanking.AUTO_WALL_USER_PINNED_SLOT_COUNT,
  );
  assert.doesNotThrow(() =>
    binance.assertExactChartWallRecommendation(valid)
  );

  const duplicate = valid.map((item) => ({ ...item }));
  duplicate[11].recommendationRank = 11;
  assert.throws(
    () => binance.assertExactChartWallRecommendation(duplicate),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.code, "invalid-response");
      assert.match(error.message, /exactly one recommendationRank.*1 through 12/i);
      return true;
    },
  );

  const duplicateSymbol = valid.map((item) => ({ ...item }));
  duplicateSymbol[11].symbol = duplicateSymbol[10].symbol;
  assert.throws(
    () => binance.assertExactChartWallRecommendation(duplicateSymbol),
    /12 unique usable ranked market items/i,
  );

  const emptyMarket = valid.map((item) => ({ ...item }));
  emptyMarket[1].lastPrice = 0;
  assert.throws(
    () => binance.assertExactChartWallRecommendation(emptyMarket),
    /12 unique usable ranked market items/i,
  );

  const missingScore = valid.map((item) => ({ ...item }));
  missingScore[2].rankingScore = Number.NaN;
  assert.throws(
    () => binance.assertExactChartWallRecommendation(missingScore),
    /12 unique usable ranked market items/i,
  );

  const nonUsdtSymbol = valid.map((item) => ({ ...item }));
  nonUsdtSymbol[3].symbol = "BTCUSD";
  assert.throws(
    () => binance.assertExactChartWallRecommendation(nonUsdtSymbol),
    /12 unique usable ranked market items/i,
  );

  const tooShortSymbol = valid.map((item) => ({ ...item }));
  tooShortSymbol[4].symbol = "USDT";
  assert.throws(
    () => binance.assertExactChartWallRecommendation(tooShortSymbol),
    /12 unique usable ranked market items/i,
  );

  const underscoreSymbol = valid.map((item) => ({ ...item }));
  underscoreSymbol[5].symbol = "BTC_USDT";
  assert.throws(
    () => binance.assertExactChartWallRecommendation(underscoreSymbol),
    /12 unique usable ranked market items/i,
  );
});

test("generated CRYPTO catalog remains valid without requiring BTC/ETH market items", () => {
  const dynamicSymbols = Array.from({ length: 12 }, (_, index) =>
    `DYN${String(index).padStart(2, "0")}USDT`
  );
  const specifications = [
    ["BTCUSDT", 1],
    ["ETHUSDT", 2],
    ...dynamicSymbols.map((symbol, index) => [symbol, 1_000 - index]),
  ];
  const catalog = binance.rankUsdtPerpetualSymbolCatalog(
    binance.parseExchangeInfo({
      symbols: specifications.map(([symbol]) => exchangeSymbol(symbol)),
    }),
    binance.parse24hrTickers(
      specifications.map(([symbol, quoteVolume]) => ticker(symbol, quoteVolume)),
    ),
  );

  const withoutDefaultSymbols = catalog.filter(({ symbol }) =>
    symbol !== "BTCUSDT" && symbol !== "ETHUSDT"
  );
  assert.equal(withoutDefaultSymbols.length, 12);
  assert.doesNotThrow(() =>
    binance.assertExactChartWallRecommendation(withoutDefaultSymbols)
  );
  assert.deepEqual(
    withoutDefaultSymbols.map(({ symbol }) => symbol),
    dynamicSymbols,
  );
});

test("parses native Binance REST klines to ordered ISO OHLCV and quote volume", () => {
  const candles = binance.parseRestKlines([
    [120_000, "2", "4", "1", "3", "10", 179_999, "25"],
    [60_000, "1", "3", "0.5", "2", "8", 119_999, "14"],
    [60_000, "9", "9", "9", "9", "9", 119_999, "81"],
    ["bad", "1", "2", "1", "2", "1", 0, "2"],
  ]);
  assert.deepEqual(candles, [
    {
      timestamp: "1970-01-01T00:01:00.000Z",
      openPrice: 9,
      highPrice: 9,
      lowPrice: 9,
      closePrice: 9,
      volume: 9,
      quoteVolume: 81,
    },
    {
      timestamp: "1970-01-01T00:02:00.000Z",
      openPrice: 2,
      highPrice: 4,
      lowPrice: 1,
      closePrice: 3,
      volume: 10,
      quoteVolume: 25,
    },
  ]);
});

test("parses the lightweight futures symbol-price feed used by one-second quotes", () => {
  assert.deepEqual(binance.parseSymbolPrices([
    { symbol: "BTCUSDT", price: "50000.25", time: 1_700_000_000_000 },
    { symbol: "1000PEPEUSDT", price: "0.0000075", time: 1_700_000_000_100 },
    { symbol: "BROKEN", price: "NaN", time: 0 },
  ]), [
    { symbol: "BTCUSDT", lastPrice: 50_000.25, timestamp: 1_700_000_000_000 },
    { symbol: "1000PEPEUSDT", lastPrice: 0.0000075, timestamp: 1_700_000_000_100 },
  ]);
});

test("validates twelve symbols and every supported requested timeframe", () => {
  const symbols = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "ADAUSDT", "TRXUSDT", "LINKUSDT", "AVAXUSDT", "1000PEPEUSDT", "SUIUSDT",
  ];
  const supportedTimeframes = [
    "1m", "3m", "5m", "15m", "1h", "4h", "1d", "1w", "1M",
  ];
  const removedTimeframes = ["30m", "2h", "6h", "8h", "12h", "3d"];
  const timeframes = symbols.map(
    (_, index) => supportedTimeframes[index % supportedTimeframes.length],
  );
  assert.deepEqual(
    binance.parseBinanceChartsRequest({ symbols, detail: "full", timeframes }),
    { symbols, detail: "full", timeframes },
  );
  for (const timeframe of supportedTimeframes) {
    assert.deepEqual(
      binance.parseBinanceChartsRequest({ symbols: ["BTCUSDT"], timeframes: [timeframe] }),
      { symbols: ["BTCUSDT"], detail: "full", timeframes: [timeframe] },
    );
  }
  for (const timeframe of removedTimeframes) {
    assert.equal(binance.isBinanceChartTimeframe(timeframe), false);
    assert.throws(
      () => binance.parseBinanceChartsRequest({
        symbols: ["BTCUSDT"],
        timeframes: [timeframe],
      }),
      /must be one of/,
    );
  }
  assert.equal(binance.isBinanceChartTimeframe("1m"), true);
  assert.equal(binance.isBinanceChartTimeframe("1M"), true);
  assert.equal(binance.isBinanceChartTimeframe("1H"), false);
  assert.deepEqual(
    binance.parseBinanceChartsRequest({ symbols: ["BTCUSDT"], timeframes: [" 1M "] }),
    { symbols: ["BTCUSDT"], detail: "full", timeframes: ["1M"] },
  );
  assert.deepEqual(
    binance.parseBinanceChartsRequest({ symbols: [" btcusdt "], detail: "quotes" }),
    { symbols: ["BTCUSDT"], detail: "quotes", timeframes: ["1m"] },
  );
  assert.throws(
    () => binance.parseBinanceChartsRequest({ symbols: [...symbols, "LTCUSDT"] }),
    /between 1 and 12/,
  );
  assert.throws(
    () => binance.parseBinanceChartsRequest({ symbols: ["BTCUSDT"], timeframes: ["45m"] }),
    /must be one of/,
  );
});

test("preserves Binance's case-sensitive monthly interval in the REST request", async () => {
  let requestedUrl;
  const client = new binance.BinanceFuturesClient({
    fetch: async (input) => {
      requestedUrl = new URL(input);
      return Response.json([]);
    },
  });

  await client.getKlines("BTCUSDT", "1M", 25);
  assert.equal(requestedUrl.pathname, "/fapi/v1/klines");
  assert.equal(requestedUrl.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(requestedUrl.searchParams.get("interval"), "1M");
  assert.equal(requestedUrl.searchParams.get("limit"), "25");
});

test("public requests work without a key and optional key is header-only", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return Response.json({ symbols: [exchangeSymbol("BTCUSDT")] });
  };

  await new binance.BinanceFuturesClient({ fetch: fetcher }).getExchangeInfo();
  await new binance.BinanceFuturesClient({
    apiKey: "server-key",
    fetch: fetcher,
  }).getExchangeInfo();

  assert.equal(calls[0].headers.has("X-MBX-APIKEY"), false);
  assert.equal(calls[1].headers.get("X-MBX-APIKEY"), "server-key");
  assert.doesNotMatch(calls[1].url, /server-key/);
  assert.match(calls[1].url, /\/fapi\/v1\/exchangeInfo$/);
});

test("surfaces distinct rate-limit, region, upstream, and timeout failures", async () => {
  const responseFor = (status, body, headers) => async () =>
    new Response(JSON.stringify(body), { status, headers });

  await assert.rejects(
    new binance.BinanceFuturesClient({
      fetch: responseFor(429, { code: -1003, msg: "Too many requests" }, { "Retry-After": "2" }),
    }).get24hrTickers(),
    (error) => error.status === 429 && error.retryAfterSeconds === 2 && /rate limit/i.test(error.message),
  );
  await assert.rejects(
    new binance.BinanceFuturesClient({ fetch: responseFor(451, {}) }).get24hrTickers(),
    (error) => error.status === 451 && /region/i.test(error.message),
  );
  await assert.rejects(
    new binance.BinanceFuturesClient({ fetch: responseFor(503, { msg: "maintenance" }) }).get24hrTickers(),
    (error) => error.status === 503 && /upstream/i.test(error.message),
  );
  await assert.rejects(
    new binance.BinanceFuturesClient({
      requestTimeoutMs: 5,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }).get24hrTickers(),
    (error) => error.code === "request-timeout" && /8000/.test(error.message) === false,
  );
});

test("suppresses CloudFront HTML and oversized upstream bodies from public errors", async () => {
  const cloudFrontHtml = `<!DOCTYPE HTML><html><head><title>ERROR</title></head><body>
    The request could not be satisfied. Request blocked. Generated by cloudfront.
    ${"private-edge-debug".repeat(100)}
  </body></html>`;
  await assert.rejects(
    new binance.BinanceFuturesClient({
      fetch: async () => new Response(cloudFrontHtml, {
        status: 403,
        headers: { "X-Cache": "Error from cloudfront", "X-Amz-Cf-Id": "trace-id" },
      }),
    }).getExchangeInfo(),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "edge-blocked");
      assert.match(error.message, /CDN edge/);
      assert.doesNotMatch(error.message, /<html|private-edge-debug|trace-id/i);
      assert.ok(error.message.length < 180);
      return true;
    },
  );

  const oversizedText = "upstream diagnostic ".repeat(100);
  await assert.rejects(
    new binance.BinanceFuturesClient({
      fetch: async () => new Response(oversizedText, { status: 400 }),
    }).getExchangeInfo(),
    (error) => {
      assert.ok(error.message.length < 330);
      assert.doesNotMatch(error.message, /upstream diagnostic (?:upstream diagnostic ){20}/);
      return true;
    },
  );
});

test("fails over only transient failures and keeps the successful configured endpoint sticky", async () => {
  const calls = [];
  const fetcher = async (input) => {
    const url = new URL(input);
    calls.push(url.origin);
    if (url.origin === "https://primary.example") {
      return new Response("<html>Request blocked. Generated by cloudfront.</html>", {
        status: 403,
        headers: { "X-Cache": "Error from cloudfront" },
      });
    }
    return Response.json({ serverTime: 1_700_000_000_000 });
  };
  const client = new binance.BinanceFuturesClient({
    baseUrl: "https://primary.example",
    fallbackBaseUrls: ["https://fallback.example"],
    fetch: fetcher,
  });

  assert.deepEqual(await client.getExchangeInfo(), { serverTime: 1_700_000_000_000 });
  assert.deepEqual(calls, ["https://primary.example", "https://fallback.example"]);

  calls.length = 0;
  assert.deepEqual(await client.getExchangeInfo(), { serverTime: 1_700_000_000_000 });
  assert.deepEqual(calls, ["https://fallback.example"]);
});

test("does not use failover to bypass rate limits, region blocks, or ordinary 403s", async () => {
  for (const [status, payload, expectedCode] of [
    [429, { code: -1003, msg: "Too many requests" }, "-1003"],
    [451, { code: 0, msg: "Unavailable for legal reasons" }, "0"],
    [403, { code: -2015, msg: "Invalid API-key" }, "-2015"],
    [403, { code: -1000, msg: "Request blocked by account policy" }, "-1000"],
  ]) {
    const calls = [];
    const client = new binance.BinanceFuturesClient({
      baseUrl: "https://primary.example",
      fallbackBaseUrls: ["https://fallback.example"],
      fetch: async (input) => {
        calls.push(new URL(input).origin);
        return Response.json(payload, { status });
      },
    });
    await assert.rejects(
      client.get24hrTickers(),
      (error) => error.status === status && error.code === expectedCode,
    );
    assert.deepEqual(calls, ["https://primary.example"]);
  }
});

test("TTL cache coalesces concurrent work, refreshes after expiry, and never caches failure", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = binance.createKeyedTtlSingleFlightCache({ ttlMs: 5_000, clock: () => now });
  const loader = async () => ++calls;
  const [first, concurrent] = await Promise.all([
    cache.get("BTCUSDT:1m", loader),
    cache.get("BTCUSDT:1m", loader),
  ]);
  assert.equal(first, 1);
  assert.equal(concurrent, 1);
  assert.equal(await cache.get("BTCUSDT:1m", loader), 1);
  now += 5_001;
  assert.equal(await cache.get("BTCUSDT:1m", loader), 2);

  let failures = 0;
  await assert.rejects(cache.get("bad", async () => {
    failures += 1;
    throw new Error("temporary");
  }));
  await assert.rejects(cache.get("bad", async () => {
    failures += 1;
    throw new Error("temporary");
  }));
  assert.equal(failures, 2);
});

test("TTL cache can share settled data without sharing pending work", async () => {
  let calls = 0;
  const resolvers = [];
  const cache = binance.createKeyedTtlSingleFlightCache({
    ttlMs: 5_000,
    coalesceInFlight: false,
  });
  const loader = () => new Promise((resolve) => {
    calls += 1;
    resolvers.push(() => resolve(calls));
  });
  const first = cache.get("catalog:crypto", loader);
  const second = cache.get("catalog:crypto", loader);
  assert.equal(calls, 2);
  resolvers[0]();
  resolvers[1]();
  await Promise.all([first, second]);

  const cached = await cache.get("catalog:crypto", async () => {
    calls += 1;
    return 99;
  });
  assert.equal(calls, 2);
  assert.equal(cached, 2);
});

test("environment factory reuses settled TTL caches without cross-request single-flight", () => {
  const environment = {
    BINANCE_FUTURES_REST_URL: "https://primary.example",
    BINANCE_FUTURES_REST_FALLBACK_URLS: "https://fallback.example",
    BINANCE_REQUEST_TIMEOUT_MS: "5000",
  };
  const firstRequestService = binance.getBinanceMarketDataServiceFromEnv(environment);
  const secondRequestService = binance.getBinanceMarketDataServiceFromEnv(environment);
  assert.equal(firstRequestService, secondRequestService);
});

test("market service coalesces and caches both full segment-ranked catalogs for five minutes", async () => {
  let now = 1_700_000_000_000;
  const calls = [];
  const fetcher = async (input) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname.endsWith("/exchangeInfo")) {
      return Response.json({
        symbols: [
          exchangeSymbol("BTCUSDT"),
          exchangeSymbol("ETHUSDT"),
          exchangeSymbol("MSTRUSDT", { contractType: "TRADIFI_PERPETUAL" }),
          exchangeSymbol("COINUSDT", { contractType: "TRADIFI_PERPETUAL" }),
        ],
      });
    }
    if (url.pathname.endsWith("/ticker/24hr")) {
      return Response.json([
        ticker("BTCUSDT", 100, 50_000, now),
        ticker("ETHUSDT", 1_000, 3_000, now),
        ticker("MSTRUSDT", 2_000, 180, now),
        ticker("COINUSDT", 200, 190, now),
      ]);
    }
    return new Response("not found", { status: 404 });
  };
  const service = new binance.BinanceMarketDataService(
    new binance.BinanceFuturesClient({ fetch: fetcher }),
    { clock: () => now },
  );

  const [crypto, tradfi] = await Promise.all([
    service.getSymbolCatalog("crypto"),
    service.getSymbolCatalog("tradfi"),
  ]);
  assert.deepEqual(crypto.map(({ symbol, rank }) => ({ symbol, rank })), [
    { symbol: "ETHUSDT", rank: 1 },
    { symbol: "BTCUSDT", rank: 2 },
  ]);
  assert.deepEqual(tradfi.map(({ symbol, rank }) => ({ symbol, rank })), [
    { symbol: "MSTRUSDT", rank: 1 },
    { symbol: "COINUSDT", rank: 2 },
  ]);
  assert.deepEqual(
    tradfi.map(({ symbol, recommendationRank, rankingScore }) => ({
      symbol,
      recommendationRank,
      rankingScore,
    })),
    [
      { symbol: "MSTRUSDT", recommendationRank: 1, rankingScore: 100 },
      { symbol: "COINUSDT", recommendationRank: 2, rankingScore: 0 },
    ],
  );
  assert.equal(binance.usableChartWallRecommendationRankCount(tradfi), 2);
  assert.throws(
    () => binance.assertExactChartWallRecommendation(tradfi),
    /recommendationRank.*1 through 12/i,
  );

  assert.deepEqual(await service.getSymbolCatalog("crypto"), crypto);
  assert.deepEqual(await service.getSymbolCatalog("tradfi"), tradfi);
  assert.equal(calls.filter((path) => path.endsWith("/exchangeInfo")).length, 1);
  assert.equal(calls.filter((path) => path.endsWith("/ticker/24hr")).length, 1);

  now += binance.BINANCE_SYMBOL_CATALOG_CACHE_MS + 1;
  await Promise.all([
    service.getSymbolCatalog("crypto"),
    service.getSymbolCatalog("tradfi"),
  ]);
  assert.equal(calls.filter((path) => path.endsWith("/exchangeInfo")).length, 2);
  assert.equal(calls.filter((path) => path.endsWith("/ticker/24hr")).length, 2);

  const emptyTradfiService = new binance.BinanceMarketDataService(
    new binance.BinanceFuturesClient({
      fetch: async (input) => new URL(input).pathname.endsWith("/exchangeInfo")
        ? Response.json({ symbols: [exchangeSymbol("BTCUSDT")] })
        : Response.json([ticker("BTCUSDT", 1_000)]),
    }),
  );
  await assert.rejects(
    emptyTradfiService.getSymbolCatalog("tradfi"),
    /no eligible TRADFI/i,
  );

  const tickerMismatchService = new binance.BinanceMarketDataService(
    new binance.BinanceFuturesClient({
      fetch: async (input) => new URL(input).pathname.endsWith("/exchangeInfo")
        ? Response.json({ symbols: [
            exchangeSymbol("MSTRUSDT", { contractType: "TRADIFI_PERPETUAL" }),
          ] })
        : Response.json([ticker("BTCUSDT", 1_000)]),
    }),
  );
  await assert.rejects(
    tickerMismatchService.getSymbolCatalog("tradfi"),
    /omitted every eligible TRADFI symbol/i,
  );
});

test("market service batches metadata and prices while caching native candle requests", async () => {
  let now = 1_700_000_000_000;
  const calls = [];
  const fetcher = async (input) => {
    const url = new URL(input);
    calls.push(`${url.pathname}?${url.searchParams}`);
    if (url.pathname.endsWith("/exchangeInfo")) {
      return Response.json({
        symbols: [
          exchangeSymbol("BTCUSDT", { baseAsset: "BTC", tickSize: "0.10" }),
          exchangeSymbol("1000PEPEUSDT", { baseAsset: "1000PEPE", tickSize: "0.0000001" }),
          exchangeSymbol("MSTRUSDT", {
            baseAsset: "MSTR",
            contractType: "TRADIFI_PERPETUAL",
            tickSize: "0.01",
          }),
        ],
      });
    }
    if (url.pathname.endsWith("/ticker/24hr")) {
      return Response.json([
        ticker("BTCUSDT", 10_000, 50_000, now),
        ticker("1000PEPEUSDT", 9_000, 0.0000075, now),
      ]);
    }
    if (url.pathname.endsWith("/ticker/price")) {
      return Response.json([
        { symbol: "BTCUSDT", price: "50000", time: now },
        { symbol: "1000PEPEUSDT", price: "0.0000075", time: now },
        { symbol: "MSTRUSDT", price: "185.25", time: now },
      ]);
    }
    if (url.pathname.endsWith("/klines")) {
      const seed = url.searchParams.get("interval") === "4h" ? 240_000 : 60_000;
      return Response.json([
        [seed, "1", "3", "0.5", "2", "8", seed + 59_999, "14"],
      ]);
    }
    return new Response("not found", { status: 404 });
  };
  const service = new binance.BinanceMarketDataService(
    new binance.BinanceFuturesClient({ fetch: fetcher }),
    {
      clock: () => now,
      exchangeInfoTtlMs: 5_000,
      tickerTtlMs: 5_000,
      priceTtlMs: 5_000,
      klineTtlMs: 5_000,
    },
  );
  const request = binance.parseBinanceChartsRequest({
    symbols: ["BTCUSDT", "1000PEPEUSDT"],
    detail: "full",
    timeframes: ["1m", "4h"],
  });

  const first = await service.getChartSeries(request);
  const cached = await service.getChartSeries(request);
  assert.deepEqual(cached, first);
  assert.deepEqual(first.map(({ symbol, timeframe, candles }) => ({
    symbol,
    timeframe,
    candleTimestamp: candles[0].timestamp,
  })), [
    { symbol: "BTCUSDT", timeframe: "1m", candleTimestamp: "1970-01-01T00:01:00.000Z" },
    { symbol: "1000PEPEUSDT", timeframe: "4h", candleTimestamp: "1970-01-01T00:04:00.000Z" },
  ]);
  assert.equal(calls.filter((call) => call.includes("exchangeInfo")).length, 1);
  assert.equal(calls.filter((call) => call.includes("ticker/price")).length, 1);
  assert.equal(calls.filter((call) => call.includes("ticker/24hr")).length, 0);
  assert.equal(calls.filter((call) => call.includes("/klines")).length, 2);
  assert.ok(calls.some((call) => call.includes("symbol=1000PEPEUSDT") && call.includes("interval=4h")));

  const tradfi = await service.getChartSeries(binance.parseBinanceChartsRequest({
    symbols: ["MSTRUSDT"],
    detail: "quotes",
  }));
  assert.deepEqual(tradfi.map(({ symbol, name, candles }) => ({ symbol, name, candles })), [
    { symbol: "MSTRUSDT", name: "MSTR/USDT", candles: [] },
  ]);
  assert.equal(calls.filter((call) => call.includes("exchangeInfo")).length, 1);
  assert.equal(calls.filter((call) => call.includes("ticker/price")).length, 1);

  now += 5_001;
  await service.getChartSeries(request);
  assert.equal(calls.filter((call) => call.includes("exchangeInfo")).length, 2);
  assert.equal(calls.filter((call) => call.includes("ticker/price")).length, 2);
  assert.equal(calls.filter((call) => call.includes("ticker/24hr")).length, 0);
  assert.equal(calls.filter((call) => call.includes("/klines")).length, 4);
});

test("radar source combines eligible crypto and TradFi and reuses successful daily history", async () => {
  const calls = [];
  const fetcher = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith("/exchangeInfo")) {
      return Response.json({
        symbols: [
          { ...exchangeSymbol("BTCUSDT"), onboardDate: 1_600_000_000_000 },
          {
            ...exchangeSymbol("MSTRUSDT", { contractType: "TRADIFI_PERPETUAL" }),
            onboardDate: 1_700_000_000_000,
          },
          exchangeSymbol("ETHUSDC", { quoteAsset: "USDC", marginAsset: "USDC" }),
          exchangeSymbol("DELIVERYUSDT", { contractType: "CURRENT_QUARTER" }),
          exchangeSymbol("PAUSEDUSDT", { status: "SETTLING" }),
        ],
      });
    }
    if (url.pathname.endsWith("/ticker/24hr")) {
      return Response.json([
        ticker("BTCUSDT", 10_000, 50_000),
        ticker("MSTRUSDT", 20_000, 185),
        ticker("ETHUSDC", 30_000, 4_000),
        ticker("DELIVERYUSDT", 40_000, 100),
        ticker("PAUSEDUSDT", 50_000, 10),
      ]);
    }
    if (url.pathname.endsWith("/klines")) {
      return Response.json([
        [1_720_000_000_000, "90", "110", "80", "100", "8", 1_720_086_399_999, "1,000"],
        [1_720_086_400_000, "100", "120", "90", "110", "9", 1_720_172_799_999, "2500"],
      ].map((row) => {
        row[7] = String(row[7]).replace(",", "");
        return row;
      }));
    }
    return new Response("not found", { status: 404 });
  };
  const service = new binance.BinanceMarketDataService(
    new binance.BinanceFuturesClient({ fetch: fetcher }),
    {
      exchangeInfoTtlMs: 60_000,
      tickerTtlMs: 60_000,
      radarHistoryTtlMs: 86_400_000,
    },
  );

  const [firstCandidates, concurrentCandidates] = await Promise.all([
    service.getRadarSourceCandidates(),
    service.getRadarSourceCandidates(),
  ]);
  assert.deepEqual(firstCandidates, concurrentCandidates);
  assert.deepEqual(firstCandidates.map(({ symbol, segment, quoteVolume24h, onboardDate }) => ({
    symbol,
    segment,
    quoteVolume24h,
    onboardDate,
  })), [
    { symbol: "MSTRUSDT", segment: "tradfi", quoteVolume24h: 20_000, onboardDate: 1_700_000_000_000 },
    { symbol: "BTCUSDT", segment: "crypto", quoteVolume24h: 10_000, onboardDate: 1_600_000_000_000 },
  ]);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/exchangeInfo")).length, 1);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/ticker/24hr")).length, 1);

  const range = { startTime: 1_719_000_000_000, endTime: 1_722_000_000_000 };
  const [history, concurrentHistory] = await Promise.all([
    service.getRadarDailyHistory("BTCUSDT", range),
    service.getRadarDailyHistory("BTCUSDT", range),
  ]);
  assert.deepEqual(concurrentHistory, history);
  assert.deepEqual(history.map(({ closePrice, quoteVolume }) => ({ closePrice, quoteVolume })), [
    { closePrice: 100, quoteVolume: 1_000 },
    { closePrice: 110, quoteVolume: 2_500 },
  ]);
  const klineCalls = calls.filter((url) => url.pathname.endsWith("/klines"));
  assert.equal(klineCalls.length, 1);
  assert.equal(klineCalls[0].searchParams.get("interval"), "1d");
  assert.equal(klineCalls[0].searchParams.get("limit"), "32");
  assert.equal(klineCalls[0].searchParams.get("startTime"), String(range.startTime));
  assert.equal(klineCalls[0].searchParams.get("endTime"), String(range.endTime));

  await service.getRadarDailyHistory("BTCUSDT", { ...range, endTime: range.endTime + 86_400_000 });
  assert.equal(calls.filter((url) => url.pathname.endsWith("/klines")).length, 2);
});

test("API routes expose the exact LIVE universe and chart contracts", async () => {
  const [universeRoute, chartsRoute, clientSource] = await Promise.all([
    readFile(new URL("../app/api/chart-universe/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/charts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/binance-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(universeRoute, /export async function GET/);
  assert.match(universeRoute, /market: "USD-M"/);
  assert.match(universeRoute, /searchParams\.get\("segment"\)/);
  assert.match(universeRoute, /parseBinanceMarketSegment/);
  assert.match(universeRoute, /getSymbolCatalog\(segment\)/);
  assert.match(universeRoute, /sort: "quoteVolume"/);
  assert.match(universeRoute, /order: "desc"/);
  assert.match(universeRoute, /window: "24h"/);
  assert.match(universeRoute, /refreshInterval: "30m"/);
  assert.match(universeRoute, /chartWallRecommendation/);
  assert.match(universeRoute, /schemaVersion: 7/);
  assert.match(universeRoute, /chartWallRecommendation: \{[\s\S]*?sort: "quoteVolume"/);
  assert.match(universeRoute, /count: 12/);
  assert.match(universeRoute, /available: recommendationAvailable/);
  assert.match(universeRoute, /availableRankCount/);
  assert.match(universeRoute, /userPinnedSlots: Array\.from/);
  assert.match(universeRoute, /defaultSymbols: segment === "crypto"/);
  assert.match(universeRoute, /BINANCE_CRYPTO_DEFAULT_CHART_SYMBOLS\s*:\s*\[\]/);
  assert.match(universeRoute, /rankedCount: BINANCE_RANKED_CHART_SLOT_COUNT/);
  assert.doesNotMatch(universeRoute, /fixedSlots/);
  assert.match(universeRoute, /rankField: "recommendationRank"/);
  assert.match(universeRoute, /refreshInterval: "1h"/);
  assert.match(universeRoute, /weights: \{ quoteVolume: 1, changeRate: 0 \}/);
  assert.match(universeRoute, /missingChangeRate: "neutral-50"/);
  assert.match(universeRoute, /if \(segment === "crypto"\) throw error/);
  assert.match(
    universeRoute,
    /Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30"/,
  );
  assert.doesNotMatch(universeRoute, /getUniverse\(/);
  assert.match(universeRoute, /segment,/);
  assert.match(chartsRoute, /export async function POST/);
  assert.match(chartsRoute, /parseBinanceChartsRequest/);
  assert.match(chartsRoute, /complete: true/);
  assert.match(chartsRoute, /Cache-Control": "no-store"/);
  assert.match(clientSource, /process\.env\.BINANCE_FUTURES_REST_URL/);
  assert.match(clientSource, /process\.env\.BINANCE_FUTURES_REST_FALLBACK_URLS/);
  assert.match(clientSource, /environment\.BINANCE_FUTURES_REST_URL\?\.trim/);
  assert.match(clientSource, /environment\.BINANCE_FUTURES_REST_FALLBACK_URLS/);
  assert.match(clientSource, /environment\.BINANCE_FUTURES_BASE_URL\?\.trim/);
  assert.match(clientSource, /https:\/\/fapi\.binance\.com/);
  assert.match(clientSource, /TRADIFI_PERPETUAL/);
  assert.match(clientSource, /marginAsset === "USDT"/);
  assert.match(clientSource, /rankBinanceWeightedCatalog\(candidates\)/);
  assert.match(clientSource, /coalesceInFlight: false/);
});
