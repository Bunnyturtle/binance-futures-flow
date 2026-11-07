import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const nextBin = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);
const STARTUP_TIMEOUT_MS = 90_000;

let server;
let baseUrl;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * `npm test`가 먼저 next build를 돌리므로 여기서는 프로덕션 서버만 띄웁니다.
 * npx나 셸을 거치면 Windows에서 kill이 래퍼만 죽이고 서버가 남아 테스트 러너가
 * 끝나지 않으므로, next CLI를 node로 직접 실행합니다.
 */
before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  server = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`next start가 종료되었습니다.\n${logs.join("")}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `next start가 ${STARTUP_TIMEOUT_MS}ms 안에 뜨지 않았습니다.\n${logs.join("")}`,
      );
    }
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
});

after(() => {
  if (!server || server.exitCode !== null) return;
  if (process.platform === "win32") {
    // Next는 워커를 띄우므로 프로세스 트리째 정리해야 포트가 풀립니다.
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  server.kill("SIGTERM");
});

test("서버 렌더링된 페이지가 업비트 화면을 담고 있다", async () => {
  const response = await fetch(`${baseUrl}/upbit`);
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /<html lang="ko"/);
  assert.match(html, /<title>UPBIT FLOW \| 업비트 KRW 실시간 12분할 차트<\/title>/);
  assert.match(html, /property="og:site_name" content="UPBIT FLOW"/);
  assert.match(html, /24시간 거래대금 상위 10종목으로 1시간마다 자동 배열/);

  // 세 탭과 12개 슬롯이 첫 HTML에 들어 있어야 자바스크립트 이전에도 뼈대가 보입니다.
  for (const label of ["CHART", "RADAR", "BALANCE"]) {
    assert.ok(html.includes(label), `${label} 탭이 없습니다.`);
  }
  for (let slot = 0; slot < 12; slot += 1) {
    assert.ok(html.includes(`slot-symbol-trigger-${slot}`), `C${slot + 1} 슬롯이 없습니다.`);
  }
  assert.match(html, /투자 조언이 아닙니다/);
  // 키가 HTML로 새어 나가지 않는지 확인합니다.
  assert.equal(/UPBIT_(ACCESS|SECRET)_KEY["']?\s*[:=]\s*["'][^"']+/.test(html), false);
});

test("잔고 라우트는 개인 정보를 캐시하지 않는다", async () => {
  const response = await fetch(`${baseUrl}/api/upbit/accounts`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  const payload = await response.json();
  // .env 없이 도는 환경에서는 키가 없으므로 비활성 응답이 나옵니다.
  if (payload.configured === false) {
    assert.equal(payload.mode, "DISABLED");
    assert.deepEqual(payload.holdings, []);
    assert.match(payload.notice, /UPBIT_ACCESS_KEY/);
  } else {
    assert.ok(payload.summary, "키가 설정된 환경이면 summary가 있어야 합니다.");
  }
});

test("차트 라우트가 잘못된 요청을 400으로 막는다", async () => {
  const post = (body) =>
    fetch(`${baseUrl}/api/upbit/charts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const cases = [
    ["KRW 마켓이 아님", { markets: ["BTC-KRW"], timeframes: ["1m"] }],
    ["지원하지 않는 봉 주기", { markets: ["KRW-BTC"], timeframes: ["7m"] }],
    ["길이 불일치", { markets: ["KRW-BTC", "KRW-ETH"], timeframes: ["1m"] }],
    ["중복 조합", { markets: ["KRW-BTC", "KRW-BTC"], timeframes: ["1m", "1m"] }],
    ["빈 요청", { markets: [], timeframes: [] }],
    ["슬롯 초과", {
      markets: Array.from({ length: 13 }, (_, i) => `KRW-C${i}`),
      timeframes: Array.from({ length: 13 }, () => "1m"),
    }],
  ];
  for (const [label, body] of cases) {
    const response = await post(body);
    assert.equal(response.status, 400, label);
    assert.ok((await response.json()).error, `${label}: error 메시지가 없습니다.`);
  }

  // 같은 종목이라도 봉 주기가 다르면 허용됩니다.
  const multiTimeframe = await post({
    markets: ["KRW-BTC", "KRW-BTC"],
    timeframes: ["1m", "5m"],
  });
  assert.notEqual(multiTimeframe.status, 400);
});
