import { BASIS_RESULT_LIMIT, getBasisSnapshot } from "@/lib/basis-gap";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** 8개 거래소의 현선갭을 |갭| 큰 순으로 돌려줍니다. ?limit=N으로 행 수를 줄일 수 있습니다. */
export async function GET(request: Request): Promise<Response> {
  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = limitParam === null ? BASIS_RESULT_LIMIT : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > BASIS_RESULT_LIMIT) {
    return Response.json(
      { error: `limit은 1~${BASIS_RESULT_LIMIT} 사이 정수여야 합니다.` },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  try {
    const snapshot = await getBasisSnapshot();
    return Response.json({ ...snapshot, rows: snapshot.rows.slice(0, limit) }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "현선갭을 불러오지 못했습니다.";
    return Response.json({ error: message }, { status: 502, headers: NO_STORE_HEADERS });
  }
}
