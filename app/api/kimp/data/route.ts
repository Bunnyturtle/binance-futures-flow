import { getSpotGapData, parseSpotGapQuery, SpotGapInputError } from "@/lib/spot-gap";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** 김프 봉 이력. 코인·분봉·기간은 쿼리(coin, interval, days)로 받습니다. */
export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseSpotGapQuery(new URL(request.url).searchParams);
    return Response.json(await getSpotGapData(query), { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "김프 데이터를 불러오지 못했습니다.";
    return Response.json(
      { error: message },
      { status: error instanceof SpotGapInputError ? 400 : 502, headers: NO_STORE_HEADERS },
    );
  }
}
