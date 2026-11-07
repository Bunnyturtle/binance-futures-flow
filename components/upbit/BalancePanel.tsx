"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatKrwCompact,
  formatKrwExact,
  formatKrwPrice,
  formatQuantity,
  formatSignedPercent,
} from "../../lib/format-krw";
import { isUpbitKrwMarket } from "../../lib/upbit-market";
import { record, numeric, text } from "../../lib/upbit-parse";
import styles from "./BalancePanel.module.css";

const BALANCE_REFRESH_MS = 15_000;
const BALANCE_TIMEOUT_MS = 10_000;

type Holding = {
  currency: string;
  market: string | null;
  name: string;
  balance: number;
  locked: number;
  total: number;
  avgBuyPrice: number;
  lastPrice: number;
  valuation: number;
  profit: number | null;
  profitRate: number | null;
};

type Summary = {
  krwBalance: number;
  krwLocked: number;
  holdingValuation: number;
  totalValuation: number;
  totalProfit: number | null;
  totalProfitRate: number | null;
};

type BalanceState =
  | { kind: "loading" }
  | { kind: "disabled"; notice: string }
  | { kind: "error"; notice: string }
  | { kind: "ready"; observedAt: string; summary: Summary; holdings: Holding[] };

export type BalancePanelProps = {
  active: boolean;
  onSelectHolding: (market: string, name: string) => void;
};

function normalizeHolding(value: unknown): Holding | null {
  const item = record(value);
  const currency = text(item, "currency").toUpperCase();
  const total = numeric(item, "total");
  if (!currency || !Number.isFinite(total) || total <= 0) return null;
  const rawMarket = text(item, "market");
  const profit = numeric(item, "profit");
  const profitRate = numeric(item, "profitRate");
  return {
    currency,
    market: isUpbitKrwMarket(rawMarket) ? rawMarket : null,
    name: text(item, "name", currency),
    balance: numeric(item, "balance") || 0,
    locked: numeric(item, "locked") || 0,
    total,
    avgBuyPrice: numeric(item, "avgBuyPrice") || 0,
    lastPrice: numeric(item, "lastPrice") || 0,
    valuation: numeric(item, "valuation") || 0,
    profit: Number.isFinite(profit) ? profit : null,
    profitRate: Number.isFinite(profitRate) ? profitRate : null,
  };
}

function normalizeSummary(value: unknown): Summary | null {
  const item = record(value);
  const totalValuation = numeric(item, "totalValuation");
  if (!Number.isFinite(totalValuation)) return null;
  const totalProfit = numeric(item, "totalProfit");
  const totalProfitRate = numeric(item, "totalProfitRate");
  return {
    krwBalance: numeric(item, "krwBalance") || 0,
    krwLocked: numeric(item, "krwLocked") || 0,
    holdingValuation: numeric(item, "holdingValuation") || 0,
    totalValuation,
    totalProfit: Number.isFinite(totalProfit) ? totalProfit : null,
    totalProfitRate: Number.isFinite(totalProfitRate) ? totalProfitRate : null,
  };
}

const KST_CLOCK = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function clockText(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : KST_CLOCK.format(parsed);
}

function tone(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value === 0) return styles.neutral;
  return value > 0 ? styles.positive : styles.negative;
}

export function BalancePanel({ active, onSelectHolding }: BalancePanelProps) {
  const [state, setState] = useState<BalanceState>({ kind: "loading" });
  const [errorNotice, setErrorNotice] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const lastReadyRef = useRef<Extract<BalanceState, { kind: "ready" }> | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    let disposed = false;
    let running = false;

    const load = async () => {
      if (running || document.hidden) return;
      running = true;
      setRefreshing(true);
      const timeout = window.setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
      try {
        const response = await fetch("/api/upbit/accounts", {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = record(await response.json().catch(() => ({})));
        if (disposed) return;
        if (payload.configured === false) {
          setState({
            kind: "disabled",
            notice: text(payload, "notice", "업비트 API 키가 설정되지 않았습니다."),
          });
          return;
        }
        if (!response.ok) {
          // 마지막 정상 잔고가 있으면 화면에 남겨 두고 헤더에만 지연을 표시합니다.
          const notice = text(payload, "notice") || text(payload, "error") ||
            `잔고 조회 실패 (${response.status})`;
          setErrorNotice(notice);
          if (!lastReadyRef.current) setState({ kind: "error", notice });
          return;
        }
        const summary = normalizeSummary(payload.summary);
        const holdings = (Array.isArray(payload.holdings) ? payload.holdings : [])
          .map(normalizeHolding)
          .filter((holding): holding is Holding => holding !== null);
        if (!summary) {
          setState({ kind: "error", notice: "잔고 응답 형식을 확인하지 못했습니다." });
          return;
        }
        const next: Extract<BalanceState, { kind: "ready" }> = {
          kind: "ready",
          observedAt: text(payload, "observedAt", new Date().toISOString()),
          summary,
          holdings,
        };
        lastReadyRef.current = next;
        setErrorNotice("");
        setState(next);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        const notice = error instanceof Error
          ? error.message
          : "잔고를 불러오지 못했습니다.";
        setErrorNotice(notice);
        if (!lastReadyRef.current) setState({ kind: "error", notice });
      } finally {
        window.clearTimeout(timeout);
        running = false;
        if (!disposed) setRefreshing(false);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), BALANCE_REFRESH_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [active, retryRevision]);

  const retry = useCallback(() => {
    setErrorNotice("");
    setRetryRevision((revision) => revision + 1);
  }, []);

  const disabled = state.kind === "disabled";
  const ready = state.kind === "ready" ? state : null;
  const statusClass = disabled
    ? styles.stateOff
    : errorNotice
      ? styles.stateDelayed
      : "";
  const statusLabel = disabled
    ? "키 없음"
    : refreshing
      ? "조회 중"
      : errorNotice
        ? "연결 지연"
        : ready
          ? "정상"
          : "대기";

  return (
    <section className={styles.panel} aria-labelledby="balance-panel-title">
      <header className={styles.header}>
        <div>
          <div className={styles.kicker}>UPBIT · MY ACCOUNT</div>
          <h2 id="balance-panel-title">보유 자산</h2>
        </div>
        <div className={`${styles.state} ${statusClass}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>{statusLabel}</span>
          {ready && <small>{clockText(ready.observedAt)} KST</small>}
          {errorNotice && (
            <button type="button" onClick={retry} disabled={refreshing}>
              {refreshing ? "재시도 중…" : "다시 조회"}
            </button>
          )}
        </div>
      </header>

      {state.kind === "disabled" && (
        <div className={styles.notice} role="status">
          <span aria-hidden="true">i</span>
          <p>
            {state.notice} <code>.env.local</code>에 <code>UPBIT_ACCESS_KEY</code>와{" "}
            <code>UPBIT_SECRET_KEY</code>를 넣고 서버를 다시 시작하세요. 업비트는 키
            발급 시 등록한 허용 IP에서만 조회를 받아 줍니다.
          </p>
        </div>
      )}

      {!disabled && errorNotice && (
        <div className={styles.notice} role="alert">
          <span aria-hidden="true">!</span>
          <p>
            {errorNotice}
            {ready ? " 마지막 정상 잔고를 유지합니다." : ""}
          </p>
        </div>
      )}

      {ready && (
        <>
          <div className={styles.summary}>
            <div>
              <small>총 평가금액</small>
              <strong>{formatKrwExact(ready.summary.totalValuation)}원</strong>
              <em>{formatKrwCompact(ready.summary.totalValuation)}</em>
            </div>
            <div>
              <small>보유 원화</small>
              <strong>{formatKrwExact(ready.summary.krwBalance)}원</strong>
              <em>
                {ready.summary.krwLocked > 0
                  ? `주문 중 ${formatKrwExact(ready.summary.krwLocked)}원`
                  : "주문 중 없음"}
              </em>
            </div>
            <div>
              <small>코인 평가금액</small>
              <strong>{formatKrwExact(ready.summary.holdingValuation)}원</strong>
              <em>{ready.holdings.length}종목 보유</em>
            </div>
            <div>
              <small>평가손익</small>
              <strong className={tone(ready.summary.totalProfit)}>
                {ready.summary.totalProfit === null
                  ? "—"
                  : `${ready.summary.totalProfit > 0 ? "+" : ""}${
                    formatKrwExact(ready.summary.totalProfit)
                  }원`}
              </strong>
              <em className={tone(ready.summary.totalProfitRate)}>
                {ready.summary.totalProfitRate === null
                  ? "매수 평균가 없음"
                  : formatSignedPercent(ready.summary.totalProfitRate)}
              </em>
            </div>
          </div>

          {ready.holdings.length === 0
            ? (
              <div className={styles.empty}>
                <strong>보유 중인 코인이 없습니다</strong>
                <span>원화 잔고만 확인됩니다.</span>
              </div>
            )
            : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">종목</th>
                      <th scope="col">보유 수량</th>
                      <th scope="col">매수 평균가</th>
                      <th scope="col">현재가</th>
                      <th scope="col">평가금액</th>
                      <th scope="col">평가손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ready.holdings.map((holding) => (
                      <tr key={holding.currency}>
                        <td>
                          <button
                            type="button"
                            className={styles.assetCell}
                            disabled={!holding.market}
                            title={holding.market
                              ? `${holding.name} 차트에 연결`
                              : "업비트 KRW 마켓에 상장되지 않은 자산입니다."}
                            onClick={() => {
                              if (holding.market) {
                                onSelectHolding(holding.market, holding.name);
                              }
                            }}
                          >
                            <div>
                              <strong>{holding.name}</strong>
                              <small>
                                {holding.currency}
                                {holding.locked > 0
                                  ? ` · 주문 중 ${formatQuantity(holding.locked)}`
                                  : ""}
                              </small>
                            </div>
                          </button>
                        </td>
                        <td>{formatQuantity(holding.total)}</td>
                        <td>
                          {holding.avgBuyPrice > 0
                            ? formatKrwPrice(holding.avgBuyPrice)
                            : "—"}
                        </td>
                        <td>
                          {holding.lastPrice > 0 ? formatKrwPrice(holding.lastPrice) : "—"}
                        </td>
                        <td>
                          {holding.valuation > 0
                            ? formatKrwExact(holding.valuation)
                            : "—"}
                        </td>
                        <td className={tone(holding.profit)}>
                          {holding.profit === null
                            ? "—"
                            : `${formatKrwExact(holding.profit)} (${
                              formatSignedPercent(holding.profitRate ?? 0)
                            })`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </>
      )}

      <footer className={styles.footer}>
        <span>업비트 /v1/accounts · 15초 갱신 · 조회 전용(주문 기능 없음)</span>
        <span>평가손익은 업비트 매수 평균가 기준이며 수수료·세금은 반영하지 않습니다.</span>
      </footer>
    </section>
  );
}

export default BalancePanel;
