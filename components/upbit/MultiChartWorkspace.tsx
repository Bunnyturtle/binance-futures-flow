"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CandlestickChart, {
  TIMEFRAME_LABEL,
  type ChartCandle,
  type ChartTimeframe,
} from "./CandlestickChart";
import { loadPublicUpbitChartSeries } from "./UpbitPublicClient";
import { formatKrwPrice } from "../../lib/format-krw";
import {
  UPBIT_CHART_TIMEFRAMES,
  isUpbitChartTimeframe,
  normalizeUpbitMarket,
  upbitBaseAsset,
  upbitCandleStreamType,
  upbitNextCandleOpen,
  upbitTimeframeDurationMs,
  isUpbitKrwMarket,
} from "../../lib/upbit-market";
import { normalizeCandleList, numeric, record, text } from "../../lib/upbit-parse";
import styles from "./MultiChartWorkspace.module.css";

export type MultiChartCandidate = {
  market: string;
  name: string;
  lastPrice?: number;
  changeRate?: number;
  priceTimestamp?: string;
  tickSize?: number | string;
  warning?: boolean;
};

type SocketState = "idle" | "connecting" | "open" | "backoff" | "error";

const CHART_HTTP_TIMEOUT_MS = 12_000;
const SAME_ORIGIN_API_BACKOFF_MS = 60_000;
const REST_REFRESH_MS = 5_000;
const UPBIT_STREAM_URL = "wss://api.upbit.com/websocket/v1";
const MAX_RECONNECT_DELAY_MS = 30_000;
// 업비트는 120초 동안 송수신이 없으면 연결을 끊습니다. 여유 있게 절반 주기로
// PING을 보내 유휴 종료를 막습니다.
const STREAM_PING_MS = 55_000;

const TIMEFRAME_OPTIONS: Array<{ value: ChartTimeframe; label: string }> =
  UPBIT_CHART_TIMEFRAMES.map((value) => ({ value, label: TIMEFRAME_LABEL[value] }));

const CANDLE_TIME_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type PriceSnapshot = {
  lastPrice: number;
  timestamp?: string;
};

type ChartSeries = {
  market: string;
  name: string;
  tickSize: number;
  price: PriceSnapshot;
  candles: ChartCandle[];
  timeframe: ChartTimeframe;
};

type ChartSelection = {
  market: string;
  timeframe: ChartTimeframe;
  key: string;
};

type MultiChartWorkspaceProps = {
  theme: "dark" | "light";
  markets: string[];
  timeframes: ChartTimeframe[];
  activeIndex: number;
  paused: boolean;
  candidates: MultiChartCandidate[];
  onSelectSlot: (index: number) => void;
  onRequestMarketChange: (index: number, trigger?: HTMLButtonElement | null) => void;
  onChangeAllTimeframes: (timeframe: ChartTimeframe) => void;
  onChangeActiveTimeframe: (timeframe: ChartTimeframe) => void;
};

const VISIBLE_CANDLES = 84;

function seriesKey(market: string, timeframe: ChartTimeframe) {
  return `${market}:${timeframe}`;
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

function candleOpenTime(candle: ChartCandle) {
  return typeof candle.openTime === "number" && Number.isFinite(candle.openTime)
    ? candle.openTime
    : Date.parse(candle.timestamp);
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
    .slice(-VISIBLE_CANDLES);
}

function normalizeSeries(value: unknown, timeframe: ChartTimeframe): ChartSeries {
  const source = record(value);
  const price = record(source.price);
  const market = normalizeUpbitMarket(source.market);
  const responseTimeframe = text(source, "timeframe");
  const rawCandles = Array.isArray(source.candles) ? source.candles : [];
  const candles = rawCandles.flatMap((entry): ChartCandle[] => {
    const candle = record(entry);
    const closePrice = numeric(candle, "closePrice");
    const openTimeValue = numeric(candle, "openTime");
    const openTime = Number.isFinite(openTimeValue)
      ? openTimeValue
      : Date.parse(text(candle, "timestamp"));
    if (!Number.isFinite(openTime) || !Number.isFinite(closePrice) || closePrice <= 0) {
      return [];
    }
    const openPrice = numeric(candle, "openPrice");
    const highPrice = numeric(candle, "highPrice");
    const lowPrice = numeric(candle, "lowPrice");
    const volume = numeric(candle, "volume");
    const quoteVolume = numeric(candle, "quoteVolume");
    const safeOpen = Number.isFinite(openPrice) && openPrice > 0 ? openPrice : closePrice;
    return [{
      timestamp: new Date(openTime).toISOString(),
      openTime,
      openPrice: safeOpen,
      highPrice: Math.max(
        Number.isFinite(highPrice) ? highPrice : 0,
        safeOpen,
        closePrice,
      ),
      lowPrice: Math.min(
        Number.isFinite(lowPrice) && lowPrice > 0 ? lowPrice : closePrice,
        safeOpen,
        closePrice,
      ),
      closePrice,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
      quoteVolume: Number.isFinite(quoteVolume) && quoteVolume > 0 ? quoteVolume : 0,
    }];
  });
  const tickSize = numeric(source, "tickSize");
  const lastPrice = numeric(price, "lastPrice");
  return {
    market,
    name: text(source, "name", upbitBaseAsset(market)),
    tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0,
    price: {
      lastPrice: Number.isFinite(lastPrice) ? lastPrice : 0,
      timestamp: isoTimestamp(price.timestamp) || undefined,
    },
    candles: mergeCandles(candles),
    timeframe: isUpbitChartTimeframe(responseTimeframe) ? responseTimeframe : timeframe,
  };
}

function candidateTickSize(value: number | string | undefined) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
  if (
    !Number.isFinite(quoteTime) ||
    quoteTime < upbitNextCandleOpen(latestOpen, timeframe)
  ) return latestOpen;
  const duration = upbitTimeframeDurationMs(timeframe);
  if (duration === null) {
    const quoteDate = new Date(quoteTime);
    return Date.UTC(quoteDate.getUTCFullYear(), quoteDate.getUTCMonth(), 1);
  }
  return latestOpen + Math.floor((quoteTime - latestOpen) / duration) * duration;
}

function formatCandleTime(value: number) {
  if (!Number.isFinite(value)) return "";
  const parts = CANDLE_TIME_FORMATTER.formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}.${read("month")}.${read("day")} ${read("hour")}:${read("minute")} KST`;
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
  return Number.isFinite(currentTime) &&
      (!Number.isFinite(incomingTime) || currentTime > incomingTime)
    ? current
    : incoming;
}

function liveDelayMessage(detail?: string) {
  const normalized = detail?.trim();
  if (!normalized || normalized.includes("업비트 연결 지연")) {
    return normalized || "업비트 연결 지연";
  }
  return `업비트 연결 지연 · ${normalized}`;
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

/** WebSocket candle 프레임은 REST 캔들과 필드 이름이 같습니다. */
function normalizeStreamCandle(frame: Record<string, unknown>) {
  const streamType = text(frame, "type");
  const market = normalizeUpbitMarket(frame.code);
  const [candle] = normalizeCandleList([frame]);
  if (!market || !candle || !streamType.startsWith("candle.")) return null;
  return {
    market,
    streamType,
    candle,
    timestamp: isoTimestamp(frame.timestamp) || candle.timestamp,
  };
}

export function MultiChartWorkspace({
  theme,
  markets,
  timeframes,
  activeIndex,
  paused,
  candidates,
  onSelectSlot,
  onRequestMarketChange,
  onChangeAllTimeframes,
  onChangeActiveTimeframe,
}: MultiChartWorkspaceProps) {
  const [fullSeries, setFullSeries] = useState<Record<string, ChartSeries>>({});
  const [quotes, setQuotes] = useState<Record<string, PriceSnapshot>>({});
  const [fullError, setFullError] = useState("");
  const [streamError, setStreamError] = useState("");
  const [lastFullAt, setLastFullAt] = useState("");
  const [lastStreamAt, setLastStreamAt] = useState("");
  const [fullNotice, setFullNotice] = useState("");
  const [socketState, setSocketState] = useState<SocketState>("idle");
  const [retryRevision, setRetryRevision] = useState(0);
  const fullApiRetryAtRef = useRef(0);

  const candidateMap = useMemo(
    () => new Map(candidates.map((candidate) => [
      normalizeUpbitMarket(candidate.market),
      candidate,
    ])),
    [candidates],
  );

  // 카탈로그는 30분마다 새 객체를 만들어 내므로, 선택 내용만 문자열로 비교해
  // 변하지 않은 메타데이터가 5초 REST 루프나 WebSocket을 재시작하지 못하게 합니다.
  const requestedSelectionContent = markets.map((rawMarket, index) => {
    const market = normalizeUpbitMarket(rawMarket);
    const timeframe = timeframes[index] ?? "1m";
    return `${market}:${timeframe}`;
  }).join("|");
  const requestedSelections = useMemo(() => {
    const seen = new Set<string>();
    return requestedSelectionContent.split("|").flatMap((encoded): ChartSelection[] => {
      const [market, timeframeValue] = encoded.split(":");
      if (!isUpbitChartTimeframe(timeframeValue)) return [];
      const key = seriesKey(market, timeframeValue);
      if (!market || !isUpbitKrwMarket(market) || seen.has(key)) return [];
      seen.add(key);
      return [{ market, timeframe: timeframeValue, key }];
    });
  }, [requestedSelectionContent]);

  /**
   * 하나의 연결에서 ticker와 봉 주기별 candle 타입을 함께 구독합니다. 일·주·월봉은
   * 업비트가 캔들 스트림을 제공하지 않으므로 ticker 체결가로만 갱신됩니다.
   */
  const subscriptionPayload = useMemo(() => {
    if (requestedSelections.length === 0) return "";
    const codes = [...new Set(requestedSelections.map(({ market }) => market))].sort();
    const byStreamType = new Map<string, Set<string>>();
    for (const { market, timeframe } of requestedSelections) {
      const streamType = upbitCandleStreamType(timeframe);
      if (!streamType) continue;
      const group = byStreamType.get(streamType) ?? new Set<string>();
      group.add(market);
      byStreamType.set(streamType, group);
    }
    return JSON.stringify([
      { ticket: "upbit-flow-multi-chart" },
      { type: "ticker", codes },
      ...[...byStreamType.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, group]) => ({ type, codes: [...group].sort() })),
      { format: "DEFAULT" },
    ]);
  }, [requestedSelections]);

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
          const aligned = rawSeries
            .map((item, index) =>
              normalizeSeries(item, requestedSelections[index]?.timeframe ?? "1m")
            )
            .filter((series) => isUpbitKrwMarket(series.market));
          const alignedByKey = new Map(
            aligned.map((series) => [seriesKey(series.market, series.timeframe), series]),
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
        let notice = "";
        let observedAt = new Date().toISOString();
        const trySameOrigin = Date.now() >= fullApiRetryAtRef.current;
        try {
          if (!trySameOrigin) throw new Error("same-origin API 재시도 대기 중");
          const response = await fetchWithTimeout("/api/upbit/charts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              markets: requestedSelections.map((selection) => selection.market),
              timeframes: requestedSelections.map((selection) => selection.timeframe),
            }),
            cache: "no-store",
          }, controller.signal, "업비트 REST 캔들 동기화");
          const root = record(await response.json().catch(() => ({})));
          notice = text(root, "notice") || text(root, "error");
          if (!response.ok || root.complete === false) {
            throw new Error(notice || `업비트 REST 캔들 동기화 실패 (${response.status})`);
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
            const directSeries = await loadPublicUpbitChartSeries(
              requestedSelections.map(({ market, timeframe }) => ({ market, timeframe })),
              controller.signal,
            );
            alignedSeries = alignAndValidate(directSeries, "");
            notice = "서버 API 지연 · 브라우저 업비트 공개 REST로 복구됨";
            observedAt = new Date().toISOString();
          } catch (publicError) {
            const apiDetail = apiError instanceof Error
              ? apiError.message
              : "same-origin API 오류";
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
            const key = seriesKey(series.market, series.timeframe);
            const existing = current[key];
            next[key] = {
              ...series,
              price: laterPrice(existing?.price, series.price),
              candles: mergeCandles(series.candles, existing?.candles ?? []),
            };
          }
          return next;
        });
        setFullNotice(notice);
        setLastFullAt(observedAt);
        setFullError("");
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setFullError(liveDelayMessage(
          error instanceof Error ? error.message : "업비트 REST 차트를 불러오지 못했습니다.",
        ));
      } finally {
        running = false;
      }
    };

    void loadFull();
    const interval = window.setInterval(() => void loadFull(), REST_REFRESH_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [paused, requestedSelections, retryRevision]);

  useEffect(() => {
    if (paused || !subscriptionPayload) return undefined;

    const selectedMarkets = new Set(requestedSelections.map(({ market }) => market));
    const streamTypeToKeys = new Map<string, Set<string>>();
    for (const { market, timeframe, key } of requestedSelections) {
      const streamType = upbitCandleStreamType(timeframe);
      if (!streamType) continue;
      const group = streamTypeToKeys.get(`${streamType}:${market}`) ?? new Set<string>();
      group.add(key);
      streamTypeToKeys.set(`${streamType}:${market}`, group);
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let pingTimer: number | undefined;
    let reconnectAttempt = 0;
    let disposed = false;
    let suspended = document.hidden;
    const decoder = new TextDecoder();

    const stopPing = () => {
      if (pingTimer !== undefined) {
        window.clearInterval(pingTimer);
        pingTimer = undefined;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || suspended || reconnectTimer !== undefined) return;
      const baseDelay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        1_000 * (2 ** Math.min(reconnectAttempt, 5)),
      );
      const delay = Math.max(500, Math.round(baseDelay * (0.75 + Math.random() * 0.5)));
      reconnectAttempt += 1;
      setSocketState("backoff");
      setStreamError(`업비트 WebSocket 재연결 대기 (${Math.ceil(delay / 1_000)}초)`);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const handleTicker = (frame: Record<string, unknown>) => {
      const market = normalizeUpbitMarket(frame.code);
      if (!selectedMarkets.has(market)) return;
      const lastPrice = numeric(frame, "trade_price");
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;
      const timestamp = isoTimestamp(frame.trade_timestamp ?? frame.timestamp) ||
        new Date().toISOString();
      setQuotes((current) => ({ ...current, [market]: { lastPrice, timestamp } }));
      setLastStreamAt(timestamp);
    };

    const handleCandle = (frame: Record<string, unknown>) => {
      const update = normalizeStreamCandle(frame);
      if (!update) return;
      const keys = streamTypeToKeys.get(`${update.streamType}:${update.market}`);
      if (!keys) return;
      setFullSeries((current) => {
        let next = current;
        for (const key of keys) {
          const existing = next[key];
          if (!existing) continue;
          if (next === current) next = { ...current };
          next[key] = {
            ...existing,
            price: { lastPrice: update.candle.closePrice, timestamp: update.timestamp },
            candles: mergeCandles(existing.candles, [update.candle]),
          };
        }
        return next;
      });
      setLastStreamAt(update.timestamp);
    };

    const connect = () => {
      if (disposed || suspended || document.hidden || typeof WebSocket !== "function") {
        return;
      }
      if (
        socket &&
        (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
      ) return;
      setSocketState("connecting");
      const connection = new WebSocket(UPBIT_STREAM_URL);
      // 업비트는 텍스트가 아닌 바이너리 프레임으로 내려 줍니다.
      connection.binaryType = "arraybuffer";
      socket = connection;

      connection.onopen = () => {
        if (disposed || socket !== connection) return;
        reconnectAttempt = 0;
        setSocketState("open");
        setStreamError("");
        connection.send(subscriptionPayload);
        stopPing();
        pingTimer = window.setInterval(() => {
          if (connection.readyState === WebSocket.OPEN) connection.send("PING");
        }, STREAM_PING_MS);
      };
      connection.onmessage = (event) => {
        if (disposed || socket !== connection) return;
        try {
          const raw = typeof event.data === "string"
            ? event.data
            : decoder.decode(event.data as ArrayBuffer);
          const frame = record(JSON.parse(raw));
          const type = text(frame, "type");
          if (type === "ticker") handleTicker(frame);
          else if (type.startsWith("candle.")) handleCandle(frame);
          // PING 응답(`{"status":"UP"}`)에는 type이 없어 그대로 무시됩니다.
        } catch {
          // 깨진 프레임 하나는 버립니다. 다음 업비트 갱신이 화면을 복구합니다.
        }
      };
      connection.onerror = () => {
        if (disposed || socket !== connection) return;
        setSocketState("error");
        setStreamError("업비트 WebSocket 오류 · REST 데이터 유지");
        connection.close();
      };
      connection.onclose = () => {
        const wasCurrent = socket === connection;
        if (wasCurrent) {
          socket = null;
          stopPing();
        }
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
        stopPing();
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
      stopPing();
      const connection = socket;
      socket = null;
      connection?.close(1000, "selection changed");
    };
  }, [paused, requestedSelections, subscriptionPayload]);

  const effectiveSocketState: SocketState = paused || requestedSelections.length === 0
    ? "idle"
    : socketState;
  const streamingDelayed = effectiveSocketState === "backoff" ||
    effectiveSocketState === "error";
  const liveDelayed = Boolean(fullError || streamingDelayed);
  const activeTimeframe = timeframes[activeIndex] ?? "1m";
  const uniformTimeframe = timeframes.length > 0 &&
      timeframes.every((timeframe) => timeframe === timeframes[0])
    ? timeframes[0]
    : null;
  const activeMarket = normalizeUpbitMarket(markets[activeIndex] || "");
  const activeLabel = activeMarket ? `${upbitBaseAsset(activeMarket)}/KRW` : "빈 슬롯";
  const activeSeries = activeMarket
    ? fullSeries[seriesKey(activeMarket, activeTimeframe)]
    : undefined;
  const activeQuoteTimestamp = activeMarket
    ? quotes[activeMarket]?.timestamp || activeSeries?.price.timestamp
    : undefined;
  const activeCandleTime = formatCandleTime(
    projectedCandleOpen(activeSeries, activeTimeframe, activeQuoteTimestamp),
  );
  const activeCandleLabel = !activeMarket
    ? "현재 캔들 · 종목 선택 필요"
    : !activeCandleTime
      ? "현재 캔들 · 동기화 중"
      : paused || liveDelayed
        ? `마지막 캔들 · ${activeCandleTime}`
        : activeCandleTime;
  const isCurrentCandleTime = Boolean(
    activeMarket && activeCandleTime && !paused && !liveDelayed,
  );

  const syncingCount = requestedSelections.filter((selection) => {
    const series = fullSeries[selection.key];
    return series?.timeframe !== selection.timeframe || !series.candles.length;
  }).length;
  const syncStateDetail = paused
    ? "탭 비활성 · 업비트 스트림 중지"
    : fullError
      ? "업비트 연결 지연 · 마지막 정상 데이터 유지"
      : streamingDelayed
        ? "WebSocket 재연결 중 · REST 데이터 유지"
        : effectiveSocketState === "connecting"
          ? "업비트 스트림 연결 중"
          : syncingCount > 0
            ? `${syncingCount}개 슬롯 REST 캔들 동기화 중`
            : effectiveSocketState === "open"
              ? ""
              : "업비트 실시간 연결 준비";
  const syncErrorDetail = fullError || streamError || fullNotice;
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
        <h2 id="multi-chart-title" className={styles.srOnly}>업비트 KRW 12분할 차트</h2>
        <div
          className={styles.syncState}
          data-paused={paused || undefined}
          data-delayed={liveDelayed || undefined}
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
            <legend className={styles.srOnly}>12개 차트 봉 주기 일괄 변경</legend>
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
                  aria-label={`${option.label}을 12개 차트에 일괄 적용`}
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
                  if (isUpbitChartTimeframe(timeframe)) onChangeActiveTimeframe(timeframe);
                }}
              >
                {TIMEFRAME_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </header>

      <div className={styles.mobileTabs} role="tablist" aria-label="차트 슬롯 선택">
        {markets.map((rawMarket, index) => {
          const market = normalizeUpbitMarket(rawMarket);
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
              {market ? `${upbitBaseAsset(market)}/KRW` : "비어 있음"}
            </button>
          );
        })}
      </div>

      <div className={styles.chartGrid}>
        {markets.map((rawMarket, index) => {
          const market = normalizeUpbitMarket(rawMarket);
          const candidate = candidateMap.get(market);
          const active = activeIndex === index;
          const slotTimeframe = timeframes[index] ?? "1m";
          const key = seriesKey(market, slotTimeframe);
          const series = fullSeries[key];
          const quote = quotes[market]?.lastPrice ? quotes[market] : series?.price;
          const tickSize = series?.tickSize || candidateTickSize(candidate?.tickSize);
          const name = candidate?.name || series?.name || upbitBaseAsset(market);
          const candleLabel = TIMEFRAME_LABEL[slotTimeframe];
          const seriesReady = series?.timeframe === slotTimeframe;
          const listed = Boolean(market && isUpbitKrwMarket(market));

          if (!market) {
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
                  onClick={(event) => onRequestMarketChange(index, event.currentTarget)}
                >
                  <span>C{index + 1}</span>
                  <strong>빈 차트 슬롯</strong>
                  <small>눌러서 업비트 KRW 전체 종목을 검색하고 지정하세요.</small>
                </button>
              </article>
            );
          }

          return (
            <article
              key={`slot-${index}-${market}-${slotTimeframe}`}
              className={styles.slot}
              data-active={active}
              data-stale={liveDelayed || !listed || undefined}
            >
              <button
                id={`slot-symbol-trigger-${index}`}
                type="button"
                className={styles.symbolOverlay}
                aria-label={`C${index + 1} ${name} 종목 변경 창 열기`}
                aria-haspopup="dialog"
                title={`${name} · 종목 선택`}
                onClick={(event) => onRequestMarketChange(index, event.currentTarget)}
              >
                {name}
                {candidate?.warning ? " ⚠" : ""}
              </button>
              <button
                type="button"
                className={styles.chartBody}
                aria-label={`${name} ${candleLabel} 차트 선택${
                  quote?.lastPrice ? `, 현재 ${formatKrwPrice(quote.lastPrice, tickSize)}원` : ""
                }`}
                onClick={() => onSelectSlot(index)}
              >
                <CandlestickChart
                  market={market}
                  candles={seriesReady ? series.candles : []}
                  livePrice={quote?.lastPrice || series?.price.lastPrice}
                  liveTimestamp={quote?.timestamp || series?.price.timestamp}
                  timeframe={slotTimeframe}
                  tickSize={tickSize}
                  theme={theme}
                />
                {(!listed || !seriesReady || !series.candles.length || liveDelayed) && (
                  <span className={styles.loadingBadge} role="status">
                    {!listed
                      ? "업비트 KRW 마켓이 아닙니다"
                      : liveDelayed
                        ? `업비트 연결 지연 · 마지막 정상 ${formatTime(lastStreamAt || lastFullAt)}`
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
          C1·C2 기본 BTC·ETH · 사용자 지정 유지 · C3~C12 24H 거래대금 상위 10종목 1시간 자동 배열
        </span>
        <span>
          실시간 WebSocket candle · 5초 REST · 일·주·월봉은 체결가로 현재 봉 갱신
        </span>
      </footer>
    </section>
  );
}

export default MultiChartWorkspace;
