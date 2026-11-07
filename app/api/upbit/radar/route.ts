import {
  UpbitValidationError,
  getUpbitMarketDataServiceFromEnv,
  responseStatusForUpbitError,
  type UpbitMarketDataService,
} from "@/lib/upbit-client";
import {
  UPBIT_RADAR_RESULT_LIMIT,
  UpbitRadarService,
  type UpbitRadarApiResponse,
} from "@/lib/upbit-radar";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const PUBLIC_RADAR_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=840",
};

const radarServices = new WeakMap<UpbitMarketDataService, UpbitRadarService>();

function radarServiceFor(marketService: UpbitMarketDataService): UpbitRadarService {
  const existing = radarServices.get(marketService);
  if (existing) return existing;
  const service = new UpbitRadarService({
    loadCandidates: () => marketService.getRadarSourceCandidates(),
    loadHistory: (candidate, range) =>
      marketService.getRadarDailyHistory(candidate.market, range),
  }, {
    // 완료된 결과만 요청 간에 공유합니다. 진행 중인 계산은 그 요청이 소유한
    // I/O를 물고 있으므로 다음 요청이 기다려서는 안 됩니다.
    coalesceInFlight: false,
  });
  radarServices.set(marketService, service);
  return service;
}

function parseLimit(request: Request): number {
  const value = new URL(request.url).searchParams.get("limit");
  if (value === null || value.trim() === "") return UPBIT_RADAR_RESULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > UPBIT_RADAR_RESULT_LIMIT) {
    throw new UpbitValidationError(
      `limit은 1 이상 ${UPBIT_RADAR_RESULT_LIMIT} 이하의 정수여야 합니다.`,
    );
  }
  return parsed;
}

export async function GET(request: Request): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    const result = await radarServiceFor(
      getUpbitMarketDataServiceFromEnv(),
    ).getRadar(parseLimit(request));
    const response: UpbitRadarApiResponse = {
      mode: "LIVE",
      source: "same-origin",
      market: "UPBIT",
      scope: "KRW_SPOT",
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
      : "업비트 관심 종목 레이더를 불러오지 못했습니다.";
    return Response.json(
      {
        mode: "LIVE",
        source: "same-origin",
        market: "UPBIT",
        scope: "KRW_SPOT",
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
        status: responseStatusForUpbitError(error),
        headers: NO_STORE_HEADERS,
      },
    );
  }
}
