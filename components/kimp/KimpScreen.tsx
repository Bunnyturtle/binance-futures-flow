"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createChart,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import FlowFrame, { useFlowTheme, type FlowFrameProps } from "../shared/FlowFrame";
import {
  SPOT_GAP_DAY_OPTIONS,
  SPOT_GAP_DEFAULTS,
  SPOT_GAP_INTERVALS,
  SPOT_GAP_VENUE_NAMES,
  type SpotGapData,
  type SpotGapLive,
} from "../../lib/spot-gap";
import styles from "./KimpScreen.module.css";

const REFRESH_MS = 60_000; // 봉 이력 전체 재조회 간격
const LIVE_MS = 2_000; // 현재가 조회 간격
const WAIT_RETRY_MS = 5_000; // 거래 개시 전 대기 중 재조회 간격
const HIDDEN_VENUES_KEY = "crypto-flow-kimp-hidden-venues";

type Status = FlowFrameProps["status"];
type QueryState = { coin: string; interval: string; days: string };
type Legend = { when: Date; price: number | null; gaps: Record<string, number | null> };
type LiveCell = { venuePrice: number; upbitPrice: number | null; gap: number; min: number; max: number };

const SPOT_GAP_DEFAULTS_STRINGS: QueryState = {
  coin: SPOT_GAP_DEFAULTS.coin,
  interval: String(SPOT_GAP_DEFAULTS.interval),
  days: String(SPOT_GAP_DEFAULTS.days),
};

const pct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const px = (value: number) => String(Number(value.toPrecision(5)));
const pad = (value: number) => String(value).padStart(2, "0");
const stamp = (date: Date) =>
  `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
const intervalLabel = (interval: number) => (interval === 60 ? "1시간봉" : `${interval}분봉`);

// 차트 라이브러리는 시각을 UTC로 그리므로, 보는 사람의 시간대로 밀어서 넣습니다.
const toLocal = (time: number) => (time - new Date(time * 1000).getTimezoneOffset() * 60) as UTCTimestamp;
const fromLocal = (time: number) => new Date((time + new Date().getTimezoneOffset() * 60) * 1000);

/** 시각이 겹치는 점이 있으면 차트가 오류를 내므로 오름차순인 점만 남깁니다. */
function points(rows: readonly (readonly [number, number])[]) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const [time, value] of rows) {
    const local = toLocal(time);
    if (!out.length || local > out[out.length - 1].time) out.push({ time: local, value });
  }
  return out;
}

function loadHidden(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_VENUES_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function saveHidden(hidden: Set<string>) {
  try {
    window.localStorage.setItem(HIDDEN_VENUES_KEY, JSON.stringify([...hidden]));
  } catch {
    // 저장소를 못 쓰는 환경이면 이번 화면에서만 유지합니다.
  }
}

export default function KimpScreen() {
  const [status, setStatus] = useState<Status>({ label: "WAITING", detail: "업비트 vs 해외 현물" });
  return (
    <FlowFrame
      section="kimp"
      eyebrow="UPBIT KRW · GLOBAL USDT SPOT"
      title="KIMCHI GAP"
      subtitle="김프 현물 갭"
      status={status}
    >
      <KimpWorkspace onStatus={setStatus} />
    </FlowFrame>
  );
}

function KimpWorkspace({ onStatus }: { onStatus: (status: Status) => void }) {
  const theme = useFlowTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const coinInputRef = useRef<HTMLInputElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const zeroSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const venueSeriesRef = useRef(new Map<string, ISeriesApi<"Line">>());
  const appliedRef = useRef<QueryState | null>(null);
  const liveRef = useRef<{ coin: string; interval: number; names: string[]; range: Record<string, [number, number]> } | null>(null);
  const latestRef = useRef<Legend | null>(null);
  const hoveringRef = useRef(false);
  const hasDataRef = useRef(false);
  const autoFitRef = useRef(false);
  const loadSeqRef = useRef(0);

  const [form, setForm] = useState<QueryState>({
    coin: SPOT_GAP_DEFAULTS.coin,
    interval: String(SPOT_GAP_DEFAULTS.interval),
    days: String(SPOT_GAP_DEFAULTS.days),
  });
  const [data, setData] = useState<SpotGapData | null>(null);
  const [waitingCoin, setWaitingCoin] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("불러오는 중…");
  const [loading, setLoading] = useState(false);
  const [legend, setLegend] = useState<Legend | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [liveCells, setLiveCells] = useState<Record<string, LiveCell>>({});

  const refit = useCallback(() => {
    const container = containerRef.current;
    if (autoFitRef.current && chartRef.current && container && container.clientWidth > 0) {
      chartRef.current.timeScale().fitContent();
    }
  }, []);

  const applyChartTheme = useCallback(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;
    const style = getComputedStyle(container);
    const css = (name: string) => style.getPropertyValue(name).trim();
    const crosshairLine = { color: css("--muted"), labelBackgroundColor: css("--muted-2") };
    chart.applyOptions({
      layout: {
        background: { color: css("--chart-bg") },
        textColor: css("--muted"),
        fontFamily: style.fontFamily,
        panes: { separatorColor: css("--line-strong") },
      },
      grid: {
        vertLines: { color: css("--line-soft"), style: LineStyle.Solid },
        horzLines: { color: css("--line-soft"), style: LineStyle.Solid },
      },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal, vertLine: crosshairLine, horzLine: crosshairLine },
    });
    priceSeriesRef.current?.applyOptions({ color: css("--text-secondary") });
    zeroSeriesRef.current?.applyOptions({ color: css("--line-strong") });
    SPOT_GAP_VENUE_NAMES.forEach((name, index) => {
      venueSeriesRef.current.get(name)?.applyOptions({ color: css(`--series-${index + 1}`) });
    });
  }, []);

  // 차트는 한 번만 만들고, 이후에는 데이터와 색만 바꿉니다.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initiallyHidden = loadHidden();
    const hiddenTimer = window.setTimeout(() => setHidden(initiallyHidden), 0);
    const quiet = { lineWidth: 2 as const, priceLineVisible: false, lastValueVisible: false };
    const pctFormat = { type: "custom" as const, minMove: 0.01, formatter: (value: number) => `${value.toFixed(2)}%` };

    const chart = createChart(container, { autoSize: true });
    const priceSeries = chart.addSeries(LineSeries, quiet, 0);
    // 갭 0% 기준선. 어떤 거래소를 꺼도 남아 있도록 별도 계열로 둡니다.
    const zeroSeries = chart.addSeries(LineSeries, { ...quiet, lineWidth: 1, crosshairMarkerVisible: false, priceFormat: pctFormat }, 1);
    const venueSeries = new Map<string, ISeriesApi<"Line">>();
    for (const name of SPOT_GAP_VENUE_NAMES) {
      venueSeries.set(name, chart.addSeries(LineSeries, { ...quiet, priceFormat: pctFormat, visible: !initiallyHidden.has(name) }, 1));
    }
    const [pricePane, gapPane] = chart.panes();
    pricePane?.setStretchFactor(1);
    gapPane?.setStretchFactor(2);

    chartRef.current = chart;
    priceSeriesRef.current = priceSeries;
    zeroSeriesRef.current = zeroSeries;
    venueSeriesRef.current = venueSeries;
    applyChartTheme();

    const onCrosshair = (param: MouseEventParams<Time>) => {
      hoveringRef.current = typeof param.time === "number" && param.seriesData.size > 0;
      if (!hoveringRef.current) {
        if (latestRef.current) setLegend(latestRef.current);
        return;
      }
      const priceValue = param.seriesData.get(priceSeries);
      const gaps: Record<string, number | null> = {};
      for (const [name, series] of venueSeries) {
        const value = param.seriesData.get(series);
        gaps[name] = value && "value" in value ? value.value : null;
      }
      setLegend({
        when: fromLocal(param.time as number),
        price: priceValue && "value" in priceValue ? priceValue.value : null,
        gaps,
      });
    };
    chart.subscribeCrosshairMove(onCrosshair);

    // 직접 확대하거나 끌어서 옮기기 전까지는 창 크기가 바뀌거나 새 봉이 들어와도 전체 기간을 보여 줍니다.
    const stopAutoFit = () => {
      autoFitRef.current = false;
    };
    container.addEventListener("wheel", stopAutoFit, { passive: true, capture: true });
    container.addEventListener("pointerdown", stopAutoFit, { passive: true, capture: true });
    const observer = new ResizeObserver(() => requestAnimationFrame(refit));
    observer.observe(container);

    return () => {
      window.clearTimeout(hiddenTimer);
      observer.disconnect();
      container.removeEventListener("wheel", stopAutoFit, { capture: true });
      container.removeEventListener("pointerdown", stopAutoFit, { capture: true });
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      zeroSeriesRef.current = null;
      venueSeriesRef.current = new Map();
    };
  }, [applyChartTheme, refit]);

  useEffect(() => {
    applyChartTheme();
  }, [theme, applyChartTheme]);

  const showData = useCallback((next: SpotGapData) => {
    const priceSeries = priceSeriesRef.current;
    const zeroSeries = zeroSeriesRef.current;
    if (!priceSeries || !zeroSeries || !next.price.length) return;
    const price = points(next.price.map(([time, usd]) => [time, usd] as const));
    const lastPrice = next.price[next.price.length - 1][1];
    // 코인마다 가격 자릿수가 다르므로 눈금 단위를 가격 크기에 맞춥니다.
    priceSeries.applyOptions({
      priceFormat: { type: "custom", minMove: 10 ** (Math.floor(Math.log10(lastPrice)) - 4), formatter: px },
    });
    priceSeries.setData(price);
    zeroSeries.setData(price.map((point) => ({ time: point.time, value: 0 })));
    const range: Record<string, [number, number]> = {};
    for (const venue of next.venues) {
      venueSeriesRef.current.get(venue.name)?.setData(points(venue.gap.map(([time, gap]) => [time, gap] as const)));
      if (venue.gap.length) {
        const gaps = venue.gap.map((row) => row[1]);
        range[venue.name] = [Math.min(...gaps), Math.max(...gaps)];
      }
    }
    const last = next.price[next.price.length - 1];
    latestRef.current = {
      when: new Date(last[0] * 1000),
      price: last[1],
      gaps: Object.fromEntries(next.venues.map((venue) => [
        venue.name,
        venue.gap.length ? venue.gap[venue.gap.length - 1][1] : null,
      ])),
    };
    if (!hoveringRef.current) setLegend(latestRef.current);
    liveRef.current = {
      coin: next.coin,
      interval: next.interval,
      names: next.venues.filter((venue) => venue.gap.length).map((venue) => venue.name),
      range,
    };
    setLiveCells({});
    setData(next);
  }, []);

  const load = useCallback(async (next?: QueryState) => {
    const seq = ++loadSeqRef.current;
    if (next) {
      setLoading(true);
      setStatusText("불러오는 중…");
    }
    try {
      const query = next ?? appliedRef.current;
      const params = new URLSearchParams(query ?? {});
      const response = await fetch(`/api/kimp/data?${params}`, { cache: "no-store" });
      const body = (await response.json()) as SpotGapData & { error?: string };
      if (seq !== loadSeqRef.current) return; // 그 사이 다른 조회를 시작했으면 버립니다.
      if (!response.ok) throw new Error(body.error || String(response.status));
      const first = !hasDataRef.current;
      showData(body);
      hasDataRef.current = true;
      setWaitingCoin(null);
      const applied = { coin: body.coin, interval: String(body.interval), days: String(body.period) };
      appliedRef.current = applied;
      setForm((current) => ({
        ...applied,
        coin: document.activeElement === coinInputRef.current ? current.coin : applied.coin,
      }));
      if (next) window.history.replaceState(window.history.state, "", `?${new URLSearchParams(applied)}`);
      if (first || next) {
        autoFitRef.current = true;
      }
      refit();
      document.title = `${body.coin} 김프 · 현물 갭 | CRYPTO FLOW`;
      setStatusText(`갱신 ${clock(new Date(body.updated * 1000))}`);
      onStatus({ label: "LIVE", detail: `${body.coin} · ${intervalLabel(body.interval)}` });
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      // 실패해도 이전 화면은 그대로 둡니다. 아직 차트가 없으면 열릴 때까지 계속 다시 조회하는 중입니다.
      setStatusText(`${hasDataRef.current ? "조회 실패" : "대기 중"}: ${message}`);
      onStatus(hasDataRef.current
        ? { label: "DELAYED", detail: "마지막 정상 차트 유지", delayed: true }
        : { label: "WAITING", detail: "다시 조회 중", delayed: true });
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [onStatus, refit, showData]);

  // 봉 이력은 REFRESH_MS마다 다시 받고, 그 사이에는 현재가만 받아 진행 중인 마지막 봉을 움직입니다.
  const tick = useCallback(async () => {
    const target = liveRef.current;
    const priceSeries = priceSeriesRef.current;
    const zeroSeries = zeroSeriesRef.current;
    if (!hasDataRef.current || !target || !target.names.length || !priceSeries || !zeroSeries) return;
    try {
      const params = new URLSearchParams({ coin: target.coin, venues: target.names.join(",") });
      const response = await fetch(`/api/kimp/live?${params}`, { cache: "no-store" });
      const now = (await response.json()) as SpotGapLive;
      if (!response.ok || target !== liveRef.current) return; // 그 사이 이력을 새로 받았으면 다음 차례에 반영합니다.
      const step = target.interval * 60;
      const time = toLocal(Math.floor(now.ts / step) * step);
      try {
        priceSeries.update({ time, value: now.upbit });
        zeroSeries.update({ time, value: 0 });
      } catch {
        return; // 마지막 봉보다 과거 시각이면 다음 이력 조회에 맡깁니다.
      }
      const gaps: Record<string, number | null> = {};
      const cells: Record<string, LiveCell> = {};
      for (const name of target.names) {
        const venuePrice = now.venues[name as keyof typeof now.venues];
        if (!venuePrice) continue;
        const gap = ((now.upbit - venuePrice) / venuePrice) * 100;
        gaps[name] = gap;
        try {
          venueSeriesRef.current.get(name)?.update({ time, value: gap });
        } catch {
          continue;
        }
        // 현재값이 종가 기준 최저·최고를 벗어나면 표에도 바로 반영합니다.
        const range = target.range[name];
        if (range) {
          range[0] = Math.min(range[0], gap);
          range[1] = Math.max(range[1], gap);
          cells[name] = { venuePrice, upbitPrice: now.upbit, gap, min: range[0], max: range[1] };
        }
      }
      latestRef.current = { when: new Date(now.ts * 1000), price: now.upbit, gaps };
      if (!hoveringRef.current) setLegend(latestRef.current);
      setLiveCells(cells);
      refit();
      setStatusText(`실시간 ${clock(new Date(now.ts * 1000))}`);
    } catch {
      // 한 번 실패해도 다음 차례에 다시 받습니다.
    }
  }, [refit]);

  useEffect(() => {
    // 주소에 코인이 들어 있으면 첫 조회가 끝나기 전에도 무엇을 기다리는지 보여 줍니다(상장 전 대기 화면).
    const params = new URLSearchParams(window.location.search);
    const initial: Partial<QueryState> = {};
    for (const key of ["coin", "interval", "days"] as const) {
      const value = params.get(key);
      if (value) initial[key] = key === "coin" ? value.toUpperCase() : value;
    }
    const timeout = window.setTimeout(() => {
      if (Object.keys(initial).length) {
        appliedRef.current = { ...SPOT_GAP_DEFAULTS_STRINGS, ...initial };
        setForm((current) => ({ ...current, ...initial }));
        if (initial.coin) setWaitingCoin(initial.coin);
      }
      void load();
    }, 0);
    const refresh = window.setInterval(() => void load(), REFRESH_MS);
    const live = window.setInterval(() => void tick(), LIVE_MS);
    // 아직 차트가 없으면(상장 전이거나 첫 체결 전) 더 자주 다시 조회해서 열리는 즉시 그립니다.
    const wait = window.setInterval(() => {
      if (!hasDataRef.current) void load();
    }, WAIT_RETRY_MS);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(refresh);
      window.clearInterval(live);
      window.clearInterval(wait);
    };
  }, [load, tick]);

  const apply = (override?: Partial<QueryState>) => {
    const next = { ...form, ...override };
    const coin = next.coin.trim().toUpperCase();
    if (!coin) return;
    void load({ ...next, coin });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply();
  };

  const toggleVenue = (name: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      venueSeriesRef.current.get(name)?.applyOptions({ visible: !next.has(name) });
      saveHidden(next);
      return next;
    });
  };

  const dayOptions = useMemo(() => {
    const values = new Set<number>(SPOT_GAP_DAY_OPTIONS);
    const current = Number(form.days);
    if (Number.isInteger(current) && current > 0) values.add(current);
    return [...values].sort((a, b) => a - b);
  }, [form.days]);

  const coinLabel = data?.coin ?? waitingCoin ?? form.coin;
  const venueRows = data?.venues ?? SPOT_GAP_VENUE_NAMES.map((name) => ({ name, symbol: "", gap: [], error: null }));

  return (
    <div className={styles.workspace}>
      <section className={styles.headPanel}>
        <div className={styles.headTitle}>
          <span className={styles.kicker}>UPBIT VS GLOBAL</span>
          <h2>{coinLabel} 현물 갭 <small>· 업비트 vs 해외</small></h2>
          <p>
            (업비트 환산가 − 해외 가격) ÷ 해외 가격 × 100
            {data ? ` · ${intervalLabel(data.interval)} 종가 · 최근 ${data.days}일` : ""}
          </p>
        </div>
        <form className={styles.controls} onSubmit={onSubmit}>
          <label>
            <span>코인</span>
            <input
              ref={coinInputRef}
              value={form.coin}
              onChange={(event) => setForm((current) => ({ ...current, coin: event.target.value.toUpperCase() }))}
              autoComplete="off"
              spellCheck={false}
              maxLength={15}
              aria-label="업비트 KRW 마켓 티커"
            />
          </label>
          <label>
            <span>봉</span>
            <select
              value={form.interval}
              onChange={(event) => {
                setForm((current) => ({ ...current, interval: event.target.value }));
                apply({ interval: event.target.value });
              }}
            >
              {SPOT_GAP_INTERVALS.map((interval) => (
                <option key={interval} value={interval}>{interval === 60 ? "1시간" : `${interval}분`}</option>
              ))}
            </select>
          </label>
          <label>
            <span>기간</span>
            <select
              value={form.days}
              onChange={(event) => {
                setForm((current) => ({ ...current, days: event.target.value }));
                apply({ days: event.target.value });
              }}
            >
              {dayOptions.map((days) => <option key={days} value={days}>{days}일</option>)}
            </select>
          </label>
          <button type="submit">적용</button>
          <span className={styles.status} role="status">{statusText}</span>
        </form>
      </section>

      <section className={styles.chartCard}>
        <div className={styles.legend}>
          <span className={styles.legendLabel}>가격</span>
          <span className={styles.legendItem}>
            <i className={styles.swatch} style={{ background: "var(--text-secondary)" }} />
            업비트 (USDT 환산)
            <b>{legend?.price == null ? "–" : px(legend.price)}</b>
          </span>
          <span className={styles.separator} aria-hidden="true" />
          <span className={styles.legendLabel}>갭</span>
          {venueRows.map((venue, index) => {
            const available = Boolean(data) && venue.gap.length > 0;
            const value = legend?.gaps[venue.name];
            return (
              <button
                key={venue.name}
                type="button"
                className={styles.legendItem}
                aria-pressed={!hidden.has(venue.name)}
                disabled={!available}
                title={available ? "" : (venue.error ?? "데이터 없음")}
                onClick={() => toggleVenue(venue.name)}
              >
                <i className={styles.swatch} style={{ background: `var(--series-${index + 1})` }} />
                {venue.name}
                <b>{value == null ? "–" : pct(value)}</b>
              </button>
            );
          })}
          <span className={styles.when}>{legend ? stamp(legend.when) : ""}</span>
        </div>
        <div ref={containerRef} className={styles.chart} data-loading={loading || undefined} />
      </section>

      <details className={styles.tableCard} open>
        <summary>표로 보기</summary>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>거래소</th>
                <th>심볼</th>
                <th>해외 가격</th>
                <th>업비트 환산가</th>
                <th>현재 갭</th>
                <th>기간 최저</th>
                <th>기간 최고</th>
              </tr>
            </thead>
            <tbody>
              {data && data.venues.map((venue, index) => {
                const swatch = <i className={styles.swatch} style={{ background: `var(--series-${index + 1})` }} />;
                if (!venue.gap.length) {
                  return (
                    <tr key={venue.name}>
                      <td>{swatch}{venue.name}</td>
                      <td>{venue.symbol}</td>
                      <td className={styles.note} colSpan={5}>{venue.error ?? "데이터 없음"}</td>
                    </tr>
                  );
                }
                const [time, gap, venuePrice] = venue.gap[venue.gap.length - 1];
                const upbit = data.price.find((row) => row[0] === time);
                const gaps = venue.gap.map((row) => row[1]);
                const live = liveCells[venue.name];
                const current = live?.gap ?? gap;
                return (
                  <tr key={venue.name}>
                    <td>{swatch}{venue.name}</td>
                    <td>{venue.symbol}</td>
                    <td>{px(live?.venuePrice ?? venuePrice)}</td>
                    <td>{live?.upbitPrice != null ? px(live.upbitPrice) : upbit ? px(upbit[1]) : "–"}</td>
                    <td data-sign={current > 0 ? "up" : current < 0 ? "down" : undefined}>{pct(current)}</td>
                    <td>{pct(live?.min ?? Math.min(...gaps))}</td>
                    <td>{pct(live?.max ?? Math.max(...gaps))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
      <p className={styles.disclaimer}>
        업비트와 해외 거래소의 공개 시세로 계산한 참고용 지표입니다. 주문 기능이 없고 투자 조언이 아닙니다.
      </p>
    </div>
  );
}
