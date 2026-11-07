import {
  UpbitValidationError,
  getUpbitMarketDataServiceFromEnv,
  parseUpbitChartsRequest,
  responseStatusForUpbitError,
} from "@/lib/upbit-client";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "JSON 본문이 필요합니다." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  let parsed;
  try {
    parsed = parseUpbitChartsRequest(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "잘못된 차트 요청입니다.";
    return Response.json(
      { error: message },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const timestamp = new Date().toISOString();
  try {
    const series = await getUpbitMarketDataServiceFromEnv().getChartSeries(parsed);
    return Response.json(
      {
        mode: "LIVE",
        complete: true,
        timestamp,
        series,
        failedMarkets: [],
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "업비트 캔들 데이터를 불러오지 못했습니다.";
    const status = error instanceof UpbitValidationError
      ? 400
      : responseStatusForUpbitError(error);
    return Response.json(
      {
        mode: "LIVE",
        complete: false,
        timestamp,
        series: [],
        failedMarkets: parsed.markets,
        sourceUnavailable: status !== 400,
        error: message,
        notice: message,
      },
      { status, headers: NO_STORE_HEADERS },
    );
  }
}
