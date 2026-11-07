"use client";

import {
  BINANCE_RADAR_ANALYSIS_LIMIT,
  BINANCE_RADAR_HISTORY_CONCURRENCY,
  BINANCE_RADAR_RESULT_LIMIT,
  buildBinanceRadarResult,
  selectBinanceRadarAnalysisCandidates,
  type BinanceRadarApiResponse,
  type BinanceRadarDailyCandle,
  type BinanceRadarSourceCandidate,
} from "../../lib/binance-radar";
import { rankBinanceWeightedCatalog } from "../../lib/binance-catalog-ranking";
import type { ChartTimeframe } from "./CandlestickChart";

export const BINANCE_PUBLIC_FUTURES_REST_BASE = "https://fapi.binance.com";
export const BINANCE_PUBLIC_REQUEST_TIMEOUT_MS = 8_000;
export const BINANCE_PUBLIC_KLINE_LIMIT = 84;

const EXCHANGE_INFO_CACHE_MS = 5 * 60_000;
const TICKER_24HR_CACHE_MS = 5 * 60_000;
const RADAR_HISTORY_DAY_MS = 24 * 60 * 60 * 1_000;
const RADAR_HISTORY_LIMIT = 32;
export const BINANCE_PUBLIC_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M",
] as const satisfies readonly ChartTimeframe[];
const VALID_TIMEFRAMES = new Set<ChartTimeframe>(BINANCE_PUBLIC_TIMEFRAMES);

export type BinancePublicSymbolInfo = {
  symbol: string;
  baseAsset: string;
  quoteAsset: "USDT";
  marginAsset: "USDT";
  contractType: "PERPETUAL" | "TRADIFI_PERPETUAL";
  tickSize: string;
  onboardDate?: number;
};

export type BinancePublicUniverseItem = {
  rank: number;
  symbol: string;
  name: string;
  baseAsset: string;
  quoteAsset: "USDT";
  currency: "USDT";
  lastPrice: number;
  changeRate: number;
  quoteVolume: number;
  priceTimestamp: string;
  tickSize: string;
};

export type BinancePublicCatalogItem = BinancePublicUniverseItem & {
  rankingScore?: number;
  volumeScore?: number;
  changeScore?: number;
  recommendationRank?: number;
};

export type BinancePublicTicker = {
  symbol: string;
  lastPrice: number;
  changeRate: number | null;
  quoteVolume: number;
  closeTime: number | null;
};

export type BinancePublicCandle = {
  timestamp: string;
  openTime: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume: number;
};

export type BinancePublicChartSeries = {
  symbol: string;
  name: string;
  currency: "USDT";
  tickSize: string;
  price: {
    lastPrice: number;
    timestamp: string;
  };
  candles: BinancePublicCandle[];
  timeframe: ChartTimeframe;
};

export type BinancePublicChartSelection = {
  symbol: string;
  timeframe: ChartTimeframe;
};

export type BinancePublicRadarResult = BinanceRadarApiResponse & {
  mode: "LIVE";
  source: "browser-public-rest";
  market: "USD-M";
  scope: "USDT_PERPETUAL";
};

type ClientOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  segment?: "crypto" | "tradfi";
};

type ExchangeInfoCache = {
  expiresAt: number;
  symbols: BinancePublicSymbolInfo[];
};

type Ticker24hrCache = {
  expiresAt: number;
  tickers: BinancePublicTicker[];
};

let exchangeInfoCache: ExchangeInfoCache | null = null;
let exchangeInfoFlight: Promise<BinancePublicSymbolInfo[]> | null = null;
let exchangeInfoCacheRevision = 0;
let ticker24hrCache: Ticker24hrCache | null = null;
let ticker24hrFlight: Promise<BinancePublicTicker[]> | null = null;
let ticker24hrCacheRevision = 0;
let radarHistorySnapshotStart = -1;
let radarHistoryCacheRevision = 0;
const radarHistoryCache = new Map<string, readonly BinanceRadarDailyCandle[]>();
const radarHistoryFlights = new Map<
  string,
  Promise<readonly BinanceRadarDailyCandle[]>
>();

export class BinancePublicClientError extends Error {
  readonly status?: number;
  readonly code: "http" | "timeout" | "cors-network" | "invalid-response" | "validation";

  constructor(
    message: string,
    code: BinancePublicClientError["code"],
    status?: number,
  ) {
    super(message);
    this.name = "BinancePublicClientError";
    this.code = code;
    this.status = status;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  return finiteNumber(value);
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "알 수 없는 오류";
}

function publicUrl(pathname: string, params?: Record<string, string>) {
  const url = new URL(pathname, BINANCE_PUBLIC_FUTURES_REST_BASE);
  if (url.origin !== BINANCE_PUBLIC_FUTURES_REST_BASE) {
    throw new BinancePublicClientError("허용되지 않은 Binance 공개 URL입니다.", "validation");
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function responsePayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

async function fetchPublicJson(
  pathname: string,
  params: Record<string, string> | undefined,
  parentSignal: AbortSignal | undefined,
  options: ClientOptions,
): Promise<unknown> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new BinancePublicClientError("브라우저 fetch를 사용할 수 없습니다.", "cors-network");
  }
  const timeoutMs = options.timeoutMs ?? BINANCE_PUBLIC_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new BinancePublicClientError("공개 REST timeout 값이 올바르지 않습니다.", "validation");
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetcher(publicUrl(pathname, params), {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await responsePayload(response);
    if (!response.ok) {
      const source = record(payload);
      const detail = text(source.msg) || text(source.message);
      throw new BinancePublicClientError(
        `Binance 브라우저 공개 REST 실패 (HTTP ${response.status})${detail ? ` · ${detail}` : ""}`,
        "http",
        response.status,
      );
    }
    return payload;
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    if (timedOut) {
      throw new BinancePublicClientError(
        `Binance 브라우저 공개 REST가 ${Math.round(timeoutMs / 1_000)}초 안에 응답하지 않았습니다.`,
        "timeout",
      );
    }
    if (error instanceof BinancePublicClientError) throw error;
    throw new BinancePublicClientError(
      `Binance 브라우저 공개 REST CORS 또는 네트워크 오류 · ${errorMessage(error)}`,
      "cors-network",
    );
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export function isEligiblePublicFuturesSymbol(symbol: string) {
  return /^[A-Z0-9]{5,30}$/.test(symbol) && symbol.endsWith("USDT");
}

export function parsePublicExchangeInfo(payload: unknown): BinancePublicSymbolInfo[] {
  const root = record(payload);
  const rawSymbols = Array.isArray(root.symbols) ? root.symbols : [];
  const seen = new Set<string>();
  const symbols: BinancePublicSymbolInfo[] = [];
  for (const rawSymbol of rawSymbols) {
    const source = record(rawSymbol);
    const symbol = text(source.symbol).toUpperCase();
    const baseAsset = text(source.baseAsset).toUpperCase();
    const quoteAsset = text(source.quoteAsset).toUpperCase();
    const marginAsset = text(source.marginAsset).toUpperCase();
    const contractType = text(source.contractType).toUpperCase();
    const status = text(source.status).toUpperCase();
    const onboardDate = finiteNumber(source.onboardDate);
    if (
      !isEligiblePublicFuturesSymbol(symbol) ||
      !baseAsset ||
      quoteAsset !== "USDT" ||
      marginAsset !== "USDT" ||
      (contractType !== "PERPETUAL" && contractType !== "TRADIFI_PERPETUAL") ||
      status !== "TRADING" ||
      seen.has(symbol)
    ) continue;
    const filters = Array.isArray(source.filters) ? source.filters : [];
    const priceFilter = filters
      .map(record)
      .find((filter) => text(filter.filterType) === "PRICE_FILTER");
    const tickSize = text(priceFilter?.tickSize);
    if (positiveNumber(tickSize) === null) continue;
    seen.add(symbol);
    symbols.push({
      symbol,
      baseAsset,
      quoteAsset: "USDT",
      marginAsset: "USDT",
      contractType,
      tickSize,
      ...(onboardDate !== null && onboardDate >= 0 ? { onboardDate } : {}),
    });
  }
  if (symbols.length === 0) {
    throw new BinancePublicClientError(
      "Binance exchangeInfo에 거래 가능한 USDT 무기한 선물이 없습니다.",
      "invalid-response",
    );
  }
  return symbols;
}

export function parsePublicTickers(payload: unknown): BinancePublicTicker[] {
  if (!Array.isArray(payload)) {
    throw new BinancePublicClientError("Binance ticker/24hr 응답 형식이 잘못됐습니다.", "invalid-response");
  }
  const tickers = payload.flatMap((rawTicker) => {
    const ticker = record(rawTicker);
    const symbol = text(ticker.symbol).toUpperCase();
    const lastPrice = positiveNumber(ticker.lastPrice);
    const changeRate = optionalFiniteNumber(ticker.priceChangePercent);
    const quoteVolume = finiteNumber(ticker.quoteVolume);
    const closeTime = finiteNumber(ticker.closeTime);
    if (
      !symbol ||
      lastPrice === null ||
      quoteVolume === null ||
      quoteVolume < 0
    ) return [];
    return [{ symbol, lastPrice, changeRate, quoteVolume, closeTime }];
  });
  if (tickers.length === 0) {
    throw new BinancePublicClientError(
      "Binance ticker/24hr에 사용 가능한 ticker가 없습니다.",
      "invalid-response",
    );
  }
  return tickers;
}

export function parsePublicKlines(payload: unknown): BinancePublicCandle[] {
  if (!Array.isArray(payload)) {
    throw new BinancePublicClientError("Binance klines 응답 형식이 잘못됐습니다.", "invalid-response");
  }
  const candles = new Map<number, BinancePublicCandle>();
  for (const rawCandle of payload) {
    if (!Array.isArray(rawCandle) || rawCandle.length < 8) continue;
    const openTime = finiteNumber(rawCandle[0]);
    const openPrice = positiveNumber(rawCandle[1]);
    const highPrice = positiveNumber(rawCandle[2]);
    const lowPrice = positiveNumber(rawCandle[3]);
    const closePrice = positiveNumber(rawCandle[4]);
    const volume = finiteNumber(rawCandle[5]);
    const quoteVolume = finiteNumber(rawCandle[7]);
    if (
      openTime === null ||
      openTime < 0 ||
      openPrice === null ||
      highPrice === null ||
      lowPrice === null ||
      closePrice === null ||
      volume === null ||
      volume < 0 ||
      quoteVolume === null ||
      quoteVolume < 0
    ) continue;
    candles.set(openTime, {
      timestamp: new Date(openTime).toISOString(),
      openTime,
      openPrice,
      highPrice: Math.max(highPrice, openPrice, closePrice),
      lowPrice: Math.min(lowPrice, openPrice, closePrice),
      closePrice,
      volume,
      quoteVolume,
    });
  }
  const ordered = [...candles.values()]
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-BINANCE_PUBLIC_KLINE_LIMIT);
  if (ordered.length === 0) {
    throw new BinancePublicClientError("Binance klines에 유효한 캔들이 없습니다.", "invalid-response");
  }
  return ordered;
}

export function parsePublicRadarDailyKlines(
  payload: unknown,
): BinanceRadarDailyCandle[] {
  if (!Array.isArray(payload)) {
    throw new BinancePublicClientError(
      "Binance 일봉 응답 형식이 잘못됐습니다.",
      "invalid-response",
    );
  }
  const candles = new Map<number, BinanceRadarDailyCandle>();
  for (const rawCandle of payload) {
    if (!Array.isArray(rawCandle) || rawCandle.length < 8) continue;
    const openTime = finiteNumber(rawCandle[0]);
    const closeTime = finiteNumber(rawCandle[6]);
    const closePrice = positiveNumber(rawCandle[4]);
    const quoteVolume = finiteNumber(rawCandle[7]);
    if (
      openTime === null ||
      openTime < 0 ||
      closeTime === null ||
      closeTime < openTime ||
      closePrice === null ||
      quoteVolume === null ||
      quoteVolume < 0
    ) continue;
    candles.set(openTime, { openTime, closeTime, closePrice, quoteVolume });
  }
  return [...candles.values()]
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-RADAR_HISTORY_LIMIT);
}

function waitForSharedFlight<T>(
  flight: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return flight;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function loadExchangeInfo(
  signal: AbortSignal | undefined,
  options: ClientOptions,
) {
  if (exchangeInfoCache && exchangeInfoCache.expiresAt > Date.now()) {
    return exchangeInfoCache.symbols;
  }
  if (!exchangeInfoFlight) {
    const revision = exchangeInfoCacheRevision;
    const flight = fetchPublicJson(
      "/fapi/v1/exchangeInfo",
      undefined,
      undefined,
      options,
    ).then((payload) => {
      const symbols = parsePublicExchangeInfo(payload);
      if (revision === exchangeInfoCacheRevision) {
        exchangeInfoCache = {
          symbols,
          expiresAt: Date.now() + EXCHANGE_INFO_CACHE_MS,
        };
      }
      return symbols;
    });
    exchangeInfoFlight = flight;
    const clearFlight = () => {
      if (exchangeInfoFlight === flight) exchangeInfoFlight = null;
    };
    void flight.then(clearFlight, clearFlight);
  }

  const flight = exchangeInfoFlight;
  if (!signal) return flight;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<BinancePublicSymbolInfo[]>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.then(
      (symbols) => {
        signal.removeEventListener("abort", onAbort);
        resolve(symbols);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function loadTicker24hr(
  signal: AbortSignal | undefined,
  options: ClientOptions,
) {
  if (ticker24hrCache && ticker24hrCache.expiresAt > Date.now()) {
    return ticker24hrCache.tickers;
  }
  if (!ticker24hrFlight) {
    const revision = ticker24hrCacheRevision;
    const flight = fetchPublicJson(
      "/fapi/v1/ticker/24hr",
      undefined,
      undefined,
      options,
    ).then((payload) => {
      const tickers = parsePublicTickers(payload);
      if (revision === ticker24hrCacheRevision) {
        ticker24hrCache = {
          tickers,
          expiresAt: Date.now() + TICKER_24HR_CACHE_MS,
        };
      }
      return tickers;
    });
    ticker24hrFlight = flight;
    const clearFlight = () => {
      if (ticker24hrFlight === flight) ticker24hrFlight = null;
    };
    void flight.then(clearFlight, clearFlight);
  }

  const flight = ticker24hrFlight;
  if (!signal) return flight;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<BinancePublicTicker[]>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.then(
      (tickers) => {
        signal.removeEventListener("abort", onAbort);
        resolve(tickers);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function rankedPublicCatalog(
  symbols: BinancePublicSymbolInfo[],
  tickers: BinancePublicTicker[],
  segment: ClientOptions["segment"],
): BinancePublicCatalogItem[] {
  const contractType = segment === "tradfi"
    ? "TRADIFI_PERPETUAL"
    : "PERPETUAL";
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  const observedAt = Date.now();
  const candidates = symbols
    .filter((symbol) => symbol.contractType === contractType)
    .map((symbol) => {
      const ticker = tickerBySymbol.get(symbol.symbol);
      const timestamp = ticker?.closeTime !== null &&
          ticker?.closeTime !== undefined &&
          ticker.closeTime >= 0
        ? ticker.closeTime
        : observedAt;
      return {
        rank: 0,
        symbol: symbol.symbol,
        name: `${symbol.baseAsset}/USDT`,
        baseAsset: symbol.baseAsset,
        quoteAsset: "USDT" as const,
        currency: "USDT" as const,
        lastPrice: ticker?.lastPrice ?? 0,
        changeRate: ticker?.changeRate ?? null,
        quoteVolume: ticker?.quoteVolume ?? 0,
        priceTimestamp: new Date(timestamp).toISOString(),
        tickSize: symbol.tickSize,
      };
    });
  const ranked = rankBinanceWeightedCatalog(candidates);
  return ranked.map((item, index): BinancePublicCatalogItem => ({
    ...item,
    rank: index + 1,
    changeRate: item.changeRate ?? 0,
  }));
}

function invalidateTicker24hrCache() {
  ticker24hrCacheRevision += 1;
  ticker24hrCache = null;
  ticker24hrFlight = null;
}

function publicRadarSources(
  symbols: BinancePublicSymbolInfo[],
  tickers: BinancePublicTicker[],
): BinanceRadarSourceCandidate[] {
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  return symbols
    .flatMap((symbol): BinanceRadarSourceCandidate[] => {
      const ticker = tickerBySymbol.get(symbol.symbol);
      if (!ticker) return [];
      return [{
        symbol: symbol.symbol,
        name: `${symbol.baseAsset}/USDT`,
        baseAsset: symbol.baseAsset,
        segment: symbol.contractType === "TRADIFI_PERPETUAL" ? "tradfi" : "crypto",
        lastPrice: ticker.lastPrice,
        changeRate: ticker.changeRate ?? 0,
        quoteVolume24h: ticker.quoteVolume,
        tickSize: symbol.tickSize,
        ...(symbol.onboardDate === undefined ? {} : { onboardDate: symbol.onboardDate }),
      }];
    })
    .sort((left, right) =>
      right.quoteVolume24h - left.quoteVolume24h ||
      left.symbol.localeCompare(right.symbol)
    );
}

function radarHistoryWindow(now: number) {
  const snapshotStart = Math.floor(now / RADAR_HISTORY_DAY_MS) * RADAR_HISTORY_DAY_MS;
  return {
    snapshotStart,
    startTime: snapshotStart - RADAR_HISTORY_LIMIT * RADAR_HISTORY_DAY_MS,
    endTime: snapshotStart - 1,
  };
}

function ensureRadarHistorySnapshot(snapshotStart: number) {
  if (radarHistorySnapshotStart === snapshotStart) return;
  radarHistoryCacheRevision += 1;
  radarHistorySnapshotStart = snapshotStart;
  radarHistoryCache.clear();
  radarHistoryFlights.clear();
}

async function loadPublicRadarHistory(
  symbol: string,
  window: ReturnType<typeof radarHistoryWindow>,
  signal: AbortSignal | undefined,
  options: ClientOptions,
): Promise<readonly BinanceRadarDailyCandle[]> {
  ensureRadarHistorySnapshot(window.snapshotStart);
  const cached = radarHistoryCache.get(symbol);
  if (cached) return cached;

  let flight = radarHistoryFlights.get(symbol);
  if (!flight) {
    const revision = radarHistoryCacheRevision;
    const snapshotStart = window.snapshotStart;
    const nextFlight = fetchPublicJson(
      "/fapi/v1/klines",
      {
        symbol,
        interval: "1d",
        startTime: String(window.startTime),
        endTime: String(window.endTime),
        limit: String(RADAR_HISTORY_LIMIT),
      },
      undefined,
      options,
    ).then((payload) => {
      const candles = parsePublicRadarDailyKlines(payload).filter((candle) =>
        candle.openTime >= window.startTime && candle.closeTime <= window.endTime
      );
      if (candles.length === 0) {
        throw new BinancePublicClientError(
          `${symbol}의 완료 일봉 거래대금 이력이 비어 있습니다.`,
          "invalid-response",
        );
      }
      if (
        revision === radarHistoryCacheRevision &&
        snapshotStart === radarHistorySnapshotStart
      ) {
        radarHistoryCache.set(symbol, candles);
      }
      return candles;
    });
    radarHistoryFlights.set(symbol, nextFlight);
    const clearFlight = () => {
      if (radarHistoryFlights.get(symbol) === nextFlight) {
        radarHistoryFlights.delete(symbol);
      }
    };
    void nextFlight.then(clearFlight, clearFlight);
    flight = nextFlight;
  }
  return waitForSharedFlight(flight, signal);
}

async function loadPublicRadarHistories(
  candidates: readonly BinanceRadarSourceCandidate[],
  window: ReturnType<typeof radarHistoryWindow>,
  signal: AbortSignal | undefined,
  options: ClientOptions,
) {
  const histories = new Map<string, readonly BinanceRadarDailyCandle[]>();
  let nextIndex = 0;
  let fatalError: unknown;
  const worker = async () => {
    while (!fatalError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      try {
        const candles = await loadPublicRadarHistory(
          candidate.symbol,
          window,
          signal,
          options,
        );
        histories.set(candidate.symbol, candles);
      } catch (error) {
        if (signal?.aborted) {
          fatalError = error;
          throw error;
        }
        if (
          error instanceof BinancePublicClientError &&
          (
            (error.status ?? 0) >= 500 ||
            error.status === 418 ||
            error.status === 429 ||
            error.status === 451 ||
            error.status === 403 ||
            error.code === "cors-network" ||
            error.code === "timeout"
          )
        ) {
          fatalError = error;
          throw error;
        }
        // A missing symbol history is scored neutrally by the shared scorer.
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(BINANCE_RADAR_HISTORY_CONCURRENCY, candidates.length) },
      () => worker(),
    ),
  );
  if (histories.size === 0) {
    throw new BinancePublicClientError(
      "Binance 브라우저 공개 REST에서 레이더 일봉 이력을 확인하지 못했습니다.",
      "invalid-response",
    );
  }
  return histories;
}

export async function loadPublicFuturesRadar(
  signal?: AbortSignal,
  options: ClientOptions = {},
): Promise<BinancePublicRadarResult> {
  const now = Date.now();
  const [symbols, tickers] = await Promise.all([
    loadExchangeInfo(signal, options),
    loadTicker24hr(signal, options),
  ]);
  const candidates = publicRadarSources(symbols, tickers);
  if (candidates.length === 0) {
    invalidateTicker24hrCache();
    throw new BinancePublicClientError(
      "Binance 브라우저 공개 REST에서 레이더 대상 USDT 무기한 선물을 확인하지 못했습니다.",
      "invalid-response",
    );
  }
  const analysisCandidates = selectBinanceRadarAnalysisCandidates(candidates)
    .slice(0, BINANCE_RADAR_ANALYSIS_LIMIT);
  const window = radarHistoryWindow(now);
  const histories = await loadPublicRadarHistories(
    analysisCandidates,
    window,
    signal,
    options,
  );
  const result = buildBinanceRadarResult(candidates, histories, {
    now,
    limit: BINANCE_RADAR_RESULT_LIMIT,
  });
  if (result.items.length === 0) {
    throw new BinancePublicClientError(
      "Binance 브라우저 공개 REST 레이더 결과가 비어 있습니다.",
      "invalid-response",
    );
  }
  if (result.coverage.historyReady === 0) {
    throw new BinancePublicClientError(
      "Binance 브라우저 공개 REST 레이더의 최신 완료 일봉 이력이 비어 있습니다.",
      "invalid-response",
    );
  }
  return {
    mode: "LIVE",
    source: "browser-public-rest",
    market: "USD-M",
    scope: "USDT_PERPETUAL",
    ...result,
    timestamp: result.computedAt,
    evaluatedCount: result.coverage.analyzed,
    eligibleCount: result.coverage.eligible,
    historyReadyCount: result.coverage.historyReady,
  };
}

export async function loadPublicFuturesCatalog(
  signal?: AbortSignal,
  options: ClientOptions = {},
): Promise<BinancePublicCatalogItem[]> {
  const [symbols, tickers] = await Promise.all([
    loadExchangeInfo(signal, options),
    loadTicker24hr(signal, options),
  ]);
  const items = rankedPublicCatalog(symbols, tickers, options.segment);
  if (items.length === 0) {
    throw new BinancePublicClientError(
      `Binance 브라우저 공개 REST에서 거래 가능한 ${
        options.segment === "tradfi" ? "TRADFI" : "CRYPTO"
      } USDT 무기한 선물이 없습니다.`,
      "invalid-response",
    );
  }
  if (!items.some((item) => item.lastPrice > 0)) {
    invalidateTicker24hrCache();
    throw new BinancePublicClientError(
      `Binance 브라우저 공개 REST에서 ${
        options.segment === "tradfi" ? "TRADFI" : "CRYPTO"
      } USDT 무기한 선물과 일치하는 24시간 ticker가 없습니다.`,
      "invalid-response",
    );
  }
  return items;
}

export async function loadPublicFuturesUniverse(
  signal?: AbortSignal,
  options: ClientOptions = {},
): Promise<BinancePublicUniverseItem[]> {
  const [symbols, tickers] = await Promise.all([
    loadExchangeInfo(signal, options),
    loadTicker24hr(signal, options),
  ]);
  const ranked = rankedPublicCatalog(symbols, tickers, options.segment)
    .filter((item) => item.lastPrice > 0)
    .sort((left, right) =>
      right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol)
    )
    .slice(0, 12)
    .map((item, index): BinancePublicUniverseItem => ({
      rank: index + 1,
      symbol: item.symbol,
      name: item.name,
      baseAsset: item.baseAsset,
      quoteAsset: item.quoteAsset,
      currency: item.currency,
      lastPrice: item.lastPrice,
      changeRate: item.changeRate,
      quoteVolume: item.quoteVolume,
      priceTimestamp: item.priceTimestamp,
      tickSize: item.tickSize,
    }));
  if (ranked.length < 12) {
    throw new BinancePublicClientError(
      `Binance 브라우저 공개 REST에서 거래 가능한 TOP12 중 ${ranked.length}개만 확인됐습니다.`,
      "invalid-response",
    );
  }
  return ranked;
}

export async function loadPublicFuturesChartSeries(
  selections: BinancePublicChartSelection[],
  signal?: AbortSignal,
  options: ClientOptions = {},
): Promise<BinancePublicChartSeries[]> {
  if (selections.length < 1 || selections.length > 12) {
    throw new BinancePublicClientError("공개 차트 요청은 1~12개 슬롯만 허용합니다.", "validation");
  }
  const normalized = selections.map((selection) => {
    const symbol = selection.symbol.trim().toUpperCase();
    if (!isEligiblePublicFuturesSymbol(symbol) || !VALID_TIMEFRAMES.has(selection.timeframe)) {
      throw new BinancePublicClientError(
        `허용되지 않은 Binance 공개 차트 요청: ${symbol || "(empty)"}`,
        "validation",
      );
    }
    return { symbol, timeframe: selection.timeframe };
  });
  const symbols = await loadExchangeInfo(signal, options);
  const infoBySymbol = new Map(symbols.map((symbol) => [symbol.symbol, symbol]));
  for (const selection of normalized) {
    if (!infoBySymbol.has(selection.symbol)) {
      throw new BinancePublicClientError(
        `${selection.symbol}은(는) 거래 가능한 USDT 무기한 선물이 아닙니다.`,
        "validation",
      );
    }
  }

  const candleSets = await Promise.all(normalized.map(async (selection) =>
    parsePublicKlines(await fetchPublicJson(
      "/fapi/v1/klines",
      {
        symbol: selection.symbol,
        interval: selection.timeframe,
        limit: String(BINANCE_PUBLIC_KLINE_LIMIT),
      },
      signal,
      options,
    ))
  ));
  const observedAt = new Date().toISOString();
  return normalized.map((selection, index): BinancePublicChartSeries => {
    const info = infoBySymbol.get(selection.symbol)!;
    const candles = candleSets[index];
    const latest = candles.at(-1)!;
    return {
      symbol: selection.symbol,
      name: `${info.baseAsset}/USDT`,
      currency: "USDT",
      tickSize: info.tickSize,
      price: { lastPrice: latest.closePrice, timestamp: observedAt },
      candles,
      timeframe: selection.timeframe,
    };
  });
}

export function clearBinancePublicClientCache() {
  exchangeInfoCacheRevision += 1;
  exchangeInfoCache = null;
  exchangeInfoFlight = null;
  invalidateTicker24hrCache();
  radarHistoryCacheRevision += 1;
  radarHistorySnapshotStart = -1;
  radarHistoryCache.clear();
  radarHistoryFlights.clear();
}
