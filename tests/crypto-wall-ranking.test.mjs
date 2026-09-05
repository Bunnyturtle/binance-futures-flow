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

const ranking = await importTypescript("../lib/crypto-wall-ranking.ts");

function candidate(index, overrides = {}) {
  return {
    symbol: `COIN${String(index + 1).padStart(2, "0")}USDT`,
    recommendationRank: index + 1,
    rankingScore: 100 - index,
    quoteVolume: 10_000 - index * 100,
    lastPrice: 100 + index,
    ...overrides,
  };
}

function catalog(overrides = new Map()) {
  return Array.from({ length: 12 }, (_, index) =>
    candidate(index, overrides.get(index + 1) ?? {})
  );
}

test("preserves user-owned C1/C2 and orders C3-C12 by exact recommendation rank", () => {
  const rankedCatalog = catalog(new Map([
    [2, { symbol: "SOLUSDT" }],
    [11, { symbol: "XRPUSDT" }],
  ]));
  const catalogInDifferentVolumeOrder = [...rankedCatalog]
    .reverse()
    .map((item, index) => ({ ...item, quoteVolume: 1_000_000 - index * 10_000 }));
  const selected = ranking.selectAutoWallSymbols(
    catalogInDifferentVolumeOrder,
    ranking.AUTO_WALL_SLOT_COUNT,
    ["SOLUSDT", "XRPUSDT"],
  );
  const expectedDynamic = rankedCatalog
    .filter(({ symbol }) => symbol !== "SOLUSDT" && symbol !== "XRPUSDT")
    .map(({ symbol }) => symbol);

  assert.equal(ranking.AUTO_WALL_SLOT_COUNT, 12);
  assert.equal(ranking.AUTO_WALL_USER_PINNED_SLOT_COUNT, 2);
  assert.equal(ranking.AUTO_WALL_RANKED_SLOT_COUNT, 10);
  assert.deepEqual(ranking.CRYPTO_WALL_DEFAULT_SYMBOLS, ["BTCUSDT", "ETHUSDT"]);
  assert.equal(
    ranking.CRYPTO_WALL_RANKING_VERSION,
    "crypto-user-pinned2-quote-volume100-change0-ranked10-v6",
  );
  assert.equal(
    ranking.TRADFI_WALL_RANKING_VERSION,
    "tradfi-user-pinned2-quote-volume100-change0-ranked10-v3",
  );
  assert.deepEqual(selected, ["SOLUSDT", "XRPUSDT", ...expectedDynamic]);
  assert.notDeepEqual(
    selected.slice(2),
    catalogInDifferentVolumeOrder
      .filter(({ symbol }) => symbol !== "SOLUSDT" && symbol !== "XRPUSDT")
      .slice(0, ranking.AUTO_WALL_RANKED_SLOT_COUNT)
      .map(({ symbol }) => symbol),
  );
});

test("uses BTC/ETH only as defaults and backfills pinned symbols inside or outside the top twelve", () => {
  const rankedCatalog = catalog(new Map([
    [1, { symbol: "BTCUSDT" }],
    [12, { symbol: "ETHUSDT" }],
  ]));
  const storedSolXrp = ranking.selectCryptoWallSymbols(
    rankedCatalog,
    12,
    ["SOLUSDT", "XRPUSDT"],
  );
  const defaults = ranking.selectCryptoWallSymbols(rankedCatalog);
  const blankTradfiDefaults = ranking.selectAutoWallSymbols(rankedCatalog, 12, []);

  assert.deepEqual(storedSolXrp.slice(0, 2), ["SOLUSDT", "XRPUSDT"]);
  assert.deepEqual(
    storedSolXrp.slice(2),
    rankedCatalog.slice(0, 10).map(({ symbol }) => symbol),
  );
  assert.deepEqual(defaults.slice(0, 2), ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(blankTradfiDefaults.slice(0, 2), ["", ""]);
  assert.deepEqual(
    blankTradfiDefaults.slice(2),
    rankedCatalog.slice(0, 10).map(({ symbol }) => symbol),
  );
  assert.deepEqual(
    defaults.slice(2),
    rankedCatalog
      .filter(({ symbol }) => symbol !== "BTCUSDT" && symbol !== "ETHUSDT")
      .map(({ symbol }) => symbol),
  );
});

test("preserves duplicate and empty pinned slots while excluding each non-empty pinned symbol", () => {
  const rankedCatalog = catalog(new Map([
    [3, { symbol: "SOLUSDT" }],
    [6, { symbol: "ETHUSDT" }],
  ]));
  const duplicatePinned = ranking.selectAutoWallSymbols(
    rankedCatalog,
    12,
    ["SOLUSDT", "SOLUSDT"],
  );
  const emptyPinned = ranking.selectAutoWallSymbols(
    rankedCatalog,
    12,
    ["", "ETHUSDT"],
  );

  assert.deepEqual(duplicatePinned.slice(0, 2), ["SOLUSDT", "SOLUSDT"]);
  assert.equal(duplicatePinned.slice(2).includes("SOLUSDT"), false);
  assert.equal(duplicatePinned.slice(2).length, 10);
  assert.deepEqual(emptyPinned.slice(0, 2), ["", "ETHUSDT"]);
  assert.equal(emptyPinned.slice(2).includes("ETHUSDT"), false);
  assert.equal(emptyPinned.slice(2).length, 10);
});

test("fails closed when the exact twelve-rank recommendation contract is invalid", () => {
  const valid = catalog();
  const duplicate = valid.map((item, index) =>
    index === 11 ? { ...item, symbol: valid[0].symbol } : item
  );
  const invalidSymbol = valid.map((item, index) =>
    index === 11 ? { ...item, symbol: "BAD" } : item
  );
  const underscoredSymbol = valid.map((item, index) =>
    index === 11 ? { ...item, symbol: "BAD_COINUSDT" } : item
  );
  const invalidRanking = valid.map((item, index) =>
    index === 11
      ? { ...item, recommendationRank: 0, rankingScore: Number.NaN }
      : item
  );
  const missingPrice = valid.map((item, index) =>
    index === 11 ? { ...item, lastPrice: 0 } : item
  );
  const duplicateRank = valid.map((item, index) =>
    index === 11 ? { ...item, recommendationRank: 11 } : item
  );

  assert.deepEqual(ranking.selectAutoWallSymbols(duplicate), []);
  assert.deepEqual(ranking.selectAutoWallSymbols(invalidSymbol), []);
  assert.deepEqual(ranking.selectAutoWallSymbols(underscoredSymbol), []);
  assert.deepEqual(ranking.selectAutoWallSymbols(invalidRanking), []);
  assert.deepEqual(ranking.selectAutoWallSymbols(missingPrice), []);
  assert.deepEqual(ranking.selectAutoWallSymbols(duplicateRank), []);
});

test("enforces a one-hour refresh delay for stored and future timestamps", () => {
  const now = 10 * 60 * 60_000;
  assert.equal(ranking.AUTO_WALL_REFRESH_MS, 60 * 60_000);
  assert.equal(ranking.autoWallRefreshDelay(0, now), 0);
  assert.equal(
    ranking.autoWallRefreshDelay(now - ranking.AUTO_WALL_REFRESH_MS + 1, now),
    1,
  );
  assert.equal(
    ranking.autoWallRefreshDelay(now - ranking.AUTO_WALL_REFRESH_MS, now),
    0,
  );
  assert.equal(
    ranking.autoWallRefreshDelay(now + ranking.AUTO_WALL_REFRESH_MS, now),
    0,
  );
  assert.equal(ranking.autoWallRefreshDelay(Number.NaN, now), 0);
});

test("compares complete symbol layouts without ignoring order", () => {
  const current = Array.from({ length: 12 }, (_, index) => candidate(index).symbol);
  assert.equal(ranking.sameSymbolLayout(current, [...current]), true);
  assert.equal(ranking.sameSymbolLayout(current, [...current].reverse()), false);
  assert.equal(ranking.sameSymbolLayout(current, current.slice(0, 11)), false);
});
