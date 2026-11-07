"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import SectionSwitcher, { type FlowSection } from "./SectionSwitcher";
import styles from "./FlowFrame.module.css";

export type FlowTheme = "dark" | "light";

/** 네 화면이 함께 쓰는 테마 저장 키. 바이낸스·업비트 화면도 같은 키를 씁니다. */
export const FLOW_THEME_KEY = "crypto-flow-theme";

const FlowThemeContext = createContext<FlowTheme>("dark");

export function useFlowTheme(): FlowTheme {
  return useContext(FlowThemeContext);
}

const clockFormat = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export interface FlowFrameProps {
  section: Exclude<FlowSection, "binance" | "upbit">;
  eyebrow: string;
  title: string;
  subtitle: string;
  /** 상단 상태 칩 문구. 예: LIVE, DELAYED */
  status: { label: string; detail?: string; delayed?: boolean };
  children: ReactNode;
}

/**
 * 김프·현선갭 화면의 바탕. 바이낸스·업비트 대시보드와 같은 상단 구성(로고, 화면 전환,
 * 테마 전환, 상태 칩, KST 시계)과 같은 색 변수를 씁니다.
 */
export default function FlowFrame({ section, eyebrow, title, subtitle, status, children }: FlowFrameProps) {
  const [theme, setTheme] = useState<FlowTheme>("dark");
  const [clock, setClock] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      let preferred: string | null = null;
      try {
        preferred = window.localStorage.getItem(FLOW_THEME_KEY);
      } catch {
        // 저장소를 못 쓰는 환경이면 시스템 설정을 따릅니다.
      }
      if (preferred === "light" || preferred === "dark") setTheme(preferred);
      else if (window.matchMedia("(prefers-color-scheme: light)").matches) setTheme("light");
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const tick = () => setClock(clockFormat.format(new Date()));
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  const switchTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(FLOW_THEME_KEY, next);
      } catch {
        // 저장하지 못해도 지금 화면에는 반영합니다.
      }
      return next;
    });
  }, []);

  return (
    <FlowThemeContext.Provider value={theme}>
      <main className={styles.shell} data-theme={theme} data-section={section}>
        <div className={styles.ambientOne} aria-hidden="true" />
        <div className={styles.ambientTwo} aria-hidden="true" />

        <header className={styles.topbar}>
          <div className={styles.brandBlock}>
            <div className={styles.brandMark} aria-hidden="true"><i /><i /><i /></div>
            <div>
              <div className={styles.eyebrow}>{eyebrow}</div>
              <h1>{title} <span>{subtitle}</span></h1>
            </div>
          </div>
          <div className={styles.headerControls}>
            <SectionSwitcher current={section} />
            <button type="button" className={styles.themeToggle} onClick={switchTheme}>
              <span className={styles.themeGlyph} aria-hidden="true">{theme === "dark" ? "☼" : "◐"}</span>
              <span className={styles.themeLabel}>{theme === "dark" ? "LIGHT" : "DARK"}</span>
            </button>
            <span className={styles.modeChip} data-delayed={status.delayed || undefined}>
              <i className={styles.statusDot} />
              {status.label}
              {status.detail && <span className={styles.feedKind}>{status.detail}</span>}
            </span>
            <div className={styles.clockBlock}>
              <span>KST</span>
              <strong>{clock ?? "--:--:--"}</strong>
            </div>
          </div>
        </header>

        <div className={styles.content}>{children}</div>
      </main>
    </FlowThemeContext.Provider>
  );
}
