export const BINANCE_WEIGHTED_CATALOG_VOLUME_WEIGHT = 1;
export const BINANCE_WEIGHTED_CATALOG_CHANGE_WEIGHT = 0;
export const BINANCE_WEIGHTED_CATALOG_NEUTRAL_SCORE = 50;

/** Backwards-compatible aliases retained for existing CRYPTO consumers. */
export const BINANCE_CRYPTO_CATALOG_VOLUME_WEIGHT = BINANCE_WEIGHTED_CATALOG_VOLUME_WEIGHT;
export const BINANCE_CRYPTO_CATALOG_CHANGE_WEIGHT = BINANCE_WEIGHTED_CATALOG_CHANGE_WEIGHT;
export const BINANCE_CRYPTO_CATALOG_NEUTRAL_SCORE = BINANCE_WEIGHTED_CATALOG_NEUTRAL_SCORE;

export interface BinanceWeightedCatalogRankingInput {
  symbol: string;
  quoteVolume: number;
  changeRate: number | null;
}

export interface BinanceWeightedCatalogRankingScores {
  rankingScore: number;
  volumeScore: number;
  changeScore: number;
  recommendationRank: number;
}

export type BinanceWeightedCatalogRanked<T extends BinanceWeightedCatalogRankingInput> =
  T & BinanceWeightedCatalogRankingScores;

export type BinanceCryptoCatalogRankingInput = BinanceWeightedCatalogRankingInput;
export type BinanceCryptoCatalogRankingScores = BinanceWeightedCatalogRankingScores;
export type BinanceCryptoCatalogRanked<T extends BinanceCryptoCatalogRankingInput> =
  BinanceWeightedCatalogRanked<T>;

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizedVolume(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function midrankPercentiles(
  entries: readonly { symbol: string; value: number }[],
): Map<string, number> {
  const ordered = entries
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) => left.value - right.value || left.symbol.localeCompare(right.symbol));
  const scores = new Map<string, number>();
  if (ordered.length === 0) return scores;
  if (ordered.length === 1) {
    scores.set(ordered[0].symbol, BINANCE_WEIGHTED_CATALOG_NEUTRAL_SCORE);
    return scores;
  }
  for (let start = 0; start < ordered.length;) {
    let end = start;
    while (end + 1 < ordered.length && ordered[end + 1].value === ordered[start].value) {
      end += 1;
    }
    const percentile = ((start + end) / 2 / (ordered.length - 1)) * 100;
    for (let index = start; index <= end; index += 1) {
      scores.set(ordered[index].symbol, percentile);
    }
    start = end + 1;
  }
  return scores;
}

/**
 * Scores one complete eligible market segment as a cross-sectional population.
 * Missing or invalid price changes are excluded from that component's percentile
 * population and receive the fixed neutral score of 50. recommendationRank keeps
 * the exact 24-hour quote-volume ordering. Price-change percentiles remain in
 * the catalog as display metadata but do not affect recommendationRank.
 */
export function rankBinanceWeightedCatalog<T extends BinanceWeightedCatalogRankingInput>(
  items: readonly T[],
): BinanceWeightedCatalogRanked<T>[] {
  const volumeScores = midrankPercentiles(items.map((item) => ({
    symbol: item.symbol,
    value: normalizedVolume(item.quoteVolume),
  })));
  const changeScores = midrankPercentiles(items.flatMap((item) =>
    item.changeRate !== null && Number.isFinite(item.changeRate)
      ? [{ symbol: item.symbol, value: item.changeRate }]
      : []
  ));

  const scored = items.map((item) => {
    const volumeScore = volumeScores.get(item.symbol) ?? BINANCE_WEIGHTED_CATALOG_NEUTRAL_SCORE;
    const changeScore = item.changeRate !== null && Number.isFinite(item.changeRate)
      ? changeScores.get(item.symbol) ?? BINANCE_WEIGHTED_CATALOG_NEUTRAL_SCORE
      : BINANCE_WEIGHTED_CATALOG_NEUTRAL_SCORE;
    const rawRankingScore =
      BINANCE_WEIGHTED_CATALOG_VOLUME_WEIGHT * volumeScore +
      BINANCE_WEIGHTED_CATALOG_CHANGE_WEIGHT * changeScore;
    return {
      item: {
        ...item,
        quoteVolume: normalizedVolume(item.quoteVolume),
        rankingScore: rounded(rawRankingScore),
        volumeScore: rounded(volumeScore),
        changeScore: rounded(changeScore),
        recommendationRank: 0,
      } as BinanceWeightedCatalogRanked<T>,
      rawRankingScore,
    };
  });

  [...scored]
    .sort((left, right) =>
      right.rawRankingScore - left.rawRankingScore ||
      right.item.quoteVolume - left.item.quoteVolume ||
      left.item.symbol.localeCompare(right.item.symbol)
    )
    .forEach(({ item }, index) => {
      item.recommendationRank = index + 1;
    });

  return scored
    .map(({ item }) => item)
    .sort((left, right) =>
      right.quoteVolume - left.quoteVolume ||
      left.symbol.localeCompare(right.symbol)
    );
}

/** Backwards-compatible alias for the original CRYPTO-only export name. */
export const rankBinanceCryptoCatalog = rankBinanceWeightedCatalog;
