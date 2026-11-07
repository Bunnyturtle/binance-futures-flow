import {
  UpbitAuthUnavailableError,
  getUpbitMarketDataServiceFromEnv,
  responseStatusForUpbitError,
} from "@/lib/upbit-client";

// 잔고는 개인 자산 정보입니다. 절대 캐시되지 않도록 no-store를 붙이고
// same-origin 요청만 처리합니다.
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
};

export async function GET(): Promise<Response> {
  const timestamp = new Date().toISOString();
  const service = getUpbitMarketDataServiceFromEnv();
  if (!service.authenticationConfigured) {
    return Response.json(
      {
        mode: "DISABLED",
        configured: false,
        timestamp,
        summary: null,
        holdings: [],
        notice:
          "UPBIT_ACCESS_KEY와 UPBIT_SECRET_KEY가 없어 잔고 패널이 꺼져 있습니다.",
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await service.getAccounts();
    return Response.json(
      { mode: "LIVE", configured: true, timestamp, ...result },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "업비트 잔고를 불러오지 못했습니다.";
    const configured = !(error instanceof UpbitAuthUnavailableError);
    return Response.json(
      {
        mode: "ERROR",
        configured,
        timestamp,
        summary: null,
        holdings: [],
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
