"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FlowFrame, { type FlowFrameProps } from "../shared/FlowFrame";
import { BASIS_EXCHANGES, type BasisSnapshot } from "../../lib/basis-gap";
import {
  collectBasisAlerts,
  DEFAULT_BASIS_ALERT_SETTINGS,
  describeBasisDirection,
  pruneBasisAlertMemory,
  type BasisAlertEvent,
  type BasisAlertMemory,
} from "../../lib/basis-alerts";
import styles from "./BasisScreen.module.css";

const POLL_MS = 10_000;
const SETTINGS_KEY = "crypto-flow-basis-settings-v1";
const MAX_ALERT_LOG = 30;
const COLLAPSED_ROWS = 40;
const AUTOPLAY_NOTICE = "브라우저가 아직 소리를 막고 있습니다. 화면을 한 번 클릭하거나 '알림 테스트'를 누르면 다음 알림부터 소리가 납니다.";

type Status = FlowFrameProps["status"];

interface Settings {
  thresholdPct: number;
  exchanges: string[];
  sound: boolean;
  /** 0~1 */
  volume: number;
  desktop: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  thresholdPct: DEFAULT_BASIS_ALERT_SETTINGS.thresholdPct,
  exchanges: [...BASIS_EXCHANGES],
  sound: true,
  volume: 0.3,
  desktop: false,
};

function readSettings(): Settings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    if (!stored || typeof stored !== "object") return DEFAULT_SETTINGS;
    const known = new Set<string>(BASIS_EXCHANGES);
    return {
      thresholdPct: typeof stored.thresholdPct === "number" && stored.thresholdPct > 0 ? stored.thresholdPct : DEFAULT_SETTINGS.thresholdPct,
      exchanges: Array.isArray(stored.exchanges) ? stored.exchanges.filter((name) => known.has(name)) : DEFAULT_SETTINGS.exchanges,
      sound: typeof stored.sound === "boolean" ? stored.sound : DEFAULT_SETTINGS.sound,
      volume: typeof stored.volume === "number" ? Math.min(1, Math.max(0, stored.volume)) : DEFAULT_SETTINGS.volume,
      desktop: typeof stored.desktop === "boolean" ? stored.desktop : DEFAULT_SETTINGS.desktop,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: Settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 저장하지 못해도 지금 화면에는 반영합니다.
  }
}

const px = (value: number) => String(Number(value.toPrecision(5)));
const pct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const pad = (value: number) => String(value).padStart(2, "0");
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

function compactUsdt(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export default function BasisScreen() {
  const [status, setStatus] = useState<Status>({ label: "WAITING", detail: "8개 거래소" });
  return (
    <FlowFrame
      section="basis"
      eyebrow="SPOT VS USDT PERPETUAL"
      title="BASIS GAP"
      subtitle="거래소별 현선갭"
      status={status}
    >
      <BasisWorkspace onStatus={setStatus} />
    </FlowFrame>
  );
}

function BasisWorkspace({ onStatus }: { onStatus: (status: Status) => void }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [snapshot, setSnapshot] = useState<BasisSnapshot | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<BasisAlertEvent[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  const memoryRef = useRef<BasisAlertMemory>({});
  const audioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSettings(readSettings()), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      writeSettings(next);
      return next;
    });
  }, []);

  /** 짧은 두 음. 소리 크기는 이 화면의 볼륨 설정만 따릅니다(윈도우 알림음과 무관). */
  const playChime = useCallback(async (volume: number) => {
    if (volume <= 0 || typeof window === "undefined" || !("AudioContext" in window)) return;
    // 브라우저는 사용자가 페이지를 한 번이라도 누르기 전에는 소리를 막습니다.
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (activation && !activation.hasBeenActive) {
      setNotice(AUTOPLAY_NOTICE);
      return;
    }
    const context = audioRef.current ?? new AudioContext();
    audioRef.current = context;
    if (context.state === "suspended") {
      // resume()이 끝나지 않고 기다리는 경우가 있어 잠깐만 기다립니다.
      await Promise.race([context.resume().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 300))]);
    }
    if (context.state !== "running") {
      setNotice(AUTOPLAY_NOTICE);
      return;
    }
    setNotice((current) => (current === AUTOPLAY_NOTICE ? null : current));
    const peak = 0.4 * volume;
    const start = context.currentTime + 0.01;
    [[880, 0], [1320, 0.16]].forEach(([frequency, offset]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(peak, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.14);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.16);
    });
  }, []);

  const showDesktopNotification = useCallback((events: BasisAlertEvent[]) => {
    if (!notificationsSupported() || Notification.permission !== "granted") return;
    const top = events.slice(0, 3)
      .map((event) => `${event.exchange} ${event.coin} ${pct(event.gapPct)} (${describeBasisDirection(event.gapPct)})`)
      .join("\n");
    try {
      // silent: 윈도우 기본 알림음 대신 이 화면의 소리(볼륨 조절 가능)만 냅니다.
      new Notification(`현선갭 알림 ${events.length}건`, { body: top, silent: true, tag: "crypto-flow-basis" });
    } catch {
      // 일부 환경은 페이지에서 직접 알림을 만들 수 없습니다.
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/basis", { cache: "no-store" });
      const body = (await response.json()) as BasisSnapshot & { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setSnapshot(body);
      setLastError(null);

      const current = settingsRef.current;
      const now = Date.now();
      const { events, memory } = collectBasisAlerts(
        body.rows,
        memoryRef.current,
        { ...DEFAULT_BASIS_ALERT_SETTINGS, thresholdPct: current.thresholdPct, exchanges: current.exchanges },
        now,
      );
      memoryRef.current = pruneBasisAlertMemory(memory, DEFAULT_BASIS_ALERT_SETTINGS.cooldownSec, now);
      if (events.length) {
        const sorted = [...events].sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
        setAlerts((previous) => [...sorted, ...previous].slice(0, MAX_ALERT_LOG));
        if (current.sound) void playChime(current.volume);
        if (current.desktop) showDesktopNotification(sorted);
      }

      const failed = body.exchanges.filter((exchange) => !exchange.ok).length;
      onStatus({
        label: failed ? "PARTIAL" : "LIVE",
        detail: `${body.exchanges.length - failed}/${body.exchanges.length} 거래소`,
        delayed: failed > 0,
      });
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
      onStatus({ label: "DELAYED", detail: "다시 조회 중", delayed: true });
    }
  }, [onStatus, playChime, showDesktopNotification]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const run = async () => {
      await poll();
      if (!cancelled) timer = window.setTimeout(run, POLL_MS);
    };
    timer = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [poll]);

  useEffect(() => () => {
    void audioRef.current?.close();
  }, []);

  const toggleExchange = (exchange: string) => {
    const enabled = new Set(settings.exchanges);
    if (enabled.has(exchange)) enabled.delete(exchange);
    else enabled.add(exchange);
    updateSettings({ exchanges: BASIS_EXCHANGES.filter((name) => enabled.has(name)) });
  };

  const toggleDesktop = async () => {
    if (settings.desktop) {
      updateSettings({ desktop: false });
      return;
    }
    if (!notificationsSupported()) {
      setNotice("이 브라우저는 데스크톱 알림을 지원하지 않습니다.");
      return;
    }
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission !== "granted") {
      setNotice("브라우저에서 알림 권한이 거부되어 있습니다. 주소창의 사이트 설정에서 알림을 허용하면 켤 수 있습니다.");
      return;
    }
    setNotice(null);
    updateSettings({ desktop: true });
  };

  const testAlert = async () => {
    setNotice(null);
    await playChime(settings.volume || 0.3);
    if (settings.desktop) {
      showDesktopNotification([{ key: "test", exchange: "TEST", coin: "BTC", gapPct: 3.21, spotPrice: 1, perpPrice: 1, at: Date.now() }]);
    }
  };

  const enabled = useMemo(() => new Set(settings.exchanges), [settings.exchanges]);
  const rows = useMemo(
    () => (snapshot?.rows ?? []).filter((row) => enabled.has(row.exchange)),
    [snapshot, enabled],
  );
  const visibleRows = showAll ? rows : rows.slice(0, COLLAPSED_ROWS);
  const overThreshold = rows.filter((row) => Math.abs(row.gapPct) >= settings.thresholdPct).length;
  const statusByExchange = new Map(snapshot?.exchanges.map((exchange) => [exchange.exchange, exchange]) ?? []);

  return (
    <div className={styles.workspace}>
      <section className={styles.settingsPanel} aria-label="현선갭 알림 설정">
        <div className={styles.formula}>
          <span className={styles.kicker}>SPOT − PERP</span>
          <h2>현선갭 감시 <small>· 같은 거래소의 USDT 현물과 무기한 선물</small></h2>
          <p>(현물 − 선물) ÷ 선물 × 100 · 10초마다 갱신 · 거래대금이 작은 종목(현물 10만·선물 100만 USDT 미만)과 |갭| 50% 초과는 제외</p>
        </div>

        <div className={styles.controlGrid}>
          <label className={styles.field}>
            <span>알림 기준 |갭|</span>
            <div className={styles.inputUnit}>
              <input
                type="number"
                min={0.5}
                max={50}
                step={0.5}
                value={settings.thresholdPct}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0) updateSettings({ thresholdPct: value });
                }}
              />
              <em>%</em>
            </div>
          </label>

          <div className={styles.field}>
            <span>알림 소리</span>
            <div className={styles.soundRow}>
              <button
                type="button"
                className={styles.toggle}
                aria-pressed={settings.sound}
                onClick={() => updateSettings({ sound: !settings.sound })}
              >
                {settings.sound ? "켜짐" : "꺼짐"}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(settings.volume * 100)}
                disabled={!settings.sound}
                aria-label="알림 소리 크기"
                onChange={(event) => updateSettings({ volume: Number(event.target.value) / 100 })}
              />
              <b>{Math.round(settings.volume * 100)}%</b>
            </div>
          </div>

          <div className={styles.field}>
            <span>윈도우 알림 (무음)</span>
            <div className={styles.soundRow}>
              <button type="button" className={styles.toggle} aria-pressed={settings.desktop} onClick={() => void toggleDesktop()}>
                {settings.desktop ? "켜짐" : "꺼짐"}
              </button>
              <button type="button" className={styles.ghostButton} onClick={() => void testAlert()}>
                알림 테스트
              </button>
            </div>
          </div>
        </div>

        <div className={styles.exchangeRow} role="group" aria-label="감시할 거래소">
          {BASIS_EXCHANGES.map((exchange) => {
            const state = statusByExchange.get(exchange);
            return (
              <button
                key={exchange}
                type="button"
                className={styles.exchangeChip}
                aria-pressed={enabled.has(exchange)}
                data-failed={state && !state.ok ? true : undefined}
                title={state?.error ?? ""}
                onClick={() => toggleExchange(exchange)}
              >
                <strong>{exchange}</strong>
                <small>{!state ? "…" : state.ok ? `${state.monitored}종목` : "조회 실패"}</small>
              </button>
            );
          })}
        </div>
        {notice && <p className={styles.notice} role="status">{notice}</p>}
      </section>

      <div className={styles.mainGrid}>
        <section className={styles.tablePanel} aria-label="현선갭 상위 종목">
          <header className={styles.panelHeader}>
            <div>
              <span className={styles.kicker}>RANKED BY |GAP|</span>
              <h3>현선갭 상위 종목</h3>
            </div>
            <p>
              {snapshot
                ? `기준 이상 ${overThreshold}개 · 표시 ${visibleRows.length}/${rows.length}개 · 갱신 ${clock(new Date(snapshot.updated * 1000))}`
                : lastError ? `조회 실패: ${lastError}` : "불러오는 중…"}
              {snapshot && lastError ? ` · 최근 조회 실패: ${lastError}` : ""}
            </p>
          </header>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>거래소</th>
                  <th>코인</th>
                  <th>현선갭</th>
                  <th>방향</th>
                  <th>현물</th>
                  <th>선물</th>
                  <th>현물 24h</th>
                  <th>선물 24h</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => {
                  const hot = Math.abs(row.gapPct) >= settings.thresholdPct;
                  return (
                    <tr key={`${row.exchange}:${row.coin}:${row.multiplier}`} data-hot={hot || undefined}>
                      <td>{index + 1}</td>
                      <td>{row.exchange}</td>
                      <td>
                        {row.coin}
                        {row.multiplier > 1 && <small className={styles.multiplier}>선물 ×{row.multiplier.toLocaleString("en-US")}</small>}
                      </td>
                      <td data-sign={row.gapPct > 0 ? "up" : "down"}><b>{pct(row.gapPct)}</b></td>
                      <td className={styles.direction}>{describeBasisDirection(row.gapPct)}</td>
                      <td>{px(row.spotPrice)}</td>
                      <td>{px(row.perpPrice)}</td>
                      <td>{compactUsdt(row.spotVolumeUsdt)}</td>
                      <td>{compactUsdt(row.perpVolumeUsdt)}</td>
                    </tr>
                  );
                })}
                {snapshot && !visibleRows.length && (
                  <tr>
                    <td colSpan={9} className={styles.empty}>선택한 거래소에 표시할 종목이 없습니다.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {rows.length > COLLAPSED_ROWS && (
            <button type="button" className={styles.moreButton} onClick={() => setShowAll((value) => !value)}>
              {showAll ? `상위 ${COLLAPSED_ROWS}개만 보기` : `전체 ${rows.length}개 보기`}
            </button>
          )}
        </section>

        <aside className={styles.alertPanel} aria-label="최근 알림">
          <header className={styles.panelHeader}>
            <div>
              <span className={styles.kicker}>ALERT LOG</span>
              <h3>최근 알림</h3>
            </div>
            {alerts.length > 0 && (
              <button type="button" className={styles.ghostButton} onClick={() => setAlerts([])}>지우기</button>
            )}
          </header>
          {alerts.length ? (
            <ol className={styles.alertList}>
              {alerts.map((event) => (
                <li key={`${event.key}:${event.at}`}>
                  <time>{clock(new Date(event.at))}</time>
                  <span>{event.exchange} <strong>{event.coin}</strong></span>
                  <b data-sign={event.gapPct > 0 ? "up" : "down"}>{pct(event.gapPct)}</b>
                  <small>{describeBasisDirection(event.gapPct)} · 현물 {px(event.spotPrice)} / 선물 {px(event.perpPrice)}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.alertEmpty}>
              |갭|이 {settings.thresholdPct}% 이상이면 여기에 쌓입니다. 같은 거래소·코인은 10분 동안 다시 알리지 않고,
              그 사이 2%p 더 벌어지면 다시 알립니다.
            </p>
          )}
          <p className={styles.alertHint}>
            이 화면이 열려 있을 때만 알립니다. 창을 닫아도 받으려면 <code>tools/gap-watch/gap_alert.py</code>를 실행하세요.
          </p>
        </aside>
      </div>

      <p className={styles.disclaimer}>
        거래소 공개 시세로 계산한 참고용 지표입니다. 주문 기능이 없고 투자 조언이 아닙니다.
      </p>
    </div>
  );
}
