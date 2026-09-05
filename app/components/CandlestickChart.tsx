"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import styles from "./CandlestickChart.module.css";

export type ChartCandle = {
  timestamp: string;
  openTime?: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume: number;
};

export type ChartTimeframe =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "1h"
  | "4h"
  | "1d"
  | "1w"
  | "1M";

type CandlestickChartProps = {
  symbol: string;
  candles: ChartCandle[];
  livePrice?: number;
  liveTimestamp?: string;
  timeframe: ChartTimeframe;
  tickSize: number;
  theme: "dark" | "light";
};

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

function nextCandleBoundary(openTime: number, timeframe: ChartTimeframe) {
  if (timeframe === "1M") {
    const openDate = new Date(openTime);
    return Date.UTC(openDate.getUTCFullYear(), openDate.getUTCMonth() + 1, 1);
  }
  return openTime + FIXED_TIMEFRAME_DURATION[timeframe];
}

function activeCandleOpen(
  priorOpenTime: number,
  quoteTime: number,
  timeframe: ChartTimeframe,
) {
  if (timeframe === "1M") {
    const quoteDate = new Date(quoteTime);
    return Date.UTC(quoteDate.getUTCFullYear(), quoteDate.getUTCMonth(), 1);
  }
  const duration = FIXED_TIMEFRAME_DURATION[timeframe];
  return priorOpenTime + Math.floor((quoteTime - priorOpenTime) / duration) * duration;
}

function color(canvas: HTMLCanvasElement, variable: string, fallback: string) {
  return getComputedStyle(canvas).getPropertyValue(variable).trim() || fallback;
}

function tickSizeDecimals(tickSize: number, price: number) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    if (price >= 1_000) return 2;
    if (price >= 1) return 4;
    return 6;
  }
  const [coefficient, exponentValue] = tickSize.toString().toLowerCase().split("e");
  const coefficientDecimals = coefficient.split(".")[1]?.length ?? 0;
  const exponent = exponentValue ? Number(exponentValue) : 0;
  return Math.min(12, Math.max(0, coefficientDecimals - exponent));
}

function compactPrice(value: number, tickSize: number) {
  const decimals = tickSizeDecimals(tickSize, value);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function candleOpenTime(candle: ChartCandle) {
  return typeof candle.openTime === "number" && Number.isFinite(candle.openTime)
    ? candle.openTime
    : Date.parse(candle.timestamp);
}

function orderedCandles(candles: ChartCandle[]) {
  const unique = new Map<number, ChartCandle>();
  for (const candle of candles) {
    const openTime = candleOpenTime(candle);
    if (!Number.isFinite(openTime) || candle.closePrice <= 0) continue;
    unique.set(openTime, { ...candle, openTime });
  }
  return [...unique.values()]
    .sort((left, right) => candleOpenTime(left) - candleOpenTime(right))
    .slice(-84);
}

export function CandlestickChart({
  symbol,
  candles,
  livePrice,
  liveTimestamp,
  timeframe,
  tickSize,
  theme,
}: CandlestickChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const displayCandles = useMemo(() => {
    const next = orderedCandles(candles).map((candle) => ({ ...candle }));
    let last = next.at(-1);
    if (last && livePrice && Number.isFinite(livePrice) && livePrice > 0) {
      const quoteTime = Date.parse(liveTimestamp ?? "");
      const candleTime = candleOpenTime(last);
      if (
        Number.isFinite(quoteTime) &&
        Number.isFinite(candleTime) &&
        quoteTime >= nextCandleBoundary(candleTime, timeframe)
      ) {
        const priorClose = last.closePrice;
        const openTime = activeCandleOpen(candleTime, quoteTime, timeframe);
        last = {
          timestamp: new Date(openTime).toISOString(),
          openTime,
          openPrice: priorClose,
          highPrice: Math.max(priorClose, livePrice),
          lowPrice: Math.min(priorClose, livePrice),
          closePrice: livePrice,
          volume: 0,
          quoteVolume: 0,
        };
        next.push(last);
      }
      // The ticker moves only the active candle price fields. Binance kline
      // frames remain authoritative for base volume and USDT quote volume.
      last.closePrice = livePrice;
      last.highPrice = Math.max(last.highPrice, livePrice);
      last.lowPrice = Math.min(last.lowPrice, livePrice);
    }
    return next.slice(-84);
  }, [candles, livePrice, liveTimestamp, timeframe]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(180, Math.floor(bounds.width));
      const height = Math.max(118, Math.floor(bounds.height));
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const grid = color(canvas, "--line-soft", "rgba(135, 146, 165, 0.12)");
      const muted = color(canvas, "--muted-2", "#647083");
      const positive = color(canvas, "--positive", "#dd3c44");
      const negative = color(canvas, "--negative", "#1375ec");
      const accent = color(canvas, "--accent", "#47d7d2");

      const chartTop = 8;
      const rightInset = 48;
      const plotWidth = Math.max(80, width - rightInset - 7);
      const chartBottom = height - 15;
      const chartHeight = Math.max(46, chartBottom - chartTop);

      context.strokeStyle = grid;
      context.lineWidth = 1;
      for (let index = 0; index <= 3; index += 1) {
        const y = chartTop + (chartHeight * index) / 3;
        context.beginPath();
        context.moveTo(7, Math.round(y) + 0.5);
        context.lineTo(7 + plotWidth, Math.round(y) + 0.5);
        context.stroke();
      }
      if (!displayCandles.length) {
        context.fillStyle = muted;
        context.font = "10px ui-monospace, monospace";
        context.textAlign = "center";
        context.fillText("Binance 캔들 동기화 대기", width / 2, height / 2);
        return;
      }

      const lows = displayCandles.map((candle) => candle.lowPrice).filter((value) => value > 0);
      const highs = displayCandles.map((candle) => candle.highPrice).filter((value) => value > 0);
      let minimum = Math.min(...lows);
      let maximum = Math.max(...highs);
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return;
      if (minimum === maximum) {
        const padding = Math.max(minimum * 0.003, tickSize || Number.EPSILON);
        minimum -= padding;
        maximum += padding;
      } else {
        const padding = (maximum - minimum) * 0.06;
        minimum -= padding;
        maximum += padding;
      }

      const step = plotWidth / displayCandles.length;
      const candleWidth = Math.max(1, Math.min(7, step * 0.62));
      const yForPrice = (value: number) =>
        chartTop + ((maximum - value) / (maximum - minimum)) * chartHeight;

      displayCandles.forEach((candle, index) => {
        const x = 7 + step * index + step / 2;
        const rising = candle.closePrice >= candle.openPrice;
        const candleColor = rising ? positive : negative;
        const highY = yForPrice(candle.highPrice);
        const lowY = yForPrice(candle.lowPrice);
        const openY = yForPrice(candle.openPrice);
        const closeY = yForPrice(candle.closePrice);

        context.strokeStyle = candleColor;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(Math.round(x) + 0.5, highY);
        context.lineTo(Math.round(x) + 0.5, lowY);
        context.stroke();

        context.fillStyle = candleColor;
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(1.2, Math.abs(closeY - openY));
        context.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);

      });

      const currentPrice = livePrice && livePrice > 0
        ? livePrice
        : displayCandles.at(-1)?.closePrice ?? 0;
      if (currentPrice > 0) {
        const currentY = Math.max(chartTop, Math.min(chartBottom, yForPrice(currentPrice)));
        context.save();
        context.setLineDash([3, 3]);
        context.strokeStyle = accent;
        context.globalAlpha = 0.78;
        context.beginPath();
        context.moveTo(7, currentY + 0.5);
        context.lineTo(7 + plotWidth, currentY + 0.5);
        context.stroke();
        context.restore();

        context.fillStyle = accent;
        context.font = "700 8px ui-monospace, monospace";
        context.textAlign = "left";
        context.textBaseline = "middle";
        context.fillText(compactPrice(currentPrice, tickSize), 7 + plotWidth + 4, currentY);
      }

      context.fillStyle = muted;
      context.font = "7px ui-monospace, monospace";
      context.textBaseline = "alphabetic";
      context.textAlign = "left";
      const firstTime = new Date(candleOpenTime(displayCandles.at(0)!));
      const lastTime = new Date(candleOpenTime(displayCandles.at(-1)!));
      const timeLabel = (date: Date) => {
        if (Number.isNaN(date.getTime())) return "--:--";
        if (timeframe === "1M") {
          return date.toLocaleDateString("ko-KR", { year: "2-digit", month: "2-digit" });
        }
        if (timeframe === "1d" || timeframe === "1w") {
          return date.toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" });
        }
        if (timeframe.endsWith("h")) {
          const day = date.toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" });
          const hour = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
          return `${day} ${hour}`;
        }
        return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
      };
      context.fillText(timeLabel(firstTime), 7, height - 3);
      context.textAlign = "right";
      context.fillText(timeLabel(lastTime), 7 + plotWidth, height - 3);
    };

    draw();
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(draw)
      : null;
    observer?.observe(canvas);
    window.addEventListener("resize", draw);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [displayCandles, livePrice, symbol, theme, tickSize, timeframe]);

  const latest = livePrice || displayCandles.at(-1)?.closePrice || 0;
  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      role="img"
      aria-label={`${symbol} ${TIMEFRAME_LABEL[timeframe]} 캔들 차트${latest ? `, 현재 ${compactPrice(latest, tickSize)} USDT` : ""}`}
    >
      {symbol} {TIMEFRAME_LABEL[timeframe]} 캔들 차트
    </canvas>
  );
}

export default memo(CandlestickChart);
