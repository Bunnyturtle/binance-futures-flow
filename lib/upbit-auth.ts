import { createHash, createHmac, randomUUID } from "node:crypto";

/**
 * 업비트 Exchange API 인증 토큰을 만듭니다. 서버 런타임 전용이며, 시크릿은 이
 * 모듈 밖으로 나가지 않습니다. 외부 JWT 라이브러리 없이 node:crypto만 씁니다.
 */

export interface UpbitCredentials {
  accessKey: string;
  secretKey: string;
}

function base64Url(value: Buffer | string): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * 파라미터가 있는 요청은 쿼리 문자열의 SHA-512 해시를 함께 서명해야 합니다.
 * 잔고 조회(`/v1/accounts`)는 파라미터가 없어 query를 생략합니다.
 */
export function upbitAuthorizationToken(
  credentials: UpbitCredentials,
  query = "",
): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: Record<string, string> = {
    access_key: credentials.accessKey,
    nonce: randomUUID(),
  };
  if (query) {
    payload.query_hash = createHash("sha512").update(query, "utf8").digest("hex");
    payload.query_hash_alg = "SHA512";
  }
  const body = base64Url(JSON.stringify(payload));
  const signature = base64Url(
    createHmac("sha256", credentials.secretKey)
      .update(`${header}.${body}`, "utf8")
      .digest(),
  );
  return `${header}.${body}.${signature}`;
}

export function upbitAuthorizationHeader(
  credentials: UpbitCredentials,
  query = "",
): string {
  return `Bearer ${upbitAuthorizationToken(credentials, query)}`;
}

/** 두 값이 모두 채워져 있을 때만 인증 경로를 켭니다. */
export function readUpbitCredentials(env: {
  UPBIT_ACCESS_KEY?: string;
  UPBIT_SECRET_KEY?: string;
}): UpbitCredentials | null {
  const accessKey = env.UPBIT_ACCESS_KEY?.trim() ?? "";
  const secretKey = env.UPBIT_SECRET_KEY?.trim() ?? "";
  return accessKey && secretKey ? { accessKey, secretKey } : null;
}
