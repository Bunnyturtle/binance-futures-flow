export const AUTO_WALL_SLOT_COUNT = 12;
export const AUTO_WALL_REFRESH_MS = 60 * 60_000;
export const AUTO_WALL_USER_PINNED_SLOT_COUNT = 2;
export const AUTO_WALL_RANKED_SLOT_COUNT =
  AUTO_WALL_SLOT_COUNT - AUTO_WALL_USER_PINNED_SLOT_COUNT;
export const CRYPTO_WALL_DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
// Persisted automatic-refresh guards are only compatible with this exact
// ranking contract. Bump this value whenever the wall selection algorithm
// changes so an older browser layout cannot defer the first fresh result.
export const CRYPTO_WALL_RANKING_VERSION =
  "crypto-user-pinned2-quote-volume100-change0-ranked10-v6";
export const TRADFI_WALL_RANKING_VERSION =
  "tradfi-user-pinned2-quote-volume100-change0-ranked10-v3";

export interface AutoWallRankingCandidate {
  symbol: string;
  recommendationRank?: number;
  rankingScore?: number;
  quoteVolume: number;
  lastPrice?: number;
}

function validSymbol(value: string): boolean {
  return /^[A-Z0-9]{5,30}$/.test(value) && value.endsWith("USDT");
}

/**
 * Preserves the user-owned C1/C2 symbols, then fills the remaining slots from
 * the exact 24-hour quote-volume order after excluding the non-empty preserved
 * symbols. The picker catalog may remain in quote-volume order independently.
 */
export function selectAutoWallSymbols(
  candidates: readonly AutoWallRankingCandidate[],
  count = AUTO_WALL_SLOT_COUNT,
  userPinnedSymbols: readonly string[] = [],
): string[] {
  const targetCount = Math.max(
    AUTO_WALL_USER_PINNED_SLOT_COUNT,
    Math.trunc(count),
  );
  const seen = new Set<string>();
  const eligible = candidates
    .filter((candidate) => {
      if (
        !validSymbol(candidate.symbol) ||
        seen.has(candidate.symbol) ||
        !Number.isFinite(candidate.lastPrice) ||
        (candidate.lastPrice ?? 0) <= 0
      ) return false;
      const hasRankingScore = Number.isFinite(candidate.rankingScore);
      const hasRecommendationRank = Number.isInteger(candidate.recommendationRank) &&
        (candidate.recommendationRank ?? 0) > 0;
      if (!hasRecommendationRank || !hasRankingScore) return false;
      seen.add(candidate.symbol);
      return true;
    });
  const ranked = eligible
    .filter((candidate) =>
      (candidate.recommendationRank ?? 0) >= 1 &&
      (candidate.recommendationRank ?? 0) <= targetCount
    )
    .sort((left, right) =>
      (left.recommendationRank as number) - (right.recommendationRank as number)
    );

  if (
    ranked.length !== targetCount ||
    ranked.some(
      (candidate, index) => candidate.recommendationRank !== index + 1,
    )
  ) return [];

  const preservedSymbols = Array.from(
    { length: AUTO_WALL_USER_PINNED_SLOT_COUNT },
    (_, index) => userPinnedSymbols[index]?.trim().toUpperCase() ?? "",
  );
  const excludedSymbols = new Set(preservedSymbols.filter(Boolean));
  const rankedSymbols = ranked
    .filter((candidate) => !excludedSymbols.has(candidate.symbol))
    .slice(0, targetCount - AUTO_WALL_USER_PINNED_SLOT_COUNT)
    .map((candidate) => candidate.symbol);
  if (rankedSymbols.length !== targetCount - AUTO_WALL_USER_PINNED_SLOT_COUNT) {
    return [];
  }
  return [...preservedSymbols, ...rankedSymbols];
}

export function sameSymbolLayout(
  current: readonly string[],
  next: readonly string[],
): boolean {
  return current.length === next.length &&
    current.every((symbol, index) => symbol === next[index]);
}

export function autoWallRefreshDelay(
  lastRankedAt: number,
  now = Date.now(),
): number {
  const safeLastRankedAt = Number.isFinite(lastRankedAt) && lastRankedAt <= now
    ? Math.max(0, lastRankedAt)
    : 0;
  return Math.max(0, safeLastRankedAt + AUTO_WALL_REFRESH_MS - now);
}

// Compatibility exports for server code and older focused tests while the
// implementation is shared by CRYPTO and TRADFI.
export const CRYPTO_WALL_SLOT_COUNT = AUTO_WALL_SLOT_COUNT;
export const CRYPTO_WALL_REFRESH_MS = AUTO_WALL_REFRESH_MS;
export const CRYPTO_WALL_USER_PINNED_SLOT_COUNT = AUTO_WALL_USER_PINNED_SLOT_COUNT;
export const CRYPTO_WALL_RANKED_SLOT_COUNT = AUTO_WALL_RANKED_SLOT_COUNT;
export type CryptoWallRankingCandidate = AutoWallRankingCandidate;
export function selectCryptoWallSymbols(
  candidates: readonly AutoWallRankingCandidate[],
  count = AUTO_WALL_SLOT_COUNT,
  userPinnedSymbols: readonly string[] = CRYPTO_WALL_DEFAULT_SYMBOLS,
): string[] {
  return selectAutoWallSymbols(candidates, count, userPinnedSymbols);
}
export const cryptoWallRefreshDelay = autoWallRefreshDelay;
