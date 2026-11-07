/**
 * 업비트 REST 응답을 다루는 순수 파서입니다. 서버 라우트와 브라우저 직접 복구
 * 경로가 같은 코드를 쓰도록 node 전용 의존성 없이 유지합니다.
 */

export interface UpbitChartCandle {
  timestamp: string;
  openTime: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume: number;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function numeric(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

export function text(
  source: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** 업비트는 `2026-09-18T07:19:11`처럼 Z 없는 UTC 문자열을 돌려줍니다. */
export function parseUpbitUtc(value: string): number {
  if (!value) return Number.NaN;
  const normalized = /([+-]\d{2}:\d{2}|Z)$/.test(value) ? value : `${value}Z`;
  return Date.parse(normalized);
}

/** 최신 봉이 먼저 오므로 오름차순으로 뒤집고, 값이 깨진 봉은 버립니다. */
export function normalizeCandleList(
  payload: readonly unknown[],
): UpbitChartCandle[] {
  const byOpenTime = new Map<number, UpbitChartCandle>();
  for (const entry of payload) {
    const item = record(entry);
    const openTime = parseUpbitUtc(text(item, "candle_date_time_utc"));
    const openPrice = numeric(item, "opening_price");
    const highPrice = numeric(item, "high_price");
    const lowPrice = numeric(item, "low_price");
    const closePrice = numeric(item, "trade_price");
    if (
      !Number.isFinite(openTime) ||
      !Number.isFinite(openPrice) || openPrice <= 0 ||
      !Number.isFinite(highPrice) || highPrice <= 0 ||
      !Number.isFinite(lowPrice) || lowPrice <= 0 ||
      !Number.isFinite(closePrice) || closePrice <= 0
    ) continue;
    const volume = numeric(item, "candle_acc_trade_volume");
    const quoteVolume = numeric(item, "candle_acc_trade_price");
    byOpenTime.set(openTime, {
      timestamp: new Date(openTime).toISOString(),
      openTime,
      openPrice,
      highPrice: Math.max(highPrice, openPrice, closePrice),
      lowPrice: Math.min(lowPrice, openPrice, closePrice),
      closePrice,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
      quoteVolume: Number.isFinite(quoteVolume) && quoteVolume > 0 ? quoteVolume : 0,
    });
  }
  return [...byOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
}
