import {
  BinanceValidationError,
  getBinanceMarketDataServiceFromEnv,
  responseStatusForBinanceError,
  type BinanceMarketDataService,
} from "@/lib/binance-client";
import {
  BINANCE_RADAR_RESULT_LIMIT,
  BinanceRadarService,
  type BinanceRadarApiResponse,
} from "@/lib/binance-radar";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const PUBLIC_RADAR_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=840",
};

const radarServices = new WeakMap<BinanceMarketDataService, BinanceRadarService>();

function radarServiceFor(marketService: BinanceMarketDataService): BinanceRadarService {
  const existing = radarServices.get(marketService);
  if (existing) return existing;
  const service = new BinanceRadarService({
    loadCandidates: () => marketService.getRadarSourceCandidates(),
    loadHistory: (candidate, range) =>
      marketService.getRadarDailyHistory(candidate.symbol, range),
  }, {
    // Keep only settled radar results across Worker requests. A pending build
    // owns request-scoped I/O and must never be awaited by a later request.
    coalesceInFlight: false,
  });
  radarServices.set(marketService, service);
  return service;
}

function parseLimit(request: Request): number {
  const value = new URL(request.url).searchParams.get("limit");
  if (value === null || value.trim() === "") return BINANCE_RADAR_RESULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > BINANCE_RADAR_RESULT_LIMIT) {
    throw new BinanceValidationError(
      `limit must be an integer between 1 and ${BINANCE_RADAR_RESULT_LIMIT}.`,
    );
  }
  return parsed;
}

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const result = await radarServiceFor(
      getBinanceMarketDataServiceFromEnv(),
    ).getRadar(parseLimit(request));
    const response: BinanceRadarApiResponse = {
      mode: "LIVE",
      source: "same-origin",
      market: "USD-M",
      scope: "USDT_PERPETUAL",
      timestamp,
      evaluatedCount: result.coverage.analyzed,
      eligibleCount: result.coverage.eligible,
      historyReadyCount: result.coverage.historyReady,
      ...result,
    };
    return Response.json(response, { headers: PUBLIC_RADAR_HEADERS });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Binance USDⓈ-M futures radar could not be loaded.";
    return Response.json(
      {
        mode: "LIVE",
        source: "same-origin",
        market: "USD-M",
        scope: "USDT_PERPETUAL",
        timestamp,
        evaluatedCount: 0,
        eligibleCount: 0,
        historyReadyCount: 0,
        coverage: {
          eligible: 0,
          analyzed: 0,
          historyReady: 0,
          provisional: 0,
          failed: 0,
        },
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
