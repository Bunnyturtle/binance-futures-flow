"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BINANCE_RADAR_RESULT_LIMIT,
  type BinanceRadarCandidate,
  type BinanceRadarResult,
} from "../../lib/binance-radar";
import { loadPublicFuturesRadar } from "./BinancePublicClient";
import styles from "./AttentionRadar.module.css";

const RADAR_REFRESH_MS = 15 * 60_000;
const RADAR_REQUEST_TIMEOUT_MS = 12_000;

type RadarSource = "api" | "public";
type RadarStatus = "loading" | "live" | "recovered" | "delayed";

export type AttentionRadarProps = {
  active: boolean;
  onSelectCandidate: (item: BinanceRadarCandidate) => void;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `요청 시간이 ${RADAR_REQUEST_TIMEOUT_MS / 1_000}초를 넘었습니다.`;
  }
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : fallback;
}

function responseMessage(payload: unknown, fallback: string): string {
  const root = record(payload);
  for (const key of ["notice", "error", "message"]) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function isRadarCandidate(value: unknown): value is BinanceRadarCandidate {
  const item = record(value);
  const rank = item.rank;
  const lastPrice = item.lastPrice;
  const quoteVolume24h = item.quoteVolume24h;
  const finiteNumericFields = [
    "rank",
    "lastPrice",
    "changeRate",
    "quoteVolume24h",
    "weekAverageQuoteVolume",
    "monthAverageQuoteVolume",
    "weekVsMonthRatio",
    "dayChangePercent",
    "sizeScore",
    "weekScore",
    "dayScore",
    "score",
  ].every((key) => typeof item[key] === "number" && Number.isFinite(item[key]));
  return typeof item.symbol === "string" &&
    /^[A-Z0-9_]{5,30}$/.test(item.symbol) &&
    item.symbol.endsWith("USDT") &&
    typeof item.name === "string" &&
    typeof item.baseAsset === "string" &&
    (item.segment === "crypto" || item.segment === "tradfi") &&
    typeof item.tickSize === "string" &&
    typeof item.evaluatedAt === "string" &&
    typeof rank === "number" &&
    Number.isInteger(rank) &&
    rank > 0 &&
    typeof lastPrice === "number" &&
    lastPrice > 0 &&
    typeof quoteVolume24h === "number" &&
    quoteVolume24h >= 0 &&
    typeof item.provisional === "boolean" &&
    typeof item.weekMetricReady === "boolean" &&
    typeof item.dayMetricReady === "boolean" &&
    finiteNumericFields;
}

function isRadarResult(value: unknown): value is BinanceRadarResult {
  const root = record(value);
  const coverage = record(root.coverage);
  return typeof root.computedAt === "string" &&
    (typeof root.historyAsOf === "string" || root.historyAsOf === null) &&
    Array.isArray(root.items) &&
    root.items.length >= 1 &&
    root.items.length <= BINANCE_RADAR_RESULT_LIMIT &&
    root.items.every(isRadarCandidate) &&
    ["eligible", "analyzed", "historyReady", "provisional", "failed"].every(
      (key) => typeof coverage[key] === "number" && Number.isFinite(coverage[key]),
    );
}

async function loadSameOriginRadar(signal: AbortSignal): Promise<BinanceRadarResult> {
  const response = await fetch("/api/radar", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(responseMessage(payload, `관심 레이더 요청 실패 (${response.status})`));
  }
  if (!isRadarResult(payload)) {
    throw new Error("관심 레이더 응답 형식을 확인하지 못했습니다.");
  }
  return payload;
}

async function withLinkedTimeout<T>(
  parentSignal: AbortSignal,
  loader: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException("Radar request timed out", "AbortError")),
    RADAR_REQUEST_TIMEOUT_MS,
  );
  try {
    return await loader(controller.signal);
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function compactUsdt(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  return `${new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value)} USDT`;
}

function priceText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const maximumFractionDigits = value >= 1_000
    ? 2
    : value >= 1
      ? 4
      : 8;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

function signedPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function ratioText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  return `${value.toFixed(2)}×`;
}

const KST_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function timeText(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : KST_FORMATTER.format(parsed);
}

function scoreTone(score: number): string {
  if (score >= 72) return styles.scoreHot;
  if (score >= 48) return styles.scoreWatch;
  return styles.scoreBase;
}

function movementTone(value: number): string {
  if (value > 0) return styles.positive;
  if (value < 0) return styles.negative;
  return styles.neutral;
}

export function AttentionRadar({ active, onSelectCandidate }: AttentionRadarProps) {
  const resultRef = useRef<BinanceRadarResult | null>(null);
  const [result, setResult] = useState<BinanceRadarResult | null>(null);
  const [source, setSource] = useState<RadarSource | null>(null);
  const [status, setStatus] = useState<RadarStatus>("loading");
  const [notice, setNotice] = useState("");
  const [pageHidden, setPageHidden] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!active || pageHidden) return undefined;
    const controller = new AbortController();
    let disposed = false;
    let running = false;

    const refresh = async () => {
      if (running || document.hidden) return;
      running = true;
      if (!resultRef.current) setStatus("loading");

      let apiFailure = "";
      try {
        const next = await withLinkedTimeout(
          controller.signal,
          loadSameOriginRadar,
        );
        if (disposed || controller.signal.aborted) return;
        resultRef.current = next;
        setResult(next);
        setSource("api");
        setStatus("live");
        setNotice("");
        setSelectedSymbol((current) =>
          current && next.items.some((item) => item.symbol === current) ? current : "",
        );
        running = false;
        return;
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        apiFailure = errorMessage(error, "Sites 레이더 연결이 지연되고 있습니다.");
      }

      try {
        const next = await withLinkedTimeout(
          controller.signal,
          (signal) => loadPublicFuturesRadar(signal),
        );
        if (disposed || controller.signal.aborted) return;
        if (!isRadarResult(next)) {
          throw new Error("브라우저 공개 REST 레이더 응답 형식을 확인하지 못했습니다.");
        }
        resultRef.current = next;
        setResult(next);
        setSource("public");
        setStatus("recovered");
        setNotice(`${apiFailure} 브라우저 공개 REST로 자동 복구했습니다.`);
        setSelectedSymbol((current) =>
          current && next.items.some((item) => item.symbol === current) ? current : "",
        );
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        const publicFailure = errorMessage(error, "브라우저 공개 REST 연결도 지연되고 있습니다.");
        setStatus("delayed");
        setNotice(`${apiFailure} ${publicFailure} 마지막 정상 레이더를 유지합니다.`);
      } finally {
        running = false;
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), RADAR_REFRESH_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [active, pageHidden, retryRevision]);

  const retry = useCallback(() => {
    setRetryRevision((current) => current + 1);
  }, []);

  const selectCandidate = useCallback((item: BinanceRadarCandidate) => {
    setSelectedSymbol(item.symbol);
    onSelectCandidate(item);
  }, [onSelectCandidate]);

  const coverage = result?.coverage;
  const visibleStatus = !active || pageHidden ? "paused" : status;
  const statusLabel = visibleStatus === "paused"
    ? "일시정지"
    : status === "loading"
      ? "계산 중"
      : status === "recovered"
        ? "자동 복구"
        : status === "delayed"
          ? "연결 지연"
          : status === "live"
            ? "정상"
            : "대기";
  const statusClass = visibleStatus === "paused"
    ? styles.statePaused
    : status === "delayed"
      ? styles.stateDelayed
      : status === "recovered"
        ? styles.stateRecovered
        : styles.stateLive;

  return (
    <section className={styles.panel} aria-labelledby="attention-radar-title">
      <header className={styles.header}>
        <div>
          <div className={styles.kicker}>CRYPTO + TRADFI · TOP 40 USDT PERPETUAL</div>
          <h2 id="attention-radar-title">관심 종목 레이더</h2>
        </div>
        <div className={`${styles.state} ${statusClass}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>{statusLabel}</span>
          <small>15분 갱신</small>
        </div>
      </header>

      <div className={styles.metaBar} aria-label="레이더 데이터 상태">
        <span><small>소스</small><strong>{source === "public" ? "브라우저 공개 REST" : source === "api" ? "Sites API" : "연결 대기"}</strong></span>
        <span>
          <small>분석 범위</small>
          <strong>{coverage ? `상위 ${coverage.analyzed} / 전체 ${coverage.eligible}` : "—"}</strong>
        </span>
        <span>
          <small>커버리지</small>
          <strong>{coverage ? `이력 ${coverage.historyReady} · 실패 ${coverage.failed}` : "—"}</strong>
        </span>
        <span><small>갱신 시각</small><strong>{timeText(result?.computedAt)} KST</strong></span>
      </div>

      {notice && (
        <div className={styles.notice} role={status === "delayed" ? "alert" : "status"}>
          <span aria-hidden="true">!</span>
          <p>{notice}</p>
          <button type="button" onClick={retry} disabled={status === "loading"}>다시 연결</button>
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">순위</th>
              <th scope="col">종목 · 현재가</th>
              <th scope="col">24H 거래대금</th>
              <th scope="col">7D ÷ 30D</th>
              <th scope="col">전일대비 가격</th>
              <th scope="col">RADAR</th>
            </tr>
          </thead>
          <tbody>
            {status === "loading" && !result && Array.from({ length: BINANCE_RADAR_RESULT_LIMIT }, (_, index) => (
              <tr className={styles.skeletonRow} key={index} aria-hidden="true">
                <td><i /></td><td><i /></td><td><i /></td><td><i /></td><td><i /></td><td><i /></td>
              </tr>
            ))}

            {status === "delayed" && !result && (
              <tr>
                <td colSpan={6}>
                  <div className={styles.emptyState} role="status">
                    <span aria-hidden="true">!</span>
                    <strong>레이더 연결이 지연되고 있습니다</strong>
                    <p>Sites API와 브라우저 공개 REST를 다시 확인합니다.</p>
                    <button type="button" onClick={retry}>다시 연결</button>
                  </div>
                </td>
              </tr>
            )}

            {result && result.items.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className={styles.emptyState}>
                    <span aria-hidden="true">⌁</span>
                    <strong>표시할 관심 종목이 없습니다</strong>
                    <p>거래대금 이력이 확보되면 순위가 자동으로 나타납니다.</p>
                  </div>
                </td>
              </tr>
            )}

            {result?.items.map((item) => {
              const isSelected = selectedSymbol === item.symbol;
              return (
                <tr
                  key={item.symbol}
                  className={isSelected ? styles.selectedRow : undefined}
                >
                  <td><span className={styles.rank}>{String(item.rank).padStart(2, "0")}</span></td>
                  <td>
                    <button
                      type="button"
                      className={styles.symbolCell}
                      aria-pressed={isSelected}
                      aria-label={`${item.name || `${item.baseAsset}/USDT`} 차트에 연결. 관심 점수 ${item.score.toFixed(1)}점`}
                      onClick={() => selectCandidate(item)}
                    >
                      <span className={styles.avatar} aria-hidden="true">{item.baseAsset.slice(0, 1)}</span>
                      <div>
                        <strong>{item.name || `${item.baseAsset}/USDT`}</strong>
                        <small>{item.symbol} · {priceText(item.lastPrice)}</small>
                      </div>
                    </button>
                  </td>
                  <td>
                    <span className={styles.valueStack}>
                      <strong>{compactUsdt(item.quoteVolume24h)}</strong>
                      <small>규모 점수 {item.sizeScore.toFixed(1)}</small>
                    </span>
                  </td>
                  <td title={`7일 점수 ${item.weekScore.toFixed(1)} · 7일 평균 ${compactUsdt(item.weekAverageQuoteVolume)} · 30일 평균 ${compactUsdt(item.monthAverageQuoteVolume)}`}>
                    <span className={styles.valueStack}>
                      <strong className={item.weekMetricReady ? movementTone(item.weekVsMonthRatio - 1) : styles.neutral}>
                        {item.weekMetricReady ? ratioText(item.weekVsMonthRatio) : "—"}
                      </strong>
                      <small>7일 점수 {item.weekScore.toFixed(1)}</small>
                    </span>
                  </td>
                  <td title={`전일대비 점수 ${item.dayScore.toFixed(1)}`}>
                    <span className={styles.valueStack}>
                      <strong className={item.dayMetricReady ? movementTone(item.dayChangePercent) : styles.neutral}>
                        {item.dayMetricReady ? signedPercent(item.dayChangePercent) : "—"}
                      </strong>
                      <small>가격 변화</small>
                    </span>
                  </td>
                  <td>
                    <span className={`${styles.score} ${scoreTone(item.score)}`}>
                      <strong>{item.score.toFixed(1)}</strong>
                      <i style={{ "--radar-score": `${Math.max(0, Math.min(100, item.score))}%` } as CSSProperties} />
                      <small>{item.provisional ? "잠정 순위" : "관심 점수"}</small>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className={styles.footer}>
        <span>24H 거래대금 상위 40 내 · 규모 50% · 최근 7일/30일 30% · 전일대비 가격 20%</span>
        <span>
          {coverage ? `${result?.items.length ?? 0}개 후보 · 잠정 ${coverage.provisional}` : "USDT 무기한 선물 통합"}
          {result?.historyAsOf ? ` · 이력 ${timeText(result.historyAsOf)}` : ""}
        </span>
      </footer>
    </section>
  );
}

export default AttentionRadar;
