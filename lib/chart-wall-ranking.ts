import { isUpbitKrwMarket } from "./upbit-market";

export const WALL_SLOT_COUNT = 12;
export const WALL_REFRESH_MS = 60 * 60_000;
export const WALL_USER_PINNED_SLOT_COUNT = 2;
export const WALL_RANKED_SLOT_COUNT = WALL_SLOT_COUNT - WALL_USER_PINNED_SLOT_COUNT;
export const WALL_DEFAULT_MARKETS = ["KRW-BTC", "KRW-ETH"] as const;

// 브라우저에 저장된 자동 배열 잠금은 이 랭킹 계약에서만 유효합니다. 선택
// 알고리즘을 바꿀 때마다 값을 올려 오래된 레이아웃이 첫 갱신을 미루지 못하게 합니다.
export const WALL_RANKING_VERSION = "upbit-krw-pinned2-quote-volume100-ranked10-v1";

export interface WallRankingCandidate {
  market: string;
  recommendationRank?: number;
  rankingScore?: number;
  quoteVolume: number;
  lastPrice?: number;
}

/**
 * 사용자가 지정한 C1·C2를 그대로 두고, 남은 슬롯을 24시간 거래대금 순위에서
 * 비어 있지 않은 고정 종목을 제외한 상위 종목으로 채웁니다. 순위 1~12가 완전하지
 * 않으면 빈 배열을 돌려주어 호출 측이 자동 배열을 건너뛰게 합니다.
 */
export function selectWallMarkets(
  candidates: readonly WallRankingCandidate[],
  count = WALL_SLOT_COUNT,
  userPinnedMarkets: readonly string[] = [],
): string[] {
  const targetCount = Math.max(WALL_USER_PINNED_SLOT_COUNT, Math.trunc(count));
  const seen = new Set<string>();
  const eligible = candidates.filter((candidate) => {
    if (
      !isUpbitKrwMarket(candidate.market) ||
      seen.has(candidate.market) ||
      !Number.isFinite(candidate.lastPrice) ||
      (candidate.lastPrice ?? 0) <= 0
    ) return false;
    const hasRankingScore = Number.isFinite(candidate.rankingScore);
    const hasRecommendationRank = Number.isInteger(candidate.recommendationRank) &&
      (candidate.recommendationRank ?? 0) > 0;
    if (!hasRecommendationRank || !hasRankingScore) return false;
    seen.add(candidate.market);
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
    ranked.some((candidate, index) => candidate.recommendationRank !== index + 1)
  ) return [];

  const preserved = Array.from(
    { length: WALL_USER_PINNED_SLOT_COUNT },
    (_, index) => userPinnedMarkets[index]?.trim().toUpperCase() ?? "",
  );
  const excluded = new Set(preserved.filter(Boolean));
  const rankedMarkets = ranked
    .filter((candidate) => !excluded.has(candidate.market))
    .slice(0, targetCount - WALL_USER_PINNED_SLOT_COUNT)
    .map((candidate) => candidate.market);
  if (rankedMarkets.length !== targetCount - WALL_USER_PINNED_SLOT_COUNT) return [];
  return [...preserved, ...rankedMarkets];
}

export function sameMarketLayout(
  current: readonly string[],
  next: readonly string[],
): boolean {
  return current.length === next.length &&
    current.every((market, index) => market === next[index]);
}

export function wallRefreshDelay(lastRankedAt: number, now = Date.now()): number {
  const safeLastRankedAt = Number.isFinite(lastRankedAt) && lastRankedAt <= now
    ? Math.max(0, lastRankedAt)
    : 0;
  return Math.max(0, safeLastRankedAt + WALL_REFRESH_MS - now);
}
