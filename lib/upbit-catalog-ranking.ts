export const UPBIT_CATALOG_VOLUME_WEIGHT = 1;
export const UPBIT_CATALOG_CHANGE_WEIGHT = 0;
export const UPBIT_CATALOG_NEUTRAL_SCORE = 50;

export interface UpbitCatalogRankingInput {
  market: string;
  /** 24시간 누적 거래대금(KRW). */
  quoteVolume: number;
  /** 전일 대비 등락률(%). 값이 없으면 null. */
  changeRate: number | null;
}

export interface UpbitCatalogRankingScores {
  rankingScore: number;
  volumeScore: number;
  changeScore: number;
  recommendationRank: number;
}

export type UpbitCatalogRanked<T extends UpbitCatalogRankingInput> =
  T & UpbitCatalogRankingScores;

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizedVolume(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function midrankPercentiles(
  entries: readonly { market: string; value: number }[],
): Map<string, number> {
  const ordered = entries
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) =>
      left.value - right.value || left.market.localeCompare(right.market)
    );
  const scores = new Map<string, number>();
  if (ordered.length === 0) return scores;
  if (ordered.length === 1) {
    scores.set(ordered[0].market, UPBIT_CATALOG_NEUTRAL_SCORE);
    return scores;
  }
  for (let start = 0; start < ordered.length;) {
    let end = start;
    while (end + 1 < ordered.length && ordered[end + 1].value === ordered[start].value) {
      end += 1;
    }
    const percentile = ((start + end) / 2 / (ordered.length - 1)) * 100;
    for (let index = start; index <= end; index += 1) {
      scores.set(ordered[index].market, percentile);
    }
    start = end + 1;
  }
  return scores;
}

/**
 * 거래 가능한 KRW 마켓 전체를 하나의 모집단으로 보고 백분위 점수를 매깁니다.
 * `recommendationRank`는 24시간 거래대금 내림차순 그대로이며, 등락률 백분위는
 * 표시용 메타데이터로만 남습니다(가중치 0).
 */
export function rankUpbitCatalog<T extends UpbitCatalogRankingInput>(
  items: readonly T[],
): UpbitCatalogRanked<T>[] {
  const volumeScores = midrankPercentiles(items.map((item) => ({
    market: item.market,
    value: normalizedVolume(item.quoteVolume),
  })));
  const changeScores = midrankPercentiles(items.flatMap((item) =>
    item.changeRate !== null && Number.isFinite(item.changeRate)
      ? [{ market: item.market, value: item.changeRate }]
      : []
  ));

  const scored = items.map((item) => {
    const volumeScore = volumeScores.get(item.market) ?? UPBIT_CATALOG_NEUTRAL_SCORE;
    const changeScore = item.changeRate !== null && Number.isFinite(item.changeRate)
      ? changeScores.get(item.market) ?? UPBIT_CATALOG_NEUTRAL_SCORE
      : UPBIT_CATALOG_NEUTRAL_SCORE;
    const rawRankingScore =
      UPBIT_CATALOG_VOLUME_WEIGHT * volumeScore +
      UPBIT_CATALOG_CHANGE_WEIGHT * changeScore;
    return {
      item: {
        ...item,
        quoteVolume: normalizedVolume(item.quoteVolume),
        rankingScore: rounded(rawRankingScore),
        volumeScore: rounded(volumeScore),
        changeScore: rounded(changeScore),
        recommendationRank: 0,
      } as UpbitCatalogRanked<T>,
      rawRankingScore,
    };
  });

  [...scored]
    .sort((left, right) =>
      right.rawRankingScore - left.rawRankingScore ||
      right.item.quoteVolume - left.item.quoteVolume ||
      left.item.market.localeCompare(right.item.market)
    )
    .forEach(({ item }, index) => {
      item.recommendationRank = index + 1;
    });

  return scored
    .map(({ item }) => item)
    .sort((left, right) =>
      right.quoteVolume - left.quoteVolume ||
      left.market.localeCompare(right.market)
    );
}
