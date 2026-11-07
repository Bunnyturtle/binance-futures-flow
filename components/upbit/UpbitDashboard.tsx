"use client";

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyTimeframeToActive,
  applyTimeframeToAll,
} from "../../lib/chart-timeframes";
import {
  WALL_DEFAULT_MARKETS,
  WALL_RANKING_VERSION,
  WALL_REFRESH_MS,
  WALL_SLOT_COUNT,
  WALL_USER_PINNED_SLOT_COUNT,
  sameMarketLayout,
  selectWallMarkets,
  wallRefreshDelay,
} from "../../lib/chart-wall-ranking";
import {
  formatKrwCompact,
  formatKrwPrice,
  formatSignedPercent,
} from "../../lib/format-krw";
import {
  UPBIT_CHART_TIMEFRAMES,
  isUpbitChartTimeframe,
  isUpbitKrwMarket,
  normalizeUpbitMarket,
  upbitBaseAsset,
} from "../../lib/upbit-market";
import { numeric, record, text } from "../../lib/upbit-parse";
import type { UpbitRadarCandidate } from "../../lib/upbit-radar";
import MultiChartWorkspace, {
  type MultiChartCandidate,
} from "./MultiChartWorkspace";
import type { ChartTimeframe } from "./CandlestickChart";
import { loadPublicUpbitCatalog } from "./UpbitPublicClient";
import AttentionRadar from "./AttentionRadar";
import BalancePanel from "./BalancePanel";
import styles from "./UpbitDashboard.module.css";
import SectionSwitcher from "../shared/SectionSwitcher";

const SLOT_COUNT = WALL_SLOT_COUNT;
const STORAGE_KEY = "upbit-flow-chart-wall-v1";
const DASHBOARD_STORAGE_LOCK_NAME = "upbit-flow-chart-wall-v1";
const AUTO_WALL_GUARD_KEY = "upbit-flow-auto-wall-ranked-at-v1";
const AUTO_WALL_LOCK_NAME = "upbit-flow-auto-wall-v1";
const THEME_KEY = "crypto-flow-theme";
const LEGACY_THEME_KEY = "upbit-flow-theme";
const SAME_ORIGIN_API_TIMEOUT_MS = 6_000;
const SAME_ORIGIN_API_BACKOFF_MS = 60_000;
const INVALID_CATALOG_RETRY_MS = 5_000;
const CATALOG_REFRESH_MS = 30 * 60_000;

const DASHBOARD_VIEWS = ["chart", "radar", "balance"] as const;
const VIEW_PARAM = "view";

type DashboardView = (typeof DASHBOARD_VIEWS)[number];

const VIEW_COPY: Record<DashboardView, { label: string; caption: string; aria: string }> = {
  chart: { label: "CHART", caption: "KRW 12분할", aria: "업비트 KRW 12분할 차트" },
  radar: { label: "RADAR", caption: "관심 종목", aria: "업비트 KRW 관심 종목 레이더" },
  balance: { label: "BALANCE", caption: "보유 자산", aria: "업비트 보유 자산" },
};

function isDashboardView(value: string | null): value is DashboardView {
  return value !== null && (DASHBOARD_VIEWS as readonly string[]).includes(value);
}

// 같은 오리진의 모든 창이 localStorage 하나를 공유하므로, 저장된 뷰로는 창마다
// 다른 탭을 유지할 수 없습니다. URL은 창에 속하므로 세션 복원 시 각 창이 마지막
// 뷰로 돌아옵니다.
function viewFromLocation(): DashboardView | null {
  const value = new URLSearchParams(window.location.search).get(VIEW_PARAM);
  return isDashboardView(value) ? value : null;
}

type Theme = "dark" | "light";

type UniverseItem = MultiChartCandidate & {
  baseAsset: string;
  rank: number;
  lastPrice: number;
  changeRate: number;
  quoteVolume: number;
  caution: boolean;
  rankingScore?: number;
  recommendationRank?: number;
};

type StoredLayout = {
  markets: string[];
  custom: boolean[];
  timeframes: ChartTimeframe[];
  activeIndex: number;
  updatedAt: number;
  autoRankedAt: number;
  autoRankingVersion: string;
};

type UniverseSource = "api" | "public";

const VALID_TIMEFRAMES = new Set<string>(UPBIT_CHART_TIMEFRAMES);

const LEGACY_TIMEFRAMES: Record<string, ChartTimeframe> = {
  "10m": "15m",
  "60m": "1h",
  "2h": "1h",
  "240m": "4h",
  "6h": "4h",
  "12h": "4h",
  "3d": "1d",
  "1mo": "1M",
  month: "1M",
};

function emptyMarkets() {
  return Array.from({ length: SLOT_COUNT }, () => "");
}

function emptyCustom() {
  return Array.from({ length: SLOT_COUNT }, () => false);
}

function defaultTimeframes() {
  return Array.from({ length: SLOT_COUNT }, () => "1m" as ChartTimeframe);
}

function defaultLayout(): StoredLayout {
  return {
    markets: emptyMarkets().map((market, index) =>
      WALL_DEFAULT_MARKETS[index] ?? market
    ),
    custom: emptyCustom(),
    timeframes: defaultTimeframes(),
    activeIndex: 0,
    updatedAt: 0,
    autoRankedAt: 0,
    autoRankingVersion: "",
  };
}

function normalizeStoredTimeframe(value: unknown): ChartTimeframe {
  if (typeof value !== "string") return "1m";
  const exact = value.trim();
  if (VALID_TIMEFRAMES.has(exact)) return exact as ChartTimeframe;
  return LEGACY_TIMEFRAMES[exact.toLowerCase()] ?? "1m";
}

function normalizeUniverseItem(value: unknown): UniverseItem | null {
  const item = record(value);
  const market = normalizeUpbitMarket(item.market);
  const lastPrice = numeric(item, "lastPrice");
  if (!isUpbitKrwMarket(market) || !Number.isFinite(lastPrice) || lastPrice <= 0) {
    return null;
  }
  const baseAsset = text(item, "baseAsset", upbitBaseAsset(market));
  const quoteVolume = numeric(item, "quoteVolume");
  const changeRate = numeric(item, "changeRate");
  const rankingScore = numeric(item, "rankingScore");
  const recommendationRank = numeric(item, "recommendationRank");
  const tickSize = text(item, "tickSize");
  return {
    market,
    name: text(item, "name", baseAsset),
    baseAsset,
    rank: Math.max(0, Math.trunc(numeric(item, "rank") || 0)),
    lastPrice,
    changeRate: Number.isFinite(changeRate) ? changeRate : 0,
    quoteVolume: Number.isFinite(quoteVolume) && quoteVolume > 0 ? quoteVolume : 0,
    priceTimestamp: text(item, "priceTimestamp") || undefined,
    tickSize: tickSize || undefined,
    warning: item.warning === true,
    caution: item.caution === true,
    rankingScore: Number.isFinite(rankingScore) ? rankingScore : undefined,
    recommendationRank: Number.isInteger(recommendationRank) && recommendationRank > 0
      ? recommendationRank
      : undefined,
  };
}

function normalizeUniverseItems(value: unknown): UniverseItem[] {
  const seen = new Set<string>();
  const items = (Array.isArray(value) ? value : [])
    .map(normalizeUniverseItem)
    .filter((item): item is UniverseItem => {
      if (!item || seen.has(item.market)) return false;
      seen.add(item.market);
      return true;
    })
    .sort((left, right) =>
      right.quoteVolume - left.quoteVolume || left.market.localeCompare(right.market)
    )
    .map((item, index) => ({ ...item, rank: index + 1 }));
  if (items.length === 0) {
    throw new Error("거래 가능한 업비트 KRW 마켓을 확인하지 못했습니다.");
  }
  return items;
}

class InvalidCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCatalogError";
  }
}

async function loadSameOriginCatalog(
  parentSignal: AbortSignal,
): Promise<{ items: UniverseItem[]; observedAt: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SAME_ORIGIN_API_TIMEOUT_MS);

  try {
    const response = await fetch("/api/upbit/chart-universe", {
      cache: "no-store",
      signal: controller.signal,
    });
    const root = record(await response.json().catch(() => ({})));
    if (!response.ok) {
      throw new Error(
        text(root, "error") || `업비트 종목 목록 조회 실패 (${response.status})`,
      );
    }
    let items: UniverseItem[];
    try {
      items = normalizeUniverseItems(root.items);
    } catch (error) {
      throw new InvalidCatalogError(
        error instanceof Error ? error.message : "응답 형식 오류",
      );
    }
    const recommendation = record(root.chartWallRecommendation);
    const weights = record(recommendation.weights);
    const validContract = root.schemaVersion === 1 &&
      text(recommendation, "sort") === "quoteVolume" &&
      numeric(weights, "quoteVolume") === 1 &&
      numeric(weights, "changeRate") === 0;
    if (!validContract) {
      throw new InvalidCatalogError("24H 거래대금 추천 계약이 올바르지 않습니다.");
    }
    if (selectWallMarkets(items, SLOT_COUNT, []).length !== SLOT_COUNT) {
      throw new InvalidCatalogError("24H 거래대금 추천 순위 1~12가 완전하지 않습니다.");
    }
    return {
      items,
      observedAt: text(root, "timestamp", new Date().toISOString()),
    };
  } catch (error) {
    if (timedOut && !parentSignal.aborted) {
      throw new Error(
        `same-origin API가 ${
          Math.round(SAME_ORIGIN_API_TIMEOUT_MS / 1_000)
        }초 안에 응답하지 않았습니다.`,
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function normalizeStoredLayout(
  value: unknown,
  expectedAutoRankingVersion = "",
): StoredLayout | null {
  const parsed = record(value);
  if (!Array.isArray(parsed.markets)) return null;
  const markets = parsed.markets
    .slice(0, SLOT_COUNT)
    .map((item) => typeof item === "string" ? normalizeUpbitMarket(item) : "");
  const custom = Array.isArray(parsed.custom)
    ? parsed.custom.slice(0, SLOT_COUNT).map(Boolean)
    : emptyCustom();
  const timeframes = Array.isArray(parsed.timeframes)
    ? parsed.timeframes.slice(0, SLOT_COUNT).map(normalizeStoredTimeframe)
    : defaultTimeframes();
  const updatedAt = Math.max(0, Math.trunc(numeric(parsed, "updatedAt") || 0));
  const storedAutoRankedAt = Math.max(0, Math.trunc(numeric(parsed, "autoRankedAt") || 0));
  const storedVersion = text(parsed, "autoRankingVersion");
  const versionMatches = !expectedAutoRankingVersion ||
    storedVersion === expectedAutoRankingVersion;
  const autoRankedAt = versionMatches && storedAutoRankedAt <= Date.now()
    ? storedAutoRankedAt
    : 0;
  return {
    markets: [...markets, ...emptyMarkets()].slice(0, SLOT_COUNT),
    custom: [...custom, ...emptyCustom()].slice(0, SLOT_COUNT),
    timeframes: [...timeframes, ...defaultTimeframes()].slice(0, SLOT_COUNT),
    activeIndex: Math.max(
      0,
      Math.min(SLOT_COUNT - 1, Math.trunc(numeric(parsed, "activeIndex") || 0)),
    ),
    updatedAt,
    autoRankedAt,
    autoRankingVersion: versionMatches ? storedVersion : "",
  };
}

function nextLayoutUpdatedAt(previous: StoredLayout) {
  return Math.max(Date.now(), previous.updatedAt + 1);
}

function parseStoredValue(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

type AutoWallGuard = { version: string; at: number; token: string };

function emptyAutoWallGuard(): AutoWallGuard {
  return { version: WALL_RANKING_VERSION, at: 0, token: "" };
}

function readAutoWallGuard(): AutoWallGuard {
  try {
    const raw = window.localStorage.getItem(AUTO_WALL_GUARD_KEY);
    if (!raw) return emptyAutoWallGuard();
    const value = record(JSON.parse(raw));
    const version = text(value, "version");
    const at = numeric(value, "at");
    const token = text(value, "token");
    return version === WALL_RANKING_VERSION &&
        Number.isFinite(at) && at >= 0 && at <= Date.now() && token
      ? { version, at, token }
      : emptyAutoWallGuard();
  } catch {
    return emptyAutoWallGuard();
  }
}

function writeAutoWallGuard(value: AutoWallGuard): boolean {
  try {
    window.localStorage.setItem(AUTO_WALL_GUARD_KEY, JSON.stringify(value));
    return true;
  } catch {
    // 브라우저 저장소를 못 쓰는 환경에서도 현재 세션은 그대로 동작합니다.
    return false;
  }
}

function guardToken(): string {
  return typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

async function withLock<T>(name: string, operation: () => T): Promise<T> {
  if (!navigator.locks) return operation();
  try {
    return await navigator.locks.request(name, operation);
  } catch {
    return operation();
  }
}

function readCurrentStoredLayout(): StoredLayout | null {
  const stored = record(parseStoredValue(STORAGE_KEY));
  return stored.layout ? normalizeStoredLayout(stored.layout, WALL_RANKING_VERSION) : null;
}

/** 수동 배치는 자동 재배열 시계를 지금으로 밀어, 다음 갱신까지 한 시간을 벌어 줍니다. */
async function markAutoWallGuard(): Promise<number> {
  return withLock(AUTO_WALL_LOCK_NAME, () => {
    const value = Math.max(Date.now(), readAutoWallGuard().at);
    writeAutoWallGuard({ version: WALL_RANKING_VERSION, at: value, token: guardToken() });
    return value;
  });
}

type AutoWallClaim = {
  at: number;
  token: string;
  previous: AutoWallGuard;
  persisted: boolean;
};

/** 여러 탭이 동시에 켜져 있어도 한 번만 재배열하도록 소유권을 선점합니다. */
async function claimAutoWallRefresh(
  knownAutoRankedAt: number,
): Promise<AutoWallClaim | null> {
  return withLock(AUTO_WALL_LOCK_NAME, () => {
    if (document.hidden) return null;
    const now = Date.now();
    const previous = readAutoWallGuard();
    const latest = Math.max(knownAutoRankedAt, previous.at);
    if (wallRefreshDelay(latest, now) > 0) return null;
    const token = guardToken();
    return {
      at: now,
      token,
      previous,
      persisted: writeAutoWallGuard({
        version: WALL_RANKING_VERSION,
        at: now,
        token,
      }),
    };
  });
}

async function releaseAutoWallClaim(claim: AutoWallClaim): Promise<void> {
  if (!claim.persisted) return;
  await withLock(AUTO_WALL_LOCK_NAME, () => {
    if (readAutoWallGuard().token === claim.token) writeAutoWallGuard(claim.previous);
  });
}

function readStoredDashboard(): StoredLayout {
  const layout = readCurrentStoredLayout() ?? defaultLayout();
  const guardAt = readAutoWallGuard().at;
  const autoRankedAt = Math.max(layout.autoRankedAt, guardAt);
  return {
    ...layout,
    autoRankedAt,
    autoRankingVersion: autoRankedAt > 0
      ? WALL_RANKING_VERSION
      : layout.autoRankingVersion,
  };
}

function formatClock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function UpbitDashboard() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [hidden, setHidden] = useState(false);
  const [activeView, setActiveView] = useState<DashboardView>("chart");
  const [layout, setLayout] = useState<StoredLayout>(defaultLayout);
  const [universe, setUniverse] = useState<UniverseItem[]>([]);
  const [universeError, setUniverseError] = useState("");
  const [universeSource, setUniverseSource] = useState<UniverseSource>("api");
  const [lastUniverseAt, setLastUniverseAt] = useState("");
  const [clock, setClock] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);
  const [autoRefreshRevision, setAutoRefreshRevision] = useState(0);
  const [pickerSlotIndex, setPickerSlotIndex] = useState<number | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const universeApiRetryAtRef = useRef(0);
  const autoRankedAtRef = useRef(0);
  const viewTabRefs = useRef<Record<DashboardView, HTMLButtonElement | null>>({
    chart: null,
    radar: null,
    balance: null,
  });
  const symbolDialogRef = useRef<HTMLDialogElement | null>(null);
  const symbolSearchRef = useRef<HTMLInputElement | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);

  const { markets, timeframes, activeIndex } = layout;

  const normalizedPickerQuery = pickerQuery.trim().toUpperCase();
  const pickerResults = useMemo(() => {
    if (!normalizedPickerQuery) return universe;
    // 한글명 검색을 위해 영숫자만 남기지 않고, 공백만 정리해 부분 일치로 봅니다.
    const query = normalizedPickerQuery.replace(/\s+/g, "");
    return universe.filter((item) =>
      item.market.replace("-", "").includes(query) ||
      item.baseAsset.toUpperCase().includes(query) ||
      item.name.toUpperCase().replace(/\s+/g, "").includes(query)
    );
  }, [normalizedPickerQuery, universe]);

  const autoWallMarkets = useMemo(
    () =>
      selectWallMarkets(
        universe,
        SLOT_COUNT,
        layout.markets.slice(0, WALL_USER_PINNED_SLOT_COUNT),
      ),
    [layout.markets, universe],
  );
  const autoWallSignature = autoWallMarkets.join(",");

  const finalizePickerClose = useCallback(() => {
    const targetSlot = pickerSlotIndex;
    setPickerSlotIndex(null);
    setPickerQuery("");
    setPickerActiveIndex(0);
    const trigger = pickerTriggerRef.current;
    pickerTriggerRef.current = null;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      else if (targetSlot !== null) {
        document.getElementById(`slot-symbol-trigger-${targetSlot}`)?.focus();
      }
    });
  }, [pickerSlotIndex]);

  const dismissSymbolPicker = useCallback(() => {
    const dialog = symbolDialogRef.current;
    if (dialog?.open) dialog.close();
    else finalizePickerClose();
  }, [finalizePickerClose]);

  const openSymbolPicker = useCallback((
    index: number,
    trigger?: HTMLButtonElement | null,
  ) => {
    const targetIndex = Math.max(0, Math.min(SLOT_COUNT - 1, index));
    pickerTriggerRef.current = trigger ?? null;
    setLayout((current) => {
      const previous = rebaseLatest(current);
      if (previous.activeIndex === targetIndex) return previous;
      return {
        ...previous,
        activeIndex: targetIndex,
        updatedAt: nextLayoutUpdatedAt(previous),
      };
    });
    setPickerQuery("");
    setPickerActiveIndex(0);
    setPickerSlotIndex(targetIndex);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const preferred = window.localStorage.getItem(THEME_KEY) ??
        window.localStorage.getItem(LEGACY_THEME_KEY);
      if (preferred === "light" || preferred === "dark") setTheme(preferred);
      else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
        setTheme("light");
      }
      setLayout(readStoredDashboard());
      setActiveView(viewFromLocation() ?? "chart");
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  // 선택한 뷰를 이 창의 URL에 남겨 새로고침·세션 복원 시 같은 탭으로 돌아오게
  // 합니다. replaceState라 뒤로 가기 이력은 그대로입니다.
  useEffect(() => {
    if (!hydrated) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(VIEW_PARAM) === activeView) return;
    url.searchParams.set(VIEW_PARAM, activeView);
    window.history.replaceState(window.history.state, "", url);
  }, [activeView, hydrated]);

  useEffect(() => {
    if (pickerSlotIndex === null) return;
    const dialog = symbolDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    window.requestAnimationFrame(() => symbolSearchRef.current?.focus());
  }, [pickerSlotIndex]);

  useEffect(() => {
    if (pickerSlotIndex === null) return;
    const activeOption = pickerResults[pickerActiveIndex];
    if (!activeOption) return;
    window.requestAnimationFrame(() => {
      document.getElementById(`symbol-option-${activeOption.market}`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, [pickerActiveIndex, pickerResults, pickerSlotIndex]);

  useEffect(() => {
    const update = () => {
      setHidden(document.hidden);
      setClock(new Date().toISOString());
    };
    update();
    document.addEventListener("visibilitychange", update);
    const interval = window.setInterval(() => setClock(new Date().toISOString()), 1_000);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    autoRankedAtRef.current = layout.autoRankedAt;
  }, [layout.autoRankedAt]);

  useEffect(() => {
    if (!hydrated || hidden || activeView !== "chart") return undefined;
    const controller = new AbortController();
    let disposed = false;
    let running = false;
    let fastRetryUsed = false;
    let pendingFastRetry = false;
    let fastRetryTimeout: number | undefined;

    const loadUniverse = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        let items: UniverseItem[];
        let observedAt = new Date().toISOString();
        let source: UniverseSource = "api";
        const trySameOrigin = Date.now() >= universeApiRetryAtRef.current;
        try {
          if (!trySameOrigin) throw new Error("same-origin API 재시도 대기 중");
          const sameOrigin = await loadSameOriginCatalog(controller.signal);
          items = sameOrigin.items;
          observedAt = sameOrigin.observedAt;
          universeApiRetryAtRef.current = 0;
        } catch (apiError) {
          if (controller.signal.aborted) throw apiError;
          if (trySameOrigin) {
            const invalid = apiError instanceof InvalidCatalogError;
            universeApiRetryAtRef.current = Date.now() +
              (invalid && !fastRetryUsed
                ? INVALID_CATALOG_RETRY_MS
                : SAME_ORIGIN_API_BACKOFF_MS);
            if (invalid && !fastRetryUsed) {
              fastRetryUsed = true;
              pendingFastRetry = true;
            }
          }
          try {
            const publicItems = normalizeUniverseItems(
              await loadPublicUpbitCatalog(controller.signal),
            );
            if (selectWallMarkets(publicItems, SLOT_COUNT, []).length !== SLOT_COUNT) {
              throw new Error("브라우저 공개 REST의 거래대금 추천 순위가 완전하지 않습니다.");
            }
            items = publicItems;
            observedAt = new Date().toISOString();
            source = "public";
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
        if (disposed || document.hidden) return;

        const preClaimLayout = readCurrentStoredLayout();
        const knownAutoRankedAt = Math.max(
          autoRankedAtRef.current,
          preClaimLayout?.autoRankedAt ?? 0,
        );
        const claim = await claimAutoWallRefresh(knownAutoRankedAt);
        if (disposed || document.hidden) {
          if (claim) await releaseAutoWallClaim(claim);
          return;
        }
        const latestStored = readCurrentStoredLayout();
        setUniverse(items);
        setUniverseError("");
        setUniverseSource(source);
        setLastUniverseAt(observedAt);
        setLayout((current) => {
          const previous = latestStored && latestStored.updatedAt > current.updatedAt
            ? { ...current, ...latestStored }
            : current;
          const nextAutoMarkets = selectWallMarkets(
            items,
            SLOT_COUNT,
            previous.markets.slice(0, WALL_USER_PINNED_SLOT_COUNT),
          );
          const applyAutoWall = nextAutoMarkets.length === SLOT_COUNT &&
            claim !== null &&
            (!claim.persisted || readAutoWallGuard().token === claim.token) &&
            wallRefreshDelay(previous.autoRankedAt, claim.at) === 0;
          if (!applyAutoWall) return previous;
          return {
            ...previous,
            markets: sameMarketLayout(previous.markets, nextAutoMarkets)
              ? previous.markets
              : nextAutoMarkets,
            custom: previous.custom.map((value, index) =>
              index < WALL_USER_PINNED_SLOT_COUNT ? value : false
            ),
            autoRankedAt: claim.at,
            autoRankingVersion: WALL_RANKING_VERSION,
            updatedAt: nextLayoutUpdatedAt(previous),
          };
        });
      } catch (error) {
        if (disposed || controller.signal.aborted || document.hidden) return;
        setUniverseError(
          error instanceof Error
            ? error.message
            : "업비트 종목 목록을 불러오지 못했습니다.",
        );
      } finally {
        running = false;
        if (
          pendingFastRetry && !disposed && !document.hidden &&
          fastRetryTimeout === undefined
        ) {
          pendingFastRetry = false;
          const delay = Math.max(0, universeApiRetryAtRef.current - Date.now());
          fastRetryTimeout = window.setTimeout(() => {
            fastRetryTimeout = undefined;
            void loadUniverse();
          }, delay + 50);
        }
      }
    };

    void loadUniverse();
    const interval = window.setInterval(() => void loadUniverse(), CATALOG_REFRESH_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
      if (fastRetryTimeout !== undefined) window.clearTimeout(fastRetryTimeout);
    };
  }, [activeView, autoRefreshRevision, hidden, hydrated, retryRevision]);

  useEffect(() => {
    if (
      !hydrated || hidden || activeView !== "chart" || universeError ||
      autoWallMarkets.length !== SLOT_COUNT
    ) return undefined;
    const delay = wallRefreshDelay(layout.autoRankedAt);
    const timeout = window.setTimeout(
      () => setAutoRefreshRevision((revision) => revision + 1),
      Math.min(delay, WALL_REFRESH_MS),
    );
    return () => window.clearTimeout(timeout);
  }, [
    activeView,
    autoWallMarkets.length,
    autoWallSignature,
    hidden,
    hydrated,
    layout.autoRankedAt,
    universeError,
  ]);

  useEffect(() => {
    if (!hydrated) return undefined;
    let cancelled = false;
    void withLock(DASHBOARD_STORAGE_LOCK_NAME, () => {
      if (cancelled) return;
      try {
        const stored = readCurrentStoredLayout();
        const winner = stored && stored.updatedAt > layout.updatedAt ? stored : layout;
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ version: 1, layout: winner }),
        );
        if (cancelled || winner === layout) return;
        setLayout((current) =>
          winner.updatedAt > current.updatedAt ? { ...current, ...winner } : current
        );
      } catch {
        // 기기 로컬 저장은 선택 사항입니다. 현재 세션은 그대로 동작합니다.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, layout]);

  useEffect(() => {
    if (!hydrated) return undefined;
    const mergeStoredLayout = (event: StorageEvent) => {
      if (
        event.key !== STORAGE_KEY || !event.newValue ||
        (event.storageArea && event.storageArea !== window.localStorage)
      ) return;
      try {
        const stored = record(JSON.parse(event.newValue));
        const remote = normalizeStoredLayout(stored.layout, WALL_RANKING_VERSION);
        if (!remote) return;
        setLayout((current) =>
          remote.updatedAt > current.updatedAt ? { ...current, ...remote } : current
        );
      } catch {
        // 다른/오래된 탭이 남긴 깨진 값은 무시합니다.
      }
    };
    window.addEventListener("storage", mergeStoredLayout);
    return () => window.removeEventListener("storage", mergeStoredLayout);
  }, [hydrated]);

  const candidates = useMemo<MultiChartCandidate[]>(
    () => universe.map((item) => ({
      market: item.market,
      name: item.name,
      lastPrice: item.lastPrice,
      changeRate: item.changeRate,
      priceTimestamp: item.priceTimestamp,
      tickSize: item.tickSize,
      warning: item.warning,
    })),
    [universe],
  );

  const assignMarketToSlot = useCallback(async (
    targetIndex: number,
    market: string,
    label: string,
  ) => {
    const manualAutoRankedAt = targetIndex >= WALL_USER_PINNED_SLOT_COUNT
      ? await markAutoWallGuard()
      : 0;
    const latestStored = readCurrentStoredLayout();
    setLayout((current) => {
      const previous = latestStored && latestStored.updatedAt > current.updatedAt
        ? { ...current, ...latestStored }
        : current;
      if (previous.markets[targetIndex] === market && previous.activeIndex === targetIndex) {
        if (!manualAutoRankedAt || previous.autoRankedAt === manualAutoRankedAt) {
          return previous;
        }
        return {
          ...previous,
          autoRankedAt: manualAutoRankedAt,
          autoRankingVersion: WALL_RANKING_VERSION,
          updatedAt: nextLayoutUpdatedAt(previous),
        };
      }
      return {
        ...previous,
        markets: previous.markets.map((value, index) =>
          index === targetIndex ? market : value
        ),
        custom: previous.custom.map((value, index) =>
          index === targetIndex ? market !== "" : value
        ),
        activeIndex: targetIndex,
        autoRankedAt: manualAutoRankedAt || previous.autoRankedAt,
        autoRankingVersion: manualAutoRankedAt
          ? WALL_RANKING_VERSION
          : previous.autoRankingVersion,
        updatedAt: nextLayoutUpdatedAt(previous),
      };
    });
    setAnnouncement(
      market ? `C${targetIndex + 1}을 ${label}로 변경했습니다.` : `C${targetIndex + 1} 종목을 비웠습니다.`,
    );
  }, []);

  const assignPickerSlot = useCallback(async (item: UniverseItem) => {
    if (pickerSlotIndex === null) return;
    await assignMarketToSlot(pickerSlotIndex, item.market, item.name);
    dismissSymbolPicker();
  }, [assignMarketToSlot, dismissSymbolPicker, pickerSlotIndex]);

  const clearPickerSlot = useCallback(async () => {
    if (pickerSlotIndex === null) return;
    await assignMarketToSlot(pickerSlotIndex, "", "");
    dismissSymbolPicker();
  }, [assignMarketToSlot, dismissSymbolPicker, pickerSlotIndex]);

  const handlePickerKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (!pickerResults.length) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissSymbolPicker();
      }
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = (pickerActiveIndex + 1) % pickerResults.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (pickerActiveIndex - 1 + pickerResults.length) % pickerResults.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = pickerResults.length - 1;
    } else if (event.key === "Enter") {
      event.preventDefault();
      void assignPickerSlot(pickerResults[pickerActiveIndex] ?? pickerResults[0]);
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      dismissSymbolPicker();
      return;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      setPickerActiveIndex(nextIndex);
    }
  }, [assignPickerSlot, dismissSymbolPicker, pickerActiveIndex, pickerResults]);

  const changeAllTimeframes = useCallback((timeframe: ChartTimeframe) => {
    setLayout((current) => {
      const previous = rebaseLatest(current);
      const next = applyTimeframeToAll(previous.timeframes, timeframe, SLOT_COUNT);
      if (next === previous.timeframes) return previous;
      return { ...previous, timeframes: next, updatedAt: nextLayoutUpdatedAt(previous) };
    });
  }, []);

  const changeActiveTimeframe = useCallback((timeframe: ChartTimeframe) => {
    setLayout((current) => {
      const previous = rebaseLatest(current);
      const next = applyTimeframeToActive(
        previous.timeframes,
        previous.activeIndex,
        timeframe,
        SLOT_COUNT,
      );
      if (next === previous.timeframes) return previous;
      return { ...previous, timeframes: next, updatedAt: nextLayoutUpdatedAt(previous) };
    });
  }, []);

  const selectSlot = useCallback((index: number) => {
    setLayout((current) => {
      const previous = rebaseLatest(current);
      const nextActiveIndex = Math.max(0, Math.min(SLOT_COUNT - 1, index));
      if (nextActiveIndex === previous.activeIndex) return previous;
      return {
        ...previous,
        activeIndex: nextActiveIndex,
        updatedAt: nextLayoutUpdatedAt(previous),
      };
    });
  }, []);

  const retryUniverse = useCallback(() => {
    universeApiRetryAtRef.current = 0;
    setUniverseError("");
    setRetryRevision((revision) => revision + 1);
  }, []);

  const connectMarketToChart = useCallback(async (market: string, label: string) => {
    const latestStored = readCurrentStoredLayout();
    const base = latestStored && latestStored.updatedAt > layout.updatedAt
      ? { ...layout, ...latestStored }
      : layout;
    const existingIndex = base.markets.indexOf(market);
    const targetIndex = existingIndex >= 0
      ? existingIndex
      : Math.max(0, Math.min(SLOT_COUNT - 1, base.activeIndex));
    await assignMarketToSlot(targetIndex, market, label);
    setActiveView("chart");
    setAnnouncement(`${label}을 C${targetIndex + 1} 차트에 연결했습니다.`);
    window.requestAnimationFrame(() => viewTabRefs.current.chart?.focus());
  }, [assignMarketToSlot, layout]);

  const connectRadarCandidate = useCallback((item: UpbitRadarCandidate) => {
    void connectMarketToChart(item.market, item.name);
  }, [connectMarketToChart]);

  const connectHolding = useCallback((market: string, name: string) => {
    void connectMarketToChart(market, name);
  }, [connectMarketToChart]);

  const handleViewTabKeyDown = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    currentView: DashboardView,
  ) => {
    let nextView: DashboardView | undefined;
    const currentIndex = DASHBOARD_VIEWS.indexOf(currentView);
    if (event.key === "ArrowRight") {
      nextView = DASHBOARD_VIEWS[(currentIndex + 1) % DASHBOARD_VIEWS.length];
    } else if (event.key === "ArrowLeft") {
      nextView = DASHBOARD_VIEWS[
        (currentIndex - 1 + DASHBOARD_VIEWS.length) % DASHBOARD_VIEWS.length
      ];
    } else if (event.key === "Home") {
      nextView = DASHBOARD_VIEWS[0];
    } else if (event.key === "End") {
      nextView = DASHBOARD_VIEWS.at(-1);
    }
    if (!nextView) return;
    event.preventDefault();
    setActiveView(nextView);
    viewTabRefs.current[nextView]?.focus();
  }, []);

  const switchTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  const chartView = activeView === "chart";
  const headerDelayed = chartView && Boolean(universeError);

  return (
    <main className={styles.shell} data-theme={theme}>
      <div className={styles.ambientOne} aria-hidden="true" />
      <div className={styles.ambientTwo} aria-hidden="true" />

      <header className={styles.topbar}>
        <div className={styles.brandBlock}>
          <div className={styles.brandMark} aria-hidden="true"><i /><i /><i /></div>
          <div>
            <div className={styles.eyebrow}>
              {activeView === "radar"
                ? "UPBIT · KRW ATTENTION RADAR"
                : activeView === "balance"
                  ? "UPBIT · MY ACCOUNT"
                  : "UPBIT · KRW SPOT"}
            </div>
            <h1>UPBIT FLOW <span>실시간 다중차트</span></h1>
          </div>
        </div>
        <div className={styles.headerControls}>
          <SectionSwitcher current="upbit" />
          <button type="button" className={styles.themeToggle} onClick={switchTheme}>
            <span className={styles.themeGlyph} aria-hidden="true">
              {theme === "dark" ? "☼" : "◐"}
            </span>
            <span className={styles.themeLabel}>{theme === "dark" ? "LIGHT" : "DARK"}</span>
          </button>
          <span
            className={styles.modeChip}
            data-mode="LIVE"
            data-delayed={headerDelayed || undefined}
          >
            <i className={styles.statusDot} />
            {headerDelayed
              ? "DELAYED"
              : activeView === "radar"
                ? "RADAR"
                : activeView === "balance"
                  ? "ACCOUNT"
                  : "LIVE"}
            <span className={styles.feedKind}>
              {activeView === "radar"
                ? "50·30·20 SCORE"
                : activeView === "balance"
                  ? "PRIVATE API"
                  : universeSource === "public"
                    ? "BROWSER DIRECT"
                    : "PUBLIC MARKET"}
            </span>
          </span>
          <div className={styles.clockBlock}>
            <span>KST</span>
            <strong>{formatClock(clock)}</strong>
          </div>
        </div>
      </header>

      <div className={styles.marketTabs} role="tablist" aria-label="업비트 대시보드 화면">
        {DASHBOARD_VIEWS.map((view) => {
          const selected = activeView === view;
          const copy = VIEW_COPY[view];
          return (
            <button
              key={view}
              ref={(node) => {
                viewTabRefs.current[view] = node;
              }}
              id={`view-tab-${view}`}
              type="button"
              role="tab"
              aria-label={copy.aria}
              aria-selected={selected}
              aria-controls={`${view}-panel`}
              tabIndex={selected ? 0 : -1}
              className={selected ? styles.marketActive : undefined}
              onClick={() => setActiveView(view)}
              onKeyDown={(event) => handleViewTabKeyDown(event, view)}
            >
              <strong>{copy.label}</strong>
              <small>{copy.caption}</small>
            </button>
          );
        })}
      </div>

      <section
        id="chart-panel"
        className={styles.marketPanel}
        role="tabpanel"
        aria-labelledby="view-tab-chart"
        aria-busy={!universe.length && !universeError}
        hidden={!chartView}
      >
        {universeError && (
          <div className={styles.errorBanner} role="alert">
            <span>!</span>
            <p>
              <strong>업비트 KRW 연결 지연</strong>
              <small>{universeError} · 마지막 정상 차트는 유지됩니다.</small>
            </p>
            <button type="button" className={styles.errorRetry} onClick={retryUniverse}>
              다시 연결
            </button>
          </div>
        )}

        <MultiChartWorkspace
          theme={theme}
          markets={markets}
          timeframes={timeframes}
          activeIndex={activeIndex}
          paused={hidden || !chartView}
          candidates={candidates}
          onSelectSlot={selectSlot}
          onRequestMarketChange={openSymbolPicker}
          onChangeAllTimeframes={changeAllTimeframes}
          onChangeActiveTimeframe={changeActiveTimeframe}
        />

        <footer className={styles.disclaimer}>
          <div><span>i</span><strong>MARKET DATA ONLY</strong></div>
          <p>
            표시 데이터는 업비트 KRW 마켓 공개 시세이며 투자 조언이 아닙니다. 주문
            기능은 제공하지 않습니다. 네트워크 지연이나 거래소 점검 시 마지막 정상값이
            유지됩니다.
          </p>
          <span>
            {lastUniverseAt
              ? `종목 목록 ${formatClock(lastUniverseAt)} KST 기준 · ${universe.length}개`
              : "UPBIT FLOW"}
          </span>
        </footer>
      </section>

      <section
        id="radar-panel"
        className={styles.radarPanel}
        role="tabpanel"
        aria-labelledby="view-tab-radar"
        hidden={activeView !== "radar"}
      >
        <AttentionRadar
          active={activeView === "radar"}
          onSelectCandidate={connectRadarCandidate}
        />
      </section>

      <section
        id="balance-panel"
        className={styles.radarPanel}
        role="tabpanel"
        aria-labelledby="view-tab-balance"
        hidden={activeView !== "balance"}
      >
        <BalancePanel
          active={activeView === "balance" && !hidden}
          onSelectHolding={connectHolding}
        />
      </section>

      {pickerSlotIndex !== null && (
        <dialog
          ref={symbolDialogRef}
          className={styles.symbolDialog}
          aria-labelledby="symbol-picker-title"
          onCancel={(event) => {
            event.preventDefault();
            dismissSymbolPicker();
          }}
          onClose={finalizePickerClose}
        >
          <div className={styles.symbolDialogCard}>
            <header className={styles.symbolDialogHeader}>
              <div>
                <span className={styles.sectionKicker}>
                  C{pickerSlotIndex + 1} · UPBIT KRW · {universe.length} MARKETS
                </span>
                <strong id="symbol-picker-title">종목 선택</strong>
                <small>24H 거래대금 순 · 30분마다 후보 갱신 · 비트코인, BTC 모두 검색됩니다.</small>
              </div>
              <button
                type="button"
                className={styles.symbolDialogClose}
                onClick={dismissSymbolPicker}
                aria-label="종목 선택 창 닫기"
              >
                ×
              </button>
            </header>

            <div className={styles.symbolSearchRow}>
              <label htmlFor="symbol-search-input">종목 검색</label>
              <div className={styles.symbolSearchControl}>
                <span aria-hidden="true">⌕</span>
                <input
                  ref={symbolSearchRef}
                  id="symbol-search-input"
                  type="search"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls="symbol-search-results"
                  aria-activedescendant={pickerResults[pickerActiveIndex]
                    ? `symbol-option-${pickerResults[pickerActiveIndex].market}`
                    : undefined}
                  value={pickerQuery}
                  placeholder="비트코인, BTC, 리플…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setPickerQuery(event.target.value);
                    setPickerActiveIndex(0);
                  }}
                  onKeyDown={handlePickerKeyDown}
                />
                {pickerQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setPickerQuery("");
                      setPickerActiveIndex(0);
                    }}
                    aria-label="검색어 지우기"
                  >
                    지우기
                  </button>
                )}
              </div>
              <small role="status" aria-live="polite">
                {pickerResults.length}개 검색됨 · ↑↓ 이동 · Enter 선택
              </small>
            </div>

            <div
              id="symbol-search-results"
              className={styles.symbolResults}
              role="listbox"
              aria-label="업비트 KRW 전체 종목"
            >
              {pickerResults.map((item, index) => {
                const usedSlots = markets
                  .map((market, slotIndex) => market === item.market ? slotIndex + 1 : 0)
                  .filter(Boolean);
                const selected = markets[pickerSlotIndex] === item.market;
                const usedSlotLabel = usedSlots.length
                  ? usedSlots.map((slot) => `C${slot}`).join(" · ")
                  : "미사용";
                return (
                  <button
                    key={item.market}
                    id={`symbol-option-${item.market}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    aria-label={`${item.rank}위 ${item.name}, 24시간 거래대금 ${
                      formatKrwCompact(item.quoteVolume)
                    }원, 전일대비 ${formatSignedPercent(item.changeRate)}, ${usedSlotLabel}${
                      item.warning ? ", 투자유의 종목" : ""
                    }`}
                    className={index === pickerActiveIndex
                      ? styles.symbolOptionActive
                      : undefined}
                    onMouseEnter={() => setPickerActiveIndex(index)}
                    onClick={() => void assignPickerSlot(item)}
                  >
                    <span className={styles.symbolOptionMark} aria-hidden="true">
                      #{item.rank}
                    </span>
                    <span className={styles.symbolOptionName}>
                      <strong>{item.name}{item.warning ? " ⚠" : ""}</strong>
                      <small>{item.baseAsset}/KRW · {formatKrwPrice(item.lastPrice)}</small>
                    </span>
                    <span className={styles.symbolOptionMeta}>
                      <strong>24H · {formatKrwCompact(item.quoteVolume)}</strong>
                      <small className={styles.symbolOptionUse}>
                        {formatSignedPercent(item.changeRate)} · {usedSlotLabel}
                      </small>
                    </span>
                  </button>
                );
              })}
              {!pickerResults.length && (
                <div className={styles.symbolEmpty} role="status">
                  <strong>검색 결과가 없습니다.</strong>
                  <small>마켓 코드나 한글 종목명을 다시 입력해 주세요.</small>
                </div>
              )}
            </div>

            <footer className={styles.symbolDialogFooter}>
              <span>같은 종목을 서로 다른 봉으로 여러 슬롯에 배치할 수 있습니다.</span>
              <button
                type="button"
                onClick={() => void clearPickerSlot()}
                disabled={!markets[pickerSlotIndex]}
              >
                C{pickerSlotIndex + 1} 비우기
              </button>
            </footer>
          </div>
        </dialog>
      )}
      <p className={styles.visuallyHidden} role="status" aria-live="polite">
        {announcement}
      </p>
    </main>
  );
}

/** 다른 탭이 더 최근 레이아웃을 저장했다면 그 위에서 이어 갑니다. */
function rebaseLatest(current: StoredLayout): StoredLayout {
  const latest = readCurrentStoredLayout();
  return latest && latest.updatedAt > current.updatedAt
    ? { ...current, ...latest }
    : current;
}

export default UpbitDashboard;
