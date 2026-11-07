import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

/**
 * 통합 앱 전체 구조(화면 전환, 김프·현선갭 화면과 API 입력 검사)를 확인합니다.
 * 거래소에 묻지 않는 경로만 확인하므로 네트워크가 없어도 통과해야 합니다.
 */
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
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
    if (server.exitCode !== null) throw new Error(`next start가 종료되었습니다.\n${logs.join("")}`);
    if (Date.now() > deadline) throw new Error(`next start가 ${STARTUP_TIMEOUT_MS}ms 안에 뜨지 않았습니다.\n${logs.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/kimp`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
});

after(() => {
  if (!server || server.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  server.kill("SIGTERM");
});

const page = async (path) => {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200, path);
  return response.text();
};

function assertSwitcher(html, current) {
  assert.match(html, /aria-label="CRYPTO FLOW 화면 전환"/);
  for (const section of ["binance", "upbit", "kimp", "basis"]) {
    assert.match(html, new RegExp(`href="/${section}"`), `${section} 링크가 없습니다.`);
  }
  assert.match(
    html,
    new RegExp(`<a(?=[^>]*href="/${current}")(?=[^>]*aria-current="page")[^>]*>`),
    `${current} 링크가 현재 화면으로 표시되지 않았습니다.`,
  );
}

test("첫 주소는 바이낸스 화면으로 넘긴다", async () => {
  const response = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.ok([307, 308].includes(response.status), `status ${response.status}`);
  assert.match(response.headers.get("location") ?? "", /\/binance$/);
});

test("네 화면 모두 같은 전환 메뉴를 갖고 현재 화면을 표시한다", async () => {
  assertSwitcher(await page("/binance"), "binance");
  assertSwitcher(await page("/upbit"), "upbit");

  const kimp = await page("/kimp");
  assertSwitcher(kimp, "kimp");
  assert.match(kimp, /<title>KIMCHI GAP \| 업비트 vs 해외 현물 갭<\/title>/);
  assert.match(kimp, /업비트 환산가 − 해외 가격/);

  const basis = await page("/basis");
  assertSwitcher(basis, "basis");
  assert.match(basis, /<title>BASIS GAP \| 거래소별 현선갭 감시<\/title>/);
  assert.match(basis, /현선갭 감시/);
  assert.match(basis, /알림 소리 크기/);
});

test("김프 API는 잘못된 입력을 거래소에 묻기 전에 400으로 막는다", async () => {
  for (const path of [
    "/api/kimp/data?coin=BTC-USD",
    "/api/kimp/data?interval=7",
    "/api/kimp/data?days=abc",
    "/api/kimp/live?coin=@@",
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.ok((await response.json()).error, `${path}: error 메시지가 없습니다.`);
  }
});

test("현선갭 API는 잘못된 limit을 400으로 막는다", async () => {
  for (const limit of ["0", "301", "1.5", "x"]) {
    const response = await fetch(`${baseUrl}/api/basis?limit=${limit}`);
    assert.equal(response.status, 400, limit);
  }
});
