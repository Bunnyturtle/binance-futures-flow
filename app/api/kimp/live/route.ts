import {
  getSpotGapLive,
  isSpotGapVenueName,
  parseSpotGapQuery,
  SpotGapInputError,
} from "@/lib/spot-gap";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** 김프 현재가. 진행 중인 마지막 봉을 몇 초마다 움직이는 데 씁니다. */
export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const { coin } = parseSpotGapQuery(params);
    const names = (params.get("venues") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(isSpotGapVenueName);
    return Response.json(await getSpotGapLive(coin, [...new Set(names)]), { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "김프 현재가를 불러오지 못했습니다.";
    return Response.json(
      { error: message },
      { status: error instanceof SpotGapInputError ? 400 : 502, headers: NO_STORE_HEADERS },
    );
  }
}
