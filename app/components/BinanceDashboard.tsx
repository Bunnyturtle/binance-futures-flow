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
  AUTO_WALL_REFRESH_MS,
  AUTO_WALL_USER_PINNED_SLOT_COUNT,
  CRYPTO_WALL_DEFAULT_SYMBOLS,
  CRYPTO_WALL_RANKING_VERSION,
  TRADFI_WALL_RANKING_VERSION,
  autoWallRefreshDelay,
  sameSymbolLayout,
  selectAutoWallSymbols,
} from "../../lib/crypto-wall-ranking";
import MultiChartWorkspace, {
  type MarketSegment,
  type MultiChartCandidate,
} from "./MultiChartWorkspace";
import type { ChartTimeframe } from "./CandlestickChart";
import { loadPublicFuturesCatalog } from "./BinancePublicClient";
import AttentionRadar from "./AttentionRadar";
import type { BinanceRadarCandidate } from "../../lib/binance-radar";
import styles from "./BinanceDashboard.module.css";

const SLOT_COUNT = 12;
const LEGACY_STORAGE_KEY = "binance-futures-chart-wall-v1";
const PREVIOUS_STORAGE_KEYS = [
  "futures-flow-market-wall-v4",
  "futures-flow-market-wall-v3",
  "futures-flow-market-wall-v2",
] as const;
const STORAGE_KEY = "futures-flow-market-wall-v5";
const DASHBOARD_STORAGE_LOCK_NAME = "binance-futures-flow-market-wall-v5";
const AUTO_WALL_GUARD_KEY_PREFIX = "futures-flow-auto-wall-ranked-at-v4";
const AUTO_WALL_LOCK_NAME_PREFIX = "binance-futures-flow-auto-wall-v4";
const THEME_KEY = "binance-futures-theme";
const SAME_ORIGIN_API_TIMEOUT_MS = 6_000;
const SAME_ORIGIN_API_BACKOFF_MS = 60_000;
const INVALID_AUTO_WALL_CATALOG_RETRY_MS = 5_000;
const CATALOG_REFRESH_MS = 30 * 60_000;
const MARKET_SEGMENTS: MarketSegment[] = ["crypto", "tradfi"];
const AUTO_WALL_RANKING_VERSION_BY_SEGMENT: Record<MarketSegment, string> = {
  crypto: CRYPTO_WALL_RANKING_VERSION,
  tradfi: TRADFI_WALL_RANKING_VERSION,
};
const DASHBOARD_VIEWS = ["crypto", "tradfi", "radar"] as const;

type DashboardView = (typeof DASHBOARD_VIEWS)[number];

type Theme = "dark" | "light";

type UniverseItem = MultiChartCandidate & {
  baseAsset: string;
  quoteAsset: string;
  rank: number;
  lastPrice: number;
  changeRate: number;
  quoteVolume: number;
  tickSize?: string;
  rankingScore?: number;
  volumeScore?: number;
  changeScore?: number;
  recommendationRank?: number;
};

type StoredLayout = {
  symbols: string[];
  custom: boolean[];
  timeframes: ChartTimeframe[];
  activeIndex: number;
  updatedAt: number;
  autoRankedAt: number;
  autoRankingVersion: string;
};

type UniverseSource = "api" | "public";

type SegmentState = StoredLayout & {
  universe: UniverseItem[];
  universeError: string;
  universeSource: UniverseSource;
  lastUniverseAt: string;
};

type SegmentStates = Record<MarketSegment, SegmentState>;

const SEGMENT_COPY: Record<MarketSegment, {
  tabLabel: string;
  tabAriaLabel: string;
  tabCaption: string;
  eyebrow: string;
  pickerTitle: string;
  pickerHint: string;
  errorTitle: string;
  disclaimer: string;
}> = {
  crypto: {
    tabLabel: "CRYPTO",
    tabAriaLabel: "암호화폐 무기한 선물",
    tabCaption: "암호화폐 전체 종목",
    eyebrow: "BINANCE · CRYPTO FUTURES",
    pickerTitle: "CRYPTO 종목 선택",
    pickerHint: "24H 거래대금 순 · 30분마다 후보 갱신 · BTC처럼 검색하세요.",
    errorTitle: "CRYPTO 선물 연결 지연",
    disclaimer: "표시 데이터는 Binance CRYPTO USDⓈ-M 공개 시장 데이터이며 투자 조언이 아닙니다. 네트워크 지연이나 거래소 점검 시 마지막 정상값이 유지됩니다.",
  },
  tradfi: {
    tabLabel: "TRADFI",
    tabAriaLabel: "전통금융 연계 무기한 선물",
    tabCaption: "전통금융 전체 종목",
    eyebrow: "BINANCE · TRADFI FUTURES",
    pickerTitle: "TRADFI 종목 선택",
    pickerHint: "24H 거래대금 순 · 30분마다 후보 갱신 · 주식·원자재 연계 심볼을 검색하세요.",
    errorTitle: "TRADFI 선물 연결 지연",
    disclaimer: "표시 데이터는 Binance TRADFI 분류 공개 시장 데이터이며 투자 조언이 아닙니다. 네트워크 지연이나 거래소 점검 시 마지막 정상값이 유지됩니다.",
  },
};

const VALID_TIMEFRAMES = new Set<ChartTimeframe>([
  "1m",
  "3m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M",
]);

const COMPACT_USDT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const LEGACY_TIMEFRAMES: Record<string, ChartTimeframe> = {
  "30m": "15m",
  "2h": "1h",
  "6h": "4h",
  "8h": "4h",
  "12h": "4h",
  "3d": "1d",
  "1mo": "1M",
  "1mon": "1M",
  month: "1M",
  monthly: "1M",
};

function emptySymbols() {
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
    symbols: emptySymbols(),
    custom: emptyCustom(),
    timeframes: defaultTimeframes(),
    activeIndex: 0,
    updatedAt: 0,
    autoRankedAt: 0,
    autoRankingVersion: "",
  };
}

function defaultCryptoLayout(): StoredLayout {
  const layout = defaultLayout();
  return {
    ...layout,
    symbols: layout.symbols.map((symbol, index) =>
      CRYPTO_WALL_DEFAULT_SYMBOLS[index] ?? symbol
    ),
  };
}

function defaultSegmentState(layout = defaultLayout()): SegmentState {
  return {
    ...layout,
    universe: [],
    universeError: "",
    universeSource: "api",
    lastUniverseAt: "",
  };
}

function defaultSegmentStates(): SegmentStates {
  return {
    crypto: defaultSegmentState(defaultCryptoLayout()),
    tradfi: defaultSegmentState(),
  };
}

function normalizeStoredTimeframe(value: unknown): ChartTimeframe {
  if (typeof value !== "string") return "1m";
  const exactValue = value.trim();
  if (VALID_TIMEFRAMES.has(exactValue as ChartTimeframe)) {
    return exactValue as ChartTimeframe;
  }
  return LEGACY_TIMEFRAMES[exactValue.toLowerCase()] ?? "1m";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(source: Record<string, unknown>, key: string) {
  const value = source[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalScoreValue(source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function optionalPositiveInteger(source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function textValue(source: Record<string, unknown>, key: string, fallback = "") {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function formatCompactUsdt(value: number) {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  return `${COMPACT_USDT_FORMATTER.format(safeValue)} USDT`;
}

function formatSignedPercent(value: number) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return `${safeValue > 0 ? "+" : ""}${safeValue.toFixed(2)}%`;
}

function normalizeUniverseItem(value: unknown): UniverseItem | null {
  const item = record(value);
  const symbol = textValue(item, "symbol").toUpperCase();
  const lastPrice = numberValue(item, "lastPrice");
  if (
    !/^[A-Z0-9]{5,30}$/.test(symbol) ||
    !symbol.endsWith("USDT")
  ) return null;
  const baseAsset = textValue(item, "baseAsset", symbol.replace(/USDT$/, ""));
  const quoteAsset = textValue(item, "quoteAsset", "USDT");
  return {
    symbol,
    name: textValue(item, "name", `${baseAsset} / ${quoteAsset}`),
    baseAsset,
    quoteAsset,
    currency: textValue(item, "currency", "USDT"),
    rank: Math.max(0, Math.trunc(numberValue(item, "rank"))),
    quoteVolume: Math.max(0, numberValue(item, "quoteVolume")),
    lastPrice,
    changeRate: numberValue(item, "changeRate"),
    priceTimestamp: textValue(item, "priceTimestamp") || undefined,
    tickSize: textValue(item, "tickSize") || undefined,
    rankingScore: optionalScoreValue(item, "rankingScore"),
    volumeScore: optionalScoreValue(item, "volumeScore"),
    changeScore: optionalScoreValue(item, "changeScore"),
    recommendationRank: optionalPositiveInteger(item, "recommendationRank"),
  };
}

function normalizeUniverseItems(value: unknown, segment: MarketSegment) {
  const seen = new Set<string>();
  const items = (Array.isArray(value) ? value : [])
    .map(normalizeUniverseItem)
    .filter((item): item is UniverseItem => {
      if (!item || seen.has(item.symbol)) return false;
      seen.add(item.symbol);
      return true;
    })
    .sort((left, right) =>
      right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol)
    )
    .map((item, index) => ({ ...item, rank: index + 1 }));
  if (items.length === 0) {
    throw new Error(
      `${SEGMENT_COPY[segment].tabLabel} 거래 가능 선물을 확인하지 못했습니다.`,
    );
  }
  if (!items.some((item) => (item.lastPrice ?? 0) > 0)) {
    throw new Error(
      `${SEGMENT_COPY[segment].tabLabel} 유효 시세를 확인하지 못했습니다.`,
    );
  }
  return items;
}

class InvalidSameOriginAutoWallCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSameOriginAutoWallCatalogError";
  }
}

async function loadSameOriginFuturesCatalog(
  segment: MarketSegment,
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
    const response = await fetch(`/api/chart-universe?segment=${segment}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const root = record(await response.json().catch(() => ({})));
    if (!response.ok) {
      throw new Error(textValue(root, "error", `선물 종목 목록 조회 실패 (${response.status})`));
    }
    let items: UniverseItem[];
    try {
      items = normalizeUniverseItems(root.items, segment);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "응답 형식 오류";
      throw new InvalidSameOriginAutoWallCatalogError(detail);
    }
    const recommendation = record(root.chartWallRecommendation);
    const recommendationWeights = record(recommendation.weights);
    const validRankingContract = root.schemaVersion === 7 &&
      textValue(recommendation, "sort") === "quoteVolume" &&
      numberValue(recommendationWeights, "quoteVolume") === 1 &&
      numberValue(recommendationWeights, "changeRate") === 0;
    if (!validRankingContract) {
      throw new InvalidSameOriginAutoWallCatalogError(
        `${segment.toUpperCase()} 24H 거래대금 추천 계약이 올바르지 않습니다.`,
      );
    }
    const exactAutoWall = selectAutoWallSymbols(items, SLOT_COUNT, []).length ===
      SLOT_COUNT;
    if (segment === "crypto" && !exactAutoWall) {
      throw new InvalidSameOriginAutoWallCatalogError(
        "CRYPTO 24H 거래대금 추천 순위 1~12가 완전하지 않습니다.",
      );
    }
    if (segment === "tradfi") {
      const recommendationAvailable = recommendation.available;
      const validAvailabilityContract = typeof recommendationAvailable === "boolean";
      if (
        !validAvailabilityContract ||
        (recommendationAvailable === true && !exactAutoWall) ||
        (recommendationAvailable === false && exactAutoWall)
      ) {
        throw new InvalidSameOriginAutoWallCatalogError(
          "TRADFI 24H 거래대금 추천 가용성 응답이 올바르지 않습니다.",
        );
      }
    }
    return {
      items,
      observedAt: textValue(root, "timestamp", new Date().toISOString()),
    };
  } catch (error) {
    if (timedOut && !parentSignal.aborted) {
      throw new Error(
        `same-origin API가 ${Math.round(SAME_ORIGIN_API_TIMEOUT_MS / 1_000)}초 안에 응답하지 않았습니다.`,
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
  if (!Array.isArray(parsed.symbols)) return null;
  const symbols = parsed.symbols
    .slice(0, SLOT_COUNT)
    .map((item) => typeof item === "string" ? item.toUpperCase() : "");
  const custom = Array.isArray(parsed.custom)
    ? parsed.custom.slice(0, SLOT_COUNT).map(Boolean)
    : emptyCustom();
  const timeframes = Array.isArray(parsed.timeframes)
    ? parsed.timeframes.slice(0, SLOT_COUNT).map(normalizeStoredTimeframe)
    : defaultTimeframes();
  const storedActiveIndex = numberValue(parsed, "activeIndex");
  const updatedAt = Math.max(0, Math.trunc(numberValue(parsed, "updatedAt")));
  const storedAutoRankedAt = Math.max(0, Math.trunc(numberValue(parsed, "autoRankedAt")));
  const storedAutoRankingVersion = textValue(parsed, "autoRankingVersion");
  const autoRankingVersionMatches = !expectedAutoRankingVersion ||
    storedAutoRankingVersion === expectedAutoRankingVersion;
  const autoRankedAt = autoRankingVersionMatches && storedAutoRankedAt <= Date.now()
    ? storedAutoRankedAt
    : 0;
  return {
    symbols: [...symbols, ...emptySymbols()].slice(0, SLOT_COUNT),
    custom: [...custom, ...emptyCustom()].slice(0, SLOT_COUNT),
    timeframes: [...timeframes, ...defaultTimeframes()].slice(0, SLOT_COUNT),
    activeIndex: Math.max(0, Math.min(SLOT_COUNT - 1, Math.trunc(storedActiveIndex))),
    updatedAt,
    autoRankedAt,
    autoRankingVersion: autoRankingVersionMatches ? storedAutoRankingVersion : "",
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

type AutoWallGuard = {
  version: string;
  at: number;
  token: string;
};

function emptyAutoWallGuard(segment: MarketSegment): AutoWallGuard {
  return {
    version: AUTO_WALL_RANKING_VERSION_BY_SEGMENT[segment],
    at: 0,
    token: "",
  };
}

function autoWallGuardKey(segment: MarketSegment) {
  return `${AUTO_WALL_GUARD_KEY_PREFIX}-${segment}`;
}

function autoWallLockName(segment: MarketSegment) {
  return `${AUTO_WALL_LOCK_NAME_PREFIX}-${segment}`;
}

function readAutoWallGuard(segment: MarketSegment): AutoWallGuard {
  try {
    const raw = window.localStorage.getItem(autoWallGuardKey(segment));
    if (!raw) return emptyAutoWallGuard(segment);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = Number(raw);
    }
    // Numeric and unversioned object guards belong to the previous ranking
    // contract. Ignoring them makes the first fresh volume-ranked catalog apply now.
    if (typeof parsed === "number") return emptyAutoWallGuard(segment);
    const value = record(parsed);
    const version = textValue(value, "version");
    const at = numberValue(value, "at");
    const token = textValue(value, "token");
    return version === AUTO_WALL_RANKING_VERSION_BY_SEGMENT[segment] &&
        Number.isFinite(at) && at >= 0 && at <= Date.now() && token
      ? { version, at, token }
      : emptyAutoWallGuard(segment);
  } catch {
    return emptyAutoWallGuard(segment);
  }
}

function dashboardStorageRoot(key: string): Record<string, unknown> | null {
  const stored = record(parseStoredValue(key));
  return Object.keys(record(stored.layouts)).length > 0 ? stored : null;
}

function readCurrentStoredLayout(segment: MarketSegment): StoredLayout | null {
  const current = dashboardStorageRoot(STORAGE_KEY);
  return current
    ? normalizeStoredLayout(
        record(current.layouts)[segment],
        AUTO_WALL_RANKING_VERSION_BY_SEGMENT[segment],
      )
    : null;
}

function rebaseLatestStoredLayout(
  segment: MarketSegment,
  current: SegmentState,
): SegmentState {
  const latest = readCurrentStoredLayout(segment);
  return latest && latest.updatedAt > current.updatedAt
    ? { ...current, ...latest }
    : current;
}

async function withDashboardStorageLock<T>(operation: () => T): Promise<T> {
  if (!navigator.locks) return operation();
  try {
    return await navigator.locks.request(DASHBOARD_STORAGE_LOCK_NAME, operation);
  } catch {
    return operation();
  }
}

function autoWallGuardToken(): string {
  return typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function writeAutoWallGuard(segment: MarketSegment, value: AutoWallGuard): boolean {
  try {
    window.localStorage.setItem(autoWallGuardKey(segment), JSON.stringify(value));
    return true;
  } catch {
    // Cross-tab coordination is best effort when browser storage is unavailable.
    return false;
  }
}

async function withAutoWallLock<T>(
  segment: MarketSegment,
  operation: () => T,
): Promise<T> {
  if (!navigator.locks) return operation();
  try {
    return await navigator.locks.request(autoWallLockName(segment), operation);
  } catch {
    return operation();
  }
}

async function markAutoWallGuard(segment: MarketSegment): Promise<number> {
  return withAutoWallLock(segment, () => {
    const value = Math.max(Date.now(), readAutoWallGuard(segment).at);
    writeAutoWallGuard(segment, {
      version: AUTO_WALL_RANKING_VERSION_BY_SEGMENT[segment],
      at: value,
      token: autoWallGuardToken(),
    });
    return value;
  });
}

type AutoWallClaim = {
  at: number;
  token: string;
  previous: AutoWallGuard;
  persisted: boolean;
};

async function claimAutoWallRefresh(
  segment: MarketSegment,
  knownAutoRankedAt: number,
): Promise<AutoWallClaim | null> {
  return withAutoWallLock(segment, () => {
    if (document.hidden) return null;
    const now = Date.now();
    const previous = readAutoWallGuard(segment);
    const latestAutoRankedAt = Math.max(knownAutoRankedAt, previous.at);
    if (autoWallRefreshDelay(latestAutoRankedAt, now) > 0) return null;
    const token = autoWallGuardToken();
    return {
      at: now,
      token,
      previous,
      persisted: writeAutoWallGuard(segment, {
        version: AUTO_WALL_RANKING_VERSION_BY_SEGMENT[segment],
        at: now,
        token,
      }),
    };
  });
}

async function releaseAutoWallClaim(
  segment: MarketSegment,
  claim: AutoWallClaim,
): Promise<void> {
  if (!claim.persisted) return;
  await withAutoWallLock(segment, () => {
    if (readAutoWallGuard(segment).token === claim.token) {
      writeAutoWallGuard(segment, claim.previous);
    }
  });
}

function readStoredDashboard(): {
  activeSegment: MarketSegment;
  layouts: Record<MarketSegment, StoredLayout>;
} {
  const legacyCrypto = normalizeStoredLayout(
    parseStoredValue(LEGACY_STORAGE_KEY),
    CRYPTO_WALL_RANKING_VERSION,
  );
  const stored = dashboardStorageRoot(STORAGE_KEY) ??
    PREVIOUS_STORAGE_KEYS
      .map(dashboardStorageRoot)
      .find((value): value is Record<string, unknown> => value !== null) ??
    {};
  const storedLayouts = record(stored.layouts);
  const activeSegment: MarketSegment = stored.activeSegment === "tradfi"
    ? "tradfi"
    : "crypto";
  const crypto = normalizeStoredLayout(
    storedLayouts.crypto,
    CRYPTO_WALL_RANKING_VERSION,
  ) ?? legacyCrypto ?? defaultCryptoLayout();
  const tradfi = normalizeStoredLayout(
    storedLayouts.tradfi,
    TRADFI_WALL_RANKING_VERSION,
  ) ?? defaultLayout();
  const cryptoGuard = readAutoWallGuard("crypto");
  const tradfiGuard = readAutoWallGuard("tradfi");
  const cryptoAutoRankedAt = Math.max(crypto.autoRankedAt, cryptoGuard.at);
  const tradfiAutoRankedAt = Math.max(tradfi.autoRankedAt, tradfiGuard.at);
  return {
    activeSegment,
    layouts: {
      crypto: {
        ...crypto,
        autoRankedAt: cryptoAutoRankedAt,
        autoRankingVersion: cryptoAutoRankedAt > 0
          ? CRYPTO_WALL_RANKING_VERSION
          : crypto.autoRankingVersion,
      },
      tradfi: {
        ...tradfi,
        autoRankedAt: tradfiAutoRankedAt,
        autoRankingVersion: tradfiAutoRankedAt > 0
          ? TRADFI_WALL_RANKING_VERSION
          : tradfi.autoRankingVersion,
      },
    },
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

export function BinanceDashboard() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [hidden, setHidden] = useState(false);
  const [activeSegment, setActiveSegment] = useState<MarketSegment>("crypto");
  const [activeView, setActiveView] = useState<DashboardView>("crypto");
  const [segmentStates, setSegmentStates] = useState<SegmentStates>(defaultSegmentStates);
  const [clock, setClock] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [retryRevisions, setRetryRevisions] = useState<Record<MarketSegment, number>>({
    crypto: 0,
    tradfi: 0,
  });
  const [autoRefreshRevisions, setAutoRefreshRevisions] = useState<
    Record<MarketSegment, number>
  >({ crypto: 0, tradfi: 0 });
  const [pickerSlotIndex, setPickerSlotIndex] = useState<number | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [pickerAnnouncement, setPickerAnnouncement] = useState("");
  const universeApiRetryAtRef = useRef<Record<MarketSegment, number>>({
    crypto: 0,
    tradfi: 0,
  });
  const autoRankedAtRef = useRef<Record<MarketSegment, number>>({
    crypto: 0,
    tradfi: 0,
  });
  const marketTabRefs = useRef<Record<DashboardView, HTMLButtonElement | null>>({
    crypto: null,
    tradfi: null,
    radar: null,
  });
  const symbolDialogRef = useRef<HTMLDialogElement | null>(null);
  const symbolSearchRef = useRef<HTMLInputElement | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);

  const activeState = segmentStates[activeSegment];
  const {
    symbols,
    timeframes,
    activeIndex,
    universe,
    universeError,
    universeSource,
  } = activeState;
  const segmentCopy = SEGMENT_COPY[activeSegment];
  const activeRetryRevision = retryRevisions[activeSegment];
  const activeAutoRefreshRevision = autoRefreshRevisions[activeSegment];
  const normalizedPickerQuery = pickerQuery
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const pickerResults = useMemo(() => {
    return universe.filter((item) => {
      if (!normalizedPickerQuery) return true;
      const symbol = item.symbol.replace(/[^A-Z0-9]/g, "");
      const baseAsset = item.baseAsset.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const name = item.name.toUpperCase().replace(/[^A-Z0-9]/g, "");
      return symbol.includes(normalizedPickerQuery) ||
        baseAsset.includes(normalizedPickerQuery) ||
        name.includes(normalizedPickerQuery);
    });
  }, [normalizedPickerQuery, universe]);
  const autoWallSymbols = useMemo(
    () => selectAutoWallSymbols(
      activeState.universe,
      SLOT_COUNT,
      activeState.symbols.slice(0, AUTO_WALL_USER_PINNED_SLOT_COUNT),
    ),
    [activeState.symbols, activeState.universe],
  );
  const autoWallSignature = autoWallSymbols.join(",");

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
    setSegmentStates((current) => {
      const currentPrevious = current[activeSegment];
      const previous = rebaseLatestStoredLayout(activeSegment, currentPrevious);
      if (previous.activeIndex === targetIndex) {
        return previous === currentPrevious
          ? current
          : { ...current, [activeSegment]: previous };
      }
      return {
        ...current,
        [activeSegment]: {
          ...previous,
          activeIndex: targetIndex,
          updatedAt: nextLayoutUpdatedAt(previous),
        },
      };
    });
    setPickerQuery("");
    setPickerActiveIndex(0);
    setPickerSlotIndex(targetIndex);
  }, [activeSegment]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const preferred = window.localStorage.getItem(THEME_KEY);
      if (preferred === "light" || preferred === "dark") {
        setTheme(preferred);
      } else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
        setTheme("light");
      }
      const stored = readStoredDashboard();
      setActiveSegment(stored.activeSegment);
      setActiveView(stored.activeSegment);
      setSegmentStates((current) => ({
        crypto: { ...current.crypto, ...stored.layouts.crypto },
        tradfi: { ...current.tradfi, ...stored.layouts.tradfi },
      }));
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

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
      document.getElementById(`symbol-option-${activeSegment}-${activeOption.symbol}`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, [activeSegment, pickerActiveIndex, pickerResults, pickerSlotIndex]);

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
    autoRankedAtRef.current = {
      crypto: segmentStates.crypto.autoRankedAt,
      tradfi: segmentStates.tradfi.autoRankedAt,
    };
  }, [segmentStates.crypto.autoRankedAt, segmentStates.tradfi.autoRankedAt]);

  useEffect(() => {
    if (!hydrated || hidden || activeView === "radar") return undefined;
    const segment = activeSegment;
    const controller = new AbortController();
    let disposed = false;
    let running = false;
    let invalidCatalogFastRetryUsed = false;
    let pendingInvalidCatalogFastRetry = false;
    let invalidCatalogRetryTimeout: number | undefined;

    const loadUniverse = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        let items: UniverseItem[] = [];
        let observedAt = new Date().toISOString();
        let source: UniverseSource = "api";
        const trySameOrigin = Date.now() >= universeApiRetryAtRef.current[segment];
        try {
          if (!trySameOrigin) {
            throw new Error("same-origin API 재시도 대기 중");
          }
          const sameOrigin = await loadSameOriginFuturesCatalog(segment, controller.signal);
          items = sameOrigin.items;
          observedAt = sameOrigin.observedAt;
          universeApiRetryAtRef.current[segment] = 0;
        } catch (apiError) {
          if (controller.signal.aborted) throw apiError;
          if (trySameOrigin) {
            const invalidAutoWallCatalog =
              apiError instanceof InvalidSameOriginAutoWallCatalogError;
            const retryDelay = invalidAutoWallCatalog && !invalidCatalogFastRetryUsed
              ? INVALID_AUTO_WALL_CATALOG_RETRY_MS
              : SAME_ORIGIN_API_BACKOFF_MS;
            universeApiRetryAtRef.current[segment] =
              Date.now() + retryDelay;
            if (invalidAutoWallCatalog && !invalidCatalogFastRetryUsed) {
              invalidCatalogFastRetryUsed = true;
              pendingInvalidCatalogFastRetry = true;
            }
          }
          try {
            const publicItems = normalizeUniverseItems(
              await loadPublicFuturesCatalog(controller.signal, { segment }),
              segment,
            );
            const publicAutoWallExact = selectAutoWallSymbols(
              publicItems,
              SLOT_COUNT,
              [],
            ).length === SLOT_COUNT;
            if (segment === "crypto" && !publicAutoWallExact) {
              throw new Error(
                `브라우저 공개 REST의 ${segment.toUpperCase()} 24H 거래대금 추천 순위가 완전하지 않습니다.`,
              );
            }
            items = publicItems;
            observedAt = new Date().toISOString();
            source = "public";
          } catch (publicError) {
            const apiDetail = apiError instanceof Error ? apiError.message : "same-origin API 오류";
            const publicDetail = publicError instanceof Error
              ? publicError.message
              : "브라우저 공개 REST 오류";
            throw new Error(`${apiDetail} · 브라우저 직접 복구 실패: ${publicDetail}`);
          }
        }
        if (disposed || document.hidden) return;
        const exactAutoWall = selectAutoWallSymbols(items, SLOT_COUNT, []).length ===
          SLOT_COUNT;
        const preClaimStoredLayout = readCurrentStoredLayout(segment);
        const knownAutoRankedAt = Math.max(
          autoRankedAtRef.current[segment],
          preClaimStoredLayout?.autoRankedAt ?? 0,
        );
        const automaticClaim = exactAutoWall
          ? await claimAutoWallRefresh(segment, knownAutoRankedAt)
          : null;
        if (disposed || document.hidden) {
          if (automaticClaim) await releaseAutoWallClaim(segment, automaticClaim);
          return;
        }
        const latestStoredLayout = readCurrentStoredLayout(segment);
        setSegmentStates((current) => {
          const currentPrevious = current[segment];
          const previous = latestStoredLayout &&
              latestStoredLayout.updatedAt > currentPrevious.updatedAt
            ? { ...currentPrevious, ...latestStoredLayout }
            : currentPrevious;
          const nextAutoSymbols = selectAutoWallSymbols(
            items,
            SLOT_COUNT,
            previous.symbols.slice(0, AUTO_WALL_USER_PINNED_SLOT_COUNT),
          );
          const applyAutomaticWall =
            nextAutoSymbols.length === SLOT_COUNT &&
            automaticClaim !== null &&
            (!automaticClaim.persisted ||
              readAutoWallGuard(segment).token === automaticClaim.token) &&
            autoWallRefreshDelay(previous.autoRankedAt, automaticClaim.at) === 0;
          return {
            ...current,
            [segment]: {
              ...previous,
              universe: items,
              universeError: "",
              universeSource: source,
              lastUniverseAt: observedAt,
              ...(applyAutomaticWall
                ? {
                    symbols: sameSymbolLayout(previous.symbols, nextAutoSymbols)
                      ? previous.symbols
                      : nextAutoSymbols,
                    custom: previous.custom.map((value, index) =>
                      index < AUTO_WALL_USER_PINNED_SLOT_COUNT ? value : false
                    ),
                    autoRankedAt: automaticClaim.at,
                    autoRankingVersion: AUTO_WALL_RANKING_VERSION_BY_SEGMENT[segment],
                    updatedAt: nextLayoutUpdatedAt(previous),
                  }
                : {}),
            },
          };
        });
      } catch (error) {
        if (disposed || controller.signal.aborted || document.hidden) return;
        const message = error instanceof Error
          ? error.message
          : `${segmentCopy.tabLabel} 선물 종목 목록을 불러오지 못했습니다.`;
        setSegmentStates((current) => ({
          ...current,
          [segment]: { ...current[segment], universeError: message },
        }));
      } finally {
        running = false;
        if (
          pendingInvalidCatalogFastRetry &&
          !disposed &&
          !document.hidden &&
          invalidCatalogRetryTimeout === undefined
        ) {
          pendingInvalidCatalogFastRetry = false;
          const retryDelay = Math.max(
            0,
            universeApiRetryAtRef.current[segment] - Date.now(),
          );
          invalidCatalogRetryTimeout = window.setTimeout(() => {
            invalidCatalogRetryTimeout = undefined;
            void loadUniverse();
          }, retryDelay + 50);
        }
      }
    };

    void loadUniverse();
    const interval = window.setInterval(() => void loadUniverse(), CATALOG_REFRESH_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
      if (invalidCatalogRetryTimeout !== undefined) {
        window.clearTimeout(invalidCatalogRetryTimeout);
      }
    };
  }, [
    activeRetryRevision,
    activeSegment,
    activeView,
    activeAutoRefreshRevision,
    hidden,
    hydrated,
    segmentCopy.tabLabel,
  ]);

  useEffect(() => {
    if (
      !hydrated ||
      activeView !== activeSegment ||
      hidden ||
      activeState.universeError ||
      autoWallSymbols.length !== SLOT_COUNT
    ) return undefined;

    const delay = autoWallRefreshDelay(activeState.autoRankedAt);
    const timeout = window.setTimeout(
      () => setAutoRefreshRevisions((current) => ({
        ...current,
        [activeSegment]: current[activeSegment] + 1,
      })),
      Math.min(delay, AUTO_WALL_REFRESH_MS),
    );
    return () => window.clearTimeout(timeout);
  }, [
    activeView,
    activeSegment,
    activeState.autoRankedAt,
    activeState.universeError,
    autoWallSignature,
    autoWallSymbols.length,
    hidden,
    hydrated,
  ]);

  const persistedLayouts = useMemo<Record<MarketSegment, StoredLayout>>(() => ({
    crypto: {
      symbols: segmentStates.crypto.symbols,
      custom: segmentStates.crypto.custom,
      timeframes: segmentStates.crypto.timeframes,
      activeIndex: segmentStates.crypto.activeIndex,
      updatedAt: segmentStates.crypto.updatedAt,
      autoRankedAt: segmentStates.crypto.autoRankedAt,
      autoRankingVersion: segmentStates.crypto.autoRankingVersion,
    },
    tradfi: {
      symbols: segmentStates.tradfi.symbols,
      custom: segmentStates.tradfi.custom,
      timeframes: segmentStates.tradfi.timeframes,
      activeIndex: segmentStates.tradfi.activeIndex,
      updatedAt: segmentStates.tradfi.updatedAt,
      autoRankedAt: segmentStates.tradfi.autoRankedAt,
      autoRankingVersion: segmentStates.tradfi.autoRankingVersion,
    },
  }), [
    segmentStates.crypto.activeIndex,
    segmentStates.crypto.autoRankedAt,
    segmentStates.crypto.autoRankingVersion,
    segmentStates.crypto.custom,
    segmentStates.crypto.symbols,
    segmentStates.crypto.timeframes,
    segmentStates.crypto.updatedAt,
    segmentStates.tradfi.activeIndex,
    segmentStates.tradfi.autoRankedAt,
    segmentStates.tradfi.autoRankingVersion,
    segmentStates.tradfi.custom,
    segmentStates.tradfi.symbols,
    segmentStates.tradfi.timeframes,
    segmentStates.tradfi.updatedAt,
  ]);

  useEffect(() => {
    if (!hydrated) return undefined;
    let cancelled = false;
    void withDashboardStorageLock(() => {
      if (cancelled) return;
      try {
        const currentStored = dashboardStorageRoot(STORAGE_KEY);
        const currentLayouts = record(currentStored?.layouts);
        const storedCrypto = normalizeStoredLayout(
          currentLayouts.crypto,
          CRYPTO_WALL_RANKING_VERSION,
        );
        const storedTradfi = normalizeStoredLayout(
          currentLayouts.tradfi,
          TRADFI_WALL_RANKING_VERSION,
        );
        const layouts: Record<MarketSegment, StoredLayout> = {
          crypto: storedCrypto &&
              storedCrypto.updatedAt > persistedLayouts.crypto.updatedAt
            ? storedCrypto
            : persistedLayouts.crypto,
          tradfi: storedTradfi &&
              storedTradfi.updatedAt > persistedLayouts.tradfi.updatedAt
            ? storedTradfi
            : persistedLayouts.tradfi,
        };
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ version: 5, activeSegment, layouts }),
        );
        if (cancelled) return;
        setSegmentStates((current) => {
          const crypto = layouts.crypto.updatedAt > current.crypto.updatedAt
            ? { ...current.crypto, ...layouts.crypto }
            : current.crypto;
          const tradfi = layouts.tradfi.updatedAt > current.tradfi.updatedAt
            ? { ...current.tradfi, ...layouts.tradfi }
            : current.tradfi;
          return crypto === current.crypto && tradfi === current.tradfi
            ? current
            : { crypto, tradfi };
        });
      } catch {
        // Device-local persistence is optional; the active session still works.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeSegment, hydrated, persistedLayouts]);

  useEffect(() => {
    if (!hydrated) return undefined;
    const mergeStoredLayouts = (event: StorageEvent) => {
      if (
        event.key !== STORAGE_KEY ||
        !event.newValue ||
        (event.storageArea && event.storageArea !== window.localStorage)
      ) return;
      try {
        const stored = record(JSON.parse(event.newValue));
        const layouts = record(stored.layouts);
        const remoteCryptoLayout = normalizeStoredLayout(
          layouts.crypto,
          CRYPTO_WALL_RANKING_VERSION,
        );
        const remoteCrypto = remoteCryptoLayout;
        const remoteTradfi = normalizeStoredLayout(
          layouts.tradfi,
          TRADFI_WALL_RANKING_VERSION,
        );
        setSegmentStates((current) => {
          const crypto = remoteCrypto &&
              remoteCrypto.updatedAt > current.crypto.updatedAt
            ? { ...current.crypto, ...remoteCrypto }
            : current.crypto;
          const tradfi = remoteTradfi && remoteTradfi.updatedAt > current.tradfi.updatedAt
            ? { ...current.tradfi, ...remoteTradfi }
            : current.tradfi;
          if (crypto === current.crypto && tradfi === current.tradfi) return current;
          return { crypto, tradfi };
        });
      } catch {
        // Ignore malformed values written by unrelated/older tabs.
      }
    };
    window.addEventListener("storage", mergeStoredLayouts);
    return () => window.removeEventListener("storage", mergeStoredLayouts);
  }, [hydrated]);

  const candidates = useMemo<MultiChartCandidate[]>(
    () => universe.map((item) => ({
      symbol: item.symbol,
      name: item.name,
      currency: item.currency,
      lastPrice: item.lastPrice,
      changeRate: item.changeRate,
      priceTimestamp: item.priceTimestamp,
      tickSize: item.tickSize,
    })),
    [universe],
  );

  const assignSymbolToPickerSlot = useCallback(async (item: UniverseItem) => {
    if (pickerSlotIndex === null) return;
    const targetIndex = pickerSlotIndex;
    const manualAutoRankedAt = targetIndex >= AUTO_WALL_USER_PINNED_SLOT_COUNT
      ? await markAutoWallGuard(activeSegment)
      : 0;
    const latestStoredLayout = readCurrentStoredLayout(activeSegment);
    setSegmentStates((current) => {
      const currentPrevious = current[activeSegment];
      const previous = latestStoredLayout &&
          latestStoredLayout.updatedAt > currentPrevious.updatedAt
        ? { ...currentPrevious, ...latestStoredLayout }
        : currentPrevious;
      if (
        previous.symbols[targetIndex] === item.symbol &&
        previous.activeIndex === targetIndex
      ) {
        if (!manualAutoRankedAt || previous.autoRankedAt === manualAutoRankedAt) {
          return previous === currentPrevious
            ? current
            : { ...current, [activeSegment]: previous };
        }
        return {
          ...current,
          [activeSegment]: {
            ...previous,
            autoRankedAt: manualAutoRankedAt,
            autoRankingVersion: AUTO_WALL_RANKING_VERSION_BY_SEGMENT[activeSegment],
            updatedAt: nextLayoutUpdatedAt(previous),
          },
        };
      }
      return {
        ...current,
        [activeSegment]: {
          ...previous,
          symbols: previous.symbols.map((symbol, index) =>
            index === targetIndex ? item.symbol : symbol,
          ),
          custom: previous.custom.map((value, index) =>
            index === targetIndex ? true : value,
          ),
          activeIndex: targetIndex,
          autoRankedAt: manualAutoRankedAt || previous.autoRankedAt,
          autoRankingVersion: manualAutoRankedAt
            ? AUTO_WALL_RANKING_VERSION_BY_SEGMENT[activeSegment]
            : previous.autoRankingVersion,
          updatedAt: nextLayoutUpdatedAt(previous),
        },
      };
    });
    setPickerAnnouncement(`C${targetIndex + 1}을 ${item.baseAsset}/USDT로 변경했습니다.`);
    dismissSymbolPicker();
  }, [activeSegment, dismissSymbolPicker, pickerSlotIndex]);

  const clearPickerSlot = useCallback(async () => {
    if (pickerSlotIndex === null) return;
    const targetIndex = pickerSlotIndex;
    const manualAutoRankedAt = targetIndex >= AUTO_WALL_USER_PINNED_SLOT_COUNT
      ? await markAutoWallGuard(activeSegment)
      : 0;
    const latestStoredLayout = readCurrentStoredLayout(activeSegment);
    setSegmentStates((current) => {
      const currentPrevious = current[activeSegment];
      const previous = latestStoredLayout &&
          latestStoredLayout.updatedAt > currentPrevious.updatedAt
        ? { ...currentPrevious, ...latestStoredLayout }
        : currentPrevious;
      if (!previous.symbols[targetIndex]) {
        if (!manualAutoRankedAt || previous.autoRankedAt === manualAutoRankedAt) {
          return previous === currentPrevious
            ? current
            : { ...current, [activeSegment]: previous };
        }
        return {
          ...current,
          [activeSegment]: {
            ...previous,
            autoRankedAt: manualAutoRankedAt,
            autoRankingVersion: AUTO_WALL_RANKING_VERSION_BY_SEGMENT[activeSegment],
            updatedAt: nextLayoutUpdatedAt(previous),
          },
        };
      }
      return {
        ...current,
        [activeSegment]: {
          ...previous,
          symbols: previous.symbols.map((symbol, index) =>
            index === targetIndex ? "" : symbol,
          ),
          custom: previous.custom.map((value, index) =>
            index === targetIndex ? false : value,
          ),
          activeIndex: targetIndex,
          autoRankedAt: manualAutoRankedAt || previous.autoRankedAt,
          autoRankingVersion: manualAutoRankedAt
            ? AUTO_WALL_RANKING_VERSION_BY_SEGMENT[activeSegment]
            : previous.autoRankingVersion,
          updatedAt: nextLayoutUpdatedAt(previous),
        },
      };
    });
    setPickerAnnouncement(`C${targetIndex + 1} 종목을 비웠습니다.`);
    dismissSymbolPicker();
  }, [activeSegment, dismissSymbolPicker, pickerSlotIndex]);

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
      assignSymbolToPickerSlot(pickerResults[pickerActiveIndex] ?? pickerResults[0]);
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
  }, [
    assignSymbolToPickerSlot,
    dismissSymbolPicker,
    pickerActiveIndex,
    pickerResults,
  ]);

  const changeAllTimeframes = useCallback((timeframe: ChartTimeframe) => {
    setSegmentStates((current) => {
      const currentPrevious = current[activeSegment];
      const previous = rebaseLatestStoredLayout(
        activeSegment,
        currentPrevious,
      );
      const nextTimeframes = applyTimeframeToAll(
        previous.timeframes,
        timeframe,
        SLOT_COUNT,
      );
      if (nextTimeframes === previous.timeframes) {
        return previous === currentPrevious
          ? current
          : { ...current, [activeSegment]: previous };
      }
      return {
        ...current,
        [activeSegment]: {
          ...previous,
          timeframes: nextTimeframes,
          updatedAt: nextLayoutUpdatedAt(previous),
        },
      };
    });
  }, [activeSegment]);

  const changeActiveTimeframe = useCallback((timeframe: ChartTimeframe) => {
    setSegmentStates((current) => {
      const currentPrevious = current[activeSegment];
      const previous = rebaseLatestStoredLayout(
        activeSegment,
        currentPrevious,
      );
      const nextTimeframes = applyTimeframeToActive(
        previous.timeframes,
        previous.activeIndex,
        timeframe,
        SLOT_COUNT,
      );
      if (nextTimeframes === previous.timeframes) {
        return previous === currentPrevious
          ? current
          : { ...current, [activeSegment]: previous };
      }
      return {
        ...current,
        [activeSegment]: {
          ...previous,
          timeframes: nextTimeframes,
          updatedAt: nextLayoutUpdatedAt(previous),
        },
      };
    });
  }, [activeSegment]);

  const selectSlot = useCallback((index: number) => {
    setSegmentStates((current) => {
      const currentPrevious = current[activeSegment];
      const previous = rebaseLatestStoredLayout(
        activeSegment,
        currentPrevious,
      );
      const nextActiveIndex = Math.max(0, Math.min(SLOT_COUNT - 1, index));
      if (nextActiveIndex === previous.activeIndex) {
        return previous === currentPrevious
          ? current
          : { ...current, [activeSegment]: previous };
      }
      return {
        ...current,
        [activeSegment]: {
          ...previous,
          activeIndex: nextActiveIndex,
          updatedAt: nextLayoutUpdatedAt(previous),
        },
      };
    });
  }, [activeSegment]);

  const retryUniverse = useCallback(() => {
    universeApiRetryAtRef.current[activeSegment] = 0;
    setRetryRevisions((current) => ({
      ...current,
      [activeSegment]: current[activeSegment] + 1,
    }));
  }, [activeSegment]);

  const connectRadarCandidate = useCallback(async (item: BinanceRadarCandidate) => {
    const targetSegment: MarketSegment = item.segment;
    const radarSymbol = item.symbol.trim().toUpperCase();
    const latestStoredLayout = readCurrentStoredLayout(targetSegment);
    const currentTargetState = segmentStates[targetSegment];
    const targetState = latestStoredLayout &&
        latestStoredLayout.updatedAt > currentTargetState.updatedAt
      ? { ...currentTargetState, ...latestStoredLayout }
      : currentTargetState;
    const existingIndex = targetState.symbols.indexOf(radarSymbol);
    const initialTargetIndex = existingIndex >= 0
      ? existingIndex
      : Math.max(0, Math.min(SLOT_COUNT - 1, targetState.activeIndex));
    const manualAutoRankedAt = initialTargetIndex >= AUTO_WALL_USER_PINNED_SLOT_COUNT
      ? await markAutoWallGuard(targetSegment)
      : 0;
    setSegmentStates((current) => {
      const currentPrevious = current[targetSegment];
      const latestStoredAtCommit = readCurrentStoredLayout(targetSegment);
      const previous = latestStoredAtCommit &&
          latestStoredAtCommit.updatedAt > currentPrevious.updatedAt
        ? { ...currentPrevious, ...latestStoredAtCommit }
        : currentPrevious;
      const targetIndex = initialTargetIndex;
      if (
        previous.symbols[targetIndex] === radarSymbol &&
        previous.activeIndex === targetIndex
      ) {
        if (!manualAutoRankedAt || previous.autoRankedAt === manualAutoRankedAt) {
          return previous === currentPrevious
            ? current
            : { ...current, [targetSegment]: previous };
        }
        return {
          ...current,
          [targetSegment]: {
            ...previous,
            autoRankedAt: manualAutoRankedAt,
            autoRankingVersion: AUTO_WALL_RANKING_VERSION_BY_SEGMENT[targetSegment],
            updatedAt: nextLayoutUpdatedAt(previous),
          },
        };
      }
      return {
        ...current,
        [targetSegment]: {
          ...previous,
          symbols: previous.symbols.map((symbol, index) =>
            index === targetIndex ? radarSymbol : symbol,
          ),
          custom: previous.custom.map((value, index) =>
            index === targetIndex ? true : value,
          ),
          activeIndex: targetIndex,
          autoRankedAt: manualAutoRankedAt || previous.autoRankedAt,
          autoRankingVersion: manualAutoRankedAt
            ? AUTO_WALL_RANKING_VERSION_BY_SEGMENT[targetSegment]
            : previous.autoRankingVersion,
          updatedAt: nextLayoutUpdatedAt(previous),
        },
      };
    });
    setActiveSegment(targetSegment);
    setActiveView(targetSegment);
    setPickerAnnouncement(
      `${item.baseAsset}/USDT를 ${targetSegment.toUpperCase()} 차트에 연결했습니다.`,
    );
    window.requestAnimationFrame(() => marketTabRefs.current[targetSegment]?.focus());
  }, [segmentStates]);

  const handleMarketTabKeyDown = useCallback((
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
    if (nextView !== "radar") setActiveSegment(nextView);
    marketTabRefs.current[nextView]?.focus();
  }, []);

  const switchTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  const radarView = activeView === "radar";
  const headerDelayed = !radarView && Boolean(universeError);

  return (
    <main className={styles.shell} data-theme={theme}>
      <div className={styles.ambientOne} aria-hidden="true" />
      <div className={styles.ambientTwo} aria-hidden="true" />

      <header className={styles.topbar}>
        <div className={styles.brandBlock}>
          <div className={styles.brandMark} aria-hidden="true"><i /><i /><i /></div>
          <div>
            <div className={styles.eyebrow}>
              {radarView ? "BINANCE · USDT FUTURES RADAR" : segmentCopy.eyebrow}
            </div>
            <h1>FUTURES FLOW <span>실시간 다중차트</span></h1>
          </div>
        </div>
        <div className={styles.headerControls}>
          <button type="button" className={styles.themeToggle} onClick={switchTheme}>
            <span className={styles.themeGlyph} aria-hidden="true">{theme === "dark" ? "☼" : "◐"}</span>
            <span className={styles.themeLabel}>{theme === "dark" ? "LIGHT" : "DARK"}</span>
          </button>
          <span className={styles.modeChip} data-mode="LIVE" data-delayed={headerDelayed || undefined}>
            <i className={styles.statusDot} />
            {headerDelayed ? "DELAYED" : radarView ? "RADAR" : "LIVE"}
            <span className={styles.feedKind}>
              {radarView
                ? "50·30·20 SCORE"
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

      <div className={styles.marketTabs} role="tablist" aria-label="선물 시장">
        {MARKET_SEGMENTS.map((segment) => {
          const selected = activeView === segment;
          const copy = SEGMENT_COPY[segment];
          return (
            <button
              key={segment}
              ref={(node) => {
                marketTabRefs.current[segment] = node;
              }}
              id={`market-tab-${segment}`}
              type="button"
              role="tab"
              aria-label={copy.tabAriaLabel}
              aria-selected={selected}
              aria-controls="market-panel"
              tabIndex={selected ? 0 : -1}
              className={selected ? styles.marketActive : undefined}
              onClick={() => {
                setActiveSegment(segment);
                setActiveView(segment);
              }}
              onKeyDown={(event) => handleMarketTabKeyDown(event, segment)}
            >
              <strong>{copy.tabLabel}</strong>
              <small>{copy.tabCaption}</small>
            </button>
          );
        })}
        <button
          ref={(node) => {
            marketTabRefs.current.radar = node;
          }}
          id="market-tab-radar"
          type="button"
          role="tab"
          aria-label="통합 선물 관심 종목 레이더"
          aria-selected={activeView === "radar"}
          aria-controls="radar-panel"
          tabIndex={activeView === "radar" ? 0 : -1}
          className={activeView === "radar" ? styles.marketActive : undefined}
          onClick={() => setActiveView("radar")}
          onKeyDown={(event) => handleMarketTabKeyDown(event, "radar")}
        >
          <strong>RADAR</strong>
          <small>통합 관심 종목</small>
        </button>
      </div>

      <section
        id="market-panel"
        className={styles.marketPanel}
        role="tabpanel"
        aria-labelledby={`market-tab-${activeSegment}`}
        aria-busy={!universe.length && !universeError}
        hidden={radarView}
      >
      {universeError && (
        <div className={styles.errorBanner} role="alert">
          <span>!</span>
          <p><strong>{segmentCopy.errorTitle}</strong><small>{universeError} · 마지막 정상 차트는 유지됩니다.</small></p>
          <button
            type="button"
            className={styles.errorRetry}
            onClick={retryUniverse}
          >
            다시 연결
          </button>
        </div>
      )}

      <MultiChartWorkspace
        key={activeSegment}
        segment={activeSegment}
        mode="LIVE"
        theme={theme}
        symbols={symbols}
        timeframes={timeframes}
        activeIndex={activeIndex}
        paused={hidden || radarView}
        candidates={candidates}
        onSelectSlot={selectSlot}
        onRequestSymbolChange={openSymbolPicker}
        onChangeAllTimeframes={changeAllTimeframes}
        onChangeActiveTimeframe={changeActiveTimeframe}
      />

      <footer className={styles.disclaimer}>
        <div><span>i</span><strong>MARKET DATA ONLY</strong></div>
        <p>{segmentCopy.disclaimer}</p>
        <span>BINANCE FUTURES FLOW</span>
      </footer>
      </section>

      <section
        id="radar-panel"
        className={styles.radarPanel}
        role="tabpanel"
        aria-labelledby="market-tab-radar"
        hidden={!radarView}
      >
        <AttentionRadar
          active={radarView}
          onSelectCandidate={connectRadarCandidate}
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
                  C{pickerSlotIndex + 1} · {segmentCopy.tabLabel} · {universe.length} SYMBOLS
                </span>
                <strong id="symbol-picker-title">{segmentCopy.pickerTitle}</strong>
                <small>{segmentCopy.pickerHint}</small>
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
                    ? `symbol-option-${activeSegment}-${pickerResults[pickerActiveIndex].symbol}`
                    : undefined}
                  value={pickerQuery}
                  placeholder="BTC, ETH, GOLD…"
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
              aria-label={`${segmentCopy.tabLabel} 전체 선물 종목`}
            >
              {pickerResults.map((item, index) => {
                const usedSlots = symbols
                  .map((symbol, slotIndex) => symbol === item.symbol ? slotIndex + 1 : 0)
                  .filter(Boolean);
                const selected = symbols[pickerSlotIndex] === item.symbol;
                const usedSlotLabel = usedSlots.length
                  ? usedSlots.map((slot) => `C${slot}`).join(" · ")
                  : "미사용";
                const accessibleRanking = `24시간 거래대금 ${formatCompactUsdt(item.quoteVolume)}, 24시간 등락 ${formatSignedPercent(item.changeRate)}`;
                return (
                  <button
                    key={item.symbol}
                    id={`symbol-option-${activeSegment}-${item.symbol}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    aria-label={`${item.rank}위 ${item.baseAsset}/USDT, ${accessibleRanking}, ${usedSlotLabel}`}
                    className={index === pickerActiveIndex
                      ? styles.symbolOptionActive
                      : undefined}
                    onMouseEnter={() => setPickerActiveIndex(index)}
                    onClick={() => assignSymbolToPickerSlot(item)}
                  >
                    <span className={styles.symbolOptionMark} aria-hidden="true">
                      #{item.rank}
                    </span>
                    <span className={styles.symbolOptionName}>
                      <strong>{item.baseAsset}/USDT</strong>
                      <small>{item.symbol}</small>
                    </span>
                    <span className={styles.symbolOptionMeta}>
                      <strong>24H VOL · {formatCompactUsdt(item.quoteVolume)}</strong>
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
                  <small>심볼이나 기초자산 이름을 다시 입력해 주세요.</small>
                </div>
              )}
            </div>

            <footer className={styles.symbolDialogFooter}>
              <span>같은 종목을 서로 다른 봉으로 여러 슬롯에 배치할 수 있습니다.</span>
              <button
                type="button"
                onClick={clearPickerSlot}
                disabled={!symbols[pickerSlotIndex]}
              >
                C{pickerSlotIndex + 1} 비우기
              </button>
            </footer>
          </div>
        </dialog>
      )}
      <p className={styles.visuallyHidden} role="status" aria-live="polite">
        {pickerAnnouncement}
      </p>
    </main>
  );
}

export default BinanceDashboard;
