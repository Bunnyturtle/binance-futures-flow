import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const title = "BINANCE FUTURES FLOW | 실시간 12분할 차트";
const description =
  "CRYPTO와 TRADFI 모두 C1·C2는 사용자가 지정한 종목을 유지하고 C3~C12는 24시간 거래대금 상위 10종목으로 1시간마다 자동 배열합니다. 새 CRYPTO 레이아웃만 C1·C2가 BTC·ETH로 시작하는 Binance USDⓈ-M 실시간 다중 차트입니다.";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function metaTag(nameAttribute, name, content) {
  return new RegExp(
    `<meta(?=[^>]*\\b${nameAttribute}=["']${escapeRegExp(name)}["'])(?=[^>]*\\bcontent=["']${escapeRegExp(content)}["'])[^>]*>`,
    "i",
  );
}

const PORT = 3411;
const BASE_URL = `http://localhost:${PORT}`;
let serverProcess;

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL, {
        headers: { accept: "text/html" },
      });
      if (response.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("next start did not become ready in time");
}

before(async () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const nextBin = fileURLToPath(
    new URL(
      process.platform === "win32"
        ? "../node_modules/next/dist/bin/next"
        : "../node_modules/.bin/next",
      import.meta.url,
    ),
  );
  serverProcess = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(PORT)],
    {
      cwd: projectRoot,
      stdio: "ignore",
    },
  );
  await waitForServer();
});

after(() => {
  serverProcess?.kill();
});

async function render() {
  return fetch(`${BASE_URL}/`, {
    headers: { accept: "text/html" },
  });
}

async function sharedRadarResultLimit() {
  const source = await readFile(
    new URL("../lib/binance-radar.ts", import.meta.url),
    "utf8",
  );
  const match = source.match(/export const BINANCE_RADAR_RESULT_LIMIT = (\d+);/);
  assert.ok(match, "the shared Radar result-limit contract is exported");
  return Number(match[1]);
}

test("server-renders the finished Binance futures dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const radarResultLimit = await sharedRadarResultLimit();
  assert.equal(radarResultLimit, 20);
  assert.match(html, new RegExp(`<title>${escapeRegExp(title)}</title>`, "i"));
  assert.match(html, /FUTURES FLOW/);
  assert.match(html, /실시간 다중차트/);
  assert.doesNotMatch(
    html,
    /(?:CRYPTO|TRADFI) C1·C2 사용자 지정 \+ (?:80:20|90:10|10:0) 상위 10종목 12분할 차트/,
  );
  assert.match(html, /id="multi-chart-title"/);
  assert.match(html, /CRYPTO 12분할 차트/);
  assert.match(html, /현재 캔들 · 동기화 중/);
  assert.doesNotMatch(html, /CUSTOM 12-SLOT WALL/);
  assert.doesNotMatch(html, /전체 봉/);
  assert.match(html, /차트 봉 주기 설정/);
  assert.match(html, /현재 시장 12개 차트 봉 주기 일괄 변경/);
  assert.match(html, /1번 활성 슬롯 봉 주기 선택/);
  assert.doesNotMatch(
    html,
    /C(?:<!-- -->)?1(?:<!-- -->)? 종목 선택|>일시정지<\/button>|활성 슬롯 C(?:<!-- -->)?1(?:<!-- -->)? ·/,
  );
  assert.doesNotMatch(html, /거래대금 순위|TOP12 재배치/);
  for (const removedHeroText of [
    "LIVE MARKET WALL",
    "공개 시세 전용 · 주문 및 계좌 권한 사용 안 함",
    "4 × 3 동시 감시",
    "CRYPTO 거래대금 1위",
    "combined WebSocket",
    "순위 갱신",
  ]) {
    assert.doesNotMatch(html, new RegExp(escapeRegExp(removedHeroText), "i"));
  }

  const marketTabs = html.match(
    /<button(?=[^>]*\brole=["']tab["'])(?=[^>]*\bid=["']market-tab-(?:crypto|tradfi|radar)["'])[^>]*>/gi,
  ) ?? [];
  assert.equal(marketTabs.length, 3);
  const cryptoTab = marketTabs.find((tag) => /\bid=["']market-tab-crypto["']/.test(tag));
  const tradfiTab = marketTabs.find((tag) => /\bid=["']market-tab-tradfi["']/.test(tag));
  const radarTab = marketTabs.find((tag) => /\bid=["']market-tab-radar["']/.test(tag));
  assert.ok(cryptoTab && /\baria-selected=["']true["']/.test(cryptoTab));
  assert.ok(cryptoTab && /\btabindex=["']0["']/.test(cryptoTab));
  assert.ok(cryptoTab && /\baria-controls=["']market-panel["']/.test(cryptoTab));
  assert.ok(tradfiTab && /\baria-selected=["']false["']/.test(tradfiTab));
  assert.ok(tradfiTab && /\btabindex=["']-1["']/.test(tradfiTab));
  assert.ok(tradfiTab && /\baria-controls=["']market-panel["']/.test(tradfiTab));
  assert.ok(radarTab && /\baria-selected=["']false["']/.test(radarTab));
  assert.ok(radarTab && /\btabindex=["']-1["']/.test(radarTab));
  assert.ok(radarTab && /\baria-controls=["']radar-panel["']/.test(radarTab));
  assert.match(
    html,
    /id=["']market-tab-crypto["'][^>]*>[\s\S]*?<strong>CRYPTO<\/strong>[\s\S]*?<small>암호화폐 전체 종목<\/small>[\s\S]*?<\/button>/i,
  );
  assert.match(
    html,
    /id=["']market-tab-tradfi["'][^>]*>[\s\S]*?<strong>TRADFI<\/strong>[\s\S]*?<small>전통금융 전체 종목<\/small>[\s\S]*?<\/button>/i,
  );
  assert.match(
    html,
    /id=["']market-tab-radar["'][^>]*>[\s\S]*?<strong>RADAR<\/strong>[\s\S]*?<small>통합 관심 종목<\/small>[\s\S]*?<\/button>/i,
  );
  assert.match(html, /role=["']tablist["'][^>]*aria-label=["']선물 시장["']/i);
  assert.ok(
    html.indexOf('role="tablist"') < html.indexOf('role="tabpanel"'),
    "the prominent market tabs precede the market panel",
  );
  assert.match(
    html,
    /id=["']market-panel["'][^>]*role=["']tabpanel["'][^>]*aria-labelledby=["']market-tab-crypto["']/i,
  );
  assert.doesNotMatch(
    html.match(/<section(?=[^>]*\bid=["']market-panel["'])[^>]*>/i)?.[0] ?? "",
    /\bhidden(?:=["'][^"']*["'])?/i,
    "the initial CRYPTO market panel is visible",
  );
  assert.match(
    html,
    /<section(?=[^>]*\bid=["']radar-panel["'])(?=[^>]*\brole=["']tabpanel["'])(?=[^>]*\baria-labelledby=["']market-tab-radar["'])(?=[^>]*\bhidden(?:=["'][^"']*["'])?)[^>]*>/i,
    "the separately mounted RADAR panel starts hidden",
  );
  assert.match(html, /관심 종목 레이더/);
  for (const radarHeader of [
    "순위",
    "종목 · 현재가",
    "24H 거래대금",
    "7D ÷ 30D",
    "전일대비 가격",
    "RADAR",
  ]) {
    assert.match(html, new RegExp(`<th[^>]*>${escapeRegExp(radarHeader)}<\\/th>`, "i"));
  }
  assert.match(html, /24H 거래대금 상위 40 내 · 규모 50% · 최근 7일\/30일 30% · 전일대비 가격 20%/);
  assert.match(html, /15분 갱신/);
  const radarSkeletonRows = html.match(
    /<tr(?=[^>]*\baria-hidden=["']true["'])[^>]*>/gi,
  ) ?? [];
  assert.equal(radarSkeletonRows.length, radarResultLimit);
  assert.doesNotMatch(html, /BTC 미결제약정|BTC 현재 MARK|24H OI 변화/);
  assert.equal(html.match(/<strong>빈 차트 슬롯<\/strong>/g)?.length, 10);
  assert.equal(html.match(/전체 선물 종목을 검색하고 지정하세요/g)?.length, 10);
  assert.ok(html.includes("BTC/USDT"));
  assert.ok(html.includes("ETH/USDT"));
  const slotSymbolTriggers = html.match(
    /<button(?=[^>]*\bid=["']slot-symbol-trigger-\d+["'])[^>]*>/gi,
  ) ?? [];
  assert.equal(slotSymbolTriggers.length, 12);
  assert.equal(
    slotSymbolTriggers.filter((tag) => /\bdisabled(?:="")?/.test(tag)).length,
    0,
  );
  for (const index of [0, 1]) {
    const trigger = slotSymbolTriggers.find((tag) =>
      new RegExp(`\\bid=["']slot-symbol-trigger-${index}["']`).test(tag)
    );
    assert.ok(trigger);
    assert.match(trigger, /aria-haspopup=["']dialog["']/);
    assert.match(trigger, /종목 변경 창 열기/);
  }

  const timeframeSelects = html.match(
    /<select(?=[^>]*\baria-label=["'][^"']*봉 주기[^"']*["'])[^>]*>[\s\S]*?<\/select>/gi,
  ) ?? [];
  assert.equal(timeframeSelects.length, 1);
  const activeTimeframeSelect = timeframeSelects.find((select) =>
    /1번 활성 슬롯 봉 주기 선택/.test(select)
  );
  assert.ok(activeTimeframeSelect);
  const allTimeframeRadios = html.match(
    /<input(?=[^>]*\btype=["']radio["'])(?=[^>]*\bname=["']all-slots-timeframe["'])[^>]*>/gi,
  ) ?? [];
  assert.equal(allTimeframeRadios.length, 9);
  for (const timeframe of [
    "1m", "3m", "5m", "15m", "1h", "4h", "1d", "1w", "1M",
  ]) {
    assert.match(activeTimeframeSelect, new RegExp(`<option[^>]*\\bvalue=["']${timeframe}["']`));
    assert.ok(
      allTimeframeRadios.some((radio) =>
        new RegExp(`\\bvalue=["']${timeframe}["']`).test(radio)
      ),
      `the global timeframe buttons include ${timeframe}`,
    );
  }
  for (const removedTimeframe of ["30m", "2h", "6h", "8h", "12h", "3d"]) {
    assert.doesNotMatch(activeTimeframeSelect, new RegExp(`\\bvalue=["']${removedTimeframe}["']`));
    assert.equal(
      allTimeframeRadios.some((radio) =>
        new RegExp(`\\bvalue=["']${removedTimeframe}["']`).test(radio)
      ),
      false,
    );
  }
  assert.match(
    activeTimeframeSelect,
    /<option(?=[^>]*\bvalue=["']1m["'])(?=[^>]*\bselected(?:=["'][^"']*["'])?)[^>]*>/,
    "the active slot defaults to 1m",
  );
  assert.ok(
    allTimeframeRadios.some((radio) =>
      /\bvalue=["']1m["']/.test(radio) && /\bchecked(?:=["'][^"']*["'])?/.test(radio)
    ),
    "the global 1m button is selected by default",
  );

  const workspaceCss = await readFile(
    new URL("../app/components/MultiChartWorkspace.module.css", import.meta.url),
    "utf8",
  );
  assert.match(
    workspaceCss,
    /\.chartGrid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(workspaceCss, /\.slot\s*\{[^}]*height:\s*clamp\(205px,\s*16\.2vw,\s*255px\)/s);
  assert.match(workspaceCss, /\.slot\s*\{[^}]*background:\s*var\(--chart-surface\)/s);
  assert.doesNotMatch(workspaceCss, /\.kicker\s*\{/);
  assert.match(
    workspaceCss,
    /@media \(max-width:\s*1180px\)[\s\S]*?\.chartGrid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    workspaceCss,
    /@media \(max-width:\s*900px\)[\s\S]*?\.chartGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    workspaceCss,
    /@media \(max-width:\s*720px\)[\s\S]*?\.chartGrid\s*\{[^}]*display:\s*block[^}]*\}[\s\S]*?\.slot\s*\{[^}]*display:\s*none[^}]*\}[\s\S]*?\.slot\[data-active="true"\]\s*\{[^}]*display:\s*block/s,
  );
  assert.doesNotMatch(workspaceCss, /@media \(min-width:\s*1041px\)/);
  assert.match(
    workspaceCss,
    /\.symbolOverlay\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*3[^}]*top:\s*7px/s,
  );
  assert.doesNotMatch(workspaceCss, /\.symbolOverlay:disabled|\.emptySlot button:disabled/);
  assert.doesNotMatch(workspaceCss, /\.workspaceHeader h2\s*\{/);
  assert.match(
    workspaceCss,
    /\.syncState\s*\{[^}]*justify-content:\s*flex-start[^}]*text-align:\s*left/s,
  );
  assert.match(workspaceCss, /\.syncState strong\s*\{[^}]*font-size:\s*9px/s);
  assert.match(
    workspaceCss,
    /\.syncState strong\.currentCandleTime\s*\{[^}]*font-size:\s*11px/s,
  );
  assert.match(workspaceCss, /\.chartBody\s*\{[^}]*height:\s*100%/s);
  assert.match(workspaceCss, /\.timeframeControls\s*\{[^}]*width:\s*min\(560px,\s*100%\)[^}]*display:\s*flex/s);
  assert.match(
    workspaceCss,
    /\.timeframeBar\s*\{[^}]*min-width:\s*0[^}]*min-height:\s*40px[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(9,\s*minmax\(0,\s*1fr\)\)[^}]*overflow:\s*hidden/s,
  );
  assert.match(workspaceCss, /\.timeframeOption\s*\{[^}]*min-width:\s*0/s);
  assert.match(workspaceCss, /\.timeframeOption span\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*height:\s*28px/s);
  assert.match(workspaceCss, /\.timeframeOption input:focus-visible \+ span\s*\{[^}]*outline:\s*2px solid var\(--accent\)/s);
  assert.match(workspaceCss, /\.timeframeOption input:checked \+ span\s*\{[^}]*background:\s*var\(--accent-strong\)/s);
  assert.match(workspaceCss, /\.activeTimeframeControl\s*\{[^}]*min-width:\s*220px/s);
  assert.match(workspaceCss, /\.timeframeControls select\s*\{[^}]*height:\s*28px/s);
  assert.match(
    workspaceCss,
    /@media \(max-width:\s*1180px\)[\s\S]*?\.timeframeControls\s*\{[^}]*width:\s*100%[^}]*order:\s*3/s,
  );
  assert.match(
    workspaceCss,
    /@media \(max-width:\s*720px\)[\s\S]*?\.timeframeControls\s*\{[^}]*flex-wrap:\s*wrap[^}]*\}[\s\S]*?\.timeframeBar\s*\{[^}]*width:\s*100%[^}]*flex:\s*1 1 100%[^}]*\}[\s\S]*?\.activeTimeframeControl\s*\{[^}]*width:\s*100%[^}]*flex:\s*1 1 100%/s,
  );
  assert.match(
    workspaceCss,
    /@media \(max-width:\s*480px\)[\s\S]*?\.timeframeBar\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.doesNotMatch(workspaceCss, /\.allTimeframeControl|\.controlLabel|\.wallTimeframeControl/);
  assert.match(
    workspaceCss,
    /@media \(max-width:\s*720px\)[\s\S]*?\.symbolOverlay\s*\{[^}]*min-height:\s*49px/s,
  );
  assert.doesNotMatch(
    workspaceCss,
    /\.slotHeader|\.slotIdentity|\.slotQuote|\.candleCount|calc\(100%\s*-\s*(?:45|52)px\)/,
  );

  const dashboardCss = await readFile(
    new URL("../app/components/BinanceDashboard.module.css", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboardCss,
    /\.marketTabs\s*\{[^}]*width:\s*min\(1560px,\s*100%\)[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    dashboardCss,
    /\.marketPanel\[hidden\],\s*\.radarPanel\[hidden\]\s*\{[^}]*display:\s*none/s,
  );
  assert.doesNotMatch(dashboardCss, /\.radarStack|\.radarPanel\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(dashboardCss, /\.marketTabs button\s*\{[^}]*height:\s*42px/s);
  assert.doesNotMatch(dashboardCss, /\.scaleFrame\s*\{|\bzoom\s*:\s*0\.9|111\.111111%|-5\.555556%/);
  assert.equal(dashboardCss.match(/--positive:\s*#dd3c44/gi)?.length, 2);
  assert.equal(dashboardCss.match(/--negative:\s*#1375ec/gi)?.length, 2);
  assert.match(
    dashboardCss,
    /--chart-surface:\s*linear-gradient\(135deg,\s*#181c27 0%,\s*#131722 100%\)/i,
  );
  assert.match(dashboardCss, /\.symbolDialog\s*\{[^}]*width:\s*min\(640px/s);
  assert.match(
    dashboardCss,
    /\.symbolResults\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  );
  assert.match(
    dashboardCss,
    /\.symbolOptionMeta\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*flex-end/s,
  );
  assert.doesNotMatch(dashboardCss, /\.heroStrip|\.heroCopy|\.safetyLine|\.statGrid/);
  assert.doesNotMatch(dashboardCss, /\.workspaceSwitch/);

  assert.match(html, metaTag("property", "og:type", "website"));
  assert.match(html, metaTag("property", "og:locale", "ko_KR"));
  assert.match(html, metaTag("property", "og:site_name", "BINANCE FUTURES FLOW"));
  assert.match(html, metaTag("property", "og:title", title));
  assert.match(html, metaTag("property", "og:description", description));
  assert.match(
    html,
    new RegExp(
      `<meta(?=[^>]*\\bproperty=["']og:image["'])(?=[^>]*\\bcontent=["']${escapeRegExp(BASE_URL)}/og\\.png["'])[^>]*>`,
      "i",
    ),
  );

  assert.doesNotMatch(
    html,
    /codex-preview|SkeletonPreview|react-loading-skeleton/i,
  );
});

test("client feed guards invalid API payloads and keeps selection dependencies stable", async () => {
  const dashboardSource = await readFile(
    new URL("../app/components/BinanceDashboard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboardSource,
    /function formatClock[\s\S]*?timeZone:\s*"Asia\/Seoul"/,
  );
  assert.doesNotMatch(dashboardSource, /formatDateTime|currentDateTime=/);
  assert.match(
    dashboardSource,
    /items\s*=\s*normalizeUniverseItems\(root\.items,\s*segment\);[\s\S]*?}\s*catch\s*\(apiError\)/,
  );
  assert.match(
    dashboardSource,
    /normalizeUniverseItems\(\s*await loadPublicFuturesCatalog\(controller\.signal,\s*\{ segment \}\)/,
  );
  assert.match(dashboardSource, /rank:\s*Math\.max\(0,\s*Math\.trunc\(numberValue\(item,\s*"rank"\)\)\)/);
  assert.match(dashboardSource, /quoteVolume:\s*Math\.max\(0,\s*numberValue\(item,\s*"quoteVolume"\)\)/);
  assert.match(dashboardSource, /rankingScore:\s*optionalScoreValue\(item,\s*"rankingScore"\)/);
  assert.match(dashboardSource, /volumeScore:\s*optionalScoreValue\(item,\s*"volumeScore"\)/);
  assert.match(dashboardSource, /changeScore:\s*optionalScoreValue\(item,\s*"changeScore"\)/);
  assert.match(
    dashboardSource,
    /recommendationRank:\s*optionalPositiveInteger\(item,\s*"recommendationRank"\)/,
  );
  const optionalPositiveIntegerSource = dashboardSource.slice(
    dashboardSource.indexOf("function optionalPositiveInteger"),
    dashboardSource.indexOf("function textValue"),
  );
  assert.match(
    optionalPositiveIntegerSource,
    /const value = source\[key\];[\s\S]*?typeof value !== "number"[\s\S]*?!Number\.isInteger\(value\)[\s\S]*?value <= 0[\s\S]*?return undefined;[\s\S]*?return value;/,
    "recommendation ranks reject numeric strings, fractions, and non-positive values",
  );
  assert.doesNotMatch(optionalPositiveIntegerSource, /Number\(value\)|Math\.trunc/);
  const normalizedCatalogSource = dashboardSource.slice(
    dashboardSource.indexOf("function normalizeUniverseItems"),
    dashboardSource.indexOf("function readStoredDashboard"),
  );
  assert.match(
    normalizedCatalogSource,
    /\.sort\(\(left, right\) =>[\s\S]*?right\.quoteVolume - left\.quoteVolume \|\| left\.symbol\.localeCompare\(right\.symbol\)[\s\S]*?\.map\(\(item, index\) => \(\{ \.\.\.item, rank: index \+ 1 \}\)\)/,
    "the picker normalizes both server and public catalogs to deterministic 24H-volume order",
  );
  assert.match(
    dashboardSource,
    /if \(!items\.some\(\(item\) => \(item\.lastPrice \?\? 0\) > 0\)\) \{[\s\S]*?유효 시세를 확인하지 못했습니다\./,
  );
  assert.match(
    dashboardSource,
    /const pickerResults = useMemo\(\(\) => \{[\s\S]*?return universe\.filter\(\(item\) => \{[\s\S]*?\}, \[normalizedPickerQuery, universe\]\);/,
  );
  assert.doesNotMatch(dashboardSource, /const scored\s*=|const score\s*=|left\.score|right\.score/);
  const pickerRenderSource = dashboardSource.slice(
    dashboardSource.indexOf("pickerResults.map((item, index)"),
    dashboardSource.indexOf("{!pickerResults.length"),
  );
  assert.match(
    pickerRenderSource,
    /#\{item\.rank\}[\s\S]*?24H VOL · \{formatCompactUsdt\(item\.quoteVolume\)\}/,
    "the picker renders the catalog rank and 24H volume in received catalog order",
  );
  assert.match(
    pickerRenderSource,
    /const accessibleRanking = `24시간 거래대금 \$\{formatCompactUsdt\(item\.quoteVolume\)\}, 24시간 등락 \$\{formatSignedPercent\(item\.changeRate\)\}`/,
  );
  assert.match(
    pickerRenderSource,
    /aria-label=\{`\$\{item\.rank\}위 \$\{item\.baseAsset\}\/USDT, \$\{accessibleRanking\}, \$\{usedSlotLabel\}`\}/,
  );
  assert.doesNotMatch(
    pickerRenderSource,
    /rankingScore|recommendationRank|(?:80:20|90:10|10:0) SCORE|(?:80대20|90대10|10대0) 관심점수/,
    "weighted recommendation metadata must not replace the volume-ordered picker presentation",
  );
  assert.match(dashboardSource, /const STORAGE_KEY = "futures-flow-market-wall-v5"/);
  assert.match(
    dashboardSource,
    /const PREVIOUS_STORAGE_KEYS = \[[\s\S]*?"futures-flow-market-wall-v4",[\s\S]*?"futures-flow-market-wall-v3",[\s\S]*?"futures-flow-market-wall-v2",[\s\S]*?\] as const;/,
    "v5 migrates prior layouts while isolating writes from older open tabs",
  );
  assert.match(
    dashboardSource,
    /const AUTO_WALL_RANKING_VERSION_BY_SEGMENT:[\s\S]*?crypto: CRYPTO_WALL_RANKING_VERSION,[\s\S]*?tradfi: TRADFI_WALL_RANKING_VERSION/,
    "each market owns an independent ranking contract",
  );
  assert.match(
    dashboardSource,
    /const AUTO_WALL_GUARD_KEY_PREFIX = "futures-flow-auto-wall-ranked-at-v4";[\s\S]*?function autoWallGuardKey\(segment: MarketSegment\)[\s\S]*?AUTO_WALL_GUARD_KEY_PREFIX[\s\S]*?segment/,
  );
  assert.match(
    dashboardSource,
    /async function claimAutoWallRefresh\([\s\S]*?segment: MarketSegment,[\s\S]*?knownAutoRankedAt: number[\s\S]*?withAutoWallLock\(segment[\s\S]*?readAutoWallGuard\(segment\)[\s\S]*?autoWallRefreshDelay\(latestAutoRankedAt, now\)[\s\S]*?writeAutoWallGuard\(segment/,
    "hourly claims and locks are isolated by segment",
  );
  assert.match(
    dashboardSource,
    /crypto: defaultSegmentState\(defaultCryptoLayout\(\)\),[\s\S]*?tradfi: defaultSegmentState\(\)/,
    "only a new CRYPTO layout receives BTC/ETH defaults",
  );
  assert.match(
    dashboardSource,
    /const crypto = normalizeStoredLayout\([\s\S]*?CRYPTO_WALL_RANKING_VERSION[\s\S]*?\) \?\? legacyCrypto \?\? defaultCryptoLayout\(\);[\s\S]*?const tradfi = normalizeStoredLayout\([\s\S]*?TRADFI_WALL_RANKING_VERSION[\s\S]*?\) \?\? defaultLayout\(\);/,
    "stored pins, custom flags, timeframes, and active slots survive v5 migration",
  );
  assert.match(
    dashboardSource,
    /const cryptoGuard = readAutoWallGuard\("crypto"\);[\s\S]*?const tradfiGuard = readAutoWallGuard\("tradfi"\);[\s\S]*?Math\.max\(crypto\.autoRankedAt, cryptoGuard\.at\)[\s\S]*?Math\.max\(tradfi\.autoRankedAt, tradfiGuard\.at\)/,
    "hydration merges each layout with only its own guard",
  );
  assert.match(
    dashboardSource,
    /const storedCrypto = normalizeStoredLayout\([\s\S]*?CRYPTO_WALL_RANKING_VERSION[\s\S]*?const storedTradfi = normalizeStoredLayout\([\s\S]*?TRADFI_WALL_RANKING_VERSION[\s\S]*?storedCrypto\.updatedAt > persistedLayouts\.crypto\.updatedAt[\s\S]*?storedTradfi\.updatedAt > persistedLayouts\.tradfi\.updatedAt[\s\S]*?JSON\.stringify\(\{ version: 5, activeSegment, layouts \}\)/,
    "central persistence CAS preserves newer layouts from either segment",
  );
  assert.match(
    dashboardSource,
    /const remoteCryptoLayout = normalizeStoredLayout\([\s\S]*?CRYPTO_WALL_RANKING_VERSION[\s\S]*?const remoteTradfi = normalizeStoredLayout\([\s\S]*?TRADFI_WALL_RANKING_VERSION[\s\S]*?remoteCrypto\.updatedAt[\s\S]*?remoteTradfi\.updatedAt[\s\S]*?window\.addEventListener\("storage",\s*mergeStoredLayouts\)/,
    "both market layouts converge across tabs",
  );

  const sameOriginLoadSourceV5 = dashboardSource.slice(
    dashboardSource.indexOf("async function loadSameOriginFuturesCatalog"),
    dashboardSource.indexOf("function normalizeStoredLayout"),
  );
  assert.match(
    sameOriginLoadSourceV5,
    /SAME_ORIGIN_API_TIMEOUT_MS[\s\S]*?const exactAutoWall = selectAutoWallSymbols\(items, SLOT_COUNT, \[\]\)\.length ===[\s\S]*?SLOT_COUNT;[\s\S]*?segment === "crypto" && !exactAutoWall[\s\S]*?InvalidSameOriginAutoWallCatalogError/,
    "a malformed CRYPTO 200 response falls through to public recovery",
  );
  assert.match(
    sameOriginLoadSourceV5,
    /root\.chartWallRecommendation[\s\S]*?root\.schemaVersion === 7[\s\S]*?textValue\(recommendation, "sort"\) === "quoteVolume"[\s\S]*?quoteVolume[\s\S]*?=== 1[\s\S]*?changeRate[\s\S]*?=== 0[\s\S]*?segment === "tradfi"[\s\S]*?typeof recommendationAvailable === "boolean"[\s\S]*?recommendationAvailable === false && exactAutoWall/,
    "TRADFI distinguishes a declared sparse catalog from stale or malformed ranking data",
  );

  const catalogLoadSourceV5 = dashboardSource.slice(
    dashboardSource.indexOf("const loadUniverse = async"),
    dashboardSource.indexOf(
      "const interval = window.setInterval",
      dashboardSource.indexOf("const loadUniverse = async"),
    ),
  );
  assert.match(
    catalogLoadSourceV5,
    /apiError instanceof InvalidSameOriginAutoWallCatalogError[\s\S]*?INVALID_AUTO_WALL_CATALOG_RETRY_MS[\s\S]*?await loadPublicFuturesCatalog\(controller\.signal, \{ segment \}\)/,
  );
  assert.match(
    catalogLoadSourceV5,
    /const publicAutoWallExact = selectAutoWallSymbols\([\s\S]*?if \(segment === "crypto" && !publicAutoWallExact\)/,
    "public TRADFI remains searchable when its auto-wall recommendation is sparse",
  );
  assert.doesNotMatch(
    catalogLoadSourceV5,
    /segment === "tradfi"[^\n]*publicAutoWallExact|publicItems\.length >= SLOT_COUNT/,
  );
  assert.match(
    catalogLoadSourceV5,
    /const exactAutoWall = selectAutoWallSymbols\(items, SLOT_COUNT, \[\]\)\.length ===[\s\S]*?const preClaimStoredLayout = readCurrentStoredLayout\(segment\);[\s\S]*?Math\.max\([\s\S]*?autoRankedAtRef\.current\[segment\],[\s\S]*?preClaimStoredLayout\?\.autoRankedAt \?\? 0[\s\S]*?const automaticClaim = exactAutoWall[\s\S]*?claimAutoWallRefresh\(segment, knownAutoRankedAt\)[\s\S]*?releaseAutoWallClaim\(segment, automaticClaim\)/,
    "sparse TRADFI catalogs remain usable without consuming the hourly guard",
  );
  assert.match(
    catalogLoadSourceV5,
    /const latestStoredLayout = readCurrentStoredLayout\(segment\);[\s\S]*?latestStoredLayout\.updatedAt > currentPrevious\.updatedAt[\s\S]*?selectAutoWallSymbols\([\s\S]*?previous\.symbols\.slice\(0, AUTO_WALL_USER_PINNED_SLOT_COUNT\)[\s\S]*?custom: previous\.custom\.map\(\(value, index\) =>[\s\S]*?index < AUTO_WALL_USER_PINNED_SLOT_COUNT \? value : false[\s\S]*?AUTO_WALL_RANKING_VERSION_BY_SEGMENT\[segment\]/,
    "auto refresh rebases latest pins and replaces only C3-C12 for either segment",
  );
  assert.doesNotMatch(catalogLoadSourceV5, /custom: emptyCustom\(\)/);
  assert.match(
    catalogLoadSourceV5,
    /if \(disposed \|\| controller\.signal\.aborted \|\| document\.hidden\) return;[\s\S]*?universeError: message/,
    "ordinary failures preserve last-good symbols and catalog",
  );

  const timerSourceV5 = dashboardSource.slice(
    dashboardSource.indexOf("const delay = autoWallRefreshDelay(activeState.autoRankedAt)"),
    dashboardSource.indexOf("const persistedLayouts"),
  );
  assert.match(
    dashboardSource,
    /activeView !== activeSegment[\s\S]*?autoWallSymbols\.length !== SLOT_COUNT/,
  );
  assert.match(
    timerSourceV5,
    /setAutoRefreshRevisions[\s\S]*?\[activeSegment\]: current\[activeSegment\] \+ 1[\s\S]*?AUTO_WALL_REFRESH_MS/,
    "each visible market schedules its own hourly fresh-catalog refresh",
  );

  const assignSymbolSourceV5 = dashboardSource.slice(
    dashboardSource.indexOf("const assignSymbolToPickerSlot"),
    dashboardSource.indexOf("const clearPickerSlot"),
  );
  const clearSymbolSourceV5 = dashboardSource.slice(
    dashboardSource.indexOf("const clearPickerSlot"),
    dashboardSource.indexOf("const handlePickerKeyDown"),
  );
  for (const [label, source] of [
    ["picker assignment", assignSymbolSourceV5],
    ["picker clearing", clearSymbolSourceV5],
  ]) {
    assert.match(
      source,
      /targetIndex >= AUTO_WALL_USER_PINNED_SLOT_COUNT[\s\S]*?markAutoWallGuard\(activeSegment\)[\s\S]*?readCurrentStoredLayout\(activeSegment\)[\s\S]*?AUTO_WALL_RANKING_VERSION_BY_SEGMENT\[activeSegment\]/,
      `${label} leaves C1/C2 guard-free and holds C3-C12 per segment`,
    );
  }
  assert.match(
    assignSymbolSourceV5,
    /symbols:\s*previous\.symbols\.map\(\(symbol, index\) =>[\s\S]*?index === targetIndex \? item\.symbol : symbol[\s\S]*?custom:\s*previous\.custom\.map\(\(value, index\) =>[\s\S]*?index === targetIndex \? true : value/,
    "manual slot assignment changes only the selected slot and may preserve duplicate symbols",
  );

  const layoutControlSourceV5 = dashboardSource.slice(
    dashboardSource.indexOf("const changeAllTimeframes"),
    dashboardSource.indexOf("const retryUniverse"),
  );
  assert.equal(
    layoutControlSourceV5.match(/rebaseLatestStoredLayout\(/g)?.length,
    3,
    "timeframe and active-slot controls rebase either segment before writing",
  );

  const connectRadarSourceV5 = dashboardSource.slice(
    dashboardSource.indexOf("const connectRadarCandidate"),
    dashboardSource.indexOf("const handleMarketTabKeyDown"),
  );
  assert.match(
    connectRadarSourceV5,
    /readCurrentStoredLayout\(targetSegment\)[\s\S]*?const initialTargetIndex = existingIndex >= 0[\s\S]*?initialTargetIndex >= AUTO_WALL_USER_PINNED_SLOT_COUNT[\s\S]*?markAutoWallGuard\(targetSegment\)[\s\S]*?const latestStoredAtCommit = readCurrentStoredLayout\(targetSegment\)[\s\S]*?const targetIndex = initialTargetIndex/,
    "Radar keeps its click-time target while rebasing the selected market",
  );
  assert.doesNotMatch(dashboardSource, /fixedSymbolCount|CRYPTO_WALL_FIXED_SLOT_COUNT/);
  assert.doesNotMatch(
    dashboardSource,
    /replacePinnedDynamicDuplicates|repairedDynamicIndexes|replacedDynamicIndexes/,
    "duplicate chart symbols remain visible until the ordinary hourly auto layout runs",
  );
  assert.match(dashboardSource, /role="combobox"/);
  assert.match(dashboardSource, /role="listbox"/);
  assert.match(dashboardSource, /aria-activedescendant=/);
  assert.match(dashboardSource, /role="option"[\s\S]*?tabIndex=\{-1\}/);
  assert.match(dashboardSource, /같은 종목을 서로 다른 봉으로 여러 슬롯에 배치/);
  assert.doesNotMatch(
    dashboardSource,
    /<MultiChartWorkspace[\s\S]*?universeError=\{universeError\}/,
  );
  assert.doesNotMatch(dashboardSource, /styles\.scaleFrame/);

  const radarSource = await readFile(
    new URL("../app/components/AttentionRadar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(radarSource, /const RADAR_REFRESH_MS = 15 \* 60_000/);
  assert.match(radarSource, /BINANCE_RADAR_RESULT_LIMIT/);
  assert.match(
    radarSource,
    /root\.items\.length >= 1[\s\S]*?root\.items\.length <= BINANCE_RADAR_RESULT_LIMIT[\s\S]*?root\.items\.every\(isRadarCandidate\)/,
  );
  assert.match(
    radarSource,
    /useState<RadarStatus>\("loading"\)[\s\S]*?Array\.from\(\{ length: BINANCE_RADAR_RESULT_LIMIT \}/,
    "the server-rendered Radar skeleton derives its row count from the shared result limit",
  );
  assert.match(
    radarSource,
    /\^\[A-Z0-9_\]\{5,30\}\$[\s\S]*?endsWith\("USDT"\)[\s\S]*?typeof item\.name === "string"[\s\S]*?typeof lastPrice === "number"[\s\S]*?lastPrice > 0/,
  );
  assert.match(
    radarSource,
    /const \[pageHidden, setPageHidden\] = useState\(false\)[\s\S]*?const onVisibility = \(\) => setPageHidden\(document\.hidden\)[\s\S]*?onVisibility\(\)[\s\S]*?addEventListener\("visibilitychange", onVisibility\)/,
  );
  assert.match(
    radarSource,
    /<th scope="col">순위<\/th>[\s\S]*?<th scope="col">종목 · 현재가<\/th>[\s\S]*?<th scope="col">24H 거래대금<\/th>[\s\S]*?<th scope="col">7D ÷ 30D<\/th>[\s\S]*?<th scope="col">전일대비 가격<\/th>[\s\S]*?<th scope="col">RADAR<\/th>/,
  );
  assert.equal(radarSource.match(/<th scope="col">/g)?.length, 6);
  assert.match(
    radarSource,
    /24H 거래대금 상위 40 내 · 규모 50% · 최근 7일\/30일 30% · 전일대비 가격 20%/,
  );
  assert.match(radarSource, /<small>15분 갱신<\/small>/);
  assert.doesNotMatch(radarSource, /BtcOpenInterestProfile/);
  assert.match(
    radarSource,
    /<\/table>[\s\S]*?<\/div>[\s\S]*?<footer/,
    "the semantic Radar table and footer remain together in the first viewport",
  );
  assert.doesNotMatch(radarSource, /<tr[\s\S]{0,260}?role="button"/);
  assert.match(
    radarSource,
    /<button[\s\S]*?type="button"[\s\S]*?className=\{styles\.symbolCell\}[\s\S]*?aria-pressed=\{isSelected\}[\s\S]*?onClick=\{\(\) => selectCandidate\(item\)\}/,
  );

  const radarCss = await readFile(
    new URL("../app/components/AttentionRadar.module.css", import.meta.url),
    "utf8",
  );
  assert.match(
    radarCss,
    /\.panel\s*\{[^}]*height:\s*calc\(100dvh - 200px\)[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
  );
  assert.match(radarCss, /\.panel\s*\{[^}]*overflow:\s*hidden/s);
  assert.doesNotMatch(radarCss, /\.panel\s*\{[^}]*overscroll-behavior|\.panel\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(
    radarCss,
    /\.tableWrap\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1 1 auto[^}]*overflow:\s*auto/s,
  );
  assert.match(radarCss, /\.symbolCell:focus-visible\s*\{[^}]*outline:\s*2px solid/s);

  const workspaceSource = await readFile(
    new URL("../app/components/MultiChartWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workspaceSource, /const requestedSelectionContent\s*=/);
  assert.match(
    workspaceSource,
    /requestedSelectionContent[\s\S]*?const timeframe = timeframes\[index\][\s\S]*?seriesKey\(symbol, timeframe\)/,
  );
  assert.doesNotMatch(workspaceSource, /CUSTOM 12-SLOT WALL|styles\.kicker/);
  assert.match(
    workspaceSource,
    /timeframes:\s*requestedSelections\.map\(\(selection\) => selection\.timeframe\)/,
  );
  assert.match(workspaceSource, /@kline_\$\{timeframe\}/);
  assert.match(
    workspaceSource,
    /const uniformTimeframe[\s\S]*?timeframes\.every\(\(timeframe\) => timeframe === timeframes\[0\]\)/,
  );
  assert.match(workspaceSource, /role="group"[\s\S]*?aria-label="차트 봉 주기 설정"/);
  assert.match(workspaceSource, /className=\{styles\.timeframeBar\}[\s\S]*?name="all-slots-timeframe"[\s\S]*?onChangeAllTimeframes\(option\.value\)/);
  assert.match(workspaceSource, /className=\{styles\.activeTimeframeControl\}[\s\S]*?onChangeActiveTimeframe\(timeframe\)/);
  assert.match(workspaceSource, /현재 시장 12개 차트 봉 주기 일괄 변경/);
  assert.match(workspaceSource, /활성 슬롯 봉 주기 선택/);
  assert.doesNotMatch(
    workspaceSource,
    /allTimeframeBarRef|allTimeframeOptionRef|getBoundingClientRect|scrollLeft|scrollIntoView/,
  );
  assert.doesNotMatch(workspaceSource, /active-slot-timeframe|전체 봉/);
  assert.match(
    workspaceSource,
    /const requestedSelections\s*=\s*useMemo\([\s\S]*?\},\s*\[requestedSelectionContent\]\);/,
  );
  assert.doesNotMatch(
    workspaceSource,
    /\},\s*\[candidateMap,\s*symbols,\s*timeframes\]\);/,
  );
  assert.match(
    workspaceSource,
    /id=\{`slot-symbol-trigger-\$\{index\}`\}[\s\S]*?className=\{styles\.symbolOverlay\}[\s\S]*?aria-label=\{`C\$\{index \+ 1\} \$\{baseSymbol\(symbol\)\}\/USDT 종목 변경 창 열기`\}[\s\S]*?aria-haspopup="dialog"[\s\S]*?onClick=\{\(event\) => onRequestSymbolChange\(index, event\.currentTarget\)\}[\s\S]*?\{baseSymbol\(symbol\)\}\/USDT/,
  );
  assert.doesNotMatch(workspaceSource, /fixedSymbolCount|fixedSymbol|disabled=\{/);
  assert.doesNotMatch(
    workspaceSource,
    /(?:CRYPTO|TRADFI) C1·C2 사용자 지정 \+ (?:80:20|90:10|10:0) 상위 10종목 12분할 차트/,
  );
  assert.match(workspaceSource, /CRYPTO 12분할 차트/);
  assert.match(workspaceSource, /TRADFI 12분할 차트/);
  assert.match(
    workspaceSource,
    /<h2 id="multi-chart-title" className=\{styles\.srOnly\}>[\s\S]*?<div[\s\S]*?className=\{styles\.syncState\}[\s\S]*?\{activeCandleLabel\}[\s\S]*?className=\{styles\.timeframeControls\}/,
    "the green candle status and timestamp occupy the left position before timeframe controls",
  );
  assert.doesNotMatch(workspaceSource, /currentDateTime/);
  assert.match(workspaceSource, /C1·C2 기본 BTC·ETH · 사용자 지정 유지 · C3~C12 24H 거래대금 상위 10종목 1시간 자동 배열/);
  assert.match(workspaceSource, /C1·C2 사용자 지정 유지 · C3~C12 24H 거래대금 상위 10종목 1시간 자동 배열/);
  assert.match(workspaceSource, /fullSeries\[seriesKey\(activeSymbol, activeTimeframe\)\]/);
  assert.match(workspaceSource, /CANDLE_TIME_FORMATTER[\s\S]*?timeZone:\s*"Asia\/Seoul"/);
  assert.match(workspaceSource, /projectedCandleOpen\(activeSeries, activeTimeframe, activeQuoteTimestamp\)/);
  assert.match(workspaceSource, /현재 캔들 · 종목 선택 필요/);
  assert.match(workspaceSource, /현재 캔들 · 동기화 중/);
  assert.match(workspaceSource, /마지막 캔들 · \$\{activeCandleTime\}/);
  assert.match(workspaceSource, /:\s*activeCandleTime;/);
  assert.match(
    workspaceSource,
    /className=\{isCurrentCandleTime \? styles\.currentCandleTime : undefined\}/,
  );
  assert.doesNotMatch(workspaceSource, /const syncTitle/);
  assert.doesNotMatch(
    workspaceSource,
    /slotHeader|slotIdentity|slotQuote|candleCount|formatUsdtPrice|Binance WebSocket LIVE · 브라우저 공개 REST 보정|Binance Futures WebSocket LIVE · 5초 REST 정합성 보정/,
  );
  assert.match(workspaceSource, /className=\{styles\.chartBody\}[\s\S]*?onClick=\{\(\) => onSelectSlot\(index\)\}/);
  assert.doesNotMatch(workspaceSource, /universeError/);

  const chartSource = await readFile(
    new URL("../app/components/CandlestickChart.tsx", import.meta.url),
    "utf8",
  );
  assert.match(chartSource, /const chartBottom\s*=\s*height - 15/);
  assert.doesNotMatch(
    chartSource,
    /volumeHeight|volumeBottom|volumeTop|quoteVolumes|maximumVolume|volumeValue|barHeight/,
  );
  assert.equal(chartSource.match(/context\.fillRect\(/g)?.length, 1);
  assert.doesNotMatch(chartSource, /globalAlpha\s*=\s*0\.34|USDT 거래대금 차트/);
  assert.match(chartSource, /\$\{TIMEFRAME_LABEL\[timeframe\]\} 캔들 차트/);
  assert.match(chartSource, /color\(canvas, "--positive", "#dd3c44"\)/);
  assert.match(chartSource, /color\(canvas, "--negative", "#1375ec"\)/);
});
