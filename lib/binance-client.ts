import type {
  BinanceRadarDailyCandle,
  BinanceRadarSourceCandidate,
} from "./binance-radar";
import { rankBinanceWeightedCatalog } from "./binance-catalog-ranking";
import {
  AUTO_WALL_RANKED_SLOT_COUNT,
  AUTO_WALL_SLOT_COUNT,
  AUTO_WALL_USER_PINNED_SLOT_COUNT,
  CRYPTO_WALL_DEFAULT_SYMBOLS,
} from "./crypto-wall-ranking";

const DEFAULT_BASE_URL = "https://fapi.binance.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_FALLBACK_BASE_URLS = 3;
const MAX_UPSTREAM_ERROR_DETAIL_LENGTH = 240;

export const MAX_BINANCE_CHART_SYMBOLS = AUTO_WALL_SLOT_COUNT;
/** Server aliases of the shared wall-layout policy used in API metadata. */
export const BINANCE_CRYPTO_DEFAULT_CHART_SYMBOLS = CRYPTO_WALL_DEFAULT_SYMBOLS;
export const BINANCE_USER_PINNED_CHART_SLOT_COUNT = AUTO_WALL_USER_PINNED_SLOT_COUNT;
export const BINANCE_RANKED_CHART_SLOT_COUNT = AUTO_WALL_RANKED_SLOT_COUNT;
export const BINANCE_UNIVERSE_CACHE_MS = 5_000;
export const BINANCE_TICKER_CACHE_MS = 5_000;
export const BINANCE_PRICE_CACHE_MS = 750;
export const BINANCE_KLINE_CACHE_MS = 4_500;
export const BINANCE_EXCHANGE_INFO_CACHE_MS = 5 * 60_000;
export const BINANCE_SYMBOL_CATALOG_CACHE_MS = 5 * 60_000;
export const BINANCE_RADAR_HISTORY_CACHE_MS = 48 * 60 * 60_000;

export const BINANCE_CHART_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M",
] as const;

export type BinanceChartTimeframe = (typeof BINANCE_CHART_TIMEFRAMES)[number];
export type BinanceChartDetail = "full" | "quotes";

export const BINANCE_MARKET_SEGMENTS = ["crypto", "tradfi"] as const;
export type BinanceMarketSegment = (typeof BINANCE_MARKET_SEGMENTS)[number];

export interface BinanceEnvironment {
  BINANCE_API_KEY?: string;
  BINANCE_FUTURES_REST_URL?: string;
  /** Backwards-compatible alias for BINANCE_FUTURES_REST_URL. */
  BINANCE_FUTURES_BASE_URL?: string;
  /** Comma-separated, operator-approved REST endpoints tried after a transient failure. */
  BINANCE_FUTURES_REST_FALLBACK_URLS?: string;
  BINANCE_REQUEST_TIMEOUT_MS?: string;
}

export interface BinanceFuturesClientConfig {
  apiKey?: string;
  baseUrl?: string;
  fallbackBaseUrls?: string[];
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface BinanceSymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  contractType: string;
  status: string;
  tickSize: string;
  onboardDate?: number;
}

export interface BinanceTicker24hr {
  symbol: string;
  lastPrice: number;
  changeRate: number | null;
  quoteVolume: number;
  closeTime?: number;
}

export interface BinancePriceTicker {
  symbol: string;
  lastPrice: number;
  timestamp?: number;
}

export interface BinanceUniverseItem {
  rank: number;
  symbol: string;
  name: string;
  baseAsset: string;
  quoteAsset: string;
  currency: "USDT";
  lastPrice: number;
  changeRate: number;
  quoteVolume: number;
  priceTimestamp: string;
  tickSize: string;
}

export interface BinanceSymbolCatalogItem {
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
  rankingScore?: number;
  volumeScore?: number;
  changeScore?: number;
  recommendationRank?: number;
}

export interface BinanceChartCandle {
  timestamp: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume: number;
}

export interface BinanceChartSeries {
  symbol: string;
  name: string;
  currency: "USDT";
  tickSize: string;
  price: {
    lastPrice: number;
    timestamp: string;
  };
  candles: BinanceChartCandle[];
  timeframe: BinanceChartTimeframe;
}

export interface BinanceChartsRequest {
  symbols: string[];
  detail: BinanceChartDetail;
  timeframes: BinanceChartTimeframe[];
}

export class BinanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinanceValidationError";
  }
}

export class BinanceApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(options: {
    message: string;
    status: number;
    code: string;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "BinanceApiError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error("Binance API configuration must only be used in a server runtime.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string {
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

function isoTimestamp(value: unknown, fallback = Date.now()): string {
  const timestamp = finiteNumber(value);
  const normalized = timestamp !== null && timestamp >= 0 ? timestamp : fallback;
  return new Date(normalized).toISOString();
}

function invalidResponse(message: string): BinanceApiError {
  return new BinanceApiError({
    message,
    status: 502,
    code: "invalid-response",
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function rawResponseMessage(payload: unknown): string | undefined {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!isRecord(payload)) return undefined;
  return text(payload.msg) || text(payload.message) || undefined;
}

function safeResponseDetail(payload: unknown): string | undefined {
  const detail = rawResponseMessage(payload)?.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  if (
    /<!doctype\s+html/i.test(detail) ||
    /<html(?:\s|>)/i.test(detail) ||
    /<body(?:\s|>)/i.test(detail) ||
    /<head(?:\s|>)/i.test(detail)
  ) {
    return undefined;
  }
  if (detail.length <= MAX_UPSTREAM_ERROR_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_UPSTREAM_ERROR_DETAIL_LENGTH - 1)}…`;
}

function isCloudFrontBlocked(response: Response, payload: unknown): boolean {
  if (response.status !== 403) return false;
  const rawDetail = rawResponseMessage(payload)?.toLowerCase() ?? "";
  const looksLikeHtml = /<!doctype\s+html|<html(?:\s|>)/i.test(rawDetail);
  const edgeHeaders = [
    response.headers.get("x-amz-cf-id"),
    response.headers.get("x-cache"),
    response.headers.get("via"),
  ].filter((value): value is string => Boolean(value)).join(" ").toLowerCase();
  return rawDetail.includes("cloudfront") ||
    (looksLikeHtml && rawDetail.includes("request could not be satisfied")) ||
    edgeHeaders.includes("cloudfront") ||
    response.headers.has("x-amz-cf-id");
}

function responseCode(payload: unknown, status: number): string {
  if (!isRecord(payload)) return `http-${status}`;
  const code = payload.code;
  return typeof code === "string" || typeof code === "number"
    ? String(code)
    : `http-${status}`;
}

function apiErrorFromResponse(response: Response, payload: unknown): BinanceApiError {
  const detail = safeResponseDetail(payload);
  const code = responseCode(payload, response.status);
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));

  if (response.status === 429) {
    return new BinanceApiError({
      message: `Binance request rate limit exceeded (HTTP 429).${
        retryAfterSeconds === undefined ? "" : ` Retry after ${retryAfterSeconds}s.`
      }`,
      status: 429,
      code,
      retryAfterSeconds,
    });
  }
  if (response.status === 451) {
    return new BinanceApiError({
      message: "Binance USDⓈ-M futures market data is unavailable in this region (HTTP 451).",
      status: 451,
      code,
    });
  }
  if (isCloudFrontBlocked(response, payload)) {
    return new BinanceApiError({
      message: "Binance USDⓈ-M futures endpoint blocked this server request at its CDN edge (HTTP 403).",
      status: 403,
      code: "edge-blocked",
    });
  }
  if (response.status >= 500) {
    return new BinanceApiError({
      message: `Binance upstream service is unavailable (HTTP ${response.status}).${
        detail ? ` ${detail}` : ""
      }`,
      status: response.status,
      code,
    });
  }
  return new BinanceApiError({
    message: `Binance request failed (HTTP ${response.status}).${detail ? ` ${detail}` : ""}`,
    status: response.status,
    code,
    retryAfterSeconds,
  });
}

function validatedBaseUrl(value: string | undefined, settingName: string): string {
  const candidate = value?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new BinanceValidationError(`${settingName} must contain valid URLs.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BinanceValidationError(`${settingName} URLs must use HTTP or HTTPS.`);
  }
  return url.href.replace(/\/$/, "");
}

function validatedBaseUrls(baseUrl: string | undefined, fallbackBaseUrls: string[]): string[] {
  if (fallbackBaseUrls.length > MAX_FALLBACK_BASE_URLS) {
    throw new BinanceValidationError(
      `At most ${MAX_FALLBACK_BASE_URLS} Binance REST fallback URLs may be configured.`,
    );
  }
  const candidates = [
    validatedBaseUrl(baseUrl, "BINANCE_FUTURES_REST_URL"),
    ...fallbackBaseUrls
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => validatedBaseUrl(value, "BINANCE_FUTURES_REST_FALLBACK_URLS")),
  ];
  return [...new Set(candidates)];
}

function shouldFailOver(error: BinanceApiError): boolean {
  return error.code === "network-error" ||
    error.code === "request-timeout" ||
    error.code === "edge-blocked" ||
    error.status >= 500;
}

function parseRequestTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BinanceValidationError("BINANCE_REQUEST_TIMEOUT_MS must be a positive number.");
  }
  return Math.floor(parsed);
}

export class BinanceFuturesClient {
  private readonly apiKey?: string;
  private readonly baseUrls: string[];
  private readonly requestTimeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;
  private activeBaseUrlIndex = 0;

  constructor(config: BinanceFuturesClientConfig = {}) {
    assertServer();
    this.apiKey = config.apiKey?.trim() || undefined;
    this.baseUrls = validatedBaseUrls(config.baseUrl, config.fallbackBaseUrls ?? []);
    this.requestTimeoutMs = Math.floor(
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new BinanceValidationError("requestTimeoutMs must be a positive number.");
    }
    this.fetcher = config.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== "function") {
      throw new Error("A Fetch API implementation is required.");
    }
  }

  private async request(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    const headers = new Headers({ Accept: "application/json" });
    if (this.apiKey) headers.set("X-MBX-APIKEY", this.apiKey);
    const startedAt = Date.now();
    const baseIndexes = this.baseUrls.map(
      (_, offset) => (this.activeBaseUrlIndex + offset) % this.baseUrls.length,
    );
    let lastError: BinanceApiError | undefined;

    for (let attempt = 0; attempt < baseIndexes.length; attempt += 1) {
      const baseIndex = baseIndexes[attempt];
      const remainingBudgetMs = Math.max(
        1,
        this.requestTimeoutMs - (Date.now() - startedAt),
      );
      const remainingAttempts = baseIndexes.length - attempt;
      const attemptTimeoutMs = Math.max(1, Math.floor(remainingBudgetMs / remainingAttempts));
      const url = new URL(`${this.baseUrls[baseIndex]}${path}`);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
      try {
        const response = await this.fetcher(url, {
          method: "GET",
          headers,
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await readResponsePayload(response);
        if (!response.ok) throw apiErrorFromResponse(response, payload);
        this.activeBaseUrlIndex = baseIndex;
        return payload;
      } catch (cause) {
        const error = cause instanceof BinanceApiError
          ? cause
          : controller.signal.aborted
          ? new BinanceApiError({
              message: `Binance request timed out within the ${this.requestTimeoutMs}ms request budget.`,
              status: 0,
              code: "request-timeout",
              cause,
            })
          : new BinanceApiError({
              message: "Binance USDⓈ-M futures market data could not be reached.",
              status: 0,
              code: "network-error",
              cause,
            });
        lastError = error;
        const hasAnotherBaseUrl = attempt + 1 < baseIndexes.length;
        if (!hasAnotherBaseUrl || !shouldFailOver(error)) throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new BinanceApiError({
      message: "Binance USDⓈ-M futures market data could not be reached.",
      status: 0,
      code: "network-error",
    });
  }

  getExchangeInfo(): Promise<unknown> {
    return this.request("/fapi/v1/exchangeInfo");
  }

  get24hrTickers(): Promise<unknown> {
    return this.request("/fapi/v1/ticker/24hr");
  }

  getSymbolPrices(): Promise<unknown> {
    return this.request("/fapi/v2/ticker/price");
  }

  getKlines(
    symbol: string,
    interval: BinanceChartTimeframe,
    limit = 200,
    range: { startTime?: number; endTime?: number } = {},
  ): Promise<unknown> {
    if (!isValidBinanceSymbol(symbol)) {
      throw new BinanceValidationError(`Invalid Binance futures symbol: ${symbol}`);
    }
    if (!isBinanceChartTimeframe(interval)) {
      throw new BinanceValidationError(`Unsupported Binance kline interval: ${interval}`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_500) {
      throw new BinanceValidationError("Kline limit must be an integer between 1 and 1500.");
    }
    const { startTime, endTime } = range;
    if (
      (startTime !== undefined && (!Number.isInteger(startTime) || startTime < 0)) ||
      (endTime !== undefined && (!Number.isInteger(endTime) || endTime < 0)) ||
      (startTime !== undefined && endTime !== undefined && startTime > endTime)
    ) {
      throw new BinanceValidationError("Kline startTime and endTime must be an ordered timestamp range.");
    }
    return this.request("/fapi/v1/klines", {
      symbol,
      interval,
      limit,
      startTime,
      endTime,
    });
  }

}

export function parseExchangeInfo(payload: unknown): BinanceSymbolInfo[] {
  if (!isRecord(payload) || !Array.isArray(payload.symbols)) {
    throw invalidResponse("Binance exchangeInfo response did not contain a symbols array.");
  }
  const symbols: BinanceSymbolInfo[] = [];
  for (const value of payload.symbols) {
    if (!isRecord(value)) continue;
    const symbol = text(value.symbol).toUpperCase();
    const baseAsset = text(value.baseAsset).toUpperCase();
    const quoteAsset = text(value.quoteAsset).toUpperCase();
    const marginAsset = text(value.marginAsset).toUpperCase();
    const contractType = text(value.contractType).toUpperCase();
    const status = text(value.status).toUpperCase();
    const onboardDate = finiteNumber(value.onboardDate);
    if (
      !symbol ||
      !baseAsset ||
      !quoteAsset ||
      !marginAsset ||
      !contractType ||
      !status
    ) continue;
    const filters = Array.isArray(value.filters) ? value.filters : [];
    const priceFilter = filters.find(
      (filter) => isRecord(filter) && text(filter.filterType) === "PRICE_FILTER",
    );
    const tickSize = isRecord(priceFilter) && positiveNumber(priceFilter.tickSize) !== null
      ? text(priceFilter.tickSize)
      : "0.01";
    symbols.push({
      symbol,
      baseAsset,
      quoteAsset,
      marginAsset,
      contractType,
      status,
      tickSize,
      ...(onboardDate !== null && onboardDate >= 0 ? { onboardDate } : {}),
    });
  }
  if (symbols.length === 0) {
    throw invalidResponse("Binance exchangeInfo response contained no usable symbols.");
  }
  return symbols;
}

export function parse24hrTickers(payload: unknown): BinanceTicker24hr[] {
  const values = Array.isArray(payload) ? payload : [payload];
  const tickers: BinanceTicker24hr[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const symbol = text(value.symbol).toUpperCase();
    const lastPrice = positiveNumber(value.lastPrice);
    const changeRate = optionalFiniteNumber(value.priceChangePercent);
    const quoteVolume = finiteNumber(value.quoteVolume);
    const closeTime = finiteNumber(value.closeTime);
    if (
      !symbol ||
      lastPrice === null ||
      quoteVolume === null ||
      quoteVolume < 0
    ) continue;
    tickers.push({
      symbol,
      lastPrice,
      changeRate,
      quoteVolume,
      ...(closeTime !== null && closeTime >= 0 ? { closeTime } : {}),
    });
  }
  if (tickers.length === 0) {
    throw invalidResponse("Binance 24hr ticker response contained no usable tickers.");
  }
  return tickers;
}

export function parseSymbolPrices(payload: unknown): BinancePriceTicker[] {
  const values = Array.isArray(payload) ? payload : [payload];
  const prices: BinancePriceTicker[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const symbol = text(value.symbol).toUpperCase();
    const lastPrice = positiveNumber(value.price);
    const timestamp = finiteNumber(value.time);
    if (!symbol || lastPrice === null) continue;
    prices.push({
      symbol,
      lastPrice,
      ...(timestamp !== null && timestamp >= 0 ? { timestamp } : {}),
    });
  }
  if (prices.length === 0) {
    throw invalidResponse("Binance symbol price response contained no usable prices.");
  }
  return prices;
}

export function parseRestKlines(payload: unknown): BinanceChartCandle[] {
  if (!Array.isArray(payload)) {
    throw invalidResponse("Binance kline response was not an array.");
  }
  const byTimestamp = new Map<number, BinanceChartCandle>();
  for (const value of payload) {
    if (!Array.isArray(value) || value.length < 8) continue;
    const openTime = finiteNumber(value[0]);
    const openPrice = positiveNumber(value[1]);
    const highPrice = positiveNumber(value[2]);
    const lowPrice = positiveNumber(value[3]);
    const closePrice = positiveNumber(value[4]);
    const volume = finiteNumber(value[5]);
    const quoteVolume = finiteNumber(value[7]);
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
    byTimestamp.set(openTime, {
      timestamp: isoTimestamp(openTime),
      openPrice,
      highPrice,
      lowPrice,
      closePrice,
      volume,
      quoteVolume,
    });
  }
  const candles = [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, candle]) => candle);
  if (candles.length === 0) {
    throw invalidResponse("Binance kline response contained no usable candles.");
  }
  return candles;
}

export function parseRadarDailyKlines(payload: unknown): BinanceRadarDailyCandle[] {
  if (!Array.isArray(payload)) {
    throw invalidResponse("Binance radar kline response was not an array.");
  }
  const candles = new Map<number, BinanceRadarDailyCandle>();
  for (const value of payload) {
    if (!Array.isArray(value) || value.length < 8) continue;
    const openTime = finiteNumber(value[0]);
    const closePrice = positiveNumber(value[4]);
    const closeTime = finiteNumber(value[6]);
    const quoteVolume = finiteNumber(value[7]);
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
  const ordered = [...candles.values()].sort((left, right) => left.openTime - right.openTime);
  if (ordered.length === 0) {
    throw invalidResponse("Binance radar kline response contained no usable daily candles.");
  }
  return ordered;
}

export function isBinanceMarketSegment(value: unknown): value is BinanceMarketSegment {
  return typeof value === "string" &&
    BINANCE_MARKET_SEGMENTS.includes(value as BinanceMarketSegment);
}

export function parseBinanceMarketSegment(value: unknown): BinanceMarketSegment {
  if (value === undefined || value === null) return "crypto";
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (isBinanceMarketSegment(normalized)) return normalized;
  throw new BinanceValidationError("segment must be crypto or tradfi.");
}

function contractTypeForSegment(segment: BinanceMarketSegment): string {
  return segment === "tradfi" ? "TRADIFI_PERPETUAL" : "PERPETUAL";
}

function tradableUsdtSymbolsByContractTypes(
  symbols: BinanceSymbolInfo[],
  contractTypes: ReadonlySet<string>,
): BinanceSymbolInfo[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const valid =
      symbol.quoteAsset === "USDT" &&
      symbol.marginAsset === "USDT" &&
      contractTypes.has(symbol.contractType) &&
      symbol.status === "TRADING" &&
      !seen.has(symbol.symbol);
    if (valid) seen.add(symbol.symbol);
    return valid;
  });
}

export function tradableUsdtPerpetualSymbols(
  symbols: BinanceSymbolInfo[],
  segment: BinanceMarketSegment = "crypto",
): BinanceSymbolInfo[] {
  return tradableUsdtSymbolsByContractTypes(
    symbols,
    new Set([contractTypeForSegment(segment)]),
  );
}

export function tradableSupportedUsdtPerpetualSymbols(
  symbols: BinanceSymbolInfo[],
): BinanceSymbolInfo[] {
  return tradableUsdtSymbolsByContractTypes(
    symbols,
    new Set(["PERPETUAL", "TRADIFI_PERPETUAL"]),
  );
}

export function rankUsdtPerpetualSymbolCatalog(
  symbols: BinanceSymbolInfo[],
  tickers: BinanceTicker24hr[],
  evaluationAt = Date.now(),
  segment: BinanceMarketSegment = "crypto",
): BinanceSymbolCatalogItem[] {
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  const candidates = tradableUsdtPerpetualSymbols(symbols, segment)
    .map((symbol) => {
      const ticker = tickerBySymbol.get(symbol.symbol);
      return {
        rank: 0,
        symbol: symbol.symbol,
        name: `${symbol.baseAsset}/${symbol.quoteAsset}`,
        baseAsset: symbol.baseAsset,
        quoteAsset: "USDT" as const,
        currency: "USDT" as const,
        lastPrice: ticker?.lastPrice ?? 0,
        changeRate: ticker?.changeRate ?? null,
        quoteVolume: ticker?.quoteVolume ?? 0,
        priceTimestamp: isoTimestamp(ticker?.closeTime, evaluationAt),
        tickSize: symbol.tickSize,
      };
    });
  const ranked = rankBinanceWeightedCatalog(candidates);
  return ranked.map((item, index): BinanceSymbolCatalogItem => ({
    ...item,
    rank: index + 1,
    changeRate: item.changeRate ?? 0,
  }));
}

/**
 * Counts recommendation rows that are independently usable and unique by both
 * rank and symbol. Sparse segments can expose this count without hiding their
 * otherwise valid volume-ordered picker catalog.
 */
export function usableChartWallRecommendationRankCount(
  items: readonly BinanceSymbolCatalogItem[],
): number {
  const usableItems = items.filter((item) =>
    Number.isInteger(item.recommendationRank) &&
    (item.recommendationRank ?? 0) >= 1 &&
    (item.recommendationRank ?? 0) <= MAX_BINANCE_CHART_SYMBOLS &&
    /^[A-Z0-9]{5,30}$/.test(item.symbol) &&
    item.symbol.endsWith("USDT") &&
    Number.isFinite(item.lastPrice) &&
    item.lastPrice > 0 &&
    Number.isFinite(item.rankingScore)
  );
  const rankCounts = new Map<number, number>();
  const symbolCounts = new Map<string, number>();
  for (const item of usableItems) {
    const rank = item.recommendationRank as number;
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
    symbolCounts.set(item.symbol, (symbolCounts.get(item.symbol) ?? 0) + 1);
  }
  return usableItems.filter((item) =>
    rankCounts.get(item.recommendationRank as number) === 1 &&
    symbolCounts.get(item.symbol) === 1
  ).length;
}

/** Verifies the exact recommendation contract used by either automatic wall. */
export function assertExactChartWallRecommendation(
  items: readonly BinanceSymbolCatalogItem[],
): void {
  const topRankedItems = items.filter((item) =>
    Number.isInteger(item.recommendationRank) &&
    (item.recommendationRank ?? 0) >= 1 &&
    (item.recommendationRank ?? 0) <= MAX_BINANCE_CHART_SYMBOLS
  );
  const topRanks = topRankedItems.map((item) => item.recommendationRank as number);
  const uniqueRanks = new Set(topRanks);
  const hasEveryRank = Array.from(
    { length: MAX_BINANCE_CHART_SYMBOLS },
    (_, index) => index + 1,
  ).every((rank) => uniqueRanks.has(rank));
  if (
    topRanks.length !== MAX_BINANCE_CHART_SYMBOLS ||
    uniqueRanks.size !== MAX_BINANCE_CHART_SYMBOLS ||
    !hasEveryRank
  ) {
    throw invalidResponse(
      `Binance catalog did not contain exactly one recommendationRank for every chart slot from 1 through ${MAX_BINANCE_CHART_SYMBOLS}.`,
    );
  }
  if (usableChartWallRecommendationRankCount(items) !== MAX_BINANCE_CHART_SYMBOLS) {
    throw invalidResponse(
      `Binance catalog did not contain ${MAX_BINANCE_CHART_SYMBOLS} unique usable ranked market items.`,
    );
  }
}

export function rankUsdtPerpetualUniverse(
  symbols: BinanceSymbolInfo[],
  tickers: BinanceTicker24hr[],
  limit = MAX_BINANCE_CHART_SYMBOLS,
  evaluationAt = Date.now(),
  segment: BinanceMarketSegment = "crypto",
): BinanceUniverseItem[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BINANCE_CHART_SYMBOLS) {
    throw new BinanceValidationError(
      `Universe limit must be between 1 and ${MAX_BINANCE_CHART_SYMBOLS}.`,
    );
  }
  const infoBySymbol = new Map(
    tradableUsdtPerpetualSymbols(symbols, segment).map((symbol) => [symbol.symbol, symbol]),
  );
  return tickers
    .filter((ticker) => infoBySymbol.has(ticker.symbol))
    .sort((left, right) =>
      right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol)
    )
    .slice(0, limit)
    .map((ticker, index) => {
      const info = infoBySymbol.get(ticker.symbol)!;
      return {
        rank: index + 1,
        symbol: info.symbol,
        name: `${info.baseAsset}/${info.quoteAsset}`,
        baseAsset: info.baseAsset,
        quoteAsset: info.quoteAsset,
        currency: "USDT",
        lastPrice: ticker.lastPrice,
        changeRate: ticker.changeRate ?? 0,
        quoteVolume: ticker.quoteVolume,
        priceTimestamp: isoTimestamp(ticker.closeTime, evaluationAt),
        tickSize: info.tickSize,
      };
    });
}

export function isBinanceChartTimeframe(value: unknown): value is BinanceChartTimeframe {
  return typeof value === "string" &&
    BINANCE_CHART_TIMEFRAMES.includes(value as BinanceChartTimeframe);
}

function normalizeBinanceChartTimeframe(value: unknown): BinanceChartTimeframe | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Binance uses uppercase M for months and lowercase m for minutes.
  const normalized = trimmed === "1M" ? trimmed : trimmed.toLowerCase();
  return isBinanceChartTimeframe(normalized) ? normalized : null;
}

export function isValidBinanceSymbol(value: string): boolean {
  return /^[A-Z0-9_]{1,30}$/.test(value);
}

export function parseBinanceChartsRequest(payload: unknown): BinanceChartsRequest {
  if (!isRecord(payload)) throw new BinanceValidationError("JSON body is required.");
  if (!Array.isArray(payload.symbols)) {
    throw new BinanceValidationError("symbols must be an array.");
  }
  if (
    payload.symbols.length < 1 ||
    payload.symbols.length > MAX_BINANCE_CHART_SYMBOLS
  ) {
    throw new BinanceValidationError(
      `symbols must contain between 1 and ${MAX_BINANCE_CHART_SYMBOLS} items.`,
    );
  }
  const detail = payload.detail === undefined ? "full" : payload.detail;
  if (detail !== "full" && detail !== "quotes") {
    throw new BinanceValidationError("detail must be full or quotes.");
  }

  const symbols = payload.symbols.map((value, index) => {
    if (typeof value !== "string") {
      throw new BinanceValidationError(`symbols[${index}] must be a string.`);
    }
    const symbol = value.trim().toUpperCase();
    if (!isValidBinanceSymbol(symbol)) {
      throw new BinanceValidationError(`Invalid Binance futures symbol: ${symbol || "(empty)"}.`);
    }
    return symbol;
  });

  if (payload.timeframes !== undefined && !Array.isArray(payload.timeframes)) {
    throw new BinanceValidationError("timeframes must be an array.");
  }
  if (
    Array.isArray(payload.timeframes) &&
    payload.timeframes.length !== symbols.length
  ) {
    throw new BinanceValidationError("timeframes must align one-to-one with symbols.");
  }
  const rawTimeframes = Array.isArray(payload.timeframes)
    ? payload.timeframes
    : symbols.map(() => "1m");
  const timeframes = rawTimeframes.map((value, index): BinanceChartTimeframe => {
    const normalized = normalizeBinanceChartTimeframe(value);
    if (normalized === null) {
      throw new BinanceValidationError(
        `timeframes[${index}] must be one of ${BINANCE_CHART_TIMEFRAMES.join(", ")}.`,
      );
    }
    return normalized;
  });
  return { symbols, detail, timeframes };
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export interface KeyedTtlSingleFlightCache<T> {
  get(key: string, loader: () => Promise<T>): Promise<T>;
  clear(): void;
}

export function createKeyedTtlSingleFlightCache<T>(options: {
  ttlMs: number;
  clock?: () => number;
  maximumEntries?: number;
  coalesceInFlight?: boolean;
}): KeyedTtlSingleFlightCache<T> {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
    throw new BinanceValidationError("Cache ttlMs must be a non-negative number.");
  }
  const clock = options.clock ?? Date.now;
  const maximumEntries = options.maximumEntries ?? 256;
  const coalesceInFlight = options.coalesceInFlight ?? true;
  const entries = new Map<string, CacheEntry<T>>();
  const flights = new Map<string, Promise<T>>();

  return {
    async get(key, loader) {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > clock()) return cached.value;
      if (coalesceInFlight) {
        const existing = flights.get(key);
        if (existing) return existing;
      }

      const flight = loader().then((value) => {
        entries.delete(key);
        entries.set(key, { value, expiresAt: clock() + options.ttlMs });
        while (entries.size > maximumEntries) {
          const oldest = entries.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
        return value;
      });
      if (coalesceInFlight) flights.set(key, flight);
      try {
        return await flight;
      } finally {
        if (coalesceInFlight && flights.get(key) === flight) flights.delete(key);
      }
    },
    clear() {
      entries.clear();
      flights.clear();
    },
  };
}

export interface BinanceMarketDataServiceOptions {
  clock?: () => number;
  coalesceInFlight?: boolean;
  exchangeInfoTtlMs?: number;
  tickerTtlMs?: number;
  priceTtlMs?: number;
  universeTtlMs?: number;
  catalogTtlMs?: number;
  klineTtlMs?: number;
  radarHistoryTtlMs?: number;
}

export class BinanceMarketDataService {
  private readonly client: BinanceFuturesClient;
  private readonly clock: () => number;
  private readonly exchangeInfoCache: KeyedTtlSingleFlightCache<BinanceSymbolInfo[]>;
  private readonly tickerCache: KeyedTtlSingleFlightCache<BinanceTicker24hr[]>;
  private readonly priceCache: KeyedTtlSingleFlightCache<BinancePriceTicker[]>;
  private readonly universeCache: KeyedTtlSingleFlightCache<BinanceUniverseItem[]>;
  private readonly catalogCache: KeyedTtlSingleFlightCache<BinanceSymbolCatalogItem[]>;
  private readonly klineCache: KeyedTtlSingleFlightCache<BinanceChartCandle[]>;
  private readonly radarHistoryCache: KeyedTtlSingleFlightCache<BinanceRadarDailyCandle[]>;

  constructor(
    client: BinanceFuturesClient,
    options: BinanceMarketDataServiceOptions = {},
  ) {
    this.client = client;
    this.clock = options.clock ?? Date.now;
    this.exchangeInfoCache = createKeyedTtlSingleFlightCache({
      ttlMs: options.exchangeInfoTtlMs ?? BINANCE_EXCHANGE_INFO_CACHE_MS,
      clock: this.clock,
      maximumEntries: 1,
      coalesceInFlight: options.coalesceInFlight,
    });
    this.tickerCache = createKeyedTtlSingleFlightCache({
      ttlMs: options.tickerTtlMs ?? BINANCE_TICKER_CACHE_MS,
      clock: this.clock,
      maximumEntries: 1,
      coalesceInFlight: options.coalesceInFlight,
    });
    this.priceCache = createKeyedTtlSingleFlightCache({
      ttlMs: options.priceTtlMs ?? BINANCE_PRICE_CACHE_MS,
      clock: this.clock,
      maximumEntries: 1,
      coalesceInFlight: options.coalesceInFlight,
    });
    this.universeCache = createKeyedTtlSingleFlightCache({
      ttlMs: options.universeTtlMs ?? BINANCE_UNIVERSE_CACHE_MS,
      clock: this.clock,
      maximumEntries: BINANCE_MARKET_SEGMENTS.length,
      coalesceInFlight: options.coalesceInFlight,
    });
    this.catalogCache = createKeyedTtlSingleFlightCache({
      ttlMs: options.catalogTtlMs ?? BINANCE_SYMBOL_CATALOG_CACHE_MS,
      clock: this.clock,
      maximumEntries: BINANCE_MARKET_SEGMENTS.length,
      coalesceInFlight: options.coalesceInFlight,
    });
    this.klineCache = createKeyedTtlSingleFlightCache({
      ttlMs: options.klineTtlMs ?? BINANCE_KLINE_CACHE_MS,
      clock: this.clock,
      maximumEntries: 256,
      coalesceInFlight: options.coalesceInFlight,
    });
    this.radarHistoryCache = createKeyedTtlSingleFlightCache({
      ttlMs: options.radarHistoryTtlMs ?? BINANCE_RADAR_HISTORY_CACHE_MS,
      clock: this.clock,
      maximumEntries: 256,
      coalesceInFlight: options.coalesceInFlight,
    });
  }

  private loadExchangeInfo(): Promise<BinanceSymbolInfo[]> {
    return this.exchangeInfoCache.get("exchange-info", async () =>
      parseExchangeInfo(await this.client.getExchangeInfo())
    );
  }

  private loadTickers(): Promise<BinanceTicker24hr[]> {
    return this.tickerCache.get("tickers-24hr", async () =>
      parse24hrTickers(await this.client.get24hrTickers())
    );
  }

  private loadPrices(): Promise<BinancePriceTicker[]> {
    return this.priceCache.get("symbol-prices", async () =>
      parseSymbolPrices(await this.client.getSymbolPrices())
    );
  }

  getUniverse(
    limit = MAX_BINANCE_CHART_SYMBOLS,
    segment: BinanceMarketSegment = "crypto",
  ): Promise<BinanceUniverseItem[]> {
    return this.universeCache.get(`universe:${segment}:${limit}`, async () => {
      const [symbols, tickers] = await Promise.all([
        this.loadExchangeInfo(),
        this.loadTickers(),
      ]);
      const items = rankUsdtPerpetualUniverse(
        symbols,
        tickers,
        limit,
        this.clock(),
        segment,
      );
      if (items.length !== limit) {
        throw invalidResponse(`Binance returned only ${items.length} eligible symbols for TOP${limit}.`);
      }
      return items;
    });
  }

  getSymbolCatalog(
    segment: BinanceMarketSegment = "crypto",
  ): Promise<BinanceSymbolCatalogItem[]> {
    return this.catalogCache.get(`catalog:${segment}`, async () => {
      const [symbols, tickers] = await Promise.all([
        this.loadExchangeInfo(),
        this.loadTickers(),
      ]);
      const items = rankUsdtPerpetualSymbolCatalog(
        symbols,
        tickers,
        this.clock(),
        segment,
      );
      if (items.length === 0) {
        throw invalidResponse(
          `Binance returned no eligible ${segment.toUpperCase()} USDⓈ-M perpetual USDT symbols.`,
        );
      }
      if (!items.some((item) => item.lastPrice > 0)) {
        throw invalidResponse(
          `Binance 24hr ticker response omitted every eligible ${segment.toUpperCase()} symbol.`,
        );
      }
      return items;
    });
  }

  async getRadarSourceCandidates(): Promise<BinanceRadarSourceCandidate[]> {
    const [symbols, tickers] = await Promise.all([
      this.loadExchangeInfo(),
      this.loadTickers(),
    ]);
    const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
    const candidates = tradableSupportedUsdtPerpetualSymbols(symbols).flatMap((symbol) => {
      const ticker = tickerBySymbol.get(symbol.symbol);
      if (!ticker) return [];
      return [{
        symbol: symbol.symbol,
        name: `${symbol.baseAsset}/${symbol.quoteAsset}`,
        baseAsset: symbol.baseAsset,
        segment: symbol.contractType === "TRADIFI_PERPETUAL" ? "tradfi" as const : "crypto" as const,
        lastPrice: ticker.lastPrice,
        changeRate: ticker.changeRate ?? 0,
        quoteVolume24h: ticker.quoteVolume,
        tickSize: symbol.tickSize,
        ...(symbol.onboardDate === undefined ? {} : { onboardDate: symbol.onboardDate }),
      }];
    }).sort((left, right) =>
      right.quoteVolume24h - left.quoteVolume24h || left.symbol.localeCompare(right.symbol)
    );
    if (candidates.length === 0) {
      throw invalidResponse("Binance returned no eligible combined USDT perpetual radar symbols.");
    }
    return candidates;
  }

  getRadarDailyHistory(
    symbol: string,
    range: { startTime: number; endTime: number },
  ): Promise<BinanceRadarDailyCandle[]> {
    if (!isValidBinanceSymbol(symbol)) {
      throw new BinanceValidationError(`Invalid Binance radar symbol: ${symbol}`);
    }
    if (
      !Number.isInteger(range.startTime) ||
      !Number.isInteger(range.endTime) ||
      range.startTime < 0 ||
      range.endTime < range.startTime
    ) {
      throw new BinanceValidationError("Radar history requires an ordered timestamp range.");
    }
    const key = `${symbol}:1d:${range.startTime}:${range.endTime}`;
    return this.radarHistoryCache.get(key, async () =>
      parseRadarDailyKlines(await this.client.getKlines(symbol, "1d", 32, range))
    );
  }

  async getChartSeries(request: BinanceChartsRequest): Promise<BinanceChartSeries[]> {
    const [symbols, prices] = await Promise.all([
      this.loadExchangeInfo(),
      this.loadPrices(),
    ]);
    const infoBySymbol = new Map(
      tradableSupportedUsdtPerpetualSymbols(symbols).map((symbol) => [symbol.symbol, symbol]),
    );
    const priceBySymbol = new Map(prices.map((price) => [price.symbol, price]));

    for (const symbol of request.symbols) {
      if (!infoBySymbol.has(symbol)) {
        throw new BinanceValidationError(
          `${symbol} is not a TRADING USDⓈ-M perpetual USDT contract.`,
        );
      }
      if (!priceBySymbol.has(symbol)) {
        throw invalidResponse(`Binance symbol price response omitted ${symbol}.`);
      }
    }

    const candleSets = request.detail === "full"
      ? await Promise.all(request.symbols.map((symbol, index) => {
          const timeframe = request.timeframes[index];
          return this.klineCache.get(`${symbol}:${timeframe}`, async () =>
            parseRestKlines(await this.client.getKlines(symbol, timeframe, 200))
          );
        }))
      : request.symbols.map(() => [] as BinanceChartCandle[]);

    return request.symbols.map((symbol, index) => {
      const info = infoBySymbol.get(symbol)!;
      const price = priceBySymbol.get(symbol)!;
      return {
        symbol,
        name: `${info.baseAsset}/${info.quoteAsset}`,
        currency: "USDT",
        tickSize: info.tickSize,
        price: {
          lastPrice: price.lastPrice,
          timestamp: isoTimestamp(price.timestamp, this.clock()),
        },
        candles: candleSets[index],
        timeframe: request.timeframes[index],
      };
    });
  }

  clear(): void {
    this.exchangeInfoCache.clear();
    this.tickerCache.clear();
    this.priceCache.clear();
    this.universeCache.clear();
    this.catalogCache.clear();
    this.klineCache.clear();
    this.radarHistoryCache.clear();
  }
}

function defaultEnvironment(): BinanceEnvironment {
  if (typeof process === "undefined") return {};
  return {
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_FUTURES_REST_URL: process.env.BINANCE_FUTURES_REST_URL,
    BINANCE_FUTURES_BASE_URL: process.env.BINANCE_FUTURES_BASE_URL,
    BINANCE_FUTURES_REST_FALLBACK_URLS:
      process.env.BINANCE_FUTURES_REST_FALLBACK_URLS,
    BINANCE_REQUEST_TIMEOUT_MS: process.env.BINANCE_REQUEST_TIMEOUT_MS,
  };
}

function configuredBaseUrl(environment: BinanceEnvironment): string | undefined {
  const preferred = environment.BINANCE_FUTURES_REST_URL?.trim();
  if (preferred) return preferred;
  return environment.BINANCE_FUTURES_BASE_URL?.trim() || undefined;
}

function configuredFallbackBaseUrls(environment: BinanceEnvironment): string[] {
  return environment.BINANCE_FUTURES_REST_FALLBACK_URLS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
}

interface DefaultServiceCache {
  apiKey?: string;
  baseUrl?: string;
  fallbackBaseUrlsKey: string;
  requestTimeoutMs?: number;
  service: BinanceMarketDataService;
}

let defaultServiceCache: DefaultServiceCache | null = null;

export function createBinanceClientFromEnv(
  environment: BinanceEnvironment = defaultEnvironment(),
): BinanceFuturesClient {
  assertServer();
  return new BinanceFuturesClient({
    apiKey: environment.BINANCE_API_KEY,
    baseUrl: configuredBaseUrl(environment),
    fallbackBaseUrls: configuredFallbackBaseUrls(environment),
    requestTimeoutMs: parseRequestTimeout(environment.BINANCE_REQUEST_TIMEOUT_MS),
  });
}

export function getBinanceMarketDataServiceFromEnv(
  environment: BinanceEnvironment = defaultEnvironment(),
): BinanceMarketDataService {
  assertServer();
  const apiKey = environment.BINANCE_API_KEY?.trim() || undefined;
  const baseUrl = configuredBaseUrl(environment);
  const fallbackBaseUrls = configuredFallbackBaseUrls(environment);
  const fallbackBaseUrlsKey = fallbackBaseUrls.join(",");
  const requestTimeoutMs = parseRequestTimeout(environment.BINANCE_REQUEST_TIMEOUT_MS);
  if (
    defaultServiceCache &&
    defaultServiceCache.apiKey === apiKey &&
    defaultServiceCache.baseUrl === baseUrl &&
    defaultServiceCache.fallbackBaseUrlsKey === fallbackBaseUrlsKey &&
    defaultServiceCache.requestTimeoutMs === requestTimeoutMs
  ) {
    return defaultServiceCache.service;
  }
  // The singleton keeps only settled plain-data TTL entries across requests.
  // Cloudflare Workers cannot safely await a Promise created by another request
  // context, so its caches deliberately do not coalesce pending work.
  const service = new BinanceMarketDataService(new BinanceFuturesClient({
    apiKey,
    baseUrl,
    fallbackBaseUrls,
    requestTimeoutMs,
  }), { coalesceInFlight: false });
  defaultServiceCache = {
    apiKey,
    baseUrl,
    fallbackBaseUrlsKey,
    requestTimeoutMs,
    service,
  };
  return service;
}

export function responseStatusForBinanceError(error: unknown): number {
  if (error instanceof BinanceValidationError) return 400;
  if (!(error instanceof BinanceApiError)) return 500;
  if (error.status === 429 || error.status === 451) return error.status;
  if (error.code === "request-timeout") return 504;
  return 502;
}
