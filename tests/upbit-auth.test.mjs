import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { loadLib } from "./load-lib.mjs";

const { readUpbitCredentials, upbitAuthorizationHeader, upbitAuthorizationToken } =
  await loadLib("upbit-auth");

const credentials = { accessKey: "test-access-key", secretKey: "test-secret-key" };

function decode(segment) {
  return JSON.parse(
    Buffer.from(segment.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString(
      "utf8",
    ),
  );
}

test("업비트 규격의 HS256 JWT를 만든다", () => {
  const token = upbitAuthorizationToken(credentials);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(decode(header), { alg: "HS256", typ: "JWT" });

  const body = decode(payload);
  assert.equal(body.access_key, credentials.accessKey);
  assert.match(body.nonce, /^[0-9a-f-]{36}$/);
  assert.equal("query_hash" in body, false, "파라미터가 없으면 query_hash를 넣지 않습니다.");

  const expected = createHmac("sha256", credentials.secretKey)
    .update(`${header}.${payload}`, "utf8")
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  assert.equal(signature, expected);
  assert.equal(token.includes("="), false, "base64url은 패딩을 쓰지 않습니다.");
});

test("파라미터가 있으면 SHA-512 query_hash를 함께 서명한다", () => {
  const query = "market=KRW-BTC&state=done";
  const body = decode(upbitAuthorizationToken(credentials, query).split(".")[1]);
  assert.equal(body.query_hash_alg, "SHA512");
  assert.equal(body.query_hash, createHash("sha512").update(query, "utf8").digest("hex"));
});

test("nonce는 요청마다 달라진다", () => {
  const first = decode(upbitAuthorizationToken(credentials).split(".")[1]).nonce;
  const second = decode(upbitAuthorizationToken(credentials).split(".")[1]).nonce;
  assert.notEqual(first, second);
});

test("Authorization 헤더는 Bearer 접두사를 붙인다", () => {
  assert.match(upbitAuthorizationHeader(credentials), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

test("두 키가 모두 있을 때만 인증 경로를 켠다", () => {
  assert.deepEqual(
    readUpbitCredentials({ UPBIT_ACCESS_KEY: " a ", UPBIT_SECRET_KEY: " b " }),
    { accessKey: "a", secretKey: "b" },
  );
  assert.equal(readUpbitCredentials({ UPBIT_ACCESS_KEY: "a" }), null);
  assert.equal(readUpbitCredentials({ UPBIT_SECRET_KEY: "b" }), null);
  assert.equal(readUpbitCredentials({ UPBIT_ACCESS_KEY: "  ", UPBIT_SECRET_KEY: "b" }), null);
  assert.equal(readUpbitCredentials({}), null);
});
