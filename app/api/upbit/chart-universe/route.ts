import {
  UPBIT_DEFAULT_CHART_MARKETS,
  UPBIT_RANKED_CHART_SLOT_COUNT,
  UPBIT_USER_PINNED_CHART_SLOT_COUNT,
  assertExactWallRecommendation,
  getUpbitMarketDataServiceFromEnv,
  responseStatusForUpbitError,
  usableWallRecommendationRankCount,
} from "@/lib/upbit-client";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const PUBLIC_CATALOG_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30",
};

export async function GET(): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const items = await getUpbitMarketDataServiceFromEnv().getMarketCatalog();
    assertExactWallRecommendation(items);
    return Response.json(
      {
        schemaVersion: 1,
        mode: "LIVE",
        exchange: "UPBIT",
        market: "KRW",
        sort: "quoteVolume",
        order: "desc",
        window: "24h",
        refreshInterval: "30m",
        chartWallRecommendation: {
          sort: "quoteVolume",
          order: "desc",
          count: 12,
          available: true,
          availableRankCount: usableWallRecommendationRankCount(items),
          userPinnedSlots: Array.from(
            { length: UPBIT_USER_PINNED_CHART_SLOT_COUNT },
            (_, index) => index + 1,
          ),
          defaultMarkets: UPBIT_DEFAULT_CHART_MARKETS,
          rankedCount: UPBIT_RANKED_CHART_SLOT_COUNT,
          rankField: "recommendationRank",
          refreshInterval: "1h",
          weights: { quoteVolume: 1, changeRate: 0 },
          missingChangeRate: "neutral-50",
        },
        timestamp,
        items,
      },
      { headers: PUBLIC_CATALOG_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "업비트 KRW 마켓 목록을 불러오지 못했습니다.";
    return Response.json(
      {
        mode: "LIVE",
        exchange: "UPBIT",
        market: "KRW",
        timestamp,
        items: [],
        sourceUnavailable: true,
        error: message,
        notice: message,
      },
      {
        status: responseStatusForUpbitError(error),
        headers: NO_STORE_HEADERS,
      },
    );
  }
}
