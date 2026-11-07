"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  UPBIT_RADAR_RESULT_LIMIT,
  type UpbitRadarCandidate,
  type UpbitRadarResult,
} from "../../lib/upbit-radar";
import {
  formatKrwCompact,
  formatKrwPrice,
  formatRatio,
  formatSignedPercent,
} from "../../lib/format-krw";
import { isUpbitKrwMarket } from "../../lib/upbit-market";
import { loadPublicUpbitRadar } from "./UpbitPublicClient";
import styles from "./AttentionRadar.module.css";

const RADAR_REFRESH_MS = 15 * 60_000;
const RADAR_REQUEST_TIMEOUT_MS = 20_000;
// 429/418은 IP 단위 한도라 잠깐 쉬어야 풀립니다. 매 갱신마다 두들기지 않도록
// 한 번 걸리면 다음 자동 갱신은 서버 경로를 건너뜁니다. 수동 재시도는 즉시 확인합니다.
const RATE_LIMITED_STATUS = new Set([418, 429]);
const RATE_LIMIT_RECHECK_MS = 10 * 60_000;

type RadarSource = "api" | "public";
type RadarStatus = "loading" | "live" | "recovered" | "delayed";

export type AttentionRadarProps = {
  active: boolean;
  onSelectCandidate: (item: UpbitRadarCandidate) => void;
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

type RadarFetchError = Error & { status?: number };

function fetchFailure(message: string, status: number): RadarFetchError {
  const error: RadarFetchError = new Error(message);
  error.status = status;
  return error;
}

function failureStatus(error: unknown): number | undefined {
  return error instanceof Error ? (error as RadarFetchError).status : undefined;
}

function isRadarCandidate(value: unknown): value is UpbitRadarCandidate {
  const item = record(value);
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
  return isUpbitKrwMarket(item.market) &&
    typeof item.name === "string" &&
    typeof item.baseAsset === "string" &&
    typeof item.tickSize === "string" &&
    typeof item.evaluatedAt === "string" &&
    typeof item.rank === "number" &&
    Number.isInteger(item.rank) &&
    item.rank > 0 &&
    typeof item.lastPrice === "number" &&
    item.lastPrice > 0 &&
    typeof item.quoteVolume24h === "number" &&
    item.quoteVolume24h >= 0 &&
    typeof item.warning === "boolean" &&
    typeof item.provisional === "boolean" &&
    typeof item.weekMetricReady === "boolean" &&
    typeof item.dayMetricReady === "boolean" &&
    finiteNumericFields;
}

function isRadarResult(value: unknown): value is UpbitRadarResult {
  const root = record(value);
  const coverage = record(root.coverage);
  return typeof root.computedAt === "string" &&
    (typeof root.historyAsOf === "string" || root.historyAsOf === null) &&
    Array.isArray(root.items) &&
    root.items.length >= 1 &&
    root.items.length <= UPBIT_RADAR_RESULT_LIMIT &&
    root.items.every(isRadarCandidate) &&
    ["eligible", "analyzed", "historyReady", "provisional", "failed"].every(
      (key) => typeof coverage[key] === "number" && Number.isFinite(coverage[key]),
    );
}

async function loadSameOriginRadar(signal: AbortSignal): Promise<UpbitRadarResult> {
  const response = await fetch("/api/upbit/radar", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw fetchFailure(
      responseMessage(payload, `관심 레이더 요청 실패 (${response.status})`),
      response.status,
    );
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

const KST_CLOCK_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// 같은 실패는 같은 문장을 만들어 내므로 확인 시각을 붙입니다. 이게 없으면
// 다시 실패한 재시도와 반응 없는 버튼을 구별할 수 없습니다.
function withCheckStamp(message: string): string {
  return `${message} (${KST_CLOCK_FORMATTER.format(new Date())} KST 확인)`;
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
  const resultRef = useRef<UpbitRadarResult | null>(null);
  const [result, setResult] = useState<UpbitRadarResult | null>(null);
  const [source, setSource] = useState<RadarSource | null>(null);
  const [status, setStatus] = useState<RadarStatus>("loading");
  const [notice, setNotice] = useState("");
  const [pageHidden, setPageHidden] = useState(false);
  const [selectedMarket, setSelectedMarket] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const pendingRetryRef = useRef(0);
  const serverThrottledUntilRef = useRef(0);

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
    // 이 effect를 다시 돌린 클릭을 소비해, 뒤이어 오는 주기 갱신이 수동 재시도로
    // 오인되지 않게 합니다.
    const manualRetry = pendingRetryRef.current > 0;
    pendingRetryRef.current = 0;

    const refresh = async (manual: boolean) => {
      if (running || document.hidden) return;
      running = true;
      // 재시도는 마지막 정상 레이더를 화면에 남겨 두므로, 진행 중 상태만이
      // 버튼이 동작했다는 유일한 신호입니다.
      if (manual) setRetrying(true);
      if (!resultRef.current) setStatus("loading");

      let apiFailure = "";
      try {
        if (manual || serverThrottledUntilRef.current <= Date.now()) {
          try {
            const next = await withLinkedTimeout(controller.signal, loadSameOriginRadar);
            if (disposed || controller.signal.aborted) return;
            serverThrottledUntilRef.current = 0;
            resultRef.current = next;
            setResult(next);
            setSource("api");
            setStatus("live");
            setNotice("");
            setSelectedMarket((current) =>
              current && next.items.some((item) => item.market === current) ? current : ""
            );
            return;
          } catch (error) {
            if (disposed || controller.signal.aborted) return;
            const status = failureStatus(error);
            if (status !== undefined && RATE_LIMITED_STATUS.has(status)) {
              serverThrottledUntilRef.current = Date.now() + RATE_LIMIT_RECHECK_MS;
            }
            apiFailure = errorMessage(error, "서버 레이더 연결이 지연되고 있습니다.");
          }
        } else {
          apiFailure = "서버 레이더가 업비트 요청 수 제한에 걸려 잠시 건너뜁니다.";
        }

        try {
          const next = await withLinkedTimeout(
            controller.signal,
            (signal) => loadPublicUpbitRadar(signal),
          );
          if (disposed || controller.signal.aborted) return;
          if (!isRadarResult(next)) {
            throw new Error("브라우저 공개 REST 레이더 응답 형식을 확인하지 못했습니다.");
          }
          resultRef.current = next;
          setResult(next);
          setSource("public");
          setStatus("recovered");
          setNotice(withCheckStamp(`${apiFailure} 브라우저 공개 REST로 자동 복구했습니다.`));
          setSelectedMarket((current) =>
            current && next.items.some((item) => item.market === current) ? current : ""
          );
        } catch (error) {
          if (disposed || controller.signal.aborted) return;
          const publicFailure = errorMessage(
            error,
            "브라우저 공개 REST 연결도 지연되고 있습니다.",
          );
          setStatus("delayed");
          setNotice(
            withCheckStamp(`${apiFailure} ${publicFailure} 마지막 정상 레이더를 유지합니다.`),
          );
        }
      } finally {
        running = false;
        // 폐기된 실행은 교체된 재시도가 소유한 플래그를 건드리면 안 됩니다.
        if (!disposed) setRetrying(false);
      }
    };

    void refresh(manualRetry);
    const interval = window.setInterval(() => void refresh(false), RADAR_REFRESH_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [active, pageHidden, retryRevision]);

  const retry = useCallback(() => {
    pendingRetryRef.current += 1;
    setRetryRevision((current) => current + 1);
  }, []);

  const selectCandidate = useCallback((item: UpbitRadarCandidate) => {
    setSelectedMarket(item.market);
    onSelectCandidate(item);
  }, [onSelectCandidate]);

  const coverage = result?.coverage;
  const visibleStatus = !active || pageHidden ? "paused" : status;
  const statusLabel = visibleStatus === "paused"
    ? "일시정지"
    : retrying
      ? "재연결 중"
      : status === "loading"
        ? "계산 중"
        : status === "recovered"
          ? "자동 복구"
          : status === "delayed"
            ? "연결 지연"
            : "정상";
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
          <div className={styles.kicker}>UPBIT KRW · 거래대금 상위 40 분석</div>
          <h2 id="attention-radar-title">관심 종목 레이더</h2>
        </div>
        <div
          className={`${styles.state} ${statusClass}`}
          role="status"
          aria-live="polite"
          title={notice || undefined}
        >
          <i aria-hidden="true" />
          <span>{statusLabel}</span>
          <small>15분 갱신</small>
        </div>
      </header>

      <div className={styles.metaBar} aria-label="레이더 데이터 상태">
        <span>
          <small>소스</small>
          <strong>
            {source === "public"
              ? "브라우저 공개 REST"
              : source === "api"
                ? "서버 API"
                : "연결 대기"}
          </strong>
        </span>
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

      {/* 자동 복구는 실데이터이므로 상태 칩과 소스 행으로 충분합니다. 두 경로가
          모두 끊겨 마지막 값만 남은 경우에만 배너를 띄웁니다. */}
      {status === "delayed" && notice && (
        <div className={styles.notice} role="alert">
          <span aria-hidden="true">!</span>
          <p>{notice}</p>
          <button type="button" onClick={retry} disabled={retrying}>
            {retrying ? "재연결 중…" : "다시 연결"}
          </button>
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
            {status === "loading" && !result &&
              Array.from({ length: UPBIT_RADAR_RESULT_LIMIT }, (_, index) => (
                <tr className={styles.skeletonRow} key={index} aria-hidden="true">
                  <td><i /></td><td><i /></td><td><i /></td>
                  <td><i /></td><td><i /></td><td><i /></td>
                </tr>
              ))}

            {status === "delayed" && !result && (
              <tr>
                <td colSpan={6}>
                  <div className={styles.emptyState} role="status">
                    <span aria-hidden="true">!</span>
                    <strong>레이더 연결이 지연되고 있습니다</strong>
                    <p>서버 API와 브라우저 공개 REST를 다시 확인합니다.</p>
                    <button type="button" onClick={retry} disabled={retrying}>
                      {retrying ? "재연결 중…" : "다시 연결"}
                    </button>
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
              const isSelected = selectedMarket === item.market;
              const tickSize = Number(item.tickSize);
              return (
                <tr
                  key={item.market}
                  className={isSelected ? styles.selectedRow : undefined}
                >
                  <td><span className={styles.rank}>{String(item.rank).padStart(2, "0")}</span></td>
                  <td>
                    <button
                      type="button"
                      className={styles.symbolCell}
                      aria-pressed={isSelected}
                      aria-label={`${item.name} 차트에 연결. 관심 점수 ${item.score.toFixed(1)}점${
                        item.warning ? ", 투자유의 종목" : ""
                      }`}
                      onClick={() => selectCandidate(item)}
                    >
                      <span className={styles.avatar} aria-hidden="true">
                        {item.baseAsset.slice(0, 1)}
                      </span>
                      <div>
                        <strong>{item.name}{item.warning ? " ⚠" : ""}</strong>
                        <small>
                          {item.baseAsset}/KRW · {formatKrwPrice(item.lastPrice, tickSize)}
                        </small>
                      </div>
                    </button>
                  </td>
                  <td>
                    <span className={styles.valueStack}>
                      <strong>{formatKrwCompact(item.quoteVolume24h)}</strong>
                      <small>규모 점수 {item.sizeScore.toFixed(1)}</small>
                    </span>
                  </td>
                  <td
                    title={`7일 점수 ${item.weekScore.toFixed(1)} · 7일 평균 ${
                      formatKrwCompact(item.weekAverageQuoteVolume)
                    } · 30일 평균 ${formatKrwCompact(item.monthAverageQuoteVolume)}`}
                  >
                    <span className={styles.valueStack}>
                      <strong
                        className={item.weekMetricReady
                          ? movementTone(item.weekVsMonthRatio - 1)
                          : styles.neutral}
                      >
                        {item.weekMetricReady ? formatRatio(item.weekVsMonthRatio) : "—"}
                      </strong>
                      <small>7일 점수 {item.weekScore.toFixed(1)}</small>
                    </span>
                  </td>
                  <td title={`전일대비 점수 ${item.dayScore.toFixed(1)}`}>
                    <span className={styles.valueStack}>
                      <strong
                        className={item.dayMetricReady
                          ? movementTone(item.dayChangePercent)
                          : styles.neutral}
                      >
                        {item.dayMetricReady
                          ? formatSignedPercent(item.dayChangePercent, 1)
                          : "—"}
                      </strong>
                      <small>가격 변화</small>
                    </span>
                  </td>
                  <td>
                    <span className={`${styles.score} ${scoreTone(item.score)}`}>
                      <strong>{item.score.toFixed(1)}</strong>
                      <i
                        style={{
                          "--radar-score": `${Math.max(0, Math.min(100, item.score))}%`,
                        } as CSSProperties}
                      />
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
          {coverage
            ? `${result?.items.length ?? 0}개 후보 · 잠정 ${coverage.provisional}`
            : "업비트 KRW 현물 통합"}
          {result?.historyAsOf ? ` · 이력 ${result.historyAsOf}` : ""}
        </span>
      </footer>
    </section>
  );
}

export default AttentionRadar;
