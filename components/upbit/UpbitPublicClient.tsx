"use client";

import { rankUpbitCatalog } from "../../lib/upbit-catalog-ranking";
import {
  isUpbitKrwMarket,
  normalizeUpbitMarket,
  upbitBaseAsset,
  upbitCandlePath,
  upbitKrwTickSize,
  type UpbitChartTimeframe,
} from "../../lib/upbit-market";
import {
  normalizeCandleList,
  numeric,
  record,
  text,
  type UpbitChartCandle,
} from "../../lib/upbit-parse";
import {
  UPBIT_RADAR_ANALYSIS_LIMIT,
  UPBIT_RADAR_HISTORY_DAYS,
  buildUpbitRadarResult,
  selectUpbitRadarAnalysisCandidates,
  type UpbitRadarDailyCandle,
  type UpbitRadarResult,
  type UpbitRadarSourceCandidate,
} from "../../lib/upbit-radar";

/**
 * same-origin API가 지연되거나 차단됐을 때 브라우저에서 업비트 공개 REST를 직접
 * 호출하는 복구 경로입니다. 업비트 시세 API는 `Access-Control-Allow-Origin: *`이고
 * 인증이 필요 없으므로, 어떤 키도 브라우저로 내려보내지 않습니다. 이때 요청 수
 * 제한은 서버 IP가 아니라 사용자 IP에 계산됩니다.
 */
const PUBLIC_REST_BASE = "https://api.upbit.com";
const BROWSER_REQUESTS_PER_SECOND = 8;
const RADAR_HISTORY_CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60 * 1_000;

const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIN_REQUEST_INTERVAL_MS = Math.ceil(1_000 / BROWSER_REQUESTS_PER_SECOND);

let limiterChain: Promise<void> = Promise.resolve();
let lastDispatchAt = 0;

/**
 * 업비트 시세 그룹은 IP 기준 초당 10회지만, 몰아친 요청은 그보다 적어도 429가
 * 납니다. 서버 경로와 동일하게 발사 간격을 균등하게 벌립니다.
 */
function scheduleRequest<T>(task: () => Promise<T>): Promise<T> {
  const slot = limiterChain.then(async () => {
    const wait = lastDispatchAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastDispatchAt = Date.now();
  });
  limiterChain = slot.then(() => undefined, () => undefined);
  return slot.then(task);
}

type PublicFetchError = Error & { status?: number };

function publicFailure(message: string, status: number): PublicFetchError {
  const error: PublicFetchError = new Error(message);
  error.status = status;
  return error;
}

async function publicJson(path: string, signal: AbortSignal): Promise<unknown> {
  return scheduleRequest(async () => {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const response = await fetch(`${PUBLIC_REST_BASE}${path}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw publicFailure(
        response.status === 429 || response.status === 418
          ? `업비트 요청 수 제한 (${response.status})`
          : `업비트 공개 REST 오류 (${response.status})`,
        response.status,
      );
    }
    return response.json() as Promise<unknown>;
  });
}

export interface PublicCatalogItem {
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

type MarketMeta = {
  name: string;
  englishName: string;
  warning: boolean;
  caution: boolean;
};

async function loadMarketMeta(signal: AbortSignal): Promise<Map<string, MarketMeta>> {
  const payload = await publicJson("/v1/market/all?isDetails=true", signal);
  if (!Array.isArray(payload)) {
    throw new Error("업비트 마켓 목록 형식을 확인하지 못했습니다.");
  }
  const markets = new Map<string, MarketMeta>();
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
  if (markets.size === 0) throw new Error("거래 가능한 KRW 마켓을 찾지 못했습니다.");
  return markets;
}

async function loadTickers(
  signal: AbortSignal,
): Promise<Map<string, Record<string, unknown>>> {
  const payload = await publicJson("/v1/ticker/all?quote_currencies=KRW", signal);
  if (!Array.isArray(payload)) {
    throw new Error("업비트 현재가 형식을 확인하지 못했습니다.");
  }
  const tickers = new Map<string, Record<string, unknown>>();
  for (const entry of payload) {
    const item = record(entry);
    const market = normalizeUpbitMarket(item.market);
    if (isUpbitKrwMarket(market)) tickers.set(market, item);
  }
  if (tickers.size === 0) throw new Error("업비트 KRW 현재가를 찾지 못했습니다.");
  return tickers;
}

export async function loadPublicUpbitCatalog(
  signal: AbortSignal,
): Promise<PublicCatalogItem[]> {
  const [markets, tickers] = await Promise.all([
    loadMarketMeta(signal),
    loadTickers(signal),
  ]);
  const bases = new Map<string, PublicCatalogItem>();
  const inputs: Array<{ market: string; quoteVolume: number; changeRate: number | null }> =
    [];
  for (const [market, meta] of markets) {
    const ticker = tickers.get(market);
    if (!ticker) continue;
    const lastPrice = numeric(ticker, "trade_price");
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) continue;
    const rawVolume = numeric(ticker, "acc_trade_price_24h");
    const quoteVolume = Number.isFinite(rawVolume) ? rawVolume : 0;
    const signedChangeRate = numeric(ticker, "signed_change_rate");
    const changeRate = Number.isFinite(signedChangeRate) ? signedChangeRate * 100 : null;
    const tradeTimestamp = numeric(ticker, "trade_timestamp");
    inputs.push({ market, quoteVolume, changeRate });
    bases.set(market, {
      market,
      name: meta.name,
      englishName: meta.englishName,
      baseAsset: upbitBaseAsset(market),
      quoteAsset: "KRW",
      currency: "KRW",
      rank: 0,
      lastPrice,
      changeRate: changeRate ?? 0,
      quoteVolume,
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
    });
  }
  if (inputs.length === 0) {
    throw new Error("거래 가능한 KRW 마켓 시세를 확인하지 못했습니다.");
  }
  return rankUpbitCatalog(inputs).map((scored, index) => {
    const base = bases.get(scored.market) as PublicCatalogItem;
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
}

export interface PublicChartSelection {
  market: string;
  timeframe: UpbitChartTimeframe;
}

export interface PublicChartSeries {
  market: string;
  name: string;
  baseAsset: string;
  currency: "KRW";
  tickSize: number;
  timeframe: UpbitChartTimeframe;
  price: { lastPrice: number; timestamp: string };
  candles: UpbitChartCandle[];
}

export async function loadPublicUpbitChartSeries(
  selections: readonly PublicChartSelection[],
  signal: AbortSignal,
): Promise<PublicChartSeries[]> {
  if (selections.length === 0) return [];
  const uniqueMarkets = [...new Set(selections.map((selection) => selection.market))];
  const tickerPayload = await publicJson(
    `/v1/ticker?markets=${uniqueMarkets.join(",")}`,
    signal,
  );
  const tickers = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(tickerPayload) ? tickerPayload : []) {
    const item = record(entry);
    tickers.set(normalizeUpbitMarket(item.market), item);
  }
  return Promise.all(selections.map(async (selection) => {
    const payload = await publicJson(
      `/v1/candles/${upbitCandlePath(selection.timeframe)}?market=${selection.market}&count=200`,
      signal,
    );
    if (!Array.isArray(payload)) {
      throw new Error(`${selection.market} 캔들 형식을 확인하지 못했습니다.`);
    }
    const candles = normalizeCandleList(payload);
    const ticker = tickers.get(selection.market);
    const tickerPrice = ticker ? numeric(ticker, "trade_price") : Number.NaN;
    const lastPrice = Number.isFinite(tickerPrice) && tickerPrice > 0
      ? tickerPrice
      : candles.at(-1)?.closePrice ?? 0;
    const tradeTimestamp = ticker ? numeric(ticker, "trade_timestamp") : Number.NaN;
    return {
      market: selection.market,
      name: upbitBaseAsset(selection.market),
      baseAsset: upbitBaseAsset(selection.market),
      currency: "KRW" as const,
      tickSize: upbitKrwTickSize(lastPrice),
      timeframe: selection.timeframe,
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

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function loadDailyHistory(
  market: string,
  range: { startTime: number; endTime: number },
  signal: AbortSignal,
): Promise<UpbitRadarDailyCandle[]> {
  const days = Math.min(
    200,
    Math.max(2, Math.ceil((range.endTime - range.startTime) / DAY_MS) + 2),
  );
  const payload = await publicJson(
    `/v1/candles/days?market=${market}&count=${days}`,
    signal,
  );
  if (!Array.isArray(payload)) return [];
  return normalizeCandleList(payload)
    .filter((candle) =>
      candle.openTime >= range.startTime && candle.openTime <= range.endTime
    )
    .map((candle) => ({
      openTime: candle.openTime,
      closeTime: candle.openTime + DAY_MS - 1,
      closePrice: candle.closePrice,
      quoteVolume: candle.quoteVolume,
    }));
}

/**
 * 서버 레이더가 응답하지 않을 때 브라우저에서 같은 50·30·20 점수를 계산합니다.
 * 상위 40종목의 일봉을 받아야 하므로, 초당 한도를 지키면 몇 초가 걸립니다.
 */
export async function loadPublicUpbitRadar(
  signal: AbortSignal,
): Promise<UpbitRadarResult> {
  const catalog = await loadPublicUpbitCatalog(signal);
  const candidates: UpbitRadarSourceCandidate[] = catalog.map((item) => ({
    market: item.market,
    name: item.name,
    baseAsset: item.baseAsset,
    lastPrice: item.lastPrice,
    changeRate: item.changeRate,
    quoteVolume24h: item.quoteVolume,
    tickSize: item.tickSize,
    warning: item.warning,
  }));
  const analyzed = selectUpbitRadarAnalysisCandidates(candidates)
    .slice(0, UPBIT_RADAR_ANALYSIS_LIMIT);
  if (analyzed.length === 0) {
    throw new Error("분석할 KRW 마켓 후보를 찾지 못했습니다.");
  }
  const now = Date.now();
  const todayStart = utcDayStart(now);
  const range = {
    startTime: todayStart - UPBIT_RADAR_HISTORY_DAYS * DAY_MS,
    endTime: todayStart - 1,
  };
  const histories = new Map<string, readonly UpbitRadarDailyCandle[]>();
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(RADAR_HISTORY_CONCURRENCY, analyzed.length) }, async () => {
      while (nextIndex < analyzed.length) {
        const candidate = analyzed[nextIndex];
        nextIndex += 1;
        if (signal.aborted) return;
        try {
          const history = await loadDailyHistory(candidate.market, range, signal);
          if (history.length > 0) histories.set(candidate.market, history);
        } catch (error) {
          // 한 종목의 이력 실패는 잠정 순위로 흡수합니다. 429/418은 IP 전체에
          // 걸린 상태이므로 남은 요청을 더 보내지 않고 즉시 멈춥니다.
          const status = (error as PublicFetchError).status;
          if (status === 429 || status === 418) return;
        }
      }
    }),
  );
  if (histories.size === 0) {
    throw new Error("완료된 업비트 일봉 이력을 받지 못했습니다.");
  }
  const result = buildUpbitRadarResult(candidates, histories, { now });
  if (result.coverage.historyReady === 0) {
    throw new Error(
      `완료된 일봉 창(${DAY_KEY.format(new Date(range.endTime))} 기준)을 확인하지 못했습니다.`,
    );
  }
  return result;
}
