"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CandlestickChart, {
  type ChartCandle,
  type ChartTimeframe,
} from "./CandlestickChart";
import { loadPublicFuturesChartSeries } from "./BinancePublicClient";
import styles from "./MultiChartWorkspace.module.css";

export type MultiChartCandidate = {
  symbol: string;
  name: string;
  currency: string;
  lastPrice?: number;
  changeRate?: number;
  priceTimestamp?: string;
  tickSize?: number | string;
  eligible?: boolean;
};

export type MarketSegment = "crypto" | "tradfi";

type FeedMode = "DEMO" | "LIVE";
type SocketState = "idle" | "connecting" | "open" | "backoff" | "error";

const CHART_HTTP_TIMEOUT_MS = 12_000;
const SAME_ORIGIN_API_BACKOFF_MS = 60_000;
const BINANCE_FUTURES_STREAM_BASE =
  "wss://fstream.binance.com/market/stream?streams=";
const MAX_RECONNECT_DELAY_MS = 30_000;

const TIMEFRAME_OPTIONS: Array<{ value: ChartTimeframe; label: string }> = [
  { value: "1m", label: "1분" },
  { value: "3m", label: "3분" },
  { value: "5m", label: "5분" },
  { value: "15m", label: "15분" },
  { value: "1h", label: "1시간" },
  { value: "4h", label: "4시간" },
  { value: "1d", label: "일봉" },
  { value: "1w", label: "주봉" },
  { value: "1M", label: "월봉" },
];

const TIMEFRAME_LABEL: Record<ChartTimeframe, string> = {
  "1m": "1분봉",
  "3m": "3분봉",
  "5m": "5분봉",
  "15m": "15분봉",
  "1h": "1시간봉",
  "4h": "4시간봉",
  "1d": "일봉",
  "1w": "주봉",
  "1M": "월봉",
};

const FIXED_TIMEFRAME_DURATION: Record<Exclude<ChartTimeframe, "1M">, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

const CANDLE_TIME_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function isChartTimeframe(value: unknown): value is ChartTimeframe {
  return typeof value === "string" && value in TIMEFRAME_LABEL;
}

type PriceSnapshot = {
  lastPrice: number;
  timestamp?: string;
};

type ChartSeries = {
  symbol: string;
  name: string;
  currency: "USDT";
  tickSize: number;
  price: PriceSnapshot;
  candles: ChartCandle[];
  timeframe: ChartTimeframe;
};

type ChartSelection = {
  symbol: string;
  timeframe: ChartTimeframe;
  key: string;
};

type MultiChartWorkspaceProps = {
  segment: MarketSegment;
  mode?: FeedMode;
  theme: "dark" | "light";
  symbols: string[];
  timeframes: ChartTimeframe[];
  activeIndex: number;
  paused: boolean;
  candidates: MultiChartCandidate[];
  onSelectSlot: (index: number) => void;
  onRequestSymbolChange: (index: number, trigger?: HTMLButtonElement | null) => void;
  onChangeAllTimeframes: (timeframe: ChartTimeframe) => void;
  onChangeActiveTimeframe: (timeframe: ChartTimeframe) => void;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function numeric(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replaceAll(",", ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function textual(source: Record<string, unknown>, fallback: string, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function responseMode(value: unknown, fallback: FeedMode): FeedMode {
  return typeof value === "string" && value.toUpperCase() === "LIVE"
    ? "LIVE"
    : typeof value === "string" && value.toUpperCase() === "DEMO"
      ? "DEMO"
      : fallback;
}

function liveDelayMessage(detail?: string) {
  const normalized = detail?.trim();
  if (!normalized || normalized.includes("Binance 연결 지연")) {
    return normalized || "Binance 연결 지연";
  }
  return `Binance 연결 지연 · ${normalized}`;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  parentSignal: AbortSignal,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CHART_HTTP_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label} 제한 시간(${CHART_HTTP_TIMEOUT_MS / 1_000}초)을 초과했습니다.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function normalizeSymbol(value: string) {
  return value.trim().toUpperCase();
}

function isEligibleFuturesSymbol(symbol: string) {
  return /^[A-Z0-9]{5,30}$/.test(symbol) && symbol.endsWith("USDT");
}

function baseSymbol(symbol: string) {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

function seriesKey(symbol: string, timeframe: ChartTimeframe) {
  return `${symbol}:${timeframe}`;
}

function isoTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) return isoTimestamp(numericValue);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return "";
}

function normalizeCandle(value: unknown): ChartCandle | null {
  const candle = record(value);
  const closePrice = numeric(candle, "closePrice", "close", "c");
  const timestamp = isoTimestamp(
    candle.openTime ?? candle.timestamp ?? candle.time ?? candle.date ?? candle.t,
  );
  if (!closePrice || !timestamp) return null;
  const openPrice = numeric(candle, "openPrice", "open", "o") || closePrice;
  const highPrice = numeric(candle, "highPrice", "high", "h") ||
    Math.max(openPrice, closePrice);
  const lowPrice = numeric(candle, "lowPrice", "low", "l") ||
    Math.min(openPrice, closePrice);
  return {
    timestamp,
    openTime: Date.parse(timestamp),
    openPrice,
    highPrice: Math.max(highPrice, openPrice, closePrice),
    lowPrice: Math.min(lowPrice, openPrice, closePrice),
    closePrice,
    volume: Math.max(0, numeric(candle, "volume", "tradingVolume", "v")),
    quoteVolume: Math.max(0, numeric(
      candle,
      "quoteVolume",
      "quoteAssetVolume",
      "tradingAmount",
      "q",
    )),
  };
}

function candleOpenTime(candle: ChartCandle) {
  return typeof candle.openTime === "number" && Number.isFinite(candle.openTime)
    ? candle.openTime
    : Date.parse(candle.timestamp);
}

function nextCandleBoundary(openTime: number, timeframe: ChartTimeframe) {
  if (timeframe === "1M") {
    const openDate = new Date(openTime);
    return Date.UTC(openDate.getUTCFullYear(), openDate.getUTCMonth() + 1, 1);
  }
  return openTime + FIXED_TIMEFRAME_DURATION[timeframe];
}

function projectedCandleOpen(
  series: ChartSeries | undefined,
  timeframe: ChartTimeframe,
  liveTimestamp?: string,
) {
  if (!series || series.timeframe !== timeframe) return Number.NaN;
  const latest = series.candles.at(-1);
  if (!latest) return Number.NaN;
  const latestOpen = candleOpenTime(latest);
  if (!Number.isFinite(latestOpen)) return Number.NaN;

  const quoteTime = Date.parse(liveTimestamp ?? "");
  if (!Number.isFinite(quoteTime) || quoteTime < nextCandleBoundary(latestOpen, timeframe)) {
    return latestOpen;
  }
  if (timeframe === "1M") {
    const quoteDate = new Date(quoteTime);
    return Date.UTC(quoteDate.getUTCFullYear(), quoteDate.getUTCMonth(), 1);
  }
  const duration = FIXED_TIMEFRAME_DURATION[timeframe];
  return latestOpen + Math.floor((quoteTime - latestOpen) / duration) * duration;
}

function formatCandleTime(value: number) {
  if (!Number.isFinite(value)) return "";
  const parts = CANDLE_TIME_FORMATTER.formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}.${read("month")}.${read("day")} ${read("hour")}:${read("minute")} KST`;
}

function mergeCandles(...collections: ChartCandle[][]) {
  const merged = new Map<number, ChartCandle>();
  for (const candles of collections) {
    for (const candle of candles) {
      const openTime = candleOpenTime(candle);
      if (!Number.isFinite(openTime) || candle.closePrice <= 0) continue;
      merged.set(openTime, { ...candle, openTime });
    }
  }
  return [...merged.values()]
    .sort((left, right) => candleOpenTime(left) - candleOpenTime(right))
    .slice(-84);
}

function normalizeSeries(value: unknown, timeframe: ChartTimeframe): ChartSeries {
  const source = record(value);
  const price = record(source.price);
  const rawCandles = Array.isArray(source.candles) ? source.candles : [];
  const responseTimeframe = textual(source, "", "timeframe", "interval");
  const symbol = normalizeSymbol(textual(source, "", "symbol", "code", "ticker"));
  return {
    symbol,
    name: textual(source, baseSymbol(symbol), "name", "displayName", "baseAsset"),
    currency: "USDT",
    tickSize: numeric(source, "tickSize") || numeric(price, "tickSize"),
    price: {
      lastPrice: numeric(price, "lastPrice", "price", "close"),
      timestamp: isoTimestamp(
        price.timestamp ?? price.observedAt ?? source.timestamp,
      ) || undefined,
    },
    candles: mergeCandles(
      rawCandles
        .map(normalizeCandle)
        .filter((candle): candle is ChartCandle => candle !== null),
    ),
    timeframe: isChartTimeframe(responseTimeframe) ? responseTimeframe : timeframe,
  };
}

function candidateTickSize(value: number | string | undefined) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatTime(value?: string) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function laterPrice(current: PriceSnapshot | undefined, incoming: PriceSnapshot) {
  if (!current?.lastPrice) return incoming;
  const currentTime = Date.parse(current.timestamp ?? "");
  const incomingTime = Date.parse(incoming.timestamp ?? "");
  return Number.isFinite(currentTime) && (!Number.isFinite(incomingTime) || currentTime > incomingTime)
    ? current
    : incoming;
}

function normalizeStreamKline(value: unknown) {
  const event = record(value);
  const kline = record(event.k);
  const symbol = normalizeSymbol(textual(kline, textual(event, "", "s"), "s"));
  const interval = textual(kline, "", "i");
  const candle = normalizeCandle({
    t: kline.t,
    o: kline.o,
    h: kline.h,
    l: kline.l,
    c: kline.c,
    v: kline.v,
    q: kline.q,
  });
  if (!symbol || !isChartTimeframe(interval) || !candle) return null;
  return {
    symbol,
    timeframe: interval,
    candle,
    timestamp: isoTimestamp(event.E ?? kline.T) || candle.timestamp,
  };
}

export function MultiChartWorkspace({
  segment,
  mode = "LIVE",
  theme,
  symbols,
  timeframes,
  activeIndex,
  paused,
  candidates,
  onSelectSlot,
  onRequestSymbolChange,
  onChangeAllTimeframes,
  onChangeActiveTimeframe,
}: MultiChartWorkspaceProps) {
  const [fullSeries, setFullSeries] = useState<Record<string, ChartSeries>>({});
  const [quotes, setQuotes] = useState<Record<string, PriceSnapshot>>({});
  const [fullError, setFullError] = useState("");
  const [streamError, setStreamError] = useState("");
  const [lastFullAt, setLastFullAt] = useState("");
  const [lastStreamAt, setLastStreamAt] = useState("");
  const [fullMode, setFullMode] = useState<FeedMode>(mode);
  const [fullNotice, setFullNotice] = useState("");
  const [socketState, setSocketState] = useState<SocketState>("idle");
  const [retryRevision, setRetryRevision] = useState(0);
  const fullApiRetryAtRef = useRef(0);

  const candidateMap = useMemo(
    () => new Map(candidates.map((candidate) => [normalizeSymbol(candidate.symbol), candidate])),
    [candidates],
  );
  // Universe quotes refresh every 15 seconds and recreate candidate objects.
  // Depend on selection content only so unchanged catalog metadata cannot restart
  // the 5-second REST loop or the combined WebSocket connection.
  const requestedSelectionContent = symbols.map((rawSymbol, index) => {
    const symbol = normalizeSymbol(rawSymbol);
    const timeframe = timeframes[index] ?? "1m";
    const eligible = candidateMap.get(symbol)?.eligible === false ? "0" : "1";
    return `${symbol}:${timeframe}:${eligible}`;
  }).join("|");
  const requestedSelections = useMemo(() => {
    const seen = new Set<string>();
    return requestedSelectionContent.split("|").flatMap((encoded): ChartSelection[] => {
      const [symbol, timeframeValue, eligible] = encoded.split(":");
      if (!isChartTimeframe(timeframeValue)) return [];
      const timeframe = timeframeValue;
      const key = seriesKey(symbol, timeframe);
      if (
        !symbol ||
        !isEligibleFuturesSymbol(symbol) ||
        eligible === "0" ||
        seen.has(key)
      ) return [];
      seen.add(key);
      return [{ symbol, timeframe, key }];
    });
  }, [requestedSelectionContent]);
  const streamNames = useMemo(() => [
    ...new Set(requestedSelections.map(({ symbol, timeframe }) =>
      `${symbol.toLowerCase()}@kline_${timeframe}`
    )),
    "!ticker@arr",
  ], [requestedSelections]);
  const streamPath = streamNames.join("/");

  useEffect(() => {
    if (paused || requestedSelections.length === 0) return undefined;
    const controller = new AbortController();
    let disposed = false;
    let running = false;

    const loadFull = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const alignAndValidate = (rawSeries: unknown[], notice: string) => {
          const aligned = rawSeries.map((item, index) => normalizeSeries(
            item,
            requestedSelections[index]?.timeframe ?? "1m",
          ))
          .filter((series) => isEligibleFuturesSymbol(series.symbol));
          const alignedByKey = new Map(
            aligned.map((series) => [seriesKey(series.symbol, series.timeframe), series]),
          );
          const incomplete = requestedSelections.filter((selection) => {
            const series = alignedByKey.get(selection.key);
            return !series?.candles.length || !series.tickSize;
          });
          if (incomplete.length > 0) {
            throw new Error(
              notice || `REST 응답에서 ${incomplete.length}개 슬롯이 누락되었습니다.`,
            );
          }
          return aligned;
        };

        let alignedSeries: ChartSeries[];
        let nextMode: FeedMode = mode;
        let notice = "";
        let observedAt = new Date().toISOString();
        const trySameOrigin = Date.now() >= fullApiRetryAtRef.current;
        try {
          if (!trySameOrigin) {
            throw new Error("same-origin API 재시도 대기 중");
          }
          const response = await fetchWithTimeout("/api/charts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              symbols: requestedSelections.map((selection) => selection.symbol),
              detail: "full",
              timeframes: requestedSelections.map((selection) => selection.timeframe),
            }),
            cache: "no-store",
          }, controller.signal, "Binance REST 캔들 동기화");
          const root = record(await response.json().catch(() => ({})));
          notice = textual(root, "", "notice", "error");
          if (!response.ok || root.complete === false) {
            throw new Error(notice || `Binance REST 캔들 동기화 실패 (${response.status})`);
          }
          nextMode = responseMode(root.mode, mode);
          if (mode === "LIVE" && (nextMode !== "LIVE" || root.sourceUnavailable === true)) {
            throw new Error(liveDelayMessage(notice || "실시간 차트 응답을 확인하지 못했습니다."));
          }
          alignedSeries = alignAndValidate(
            Array.isArray(root.series) ? root.series : [],
            notice,
          );
          observedAt = isoTimestamp(root.timestamp) || observedAt;
          fullApiRetryAtRef.current = 0;
        } catch (apiError) {
          if (controller.signal.aborted) throw apiError;
          if (trySameOrigin) {
            fullApiRetryAtRef.current = Date.now() + SAME_ORIGIN_API_BACKOFF_MS;
          }
          try {
            const directSeries = await loadPublicFuturesChartSeries(
              requestedSelections.map(({ symbol, timeframe }) => ({ symbol, timeframe })),
              controller.signal,
            );
            alignedSeries = alignAndValidate(directSeries, "");
            nextMode = "LIVE";
            notice = "Sites API 지연 · 브라우저 Binance 공개 REST로 복구됨";
            observedAt = new Date().toISOString();
          } catch (publicError) {
            const apiDetail = apiError instanceof Error ? apiError.message : "same-origin API 오류";
            const publicDetail = publicError instanceof Error
              ? publicError.message
              : "브라우저 공개 REST 오류";
            throw new Error(`${apiDetail} · 브라우저 직접 복구 실패: ${publicDetail}`);
          }
        }
        if (disposed) return;
        setFullSeries((current) => {
          const next = { ...current };
          for (const series of alignedSeries) {
            const key = seriesKey(series.symbol, series.timeframe);
            const existing = current[key];
            next[key] = {
              ...series,
              price: laterPrice(existing?.price, series.price),
              candles: mergeCandles(series.candles, existing?.candles ?? []),
            };
          }
          return next;
        });
        setFullMode(nextMode);
        setFullNotice(notice);
        setLastFullAt(observedAt);
        setFullError("");
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        const detail = error instanceof Error
          ? error.message
          : "Binance REST 차트를 불러오지 못했습니다.";
        setFullError(mode === "LIVE" ? liveDelayMessage(detail) : detail);
      } finally {
        running = false;
      }
    };

    void loadFull();
    const interval = window.setInterval(() => void loadFull(), 5_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [mode, paused, requestedSelections, retryRevision]);

  useEffect(() => {
    if (paused || mode !== "LIVE" || requestedSelections.length === 0) {
      return undefined;
    }

    const selectedSymbols = new Set(requestedSelections.map(({ symbol }) => symbol));
    const selectedKeys = new Set(requestedSelections.map(({ key }) => key));
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let disposed = false;
    let suspended = document.hidden;

    const scheduleReconnect = () => {
      if (disposed || suspended || reconnectTimer !== undefined) return;
      const baseDelay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        1_000 * (2 ** Math.min(reconnectAttempt, 5)),
      );
      const delay = Math.max(500, Math.round(baseDelay * (0.75 + Math.random() * 0.5)));
      reconnectAttempt += 1;
      setSocketState("backoff");
      setStreamError(`Binance WebSocket 재연결 대기 (${Math.ceil(delay / 1_000)}초)`);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const handleTickerArray = (value: unknown) => {
      if (!Array.isArray(value)) return;
      const updates: Array<{ symbol: string; lastPrice: number; timestamp: string }> = [];
      let observedAt = "";
      for (const item of value) {
        const ticker = record(item);
        const symbol = normalizeSymbol(textual(ticker, "", "s", "symbol"));
        if (!selectedSymbols.has(symbol)) continue;
        const lastPrice = numeric(ticker, "c", "lastPrice", "price");
        if (lastPrice <= 0) continue;
        const timestamp = isoTimestamp(ticker.E ?? ticker.eventTime) ||
          new Date().toISOString();
        updates.push({ symbol, lastPrice, timestamp });
        observedAt = timestamp;
      }
      if (updates.length === 0) return;
      setQuotes((current) => {
        const next = { ...current };
        for (const update of updates) {
          next[update.symbol] = {
            lastPrice: update.lastPrice,
            timestamp: update.timestamp,
          };
        }
        return next;
      });
      setLastStreamAt(observedAt);
    };

    const handleKline = (value: unknown) => {
      const update = normalizeStreamKline(value);
      if (!update) return;
      const key = seriesKey(update.symbol, update.timeframe);
      if (!selectedKeys.has(key)) return;
      setFullSeries((current) => {
        const existing = current[key];
        if (!existing) return current;
        return {
          ...current,
          [key]: {
            ...existing,
            price: {
              lastPrice: update.candle.closePrice,
              timestamp: update.timestamp,
            },
            candles: mergeCandles(existing.candles, [update.candle]),
          },
        };
      });
      setQuotes((current) => ({
        ...current,
        [update.symbol]: {
          lastPrice: update.candle.closePrice,
          timestamp: update.timestamp,
        },
      }));
      setLastStreamAt(update.timestamp);
    };

    const connect = () => {
      if (disposed || suspended || document.hidden || typeof WebSocket !== "function") return;
      if (
        socket &&
        (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
      ) return;
      setSocketState("connecting");
      const connection = new WebSocket(`${BINANCE_FUTURES_STREAM_BASE}${streamPath}`);
      socket = connection;

      connection.onopen = () => {
        if (disposed || socket !== connection) return;
        reconnectAttempt = 0;
        setSocketState("open");
        setStreamError("");
      };
      connection.onmessage = (event) => {
        if (disposed || socket !== connection) return;
        try {
          const parsed: unknown = JSON.parse(String(event.data));
          if (Array.isArray(parsed)) {
            handleTickerArray(parsed);
            return;
          }
          const wrapper = record(parsed);
          const payload = Object.prototype.hasOwnProperty.call(wrapper, "data")
            ? wrapper.data
            : parsed;
          const stream = textual(wrapper, "", "stream");
          if (stream === "!ticker@arr" || Array.isArray(payload)) {
            handleTickerArray(payload);
            return;
          }
          const data = record(payload);
          if (textual(data, "", "e") === "kline" || data.k) handleKline(data);
        } catch {
          // Ignore a malformed frame; the next Binance update repairs the view.
        }
      };
      connection.onerror = () => {
        if (disposed || socket !== connection) return;
        setSocketState("error");
        setStreamError("Binance WebSocket 오류 · REST 데이터 유지");
        connection.close();
      };
      connection.onclose = () => {
        const wasCurrent = socket === connection;
        if (wasCurrent) socket = null;
        if (wasCurrent && !disposed && !suspended) scheduleReconnect();
      };
    };

    const onVisibilityChange = () => {
      suspended = document.hidden;
      if (suspended) {
        if (reconnectTimer !== undefined) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        const connection = socket;
        socket = null;
        connection?.close(1000, "tab hidden");
        setSocketState("idle");
        return;
      }
      reconnectAttempt = 0;
      connect();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (!suspended) connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const connection = socket;
      socket = null;
      connection?.close(1000, "selection changed");
    };
  }, [mode, paused, requestedSelections, streamPath]);

  const effectiveSocketState: SocketState = paused || requestedSelections.length === 0
    ? "idle"
    : socketState;
  const streamingDelayed = effectiveSocketState === "backoff" ||
    effectiveSocketState === "error";
  const liveDelayed = mode === "LIVE" && Boolean(
    fullError || fullMode !== "LIVE" || streamingDelayed
  );
  const delayed = Boolean(fullError || streamingDelayed);
  const activeTimeframe = timeframes[activeIndex] ?? "1m";
  const uniformTimeframe = timeframes.length > 0 &&
    timeframes.every((timeframe) => timeframe === timeframes[0])
    ? timeframes[0]
    : null;
  const activeSymbol = normalizeSymbol(symbols[activeIndex] || "");
  const activeLabel = activeSymbol ? `${baseSymbol(activeSymbol)}/USDT` : "빈 슬롯";
  const activeSeries = activeSymbol
    ? fullSeries[seriesKey(activeSymbol, activeTimeframe)]
    : undefined;
  const activeQuoteTimestamp = activeSymbol
    ? quotes[activeSymbol]?.timestamp || activeSeries?.price.timestamp
    : undefined;
  const activeCandleTime = formatCandleTime(
    projectedCandleOpen(activeSeries, activeTimeframe, activeQuoteTimestamp),
  );
  const activeCandleLabel = !activeSymbol
    ? "현재 캔들 · 종목 선택 필요"
    : !activeCandleTime
      ? "현재 캔들 · 동기화 중"
      : paused || liveDelayed
        ? `마지막 캔들 · ${activeCandleTime}`
        : activeCandleTime;
  const isCurrentCandleTime = Boolean(
    activeSymbol && activeCandleTime && !paused && !liveDelayed,
  );

  const syncingCount = requestedSelections.filter((selection) => {
    const series = fullSeries[selection.key];
    return series?.timeframe !== selection.timeframe || !series.candles.length;
  }).length;
  const terminalMessage = fullError;
  const syncStateDetail = paused
    ? "탭 비활성 · Binance 스트림 중지"
    : terminalMessage
      ? "Binance 연결 지연 · 마지막 정상 데이터 유지"
      : effectiveSocketState === "backoff" || effectiveSocketState === "error"
        ? "WebSocket 재연결 중 · REST 데이터 유지"
        : effectiveSocketState === "connecting"
          ? "Binance Futures 스트림 연결 중"
          : syncingCount > 0
            ? `${syncingCount}개 슬롯 REST 캔들 동기화 중`
            : effectiveSocketState === "open"
              ? ""
              : "Binance Futures 실시간 연결 준비";
  const syncErrorDetail = terminalMessage || streamError ||
    (mode === "DEMO" ? fullNotice : "");
  const syncDetail = [
    syncStateDetail,
    syncErrorDetail,
    syncErrorDetail
      ? `마지막 스트림 ${formatTime(lastStreamAt)} · REST ${formatTime(lastFullAt)}`
      : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className={styles.workspace} aria-labelledby="multi-chart-title">
      <header className={styles.workspaceHeader}>
        <h2 id="multi-chart-title" className={styles.srOnly}>
          {segment === "crypto" ? "CRYPTO 12분할 차트" : "TRADFI 12분할 차트"}
        </h2>
        <div
          className={styles.syncState}
          data-paused={paused || undefined}
          data-delayed={delayed || undefined}
          data-syncing={syncingCount > 0 || effectiveSocketState === "connecting" || undefined}
        >
          <span aria-hidden="true" />
          <div>
            <strong className={isCurrentCandleTime ? styles.currentCandleTime : undefined}>
              {activeCandleLabel}
            </strong>
            {syncDetail && <small>{syncDetail}</small>}
          </div>
          {fullError && !paused && (
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => {
                fullApiRetryAtRef.current = 0;
                setFullError("");
                setRetryRevision((revision) => revision + 1);
              }}
            >
              지금 재시도
            </button>
          )}
        </div>
        <div
          className={styles.timeframeControls}
          role="group"
          aria-label="차트 봉 주기 설정"
        >
          <fieldset className={styles.timeframeBar}>
            <legend className={styles.srOnly}>
              현재 시장 12개 차트 봉 주기 일괄 변경
            </legend>
            {TIMEFRAME_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={styles.timeframeOption}
                title={option.label}
              >
                <input
                  type="radio"
                  name="all-slots-timeframe"
                  value={option.value}
                  checked={option.value === uniformTimeframe}
                  aria-label={`${option.label}을 현재 시장 12개 차트에 일괄 적용`}
                  onChange={() => onChangeAllTimeframes(option.value)}
                />
                <span>{option.value}</span>
              </label>
            ))}
          </fieldset>
          <div className={styles.activeTimeframeControl}>
            <span>
              <b>C{activeIndex + 1}</b>
              {activeLabel}
              <em>{TIMEFRAME_LABEL[activeTimeframe]}</em>
            </span>
            <label>
              <span className={styles.srOnly}>{activeIndex + 1}번 활성 슬롯 봉 주기</span>
              <select
                value={activeTimeframe}
                aria-label={`${activeIndex + 1}번 활성 슬롯 봉 주기 선택`}
                onChange={(event) => {
                  const timeframe = event.target.value;
                  if (isChartTimeframe(timeframe)) onChangeActiveTimeframe(timeframe);
                }}
              >
                {TIMEFRAME_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </header>

      <div className={styles.mobileTabs} role="tablist" aria-label="차트 슬롯 선택">
        {symbols.map((rawSymbol, index) => {
          const symbol = normalizeSymbol(rawSymbol);
          return (
            <button
              key={`mobile-slot-${index}`}
              type="button"
              role="tab"
              aria-selected={activeIndex === index}
              className={activeIndex === index ? styles.mobileTabActive : ""}
              onClick={() => onSelectSlot(index)}
            >
              <span>C{index + 1}</span>
              {symbol ? `${baseSymbol(symbol)}/USDT` : "비어 있음"}
            </button>
          );
        })}
      </div>

      <div className={styles.chartGrid}>
        {symbols.map((rawSymbol, index) => {
          const symbol = normalizeSymbol(rawSymbol);
          const candidate = candidateMap.get(symbol);
          const active = activeIndex === index;
          const slotTimeframe = timeframes[index] ?? "1m";
          const key = seriesKey(symbol, slotTimeframe);
          const series = fullSeries[key];
          const quote = quotes[symbol]?.lastPrice ? quotes[symbol] : series?.price;
          const tickSize = series?.tickSize || candidateTickSize(candidate?.tickSize);
          const name = series?.name || candidate?.name || baseSymbol(symbol);
          const candleLabel = TIMEFRAME_LABEL[slotTimeframe];
          const seriesReady = series?.timeframe === slotTimeframe;
          const eligible = Boolean(
            symbol && isEligibleFuturesSymbol(symbol) && candidate?.eligible !== false,
          );

          if (!symbol) {
            return (
              <article
                key={`empty-slot-${index}`}
                className={`${styles.slot} ${styles.emptySlot}`}
                data-active={active}
              >
                 <button
                   id={`slot-symbol-trigger-${index}`}
                   type="button"
                   aria-label={`C${index + 1} 빈 차트 슬롯 종목 선택`}
                   title="종목 선택"
                   onClick={(event) => onRequestSymbolChange(index, event.currentTarget)}
                 >
                   <span>C{index + 1}</span>
                   <strong>빈 차트 슬롯</strong>
                   <small>눌러서 전체 선물 종목을 검색하고 지정하세요.</small>
                 </button>
              </article>
            );
          }

          return (
            <article
              key={`slot-${index}-${symbol}-${slotTimeframe}`}
              className={styles.slot}
              data-active={active}
              data-stale={liveDelayed || !eligible || undefined}
            >
              <button
                id={`slot-symbol-trigger-${index}`}
                type="button"
                className={styles.symbolOverlay}
                aria-label={`C${index + 1} ${baseSymbol(symbol)}/USDT 종목 변경 창 열기`}
                aria-haspopup="dialog"
                title="종목 선택"
                onClick={(event) => onRequestSymbolChange(index, event.currentTarget)}
              >
                {baseSymbol(symbol)}/USDT
              </button>
              <button
                type="button"
                className={styles.chartBody}
                aria-label={`${name} ${candleLabel} 차트 선택`}
                onClick={() => onSelectSlot(index)}
              >
                <CandlestickChart
                  symbol={symbol}
                  candles={seriesReady ? series.candles : []}
                  livePrice={quote?.lastPrice || series?.price.lastPrice}
                  liveTimestamp={quote?.timestamp || series?.price.timestamp}
                  timeframe={slotTimeframe}
                  tickSize={tickSize}
                  theme={theme}
                />
                {(!eligible || !seriesReady || !series.candles.length || liveDelayed) && (
                  <span className={styles.loadingBadge} role="status">
                    {!eligible
                      ? "지원되지 않는 USDⓈ-M 선물 심볼"
                      : liveDelayed
                        ? `Binance 연결 지연 · 마지막 정상 ${formatTime(lastStreamAt || lastFullAt)}`
                        : fullError
                          ? `${candleLabel} REST 오류 · 자동 재시도 중`
                          : `${candleLabel} REST 캔들 동기화 중`}
                  </span>
                )}
              </button>
            </article>
          );
        })}
      </div>

      <footer className={styles.workspaceFooter}>
        <span>
          {segment === "crypto"
            ? "C1·C2 기본 BTC·ETH · 사용자 지정 유지 · C3~C12 24H 거래대금 상위 10종목 1시간 자동 배열 · 봉 주기 전체/활성 슬롯 개별 설정"
            : "C1·C2 사용자 지정 유지 · C3~C12 24H 거래대금 상위 10종목 1시간 자동 배열 · 봉 주기 전체/활성 슬롯 개별 설정"}
        </span>
        <span>실시간 WebSocket kline · 5초 REST · 브라우저 공개 REST 자동 복구</span>
      </footer>
    </section>
  );
}

export default MultiChartWorkspace;
