/**
 * 업비트 대 해외 거래소 현물 갭(김프). gap-watch/spot_gap_chart.py를 옮긴 모듈입니다.
 *
 * 갭(%) = (업비트 환산가 - 해외 가격) / 해외 가격 × 100
 * 업비트 환산가 = 업비트 KRW 가격 / 업비트 KRW-USDT 가격 (같은 봉의 종가끼리 계산)
 *
 * 순수 계산(parseSpotGapQuery, computeSpotGap)과 거래소 조회(buildSpotGapData,
 * buildSpotGapLive)를 한 파일에 두되, 조회 함수만 네트워크를 씁니다.
 */

export const SPOT_GAP_INTERVALS = [1, 5, 15, 60] as const;
export type SpotGapInterval = (typeof SPOT_GAP_INTERVALS)[number];
export const SPOT_GAP_DAY_OPTIONS = [1, 3, 7, 14, 30] as const;
export const SPOT_GAP_MAX_DAYS = 60;
export const SPOT_GAP_MAX_CANDLES = 1000;
/** 갭이 이 범위를 벗어나면 티커만 같은 다른 코인으로 보고 뺍니다. 상장 직후 업비트가 훨씬 비싸게 열릴 수 있어 위쪽은 넉넉하게 둡니다. */
export const MISMATCH_LOW_PCT = -50;
export const MISMATCH_HIGH_PCT = 300;

export interface SpotGapQuery {
  coin: string;
  interval: SpotGapInterval;
  days: number;
}

export const SPOT_GAP_DEFAULTS: SpotGapQuery = { coin: "XRP", interval: 15, days: 7 };

/** 해외 거래소(최대 5개, 차트 색상 수)와 USDT 현물 심볼 형식. */
export const SPOT_GAP_VENUES = [
  { name: "Binance", symbol: (coin: string) => `${coin}USDT` },
  { name: "Bybit", symbol: (coin: string) => `${coin}USDT` },
  { name: "Bitget", symbol: (coin: string) => `${coin}USDT` },
  { name: "Gate", symbol: (coin: string) => `${coin}_USDT` },
  { name: "OKX", symbol: (coin: string) => `${coin}-USDT` },
] as const;
export type SpotGapVenueName = (typeof SPOT_GAP_VENUES)[number]["name"];
export const SPOT_GAP_VENUE_NAMES: readonly SpotGapVenueName[] = SPOT_GAP_VENUES.map((venue) => venue.name);

/** 화면에서 고친 입력이 잘못됐을 때(400). */
export class SpotGapInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpotGapInputError";
  }
}

/** 거래소가 심볼이 없다고 알려 준 경우 등, 조회는 됐지만 값을 쓸 수 없는 경우. */
export class SpotGapLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpotGapLookupError";
  }
}

export class SpotGapHttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status} (${new URL(url).host})`);
    this.name = "SpotGapHttpError";
    this.status = status;
  }
}

function isSpotGapInterval(value: number): value is SpotGapInterval {
  return (SPOT_GAP_INTERVALS as readonly number[]).includes(value);
}

/** 화면에서 고른 코인·분봉·기간. 빠진 값은 기본값을 씁니다. */
export function parseSpotGapQuery(
  params: URLSearchParams,
  defaults: SpotGapQuery = SPOT_GAP_DEFAULTS,
): SpotGapQuery {
  const coin = (params.get("coin") ?? defaults.coin).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,15}$/.test(coin)) {
    throw new SpotGapInputError(`코인 티커가 올바르지 않음: ${coin || "(빈 값)"}`);
  }
  const intervalRaw = params.get("interval");
  const interval = intervalRaw === null || intervalRaw.trim() === ""
    ? defaults.interval
    : Number(intervalRaw);
  if (!isSpotGapInterval(interval)) {
    throw new SpotGapInputError(`지원하지 않는 분봉: ${intervalRaw}`);
  }
  const daysRaw = params.get("days");
  const days = daysRaw === null || daysRaw.trim() === "" ? defaults.days : Number(daysRaw);
  if (!Number.isInteger(days)) {
    throw new SpotGapInputError(`기간이 올바르지 않음: ${daysRaw}`);
  }
  return { coin, interval, days: Math.max(1, Math.min(days, SPOT_GAP_MAX_DAYS)) };
}

/** 한 번에 받을 수 있는 봉은 1,000개라서 1분봉은 약 17시간, 15분봉은 약 10일까지입니다. */
export function spotGapCandleCount(interval: SpotGapInterval, days: number): number {
  return Math.min(Math.floor((days * 1440) / interval), SPOT_GAP_MAX_CANDLES);
}

/** 봉 시작 시각(UTC 초) → 종가. */
export type CloseSeries = Map<number, number>;

export type VenueCloses =
  | { ok: true; closes: CloseSeries }
  | { ok: false; error: unknown };

export interface SpotGapVenueRow {
  name: string;
  symbol: string;
  /** [봉 시각(UTC 초), 갭(%), 해외 가격] */
  gap: [number, number, number][];
  error: string | null;
}

export interface SpotGapData {
  coin: string;
  interval: SpotGapInterval;
  /** 요청한 기간(일) */
  period: number;
  /** 봉 수 한도를 적용한 실제 기간(일) */
  days: number;
  updated: number;
  /** [봉 시각(UTC 초), 업비트 환산가(USDT), 업비트 KRW 가격] */
  price: [number, number, number][];
  venues: SpotGapVenueRow[];
}

export interface SpotGapLive {
  coin: string;
  ts: number;
  krw: number;
  upbit: number;
  venues: Partial<Record<SpotGapVenueName, number | null>>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 파이썬의 `f"{x:.4g}"`처럼 유효숫자 4자리로 줄입니다. */
function significant(value: number, digits = 4): string {
  return String(Number(value.toPrecision(digits)));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function describeVenueError(error: unknown): string {
  // 없는 심볼이면 거래소가 400/404나 오류 코드로 알려 줍니다.
  const unlisted = error instanceof SpotGapLookupError
    || (error instanceof SpotGapHttpError && (error.status === 400 || error.status === 404));
  return unlisted ? "미상장 (이 거래소 현물에 없는 심볼)" : `조회 실패 (${errorMessage(error)})`;
}

export function computeSpotGap(input: {
  coin: string;
  interval: SpotGapInterval;
  period: number;
  count: number;
  coinKrw: CloseSeries;
  usdtKrw: CloseSeries;
  venues: { name: string; symbol: string; result: VenueCloses }[];
  now?: number;
}): SpotGapData {
  const upbit = new Map<number, number>();
  for (const [time, krw] of input.coinKrw) {
    const usdt = input.usdtKrw.get(time);
    if (usdt && usdt > 0) upbit.set(time, krw / usdt);
  }

  const venues = input.venues.map(({ name, symbol, result }): SpotGapVenueRow => {
    if (!result.ok) return { name, symbol, gap: [], error: describeVenueError(result.error) };
    const gap: [number, number, number][] = [...result.closes.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([time, venuePrice]) => {
        const upbitPrice = upbit.get(time);
        if (upbitPrice === undefined || !(venuePrice > 0)) return [];
        return [[time, round4(((upbitPrice - venuePrice) / venuePrice) * 100), venuePrice]];
      });
    if (!gap.length) return { name, symbol, gap: [], error: "업비트와 겹치는 봉이 없음" };
    const [lastTime, lastGap, lastVenuePrice] = gap[gap.length - 1];
    if (lastGap < MISMATCH_LOW_PCT || lastGap > MISMATCH_HIGH_PCT) {
      return {
        name,
        symbol,
        gap: [],
        error: `티커만 같은 다른 코인 (이 거래소 ${significant(lastVenuePrice)} USDT, 업비트 환산 ${significant(upbit.get(lastTime) ?? 0)} USDT)`,
      };
    }
    return { name, symbol, gap, error: null };
  });

  return {
    coin: input.coin,
    interval: input.interval,
    period: input.period,
    days: Math.round((input.count * input.interval) / 1440 * 10) / 10,
    updated: Math.floor((input.now ?? Date.now()) / 1000),
    price: [...upbit.keys()]
      .sort((a, b) => a - b)
      .map((time) => [time, upbit.get(time) as number, input.coinKrw.get(time) as number]),
    venues,
  };
}

// ── 거래소 조회 ───────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new SpotGapHttpError(response.status, url);
  return response.json();
}

function rows(value: unknown, where: string): unknown[][] {
  if (!Array.isArray(value)) throw new Error(`${where} 응답 형식이 예상과 다름`);
  return value as unknown[][];
}

function closesFrom(list: unknown[][], timeIndex: number, closeIndex: number, timeInMs: boolean): CloseSeries {
  const out: CloseSeries = new Map();
  for (const row of list) {
    const time = Number(row[timeIndex]);
    const close = Number(row[closeIndex]);
    if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
    out.set(timeInMs ? Math.floor(time / 1000) : time, close);
  }
  return out;
}

const binanceBar = (minutes: SpotGapInterval) => (minutes === 60 ? "1h" : `${minutes}m`);

export async function fetchUpbitCloses(market: string, minutes: SpotGapInterval, count: number): Promise<CloseSeries> {
  const start = Date.now() / 1000 - count * minutes * 60;
  const out: CloseSeries = new Map();
  let to = "";
  for (;;) {
    const url = `https://api.upbit.com/v1/candles/minutes/${minutes}?market=${market}&count=200${to}`;
    let list: { candle_date_time_utc: string; trade_price: number }[] = [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        list = (await getJson(url)) as typeof list;
        break;
      } catch (error) {
        // 429 = 초당 요청 제한 초과
        if (!(error instanceof SpotGapHttpError) || error.status !== 429 || attempt === 3) throw error;
        await sleep(1000);
      }
    }
    if (!Array.isArray(list)) throw new Error("업비트 응답 형식이 예상과 다름");
    for (const row of list) {
      out.set(Date.parse(`${row.candle_date_time_utc}Z`) / 1000, Number(row.trade_price));
    }
    // 체결이 없는 봉은 빠져서 오므로 개수가 아니라 시각으로 끝을 판단합니다.
    if (list.length < 200 || Math.min(...out.keys()) <= start) break;
    to = `&to=${encodeURIComponent(`${list[list.length - 1].candle_date_time_utc}Z`)}`;
    await sleep(150);
  }
  return new Map([...out].filter(([time]) => time >= start));
}

const VENUE_CANDLES: Record<SpotGapVenueName, (symbol: string, minutes: SpotGapInterval, count: number) => Promise<CloseSeries>> = {
  async Binance(symbol, minutes, count) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceBar(minutes)}&limit=${count}`;
    return closesFrom(rows(await getJson(url), "Binance"), 0, 4, true);
  },
  async Bybit(symbol, minutes, count) {
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${minutes}&limit=${count}`;
    const body = (await getJson(url)) as { retCode: number; retMsg: string; result?: { list?: unknown } };
    if (body.retCode !== 0) throw new SpotGapLookupError(body.retMsg);
    return closesFrom(rows(body.result?.list, "Bybit"), 0, 4, true);
  },
  async Bitget(symbol, minutes, count) {
    const bar = minutes === 60 ? "1h" : `${minutes}min`;
    const url = `https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=${bar}&limit=${count}`;
    const body = (await getJson(url)) as { data?: unknown };
    return closesFrom(rows(body.data, "Bitget"), 0, 4, true);
  },
  async Gate(symbol, minutes, count) {
    const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${symbol}&interval=${binanceBar(minutes)}&limit=${count}`;
    // Gate 캔들은 [시각(초), 거래대금, 종가, 고가, 저가, 시가, ...] 순서입니다.
    return closesFrom(rows(await getJson(url), "Gate"), 0, 2, false);
  },
  async OKX(symbol, minutes, count) {
    const bar = minutes === 60 ? "1H" : `${minutes}m`;
    const out: CloseSeries = new Map();
    let after = "";
    while (out.size < count) { // 요청당 300봉 제한
      const url = `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=300${after}`;
      const body = (await getJson(url)) as { code: string; msg: string; data?: unknown };
      if (body.code !== "0") throw new SpotGapLookupError(body.msg);
      const list = rows(body.data, "OKX");
      for (const [time, close] of closesFrom(list, 0, 4, true)) out.set(time, close);
      if (list.length < 300) break;
      after = `&after=${list[list.length - 1][0]}`;
    }
    return out;
  },
};

export async function buildSpotGapData(query: SpotGapQuery): Promise<SpotGapData> {
  const { coin, interval, days } = query;
  const count = spotGapCandleCount(interval, days);
  const market = `KRW-${coin}`;
  // 업비트는 초당 요청 제한이 빡빡해서 두 마켓을 동시에 받지 않고 차례로 받습니다.
  const upbitPair = (async () => {
    const coinKrw = await fetchUpbitCloses(market, interval, count);
    const usdtKrw = await fetchUpbitCloses("KRW-USDT", interval, count);
    return { coinKrw, usdtKrw };
  })();
  const venueJobs = SPOT_GAP_VENUES.map(async (venue) => {
    const symbol = venue.symbol(coin);
    try {
      return { name: venue.name, symbol, result: { ok: true, closes: await VENUE_CANDLES[venue.name](symbol, interval, count) } as VenueCloses };
    } catch (error) {
      return { name: venue.name, symbol, result: { ok: false, error } as VenueCloses };
    }
  });

  let pair: { coinKrw: CloseSeries; usdtKrw: CloseSeries };
  try {
    pair = await upbitPair;
  } catch (error) {
    await Promise.allSettled(venueJobs);
    if (error instanceof SpotGapHttpError && error.status === 404) {
      throw new SpotGapLookupError(`업비트에 ${market} 마켓이 아직 없음 (거래 개시 전이면 열릴 때까지 자동으로 다시 조회)`);
    }
    throw new SpotGapLookupError(`업비트 KRW 마켓에서 ${coin} 조회 실패 (${errorMessage(error)})`);
  }
  const venues = await Promise.all(venueJobs);
  if (!pair.coinKrw.size) throw new SpotGapLookupError(`업비트 ${market} 첫 체결 대기 중`);

  return computeSpotGap({
    coin,
    interval,
    period: days,
    count,
    coinKrw: pair.coinKrw,
    usdtKrw: pair.usdtKrw,
    venues,
  });
}

const VENUE_TICKERS: Record<SpotGapVenueName, (symbol: string) => Promise<unknown>> = {
  Binance: async (symbol) => ((await getJson(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)) as { price: string }).price,
  Bybit: async (symbol) => ((await getJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`)) as { result: { list: { lastPrice: string }[] } }).result.list[0].lastPrice,
  Bitget: async (symbol) => ((await getJson(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol}`)) as { data: { lastPr: string }[] }).data[0].lastPr,
  Gate: async (symbol) => ((await getJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${symbol}`)) as { last: string }[])[0].last,
  OKX: async (symbol) => ((await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}`)) as { data: { last: string }[] }).data[0].last,
};

export function isSpotGapVenueName(value: string): value is SpotGapVenueName {
  return (SPOT_GAP_VENUE_NAMES as readonly string[]).includes(value);
}

/** 현재가만 가볍게 조회합니다. 화면이 몇 초 간격으로 마지막 봉을 움직이는 데 씁니다. */
export async function buildSpotGapLive(coin: string, names: readonly SpotGapVenueName[]): Promise<SpotGapLive> {
  const upbitJob = (async () => {
    const list = (await getJson(`https://api.upbit.com/v1/ticker?markets=KRW-${coin},KRW-USDT`)) as { market: string; trade_price: number }[];
    const prices = new Map(list.map((row) => [row.market, Number(row.trade_price)]));
    const krw = prices.get(`KRW-${coin}`);
    const usdt = prices.get("KRW-USDT");
    if (!krw || !usdt) throw new SpotGapLookupError(`업비트 ${coin} 현재가 없음`);
    return { krw, usdt };
  })();
  const venuePrices = await Promise.all(names.map(async (name) => {
    const venue = SPOT_GAP_VENUES.find((item) => item.name === name);
    if (!venue) return [name, null] as const;
    try {
      const price = Number(await VENUE_TICKERS[name](venue.symbol(coin)));
      return [name, Number.isFinite(price) && price > 0 ? price : null] as const;
    } catch {
      return [name, null] as const;
    }
  }));
  const { krw, usdt } = await upbitJob;
  return {
    coin,
    ts: Math.floor(Date.now() / 1000),
    krw,
    upbit: krw / usdt,
    venues: Object.fromEntries(venuePrices),
  };
}

// ── 짧은 캐시: 같은 조건의 조회가 몰려도 거래소에는 ttl마다 한 번만 묻습니다 ──

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttlMs: number, build: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at <= ttlMs) return hit.value as Promise<T>;
  if (cache.size >= 32) cache.clear();
  const value = build();
  cache.set(key, { at: now, value });
  // 실패한 조회는 남기지 않아 다음 요청이 바로 다시 묻습니다.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

export function getSpotGapData(query: SpotGapQuery): Promise<SpotGapData> {
  return cached(`data:${query.coin}:${query.interval}:${query.days}`, 30_000, () => buildSpotGapData(query));
}

export function getSpotGapLive(coin: string, names: readonly SpotGapVenueName[]): Promise<SpotGapLive> {
  return cached(`live:${coin}:${names.join(",")}`, 1_000, () => buildSpotGapLive(coin, names));
}
