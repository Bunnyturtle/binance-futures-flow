import { isUpbitKrwMarket } from "./upbit-market";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const UPBIT_RADAR_ANALYSIS_LIMIT = 40;
export const UPBIT_RADAR_RESULT_LIMIT = 20;
// UI가 15분마다 새로 고치므로 캐시는 그보다 약간 짧게 잡아, 직전 계산이 몇 초
// 걸렸더라도 예정된 갱신이 항상 만료 시점을 넘기도록 합니다.
export const UPBIT_RADAR_RESULT_CACHE_MS = 14 * 60 * 1_000;
export const UPBIT_RADAR_HISTORY_DAYS = 30;
export const UPBIT_RADAR_WEEK_DAYS = 7;
// 시세 조회 그룹은 IP 기준 초당 10회입니다. 동시 6개면 한 요청이 수십 ms 안에
// 끝나더라도 초당 한도에 여유가 남습니다.
export const UPBIT_RADAR_HISTORY_CONCURRENCY = 6;

export interface UpbitRadarSourceCandidate {
  market: string;
  /** 업비트 한글명. 없으면 기초자산 코드. */
  name: string;
  baseAsset: string;
  lastPrice: number;
  /** 업비트 전일 대비 등락률(%). */
  changeRate: number;
  quoteVolume24h: number;
  tickSize: string;
  /** 투자유의 종목 여부. 레이더 행에 배지로 표시합니다. */
  warning: boolean;
}

export interface UpbitRadarDailyCandle {
  openTime: number;
  closeTime: number;
  closePrice: number;
  quoteVolume: number;
}

export interface UpbitRadarCandidate {
  rank: number;
  market: string;
  name: string;
  baseAsset: string;
  lastPrice: number;
  changeRate: number;
  quoteVolume24h: number;
  weekAverageQuoteVolume: number;
  monthAverageQuoteVolume: number;
  weekVsMonthRatio: number;
  dayChangePercent: number;
  weekMetricReady: boolean;
  dayMetricReady: boolean;
  /** 50% 가중치를 적용하기 전 횡단면 백분위입니다. */
  sizeScore: number;
  /** 30% 가중치를 적용하기 전 횡단면 백분위입니다. */
  weekScore: number;
  /** 20% 가중치를 적용하기 전 횡단면 백분위입니다. */
  dayScore: number;
  score: number;
  tickSize: string;
  warning: boolean;
  provisional: boolean;
  evaluatedAt: string;
}

export interface UpbitRadarCoverage {
  eligible: number;
  analyzed: number;
  historyReady: number;
  provisional: number;
  failed: number;
}

export interface UpbitRadarMethodology {
  weights: {
    volumeSize: 0.5;
    weekVsMonth: 0.3;
    dayChange: 0.2;
  };
  analysisLimit: number;
  resultLimit: number;
  historyWindow: "30 completed UTC calendar days";
  weekWindow: "7 completed UTC calendar days";
  dayChange: "last price vs latest completed session close";
  normalization: "full-universe-size-and-analyzed-history-midranks";
}

export interface UpbitRadarResult {
  computedAt: string;
  historyAsOf: string;
  methodology: UpbitRadarMethodology;
  coverage: UpbitRadarCoverage;
  items: UpbitRadarCandidate[];
}

export interface UpbitRadarApiResponse extends UpbitRadarResult {
  mode: "LIVE" | "STALE";
  source: "same-origin" | "browser-public-rest" | "last-good";
  market: "UPBIT";
  scope: "KRW_SPOT";
  timestamp: string;
  evaluatedCount: number;
  eligibleCount: number;
  historyReadyCount: number;
}

export type UpbitRadarHistoryByMarket = ReadonlyMap<
  string,
  readonly UpbitRadarDailyCandle[]
>;

export interface UpbitRadarBuildOptions {
  now?: number;
  limit?: number;
}

export interface UpbitRadarDataSource {
  loadCandidates(): Promise<readonly UpbitRadarSourceCandidate[]>;
  loadHistory(
    candidate: UpbitRadarSourceCandidate,
    range: { startTime: number; endTime: number },
  ): Promise<readonly UpbitRadarDailyCandle[]>;
}

export interface UpbitRadarServiceOptions {
  clock?: () => number;
  resultTtlMs?: number;
  concurrency?: number;
  coalesceInFlight?: boolean;
}

type RawRadarMetrics = {
  candidate: UpbitRadarSourceCandidate;
  weekAverageQuoteVolume: number;
  monthAverageQuoteVolume: number;
  weekVsMonthRatio: number | null;
  dayChangePercent: number | null;
  historyReady: boolean;
  historyFailed: boolean;
};

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function rounded(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function validResultLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > UPBIT_RADAR_RESULT_LIMIT) {
    throw new RangeError(
      `Radar limit must be an integer between 1 and ${UPBIT_RADAR_RESULT_LIMIT}.`,
    );
  }
  return value;
}

function isUsableCandidate(candidate: UpbitRadarSourceCandidate): boolean {
  return isUpbitKrwMarket(candidate.market) &&
    candidate.baseAsset.length > 0 &&
    finitePositive(candidate.lastPrice) &&
    Number.isFinite(candidate.changeRate) &&
    finiteNonNegative(candidate.quoteVolume24h) &&
    finitePositive(Number(candidate.tickSize));
}

function eligibleRadarCandidates(
  candidates: readonly UpbitRadarSourceCandidate[],
): UpbitRadarSourceCandidate[] {
  const unique = new Map<string, UpbitRadarSourceCandidate>();
  for (const candidate of candidates) {
    if (!isUsableCandidate(candidate) || unique.has(candidate.market)) continue;
    unique.set(candidate.market, candidate);
  }
  return [...unique.values()].sort((left, right) =>
    right.quoteVolume24h - left.quoteVolume24h ||
    left.market.localeCompare(right.market)
  );
}

export function selectUpbitRadarAnalysisCandidates(
  candidates: readonly UpbitRadarSourceCandidate[],
): UpbitRadarSourceCandidate[] {
  return eligibleRadarCandidates(candidates).slice(0, UPBIT_RADAR_ANALYSIS_LIMIT);
}

function normalizedHistory(
  history: readonly UpbitRadarDailyCandle[] | undefined,
  monthStart: number,
  todayStart: number,
): UpbitRadarDailyCandle[] {
  const byOpenTime = new Map<number, UpbitRadarDailyCandle>();
  for (const candle of history ?? []) {
    if (
      !Number.isFinite(candle.openTime) ||
      !Number.isFinite(candle.closeTime) ||
      candle.openTime < monthStart ||
      candle.openTime >= todayStart ||
      candle.closeTime >= todayStart ||
      !finitePositive(candle.closePrice) ||
      !finiteNonNegative(candle.quoteVolume)
    ) continue;
    byOpenTime.set(candle.openTime, candle);
  }
  return [...byOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
}

function rawMetricsForCandidate(
  candidate: UpbitRadarSourceCandidate,
  history: readonly UpbitRadarDailyCandle[] | undefined,
  todayStart: number,
): RawRadarMetrics {
  const monthStart = todayStart - UPBIT_RADAR_HISTORY_DAYS * DAY_MS;
  const weekStart = todayStart - UPBIT_RADAR_WEEK_DAYS * DAY_MS;
  const candles = normalizedHistory(history, monthStart, todayStart);
  const monthVolume = candles.reduce((sum, candle) => sum + candle.quoteVolume, 0);
  const recentCandles = candles.filter((candle) => candle.openTime >= weekStart);
  const weekVolume = candles.reduce(
    (sum, candle) => sum + (candle.openTime >= weekStart ? candle.quoteVolume : 0),
    0,
  );
  const weekAverageQuoteVolume = weekVolume / UPBIT_RADAR_WEEK_DAYS;
  const monthAverageQuoteVolume = monthVolume / UPBIT_RADAR_HISTORY_DAYS;
  const earliest = candles[0];
  const latest = candles.at(-1);
  const hasLatestCompletedSession = latest?.openTime === todayStart - DAY_MS;
  // 업비트 일봉은 체결이 있는 날만 생성되므로 신규 상장·거래 공백을 구분하려면
  // 창의 시작 부근에 캔들이 있고 충분한 일수가 모였는지 함께 확인해야 합니다.
  const spansHistoryWindow = Boolean(
    earliest && latest &&
      earliest.openTime <= monthStart + 4 * DAY_MS &&
      hasLatestCompletedSession &&
      candles.length >= 21 &&
      recentCandles.length >= 5,
  );
  const weekVsMonthRatio = spansHistoryWindow && finitePositive(monthAverageQuoteVolume)
    ? weekAverageQuoteVolume / monthAverageQuoteVolume
    : null;
  const dayChangePercent =
    latest && hasLatestCompletedSession && finitePositive(candidate.lastPrice)
      ? (candidate.lastPrice / latest.closePrice - 1) * 100
      : null;
  const historyReady = weekVsMonthRatio !== null && dayChangePercent !== null;
  return {
    candidate,
    weekAverageQuoteVolume,
    monthAverageQuoteVolume,
    weekVsMonthRatio,
    dayChangePercent,
    historyReady,
    historyFailed: history === undefined || candles.length === 0,
  };
}

function midrankPercentiles(
  values: readonly { market: string; value: number }[],
): Map<string, number> {
  const ordered = values
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) =>
      left.value - right.value || left.market.localeCompare(right.market)
    );
  const result = new Map<string, number>();
  if (ordered.length === 0) return result;
  if (ordered.length === 1) {
    result.set(ordered[0].market, 50);
    return result;
  }
  for (let start = 0; start < ordered.length;) {
    let end = start;
    while (end + 1 < ordered.length && ordered[end + 1].value === ordered[start].value) {
      end += 1;
    }
    const percentile = ((start + end) / 2 / (ordered.length - 1)) * 100;
    for (let index = start; index <= end; index += 1) {
      result.set(ordered[index].market, percentile);
    }
    start = end + 1;
  }
  return result;
}

export function buildUpbitRadarResult(
  candidates: readonly UpbitRadarSourceCandidate[],
  histories: UpbitRadarHistoryByMarket,
  options: UpbitRadarBuildOptions = {},
): UpbitRadarResult {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new RangeError("Radar now must be a timestamp.");
  const limit = validResultLimit(options.limit ?? UPBIT_RADAR_RESULT_LIMIT);
  const evaluatedAt = new Date(now).toISOString();
  const todayStart = utcDayStart(now);
  const eligible = eligibleRadarCandidates(candidates);
  const analyzed = eligible.slice(0, UPBIT_RADAR_ANALYSIS_LIMIT);
  const metrics = analyzed.map((candidate) =>
    rawMetricsForCandidate(candidate, histories.get(candidate.market), todayStart)
  );
  // 거래대금 규모는 거래 가능한 KRW 마켓 전체에서, 이력이 필요한 두 지표는
  // 분석군(상위 40) 안에서 백분위를 구합니다.
  const sizePercentiles = midrankPercentiles(eligible.map((candidate) => ({
    market: candidate.market,
    value: candidate.quoteVolume24h,
  })));
  const weekPercentiles = midrankPercentiles(metrics.flatMap((metric) =>
    metric.weekVsMonthRatio === null
      ? []
      : [{ market: metric.candidate.market, value: metric.weekVsMonthRatio }]
  ));
  const dayPercentiles = midrankPercentiles(metrics.flatMap((metric) =>
    metric.dayChangePercent === null
      ? []
      : [{ market: metric.candidate.market, value: metric.dayChangePercent }]
  ));

  const scored = metrics.map((metric): UpbitRadarCandidate => {
    const sizeScore = sizePercentiles.get(metric.candidate.market) ?? 50;
    const weekScore = weekPercentiles.get(metric.candidate.market) ?? 50;
    const dayScore = dayPercentiles.get(metric.candidate.market) ?? 50;
    return {
      rank: 0,
      market: metric.candidate.market,
      name: metric.candidate.name,
      baseAsset: metric.candidate.baseAsset,
      lastPrice: metric.candidate.lastPrice,
      changeRate: metric.candidate.changeRate,
      quoteVolume24h: metric.candidate.quoteVolume24h,
      weekAverageQuoteVolume: rounded(metric.weekAverageQuoteVolume),
      monthAverageQuoteVolume: rounded(metric.monthAverageQuoteVolume),
      weekVsMonthRatio: rounded(metric.weekVsMonthRatio ?? 0, 6),
      dayChangePercent: rounded(metric.dayChangePercent ?? 0),
      weekMetricReady: metric.weekVsMonthRatio !== null,
      dayMetricReady: metric.dayChangePercent !== null,
      sizeScore: rounded(sizeScore),
      weekScore: rounded(weekScore),
      dayScore: rounded(dayScore),
      score: rounded(0.5 * sizeScore + 0.3 * weekScore + 0.2 * dayScore, 2),
      tickSize: metric.candidate.tickSize,
      warning: metric.candidate.warning,
      provisional: !metric.historyReady,
      evaluatedAt,
    };
  }).sort((left, right) =>
    right.score - left.score ||
    right.quoteVolume24h - left.quoteVolume24h ||
    left.market.localeCompare(right.market)
  ).slice(0, limit).map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  const historyReady = metrics.filter((metric) => metric.historyReady).length;
  const failed = metrics.filter((metric) => metric.historyFailed).length;
  return {
    computedAt: evaluatedAt,
    historyAsOf: new Date(todayStart - DAY_MS).toISOString().slice(0, 10),
    methodology: {
      weights: { volumeSize: 0.5, weekVsMonth: 0.3, dayChange: 0.2 },
      analysisLimit: UPBIT_RADAR_ANALYSIS_LIMIT,
      resultLimit: limit,
      historyWindow: "30 completed UTC calendar days",
      weekWindow: "7 completed UTC calendar days",
      dayChange: "last price vs latest completed session close",
      normalization: "full-universe-size-and-analyzed-history-midranks",
    },
    coverage: {
      eligible: eligible.length,
      analyzed: metrics.length,
      historyReady,
      provisional: metrics.length - historyReady,
      failed,
    },
    items: scored,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
  isFatal: (reason: unknown) => boolean = () => false,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  let fatalError: unknown;
  async function runWorker() {
    while (fatalError === undefined && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
        if (isFatal(reason)) fatalError = reason;
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => runWorker(),
  ));
  if (fatalError !== undefined) throw fatalError;
  return results;
}

/**
 * 429(초당 한도 초과)와 418(누적 위반 차단)은 개별 종목 문제가 아니라 IP 전체에
 * 걸린 상태이므로, 남은 요청을 계속 보내 상황을 악화시키지 않고 즉시 중단합니다.
 */
function isFatalRadarHistoryError(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  const status = "status" in reason ? Number(reason.status) : 0;
  const code = "code" in reason ? String(reason.code) : "";
  return status >= 500 ||
    status === 418 ||
    status === 429 ||
    status === 451 ||
    status === 403 ||
    code === "edge-blocked" ||
    code === "network-error" ||
    code === "request-timeout";
}

export class UpbitRadarService {
  private readonly source: UpbitRadarDataSource;
  private readonly clock: () => number;
  private readonly resultTtlMs: number;
  private readonly concurrency: number;
  private readonly coalesceInFlight: boolean;
  private cached: { expiresAt: number; result: UpbitRadarResult } | null = null;
  private flight: Promise<UpbitRadarResult> | null = null;

  constructor(source: UpbitRadarDataSource, options: UpbitRadarServiceOptions = {}) {
    this.source = source;
    this.clock = options.clock ?? Date.now;
    this.resultTtlMs = options.resultTtlMs ?? UPBIT_RADAR_RESULT_CACHE_MS;
    this.concurrency = options.concurrency ?? UPBIT_RADAR_HISTORY_CONCURRENCY;
    this.coalesceInFlight = options.coalesceInFlight ?? true;
    if (!Number.isFinite(this.resultTtlMs) || this.resultTtlMs < 0) {
      throw new RangeError("Radar resultTtlMs must be a non-negative number.");
    }
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 10) {
      throw new RangeError("Radar concurrency must be an integer between 1 and 10.");
    }
  }

  async getRadar(limit = UPBIT_RADAR_RESULT_LIMIT): Promise<UpbitRadarResult> {
    const normalizedLimit = validResultLimit(limit);
    const now = this.clock();
    if (this.cached && this.cached.expiresAt > now) {
      return this.withLimit(this.cached.result, normalizedLimit);
    }
    if (!this.coalesceInFlight) {
      return this.withLimit(await this.build(), normalizedLimit);
    }
    if (!this.flight) {
      const flight = this.build();
      this.flight = flight;
      const clear = () => {
        if (this.flight === flight) this.flight = null;
      };
      void flight.then(clear, clear);
    }
    return this.withLimit(await this.flight, normalizedLimit);
  }

  clear(): void {
    this.cached = null;
    this.flight = null;
  }

  private async build(): Promise<UpbitRadarResult> {
    const candidates = await this.source.loadCandidates();
    const analyzed = selectUpbitRadarAnalysisCandidates(candidates);
    if (analyzed.length === 0) {
      throw new Error("Upbit radar source contained no usable KRW market candidates.");
    }
    const now = this.clock();
    const todayStart = utcDayStart(now);
    const range = {
      startTime: todayStart - UPBIT_RADAR_HISTORY_DAYS * DAY_MS,
      endTime: todayStart - 1,
    };
    const settled = await mapWithConcurrency(
      analyzed,
      this.concurrency,
      (candidate) => this.source.loadHistory(candidate, range),
      isFatalRadarHistoryError,
    );
    const histories = new Map<string, readonly UpbitRadarDailyCandle[]>();
    settled.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.length > 0) {
        histories.set(analyzed[index].market, result.value);
      }
    });
    if (histories.size === 0) {
      throw new Error(
        "Upbit radar could not load any completed daily history; public fallback is required.",
      );
    }
    const built = buildUpbitRadarResult(candidates, histories, {
      now,
      limit: UPBIT_RADAR_RESULT_LIMIT,
    });
    if (built.coverage.historyReady === 0) {
      throw new Error(
        "Upbit radar did not contain a current completed daily history window; public fallback is required.",
      );
    }
    this.cached = { result: built, expiresAt: this.clock() + this.resultTtlMs };
    return built;
  }

  private withLimit(result: UpbitRadarResult, limit: number): UpbitRadarResult {
    if (limit === UPBIT_RADAR_RESULT_LIMIT) return result;
    return {
      ...result,
      methodology: { ...result.methodology, resultLimit: limit },
      items: result.items.slice(0, limit).map((item, index) => ({ ...item, rank: index + 1 })),
    };
  }
}
