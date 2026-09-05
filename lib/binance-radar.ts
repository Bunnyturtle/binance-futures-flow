const DAY_MS = 24 * 60 * 60 * 1_000;

export const BINANCE_RADAR_ANALYSIS_LIMIT = 40;
export const BINANCE_RADAR_RESULT_LIMIT = 20;
// Keep the cache slightly shorter than the 15-minute UI poll so each scheduled
// refresh crosses the service expiry even when the previous build took seconds.
export const BINANCE_RADAR_RESULT_CACHE_MS = 14 * 60 * 1_000;
export const BINANCE_RADAR_HISTORY_DAYS = 30;
export const BINANCE_RADAR_WEEK_DAYS = 7;
export const BINANCE_RADAR_HISTORY_CONCURRENCY = 6;

export type BinanceRadarSegment = "crypto" | "tradfi";

export interface BinanceRadarSourceCandidate {
  symbol: string;
  name: string;
  baseAsset: string;
  segment: BinanceRadarSegment;
  lastPrice: number;
  /** Binance rolling 24-hour priceChangePercent. */
  changeRate: number;
  quoteVolume24h: number;
  tickSize: string;
  onboardDate?: number;
}

export interface BinanceRadarDailyCandle {
  openTime: number;
  closeTime: number;
  closePrice: number;
  quoteVolume: number;
}

export interface BinanceRadarCandidate {
  rank: number;
  symbol: string;
  name: string;
  baseAsset: string;
  segment: BinanceRadarSegment;
  lastPrice: number;
  changeRate: number;
  quoteVolume24h: number;
  weekAverageQuoteVolume: number;
  monthAverageQuoteVolume: number;
  weekVsMonthRatio: number;
  dayChangePercent: number;
  weekMetricReady: boolean;
  dayMetricReady: boolean;
  /** Cross-sectional percentile before applying the 50% weight. */
  sizeScore: number;
  /** Cross-sectional percentile before applying the 30% weight. */
  weekScore: number;
  /** Cross-sectional percentile before applying the 20% weight. */
  dayScore: number;
  score: number;
  tickSize: string;
  provisional: boolean;
  evaluatedAt: string;
}

export interface BinanceRadarCoverage {
  eligible: number;
  analyzed: number;
  historyReady: number;
  provisional: number;
  failed: number;
}

export interface BinanceRadarMethodology {
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

export interface BinanceRadarResult {
  computedAt: string;
  historyAsOf: string;
  methodology: BinanceRadarMethodology;
  coverage: BinanceRadarCoverage;
  items: BinanceRadarCandidate[];
}

export interface BinanceRadarApiResponse extends BinanceRadarResult {
  mode: "LIVE" | "STALE";
  source: "same-origin" | "browser-public-rest" | "last-good";
  market: "USD-M";
  scope: "USDT_PERPETUAL";
  timestamp: string;
  evaluatedCount: number;
  eligibleCount: number;
  historyReadyCount: number;
}

export type BinanceRadarHistoryBySymbol = ReadonlyMap<
  string,
  readonly BinanceRadarDailyCandle[]
>;

export interface BinanceRadarBuildOptions {
  now?: number;
  limit?: number;
}

export interface BinanceRadarDataSource {
  loadCandidates(): Promise<readonly BinanceRadarSourceCandidate[]>;
  loadHistory(
    candidate: BinanceRadarSourceCandidate,
    range: { startTime: number; endTime: number },
  ): Promise<readonly BinanceRadarDailyCandle[]>;
}

export interface BinanceRadarServiceOptions {
  clock?: () => number;
  resultTtlMs?: number;
  concurrency?: number;
  coalesceInFlight?: boolean;
}

type RawRadarMetrics = {
  candidate: BinanceRadarSourceCandidate;
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
  if (!Number.isInteger(value) || value < 1 || value > BINANCE_RADAR_RESULT_LIMIT) {
    throw new RangeError(
      `Radar limit must be an integer between 1 and ${BINANCE_RADAR_RESULT_LIMIT}.`,
    );
  }
  return value;
}

function isUsableCandidate(candidate: BinanceRadarSourceCandidate): boolean {
  return /^[A-Z0-9_]{5,30}$/.test(candidate.symbol) &&
    candidate.symbol.endsWith("USDT") &&
    candidate.baseAsset.length > 0 &&
    (candidate.segment === "crypto" || candidate.segment === "tradfi") &&
    finitePositive(candidate.lastPrice) &&
    Number.isFinite(candidate.changeRate) &&
    finiteNonNegative(candidate.quoteVolume24h) &&
    finitePositive(Number(candidate.tickSize));
}

function eligibleBinanceRadarCandidates(
  candidates: readonly BinanceRadarSourceCandidate[],
): BinanceRadarSourceCandidate[] {
  const unique = new Map<string, BinanceRadarSourceCandidate>();
  for (const candidate of candidates) {
    if (!isUsableCandidate(candidate) || unique.has(candidate.symbol)) continue;
    unique.set(candidate.symbol, candidate);
  }
  return [...unique.values()].sort((left, right) =>
    right.quoteVolume24h - left.quoteVolume24h ||
    left.symbol.localeCompare(right.symbol)
  );
}

export function selectBinanceRadarAnalysisCandidates(
  candidates: readonly BinanceRadarSourceCandidate[],
): BinanceRadarSourceCandidate[] {
  return eligibleBinanceRadarCandidates(candidates).slice(0, BINANCE_RADAR_ANALYSIS_LIMIT);
}

function normalizedHistory(
  history: readonly BinanceRadarDailyCandle[] | undefined,
  monthStart: number,
  todayStart: number,
): BinanceRadarDailyCandle[] {
  const byOpenTime = new Map<number, BinanceRadarDailyCandle>();
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
  candidate: BinanceRadarSourceCandidate,
  history: readonly BinanceRadarDailyCandle[] | undefined,
  todayStart: number,
): RawRadarMetrics {
  const monthStart = todayStart - BINANCE_RADAR_HISTORY_DAYS * DAY_MS;
  const weekStart = todayStart - BINANCE_RADAR_WEEK_DAYS * DAY_MS;
  const candles = normalizedHistory(history, monthStart, todayStart);
  const monthVolume = candles.reduce((sum, candle) => sum + candle.quoteVolume, 0);
  const recentCandles = candles.filter((candle) => candle.openTime >= weekStart);
  const weekVolume = candles.reduce(
    (sum, candle) => sum + (candle.openTime >= weekStart ? candle.quoteVolume : 0),
    0,
  );
  const weekAverageQuoteVolume = weekVolume / BINANCE_RADAR_WEEK_DAYS;
  const monthAverageQuoteVolume = monthVolume / BINANCE_RADAR_HISTORY_DAYS;
  const earliest = candles[0];
  const latest = candles.at(-1);
  const hasLatestCompletedSession = latest?.openTime === todayStart - DAY_MS;
  const wasListedForFullWindow = candidate.onboardDate === undefined
    ? Boolean(earliest && earliest.openTime <= monthStart + 4 * DAY_MS)
    : candidate.onboardDate <= monthStart;
  const spansHistoryWindow = Boolean(
    earliest && latest &&
      earliest.openTime <= monthStart + 4 * DAY_MS &&
      hasLatestCompletedSession &&
      candles.length >= 21 &&
      recentCandles.length >= 5,
  );
  const weekVsMonthRatio =
    wasListedForFullWindow &&
      spansHistoryWindow &&
      finitePositive(monthAverageQuoteVolume)
      ? weekAverageQuoteVolume / monthAverageQuoteVolume
      : null;
  const dayChangePercent = latest && hasLatestCompletedSession && finitePositive(candidate.lastPrice)
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
  values: readonly { symbol: string; value: number }[],
): Map<string, number> {
  const ordered = values
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) => left.value - right.value || left.symbol.localeCompare(right.symbol));
  const result = new Map<string, number>();
  if (ordered.length === 0) return result;
  if (ordered.length === 1) {
    result.set(ordered[0].symbol, 50);
    return result;
  }
  for (let start = 0; start < ordered.length;) {
    let end = start;
    while (end + 1 < ordered.length && ordered[end + 1].value === ordered[start].value) {
      end += 1;
    }
    const percentile = ((start + end) / 2 / (ordered.length - 1)) * 100;
    for (let index = start; index <= end; index += 1) {
      result.set(ordered[index].symbol, percentile);
    }
    start = end + 1;
  }
  return result;
}

export function buildBinanceRadarResult(
  candidates: readonly BinanceRadarSourceCandidate[],
  histories: BinanceRadarHistoryBySymbol,
  options: BinanceRadarBuildOptions = {},
): BinanceRadarResult {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new RangeError("Radar now must be a timestamp.");
  const limit = validResultLimit(options.limit ?? BINANCE_RADAR_RESULT_LIMIT);
  const evaluatedAt = new Date(now).toISOString();
  const todayStart = utcDayStart(now);
  const eligible = eligibleBinanceRadarCandidates(candidates);
  const analyzed = eligible.slice(0, BINANCE_RADAR_ANALYSIS_LIMIT);
  const metrics = analyzed.map((candidate) =>
    rawMetricsForCandidate(candidate, histories.get(candidate.symbol), todayStart)
  );
  const sizePercentiles = midrankPercentiles(eligible.map((candidate) => ({
    symbol: candidate.symbol,
    value: candidate.quoteVolume24h,
  })));
  const weekPercentiles = midrankPercentiles(metrics.flatMap((metric) =>
    metric.weekVsMonthRatio === null
      ? []
      : [{ symbol: metric.candidate.symbol, value: metric.weekVsMonthRatio }]
  ));
  const dayPercentiles = midrankPercentiles(metrics.flatMap((metric) =>
    metric.dayChangePercent === null
      ? []
      : [{ symbol: metric.candidate.symbol, value: metric.dayChangePercent }]
  ));

  const scored = metrics.map((metric): BinanceRadarCandidate => {
    const sizeScore = sizePercentiles.get(metric.candidate.symbol) ?? 50;
    const weekScore = weekPercentiles.get(metric.candidate.symbol) ?? 50;
    const dayScore = dayPercentiles.get(metric.candidate.symbol) ?? 50;
    return {
      rank: 0,
      symbol: metric.candidate.symbol,
      name: metric.candidate.name,
      baseAsset: metric.candidate.baseAsset,
      segment: metric.candidate.segment,
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
      provisional: !metric.historyReady,
      evaluatedAt,
    };
  }).sort((left, right) =>
    right.score - left.score ||
    right.quoteVolume24h - left.quoteVolume24h ||
    left.symbol.localeCompare(right.symbol)
  ).slice(0, limit).map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  const historyReady = metrics.filter((metric) => metric.historyReady).length;
  const failed = metrics.filter((metric) => metric.historyFailed).length;
  return {
    computedAt: evaluatedAt,
    historyAsOf: new Date(todayStart - DAY_MS).toISOString().slice(0, 10),
    methodology: {
      weights: { volumeSize: 0.5, weekVsMonth: 0.3, dayChange: 0.2 },
      analysisLimit: BINANCE_RADAR_ANALYSIS_LIMIT,
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

export class BinanceRadarService {
  private readonly source: BinanceRadarDataSource;
  private readonly clock: () => number;
  private readonly resultTtlMs: number;
  private readonly concurrency: number;
  private readonly coalesceInFlight: boolean;
  private cached: { expiresAt: number; result: BinanceRadarResult } | null = null;
  private flight: Promise<BinanceRadarResult> | null = null;

  constructor(source: BinanceRadarDataSource, options: BinanceRadarServiceOptions = {}) {
    this.source = source;
    this.clock = options.clock ?? Date.now;
    this.resultTtlMs = options.resultTtlMs ?? BINANCE_RADAR_RESULT_CACHE_MS;
    this.concurrency = options.concurrency ?? BINANCE_RADAR_HISTORY_CONCURRENCY;
    this.coalesceInFlight = options.coalesceInFlight ?? true;
    if (!Number.isFinite(this.resultTtlMs) || this.resultTtlMs < 0) {
      throw new RangeError("Radar resultTtlMs must be a non-negative number.");
    }
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 12) {
      throw new RangeError("Radar concurrency must be an integer between 1 and 12.");
    }
  }

  async getRadar(limit = BINANCE_RADAR_RESULT_LIMIT): Promise<BinanceRadarResult> {
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

  private async build(): Promise<BinanceRadarResult> {
    const candidates = await this.source.loadCandidates();
    const analyzed = selectBinanceRadarAnalysisCandidates(candidates);
    if (analyzed.length === 0) {
      throw new Error("Binance radar source contained no usable USDT perpetual candidates.");
    }
    const now = this.clock();
    const todayStart = utcDayStart(now);
    const range = {
      startTime: todayStart - BINANCE_RADAR_HISTORY_DAYS * DAY_MS,
      endTime: todayStart - 1,
    };
    const settled = await mapWithConcurrency(
      analyzed,
      this.concurrency,
      (candidate) => this.source.loadHistory(candidate, range),
      isFatalRadarHistoryError,
    );
    const histories = new Map<string, readonly BinanceRadarDailyCandle[]>();
    settled.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.length > 0) {
        histories.set(analyzed[index].symbol, result.value);
      }
    });
    if (analyzed.length > 0 && histories.size === 0) {
      throw new Error(
        "Binance radar could not load any completed daily history; public fallback is required.",
      );
    }
    const built = buildBinanceRadarResult(candidates, histories, {
      now,
      limit: BINANCE_RADAR_RESULT_LIMIT,
    });
    if (built.coverage.historyReady === 0) {
      throw new Error(
        "Binance radar did not contain a current completed daily history window; public fallback is required.",
      );
    }
    this.cached = { result: built, expiresAt: this.clock() + this.resultTtlMs };
    return built;
  }

  private withLimit(result: BinanceRadarResult, limit: number): BinanceRadarResult {
    if (limit === BINANCE_RADAR_RESULT_LIMIT) return result;
    return {
      ...result,
      methodology: { ...result.methodology, resultLimit: limit },
      items: result.items.slice(0, limit).map((item, index) => ({ ...item, rank: index + 1 })),
    };
  }
}
