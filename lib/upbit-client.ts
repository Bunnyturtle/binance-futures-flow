import { rankUpbitCatalog } from "./upbit-catalog-ranking";
import {
  WALL_DEFAULT_MARKETS,
  WALL_RANKED_SLOT_COUNT,
  WALL_SLOT_COUNT,
  WALL_USER_PINNED_SLOT_COUNT,
  selectWallMarkets,
} from "./chart-wall-ranking";
import {
  isUpbitChartTimeframe,
  isUpbitKrwMarket,
  normalizeUpbitMarket,
  upbitBaseAsset,
  upbitCandlePath,
  upbitKrwTickSize,
  type UpbitChartTimeframe,
} from "./upbit-market";
import type {
  UpbitRadarDailyCandle,
  UpbitRadarSourceCandidate,
} from "./upbit-radar";
import { readUpbitCredentials, upbitAuthorizationHeader } from "./upbit-auth";
import {
  normalizeCandleList,
  numeric,
  record,
  text,
  type UpbitChartCandle,
} from "./upbit-parse";

const DEFAULT_BASE_URL = "https://api.upbit.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_FALLBACK_BASE_URLS = 3;
const MAX_UPSTREAM_ERROR_DETAIL_LENGTH = 240;
const MAX_CANDLE_COUNT = 200;

export const MAX_UPBIT_CHART_MARKETS = WALL_SLOT_COUNT;
export const UPBIT_DEFAULT_CHART_MARKETS = WALL_DEFAULT_MARKETS;
export const UPBIT_USER_PINNED_CHART_SLOT_COUNT = WALL_USER_PINNED_SLOT_COUNT;
export const UPBIT_RANKED_CHART_SLOT_COUNT = WALL_RANKED_SLOT_COUNT;
export const UPBIT_CHART_CANDLE_COUNT = MAX_CANDLE_COUNT;

export const UPBIT_MARKET_LIST_CACHE_MS = 5 * 60_000;
export const UPBIT_TICKER_CACHE_MS = 3_000;
export const UPBIT_CANDLE_CACHE_MS = 4_500;
export const UPBIT_CATALOG_CACHE_MS = 5_000;
export const UPBIT_RADAR_HISTORY_CACHE_MS = 12 * 60 * 60_000;
export const UPBIT_ACCOUNTS_CACHE_MS = 3_000;

export type { UpbitChartCandle };

/**
 * 시세 조회 그룹별 한도는 IP 기준 초당 10회지만, 실측해 보면 한 번에 몰아치는
 * 요청은 초당 10회 미만이어도 429를 돌려줍니다(8개를 동시에 보내면 즉시 거절,
 * 같은 8회를 125ms 간격으로 흘려보내면 전부 통과). 그래서 횟수를 세는 대신
 * 발사 간격을 균등하게 벌립니다.
 */
const REQUESTS_PER_SECOND = 8;

export type UpbitRequestGroup = "market" | "candle" | "ticker" | "exchange";

export interface UpbitEnvironment {
  UPBIT_ACCESS_KEY?: string;
  UPBIT_SECRET_KEY?: string;
  UPBIT_REST_URL?: string;
  /** 운영자가 직접 검증한 대체 REST 주소를 쉼표로 최대 3개까지 지정합니다. */
  UPBIT_REST_FALLBACK_URLS?: string;
  UPBIT_REQUEST_TIMEOUT_MS?: string;
}

export class UpbitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpbitValidationError";
  }
}

export class UpbitUpstreamError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "UpbitUpstreamError";
    this.status = status;
    this.code = code;
  }
}

export class UpbitAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpbitAuthUnavailableError";
  }
}

export function responseStatusForUpbitError(error: unknown): number {
  if (error instanceof UpbitValidationError) return 400;
  if (error instanceof UpbitAuthUnavailableError) return 503;
  if (error instanceof UpbitUpstreamError) {
    if (error.status === 429 || error.status === 418) return 429;
    if (error.status === 401 || error.status === 403) return 502;
    if (error.status >= 400 && error.status < 500) return 502;
    return 502;
  }
  return 502;
}

export interface UpbitCatalogItem {
  market: string;
  name: string;
  englishName: string;
  baseAsset: string;
  quoteAsset: "KRW";
  currency: "KRW";
  rank: number;
  lastPrice: number;
  changeRate: number;
  quoteVolume: number;
  tickSize: string;
  priceTimestamp: string;
  warning: boolean;
  caution: boolean;
  rankingScore: number;
  volumeScore: number;
  changeScore: number;
  recommendationRank: number;
}

export interface UpbitChartSeries {
  market: string;
  name: string;
  baseAsset: string;
  currency: "KRW";
  tickSize: number;
  timeframe: UpbitChartTimeframe;
  price: { lastPrice: number; timestamp: string };
  candles: UpbitChartCandle[];
}

export interface UpbitChartsRequest {
  markets: string[];
  timeframes: UpbitChartTimeframe[];
}

export interface UpbitAccountHolding {
  currency: string;
  market: string | null;
  name: string;
  balance: number;
  locked: number;
  total: number;
  avgBuyPrice: number;
  lastPrice: number;
  /** 평가금액(KRW). 원화 잔고는 balance 그대로입니다. */
  valuation: number;
  /** 매수 평균가 기준 평가손익(KRW). 원화 잔고와 시세 미확인 종목은 null. */
  profit: number | null;
  profitRate: number | null;
}

export interface UpbitAccountSummary {
  krwBalance: number;
  krwLocked: number;
  holdingValuation: number;
  holdingCost: number;
  totalValuation: number;
  totalProfit: number | null;
  totalProfitRate: number | null;
}

export interface UpbitAccountsResult {
  observedAt: string;
  summary: UpbitAccountSummary;
  holdings: UpbitAccountHolding[];
}

function truncateDetail(value: string): string {
  const flattened = value.replaceAll(/\s+/g, " ").trim();
  return flattened.length > MAX_UPSTREAM_ERROR_DETAIL_LENGTH
    ? `${flattened.slice(0, MAX_UPSTREAM_ERROR_DETAIL_LENGTH)}…`
    : flattened;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 요청을 균등한 간격으로 흘려보냅니다. 발사 순서만 직렬화하고 응답 대기는 겹치게
 * 두므로, 12분할 차트의 첫 로드처럼 요청이 몰려도 업비트에는 일정한 속도로만
 * 도착합니다. 서버 인스턴스가 여러 개면 업비트는 IP 단위로 합산하므로, 수평
 * 확장 시에는 인스턴스 수에 맞춰 REQUESTS_PER_SECOND를 낮춰야 합니다.
 */
class RequestRateLimiter {
  private readonly minIntervalMs: number;
  private chain: Promise<void> = Promise.resolve();
  private lastDispatchAt = 0;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = Math.ceil(1_000 / Math.max(1, requestsPerSecond));
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const slot = this.chain.then(async () => {
      const wait = this.lastDispatchAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastDispatchAt = Date.now();
    });
    this.chain = slot.then(() => undefined, () => undefined);
    return slot.then(task);
  }
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** TTL + single-flight 캐시입니다. 같은 키의 동시 요청은 한 번만 나갑니다. */
class TtlCache {
  private readonly values = new Map<string, CacheEntry<unknown>>();
  private readonly flights = new Map<string, Promise<unknown>>();

  async resolve<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > now) return cached.value as T;
    const inFlight = this.flights.get(key);
    if (inFlight) return inFlight as Promise<T>;
    const flight = loader().then(
      (value) => {
        this.values.set(key, { expiresAt: Date.now() + ttlMs, value });
        this.flights.delete(key);
        return value;
      },
      (error) => {
        this.flights.delete(key);
        throw error;
      },
    );
    this.flights.set(key, flight);
    return flight;
  }

  clear(): void {
    this.values.clear();
    this.flights.clear();
  }
}

function parseBaseUrls(environment: UpbitEnvironment): string[] {
  const primary = environment.UPBIT_REST_URL?.trim() || DEFAULT_BASE_URL;
  const fallbacks = (environment.UPBIT_REST_FALLBACK_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, MAX_FALLBACK_BASE_URLS);
  const unique: string[] = [];
  for (const candidate of [primary, ...fallbacks]) {
    let normalized: string;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:") continue;
      normalized = url.origin;
    } catch {
      continue;
    }
    if (!unique.includes(normalized)) unique.push(normalized);
  }
  return unique.length > 0 ? unique : [DEFAULT_BASE_URL];
}

function parseTimeout(environment: UpbitEnvironment): number {
  const parsed = Number(environment.UPBIT_REQUEST_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 30_000
    ? Math.trunc(parsed)
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export class UpbitMarketDataService {
  private readonly baseUrls: string[];
  private readonly timeoutMs: number;
  private readonly credentials: ReturnType<typeof readUpbitCredentials>;
  private readonly cache = new TtlCache();
  private readonly limiters: Record<UpbitRequestGroup, RequestRateLimiter> = {
    market: new RequestRateLimiter(REQUESTS_PER_SECOND),
    candle: new RequestRateLimiter(REQUESTS_PER_SECOND),
    ticker: new RequestRateLimiter(REQUESTS_PER_SECOND),
    exchange: new RequestRateLimiter(REQUESTS_PER_SECOND),
  };

  constructor(environment: UpbitEnvironment = {}) {
    this.baseUrls = parseBaseUrls(environment);
    this.timeoutMs = parseTimeout(environment);
    this.credentials = readUpbitCredentials(environment);
  }

  get authenticationConfigured(): boolean {
    return this.credentials !== null;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async requestJson(
    path: string,
    group: UpbitRequestGroup,
    options: { authorized?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.authorized) {
      if (!this.credentials) {
        throw new UpbitAuthUnavailableError(
          "UPBIT_ACCESS_KEY와 UPBIT_SECRET_KEY가 설정되지 않았습니다.",
        );
      }
      const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
      headers.Authorization = upbitAuthorizationHeader(this.credentials, query);
    }

    let lastError: unknown;
    for (const baseUrl of this.baseUrls) {
      try {
        return await this.limiters[group].schedule(
          () => this.fetchOnce(`${baseUrl}${path}`, headers),
        );
      } catch (error) {
        lastError = error;
        // 한도 초과와 인증 실패는 주소를 바꿔도 같은 결과이므로 즉시 포기합니다.
        if (
          error instanceof UpbitUpstreamError &&
          (error.status === 429 || error.status === 418 ||
            error.status === 401 || error.status === 403)
        ) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new UpbitUpstreamError("업비트 REST 응답을 받지 못했습니다.", 502, "network-error");
  }

  private async fetchOnce(
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw new UpbitUpstreamError(
        aborted
          ? `업비트 REST가 ${Math.round(this.timeoutMs / 1_000)}초 안에 응답하지 않았습니다.`
          : `업비트 REST 연결에 실패했습니다: ${
            error instanceof Error ? truncateDetail(error.message) : "network error"
          }`,
        aborted ? 504 : 502,
        aborted ? "request-timeout" : "network-error",
      );
    } finally {
      clearTimeout(timeout);
    }

    const body = await response.text();
    if (!response.ok) {
      const detail = record(record(safeJson(body)).error);
      const message = text(detail, "message") || truncateDetail(body) ||
        response.statusText;
      const name = text(detail, "name", `http-${response.status}`);
      throw new UpbitUpstreamError(
        response.status === 429 || response.status === 418
          ? `업비트 요청 수 제한에 걸렸습니다 (${response.status}). ${message}`
          : `업비트 REST 오류 (${response.status}): ${message}`,
        response.status,
        name,
      );
    }
    const parsed = safeJson(body);
    if (parsed === undefined) {
      throw new UpbitUpstreamError(
        "업비트 REST가 JSON이 아닌 응답을 돌려주었습니다.",
        502,
        "invalid-json",
      );
    }
    return parsed;
  }

  /** `GET /v1/market/all` — 마켓 코드, 한글명, 유의/주의 지정 여부. */
  private async loadKrwMarketList(): Promise<Map<string, {
    name: string;
    englishName: string;
    warning: boolean;
    caution: boolean;
  }>> {
    return this.cache.resolve(
      "market/all",
      UPBIT_MARKET_LIST_CACHE_MS,
      async () => {
        const payload = await this.requestJson(
          "/v1/market/all?isDetails=true",
          "market",
        );
        if (!Array.isArray(payload)) {
          throw new UpbitUpstreamError(
            "업비트 마켓 목록 형식을 확인하지 못했습니다.",
            502,
            "invalid-market-list",
          );
        }
        const markets = new Map<string, {
          name: string;
          englishName: string;
          warning: boolean;
          caution: boolean;
        }>();
        for (const entry of payload) {
          const item = record(entry);
          const market = normalizeUpbitMarket(item.market);
          if (!isUpbitKrwMarket(market)) continue;
          const event = record(item.market_event);
          const caution = record(event.caution);
          markets.set(market, {
            name: text(item, "korean_name", upbitBaseAsset(market)),
            englishName: text(item, "english_name", upbitBaseAsset(market)),
            warning: event.warning === true,
            caution: Object.values(caution).some((value) => value === true),
          });
        }
        if (markets.size === 0) {
          throw new UpbitUpstreamError(
            "거래 가능한 KRW 마켓을 찾지 못했습니다.",
            502,
            "empty-market-list",
          );
        }
        return markets;
      },
    );
  }

  /** `GET /v1/ticker/all?quote_currencies=KRW` — 전 종목 현재가를 한 번에 받습니다. */
  private async loadKrwTickers(): Promise<Map<string, Record<string, unknown>>> {
    return this.cache.resolve("ticker/all", UPBIT_TICKER_CACHE_MS, async () => {
      const payload = await this.requestJson(
        "/v1/ticker/all?quote_currencies=KRW",
        "ticker",
      );
      if (!Array.isArray(payload)) {
        throw new UpbitUpstreamError(
          "업비트 현재가 형식을 확인하지 못했습니다.",
          502,
          "invalid-ticker",
        );
      }
      const tickers = new Map<string, Record<string, unknown>>();
      for (const entry of payload) {
        const item = record(entry);
        const market = normalizeUpbitMarket(item.market);
        if (isUpbitKrwMarket(market)) tickers.set(market, item);
      }
      if (tickers.size === 0) {
        throw new UpbitUpstreamError(
          "업비트 KRW 현재가를 찾지 못했습니다.",
          502,
          "empty-ticker",
        );
      }
      return tickers;
    });
  }

  /** 검색 후보와 자동 배열에 쓰이는, 24시간 거래대금 순 카탈로그입니다. */
  async getMarketCatalog(): Promise<UpbitCatalogItem[]> {
    return this.cache.resolve("catalog", UPBIT_CATALOG_CACHE_MS, async () => {
      const [markets, tickers] = await Promise.all([
        this.loadKrwMarketList(),
        this.loadKrwTickers(),
      ]);
      const inputs: Array<{
        market: string;
        quoteVolume: number;
        changeRate: number | null;
        base: UpbitCatalogItem;
      }> = [];
      for (const [market, meta] of markets) {
        const ticker = tickers.get(market);
        if (!ticker) continue;
        const lastPrice = numeric(ticker, "trade_price");
        const quoteVolume = numeric(ticker, "acc_trade_price_24h");
        if (!Number.isFinite(lastPrice) || lastPrice <= 0) continue;
        const signedChangeRate = numeric(ticker, "signed_change_rate");
        const changeRate = Number.isFinite(signedChangeRate)
          ? signedChangeRate * 100
          : null;
        const tradeTimestamp = numeric(ticker, "trade_timestamp");
        inputs.push({
          market,
          quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
          changeRate,
          base: {
            market,
            name: meta.name,
            englishName: meta.englishName,
            baseAsset: upbitBaseAsset(market),
            quoteAsset: "KRW",
            currency: "KRW",
            rank: 0,
            lastPrice,
            changeRate: changeRate ?? 0,
            quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
            tickSize: String(upbitKrwTickSize(lastPrice)),
            priceTimestamp: Number.isFinite(tradeTimestamp)
              ? new Date(tradeTimestamp).toISOString()
              : new Date().toISOString(),
            warning: meta.warning,
            caution: meta.caution,
            rankingScore: 0,
            volumeScore: 0,
            changeScore: 0,
            recommendationRank: 0,
          },
        });
      }
      if (inputs.length === 0) {
        throw new UpbitUpstreamError(
          "거래 가능한 KRW 마켓 시세를 확인하지 못했습니다.",
          502,
          "empty-catalog",
        );
      }
      const ranked = rankUpbitCatalog(inputs.map((entry) => ({
        market: entry.market,
        quoteVolume: entry.quoteVolume,
        changeRate: entry.changeRate,
      })));
      const baseByMarket = new Map(inputs.map((entry) => [entry.market, entry.base]));
      return ranked.map((scored, index) => {
        const base = baseByMarket.get(scored.market) as UpbitCatalogItem;
        return {
          ...base,
          rank: index + 1,
          quoteVolume: scored.quoteVolume,
          rankingScore: scored.rankingScore,
          volumeScore: scored.volumeScore,
          changeScore: scored.changeScore,
          recommendationRank: scored.recommendationRank,
        };
      });
    });
  }

  private async loadCandles(
    market: string,
    timeframe: UpbitChartTimeframe,
    count = MAX_CANDLE_COUNT,
  ): Promise<UpbitChartCandle[]> {
    const path =
      `/v1/candles/${upbitCandlePath(timeframe)}?market=${market}&count=${count}`;
    return this.cache.resolve(
      `candles:${market}:${timeframe}:${count}`,
      UPBIT_CANDLE_CACHE_MS,
      async () => {
        const payload = await this.requestJson(path, "candle");
        if (!Array.isArray(payload)) {
          throw new UpbitUpstreamError(
            `${market} ${timeframe} 캔들 형식을 확인하지 못했습니다.`,
            502,
            "invalid-candles",
          );
        }
        return normalizeCandleList(payload);
      },
    );
  }

  /** 12개 슬롯의 과거 봉과 현재가입니다. 현재가는 ticker 한 번으로 모두 채웁니다. */
  async getChartSeries(request: UpbitChartsRequest): Promise<UpbitChartSeries[]> {
    const [markets, tickers] = await Promise.all([
      this.loadKrwMarketList(),
      this.loadKrwTickers(),
    ]);
    const unknownMarket = request.markets.find((market) => !markets.has(market));
    if (unknownMarket) {
      throw new UpbitValidationError(
        `${unknownMarket}은 거래 가능한 업비트 KRW 마켓이 아닙니다.`,
      );
    }
    return Promise.all(request.markets.map(async (market, index) => {
      const timeframe = request.timeframes[index];
      const candles = await this.loadCandles(market, timeframe);
      const ticker = tickers.get(market);
      const meta = markets.get(market);
      const latestClose = candles.at(-1)?.closePrice ?? 0;
      const tickerPrice = ticker ? numeric(ticker, "trade_price") : Number.NaN;
      const lastPrice = Number.isFinite(tickerPrice) && tickerPrice > 0
        ? tickerPrice
        : latestClose;
      const tradeTimestamp = ticker ? numeric(ticker, "trade_timestamp") : Number.NaN;
      return {
        market,
        name: meta?.name ?? upbitBaseAsset(market),
        baseAsset: upbitBaseAsset(market),
        currency: "KRW" as const,
        tickSize: upbitKrwTickSize(lastPrice),
        timeframe,
        price: {
          lastPrice,
          timestamp: Number.isFinite(tradeTimestamp)
            ? new Date(tradeTimestamp).toISOString()
            : new Date().toISOString(),
        },
        candles,
      };
    }));
  }

  async getRadarSourceCandidates(): Promise<UpbitRadarSourceCandidate[]> {
    const catalog = await this.getMarketCatalog();
    return catalog.map((item) => ({
      market: item.market,
      name: item.name,
      baseAsset: item.baseAsset,
      lastPrice: item.lastPrice,
      changeRate: item.changeRate,
      quoteVolume24h: item.quoteVolume,
      tickSize: item.tickSize,
      warning: item.warning,
    }));
  }

  /**
   * 완료된 UTC 일봉만 남깁니다. 오늘 캔들까지 받아 오늘치를 버리는 편이,
   * `to` 파라미터로 경계를 맞추는 것보다 상장 공백에 견고합니다.
   */
  async getRadarDailyHistory(
    market: string,
    range: { startTime: number; endTime: number },
  ): Promise<UpbitRadarDailyCandle[]> {
    const days = Math.min(
      MAX_CANDLE_COUNT,
      Math.max(2, Math.ceil((range.endTime - range.startTime) / 86_400_000) + 2),
    );
    const dayKey = new Date(range.endTime).toISOString().slice(0, 10);
    const candles = await this.cache.resolve(
      `radar-history:${market}:${dayKey}:${days}`,
      UPBIT_RADAR_HISTORY_CACHE_MS,
      () => this.loadCandles(market, "1d", days),
    );
    return candles
      .filter((candle) =>
        candle.openTime >= range.startTime && candle.openTime <= range.endTime
      )
      .map((candle) => ({
        openTime: candle.openTime,
        closeTime: candle.openTime + 86_400_000 - 1,
        closePrice: candle.closePrice,
        quoteVolume: candle.quoteVolume,
      }));
  }

  /** `GET /v1/accounts` — 보유 자산. 키가 없으면 호출 전에 막습니다. */
  async getAccounts(): Promise<UpbitAccountsResult> {
    if (!this.credentials) {
      throw new UpbitAuthUnavailableError(
        "업비트 API 키가 설정되지 않아 잔고를 조회할 수 없습니다.",
      );
    }
    return this.cache.resolve("accounts", UPBIT_ACCOUNTS_CACHE_MS, async () => {
      const payload = await this.requestJson("/v1/accounts", "exchange", {
        authorized: true,
      });
      if (!Array.isArray(payload)) {
        throw new UpbitUpstreamError(
          "업비트 잔고 응답 형식을 확인하지 못했습니다.",
          502,
          "invalid-accounts",
        );
      }
      const [markets, tickers] = await Promise.all([
        this.loadKrwMarketList(),
        this.loadKrwTickers(),
      ]);
      const holdings: UpbitAccountHolding[] = [];
      let krwBalance = 0;
      let krwLocked = 0;
      for (const entry of payload) {
        const item = record(entry);
        const currency = text(item, "currency").toUpperCase();
        if (!currency) continue;
        const balance = numeric(item, "balance");
        const locked = numeric(item, "locked");
        const safeBalance = Number.isFinite(balance) ? balance : 0;
        const safeLocked = Number.isFinite(locked) ? locked : 0;
        const total = safeBalance + safeLocked;
        if (total <= 0) continue;
        if (currency === "KRW") {
          krwBalance = safeBalance;
          krwLocked = safeLocked;
          continue;
        }
        const market = `KRW-${currency}`;
        const listed = markets.has(market);
        const ticker = listed ? tickers.get(market) : undefined;
        const tickerPrice = ticker ? numeric(ticker, "trade_price") : Number.NaN;
        const lastPrice = Number.isFinite(tickerPrice) ? tickerPrice : 0;
        const avgBuyPrice = numeric(item, "avg_buy_price");
        const safeAvgBuyPrice = Number.isFinite(avgBuyPrice) ? avgBuyPrice : 0;
        const valuation = lastPrice > 0 ? lastPrice * total : 0;
        const cost = safeAvgBuyPrice * total;
        const priced = lastPrice > 0 && cost > 0;
        holdings.push({
          currency,
          market: listed ? market : null,
          name: listed ? markets.get(market)?.name ?? currency : currency,
          balance: safeBalance,
          locked: safeLocked,
          total,
          avgBuyPrice: safeAvgBuyPrice,
          lastPrice,
          valuation,
          profit: priced ? valuation - cost : null,
          profitRate: priced ? (valuation / cost - 1) * 100 : null,
        });
      }
      holdings.sort((left, right) =>
        right.valuation - left.valuation || left.currency.localeCompare(right.currency)
      );
      const holdingValuation = holdings.reduce(
        (sum, holding) => sum + holding.valuation,
        0,
      );
      const holdingCost = holdings.reduce(
        (sum, holding) =>
          sum + (holding.profit === null ? 0 : holding.avgBuyPrice * holding.total),
        0,
      );
      const pricedValuation = holdings.reduce(
        (sum, holding) => sum + (holding.profit === null ? 0 : holding.valuation),
        0,
      );
      return {
        observedAt: new Date().toISOString(),
        summary: {
          krwBalance,
          krwLocked,
          holdingValuation,
          holdingCost,
          totalValuation: krwBalance + krwLocked + holdingValuation,
          totalProfit: holdingCost > 0 ? pricedValuation - holdingCost : null,
          totalProfitRate: holdingCost > 0
            ? (pricedValuation / holdingCost - 1) * 100
            : null,
        },
        holdings,
      };
    });
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function parseUpbitChartsRequest(payload: unknown): UpbitChartsRequest {
  const body = record(payload);
  const rawMarkets = Array.isArray(body.markets) ? body.markets : null;
  if (!rawMarkets || rawMarkets.length === 0) {
    throw new UpbitValidationError("markets 배열이 필요합니다.");
  }
  if (rawMarkets.length > MAX_UPBIT_CHART_MARKETS) {
    throw new UpbitValidationError(
      `markets는 최대 ${MAX_UPBIT_CHART_MARKETS}개까지 요청할 수 있습니다.`,
    );
  }
  const markets = rawMarkets.map((value) => {
    const market = normalizeUpbitMarket(value);
    if (!isUpbitKrwMarket(market)) {
      throw new UpbitValidationError(`${String(value)}은 올바른 KRW 마켓 코드가 아닙니다.`);
    }
    return market;
  });
  const rawTimeframes = Array.isArray(body.timeframes) ? body.timeframes : null;
  if (!rawTimeframes || rawTimeframes.length !== markets.length) {
    throw new UpbitValidationError("timeframes는 markets와 같은 길이여야 합니다.");
  }
  const timeframes = rawTimeframes.map((value) => {
    if (!isUpbitChartTimeframe(value)) {
      throw new UpbitValidationError(`${String(value)}은 지원하지 않는 봉 주기입니다.`);
    }
    return value;
  });
  const seen = new Set<string>();
  for (const [index, market] of markets.entries()) {
    const key = `${market}:${timeframes[index]}`;
    if (seen.has(key)) {
      throw new UpbitValidationError(`${key} 조합이 중복되었습니다.`);
    }
    seen.add(key);
  }
  return { markets, timeframes };
}

/**
 * 자동 배열 계약을 확인합니다. 순위 1~12가 완전할 때만 12분할 벽을 새로 배치합니다.
 */
export function usableWallRecommendationRankCount(
  items: readonly UpbitCatalogItem[],
): number {
  const ranks = new Set(
    items
      .filter((item) => item.lastPrice > 0 && Number.isFinite(item.rankingScore))
      .map((item) => item.recommendationRank),
  );
  let count = 0;
  while (ranks.has(count + 1)) count += 1;
  return count;
}

export function assertExactWallRecommendation(
  items: readonly UpbitCatalogItem[],
): void {
  if (selectWallMarkets(items, WALL_SLOT_COUNT, []).length !== WALL_SLOT_COUNT) {
    throw new UpbitUpstreamError(
      "24시간 거래대금 추천 순위 1~12가 완전하지 않습니다.",
      502,
      "incomplete-recommendation",
    );
  }
}

let cachedService: UpbitMarketDataService | null = null;
let cachedEnvironmentKey = "";

function environmentKey(environment: UpbitEnvironment): string {
  return [
    environment.UPBIT_REST_URL ?? "",
    environment.UPBIT_REST_FALLBACK_URLS ?? "",
    environment.UPBIT_REQUEST_TIMEOUT_MS ?? "",
    environment.UPBIT_ACCESS_KEY ? "auth" : "anon",
  ].join("|");
}

export function getUpbitMarketDataServiceFromEnv(
  environment: UpbitEnvironment = process.env as UpbitEnvironment,
): UpbitMarketDataService {
  const key = environmentKey(environment);
  if (!cachedService || cachedEnvironmentKey !== key) {
    cachedService = new UpbitMarketDataService(environment);
    cachedEnvironmentKey = key;
  }
  return cachedService;
}
