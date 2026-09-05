import {
  BinanceValidationError,
  getBinanceMarketDataServiceFromEnv,
  parseBinanceChartsRequest,
  responseStatusForBinanceError,
} from "@/lib/binance-client";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "JSON body is required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  let parsed;
  try {
    parsed = parseBinanceChartsRequest(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid chart request.";
    return Response.json(
      { error: message },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const timestamp = new Date().toISOString();
  try {
    const series = await getBinanceMarketDataServiceFromEnv().getChartSeries(parsed);
    return Response.json(
      {
        mode: "LIVE",
        complete: true,
        timestamp,
        series,
        failedSymbols: [],
        fallbackSymbols: [],
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Binance USDⓈ-M futures chart data could not be loaded.";
    const status = error instanceof BinanceValidationError
      ? 400
      : responseStatusForBinanceError(error);
    return Response.json(
      {
        mode: "LIVE",
        complete: false,
        timestamp,
        series: [],
        failedSymbols: parsed.symbols,
        fallbackSymbols: [],
        sourceUnavailable: status !== 400,
        error: message,
        notice: message,
      },
      { status, headers: NO_STORE_HEADERS },
    );
  }
}

