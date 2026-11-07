import {
  assertExactChartWallRecommendation,
  BINANCE_CRYPTO_DEFAULT_CHART_SYMBOLS,
  BINANCE_RANKED_CHART_SLOT_COUNT,
  BINANCE_USER_PINNED_CHART_SLOT_COUNT,
  getBinanceMarketDataServiceFromEnv,
  parseBinanceMarketSegment,
  responseStatusForBinanceError,
  usableChartWallRecommendationRankCount,
} from "@/lib/binance-client";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const PUBLIC_CATALOG_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30",
};

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const segment = parseBinanceMarketSegment(
      new URL(request.url).searchParams.get("segment"),
    );
    const items = await getBinanceMarketDataServiceFromEnv().getSymbolCatalog(segment);
    const availableRankCount = usableChartWallRecommendationRankCount(items);
    let recommendationAvailable = false;
    try {
      assertExactChartWallRecommendation(items);
      recommendationAvailable = true;
    } catch (error) {
      // CRYPTO retains its strict twelve-slot contract. A sparse TRADFI
      // universe must still keep its volume-ordered picker catalog available.
      if (segment === "crypto") throw error;
    }
    return Response.json(
      {
        schemaVersion: 7,
        mode: "LIVE",
        market: "USD-M",
        segment,
        sort: "quoteVolume",
        order: "desc",
        window: "24h",
        refreshInterval: "30m",
        chartWallRecommendation: {
          sort: "quoteVolume",
          order: "desc",
          count: 12,
          available: recommendationAvailable,
          availableRankCount,
          userPinnedSlots: Array.from(
            { length: BINANCE_USER_PINNED_CHART_SLOT_COUNT },
            (_, index) => index + 1,
          ),
          defaultSymbols: segment === "crypto"
            ? BINANCE_CRYPTO_DEFAULT_CHART_SYMBOLS
            : [],
          rankedCount: BINANCE_RANKED_CHART_SLOT_COUNT,
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
      : "Binance USDⓈ-M futures universe could not be loaded.";
    return Response.json(
      {
        mode: "LIVE",
        market: "USD-M",
        timestamp,
        items: [],
        sourceUnavailable: true,
        error: message,
        notice: message,
      },
      {
        status: responseStatusForBinanceError(error),
        headers: NO_STORE_HEADERS,
      },
    );
  }
}
