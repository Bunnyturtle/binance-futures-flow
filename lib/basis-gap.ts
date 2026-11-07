/**
 * 거래소별 현선갭. gap-watch/gap_alert.py를 옮긴 모듈입니다.
 *
 * 갭(%) = (현물 - 선물) / 선물 × 100   (트레이딩뷰 수식 (XXXUSDT-XXXUSDT.P)/XXXUSDT.P*100과 같습니다)
 * 같은 거래소 안의 USDT 현물과 USDT 무기한 선물을 비교합니다.
 */

export const BASIS_EXCHANGES = ["Binance", "OKX", "Bybit", "Bitget", "Gate", "KuCoin", "MEXC", "HTX"] as const;
export type BasisExchange = (typeof BASIS_EXCHANGES)[number];

export interface BasisLimits {
  /** |갭|이 이 값을 넘으면 티커만 같은 다른 코인으로 보고 무시합니다. */
  maxGapPct: number;
  /** 현물 24h 거래대금 하한(체결 없는 현물의 가짜 갭 제거). */
  minSpotVolumeUsdt: number;
  /** 선물 24h 거래대금 하한. */
  minPerpVolumeUsdt: number;
}

export const BASIS_LIMITS: BasisLimits = {
  maxGapPct: 50,
  minSpotVolumeUsdt: 100_000,
  minPerpVolumeUsdt: 1_000_000,
};

/** 한 번에 내려보내는 갭 행 수(|갭| 큰 순). */
export const BASIS_RESULT_LIMIT = 300;

export interface BasisTicker {
  price: number;
  volumeUsdt: number;
}

export type BasisBook = Map<string, BasisTicker>;

export interface BasisGap {
  coin: string;
  gapPct: number;
  spotPrice: number;
  /** 수량 배수(1000PEPE 등)를 나눈 1코인당 선물 가격 */
  perpPrice: number;
  spotVolumeUsdt: number;
  perpVolumeUsdt: number;
  /** 선물 심볼의 수량 배수. 1이면 배수 없음 */
  multiplier: number;
}

export interface BasisRow extends BasisGap {
  exchange: BasisExchange;
}

export interface BasisExchangeStatus {
  exchange: BasisExchange;
  ok: boolean;
  error: string | null;
  /** 필터를 통과해 감시 중인 종목 수 */
  monitored: number;
}

export interface BasisSnapshot {
  updated: number;
  limits: BasisLimits;
  exchanges: BasisExchangeStatus[];
  /** 전체 거래소를 합쳐 |갭| 큰 순으로 자른 행 */
  rows: BasisRow[];
  totalRows: number;
}

/** 파이썬 float()처럼 숫자로 못 바꾸는 값은 0으로 봅니다. */
export function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 'BTCUSDT' → 'BTC'. 해당 마켓이 아니면 null. */
export function baseOf(symbol: string, suffix: string): string | null {
  if (!symbol.endsWith(suffix)) return null;
  const base = symbol.slice(0, -suffix.length);
  return base || null;
}

/** 선물 심볼의 수량 배수 접두사 (예: 1000PEPE, 1MBABYDOGE) */
export const MULT_PREFIX = /^(1000000|100000|10000|1000|1M)(?=[A-Z])/;

export function calcBasisGaps(
  spot: BasisBook,
  perp: BasisBook,
  limits: BasisLimits = BASIS_LIMITS,
  watchlist: readonly string[] = [],
): BasisGap[] {
  const gaps: BasisGap[] = [];
  for (const [base, perpTicker] of perp) {
    let coin = base;
    let multiplier = 1;
    if (!spot.has(coin)) {
      // 선물만 1000PEPE처럼 배수 단위로 상장된 경우 현물 PEPE와 맞춥니다.
      const match = MULT_PREFIX.exec(base);
      if (!match || !spot.has(base.slice(match[0].length))) continue;
      coin = base.slice(match[0].length);
      multiplier = match[1] === "1M" ? 1_000_000 : Number(match[1]);
    }
    if (watchlist.length && !watchlist.includes(coin)) continue;
    const spotTicker = spot.get(coin) as BasisTicker;
    const perpPrice = perpTicker.price / multiplier;
    if (spotTicker.price <= 0 || perpPrice <= 0) continue;
    if (spotTicker.volumeUsdt < limits.minSpotVolumeUsdt || perpTicker.volumeUsdt < limits.minPerpVolumeUsdt) continue;
    const gapPct = ((spotTicker.price - perpPrice) / perpPrice) * 100;
    if (Math.abs(gapPct) > limits.maxGapPct) continue;
    gaps.push({
      coin,
      gapPct,
      spotPrice: spotTicker.price,
      perpPrice,
      spotVolumeUsdt: spotTicker.volumeUsdt,
      perpVolumeUsdt: perpTicker.volumeUsdt,
      multiplier,
    });
  }
  return gaps;
}

/** 거래소별 결과를 합쳐 |갭| 큰 순으로 정렬하고 limit개로 자릅니다. */
export function mergeBasisResults(
  results: { exchange: BasisExchange; gaps: BasisGap[] | null; error: string | null }[],
  limits: BasisLimits = BASIS_LIMITS,
  limit = BASIS_RESULT_LIMIT,
  now = Date.now(),
): BasisSnapshot {
  const rows = results
    .flatMap(({ exchange, gaps }) => (gaps ?? []).map((gap): BasisRow => ({ exchange, ...gap })))
    .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
  return {
    updated: Math.floor(now / 1000),
    limits,
    exchanges: results.map(({ exchange, gaps, error }) => ({
      exchange,
      ok: gaps !== null,
      error,
      monitored: gaps?.length ?? 0,
    })),
    rows: rows.slice(0, limit),
    totalRows: rows.length,
  };
}

// ── 거래소 조회: (현물, 선물)을 {코인: (최종 체결가, 24h 거래대금 USDT)}로 돌려줍니다 ──

const REQUEST_TIMEOUT_MS = 10_000;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} (${new URL(url).host})`);
  return response.json();
}

type Row = Record<string, unknown>;

function list(value: unknown, where: string): Row[] {
  if (!Array.isArray(value)) throw new Error(`${where} 응답 형식이 예상과 다름`);
  return value as Row[];
}

function book(
  rows: Row[],
  symbolKey: string,
  suffix: string,
  ticker: (row: Row) => BasisTicker,
  transform: (symbol: string) => string = (symbol) => symbol,
): BasisBook {
  const out: BasisBook = new Map();
  for (const row of rows) {
    const base = baseOf(transform(String(row[symbolKey] ?? "")), suffix);
    if (base) out.set(base, ticker(row));
  }
  return out;
}

const FETCHERS: Record<BasisExchange, () => Promise<[BasisBook, BasisBook]>> = {
  async Binance() {
    const [spot, perp] = await Promise.all([
      getJson("https://api.binance.com/api/v3/ticker/24hr"),
      getJson("https://fapi.binance.com/fapi/v1/ticker/24hr"),
    ]);
    const ticker = (row: Row) => ({ price: num(row.lastPrice), volumeUsdt: num(row.quoteVolume) });
    // 만기 선물(BTCUSDT_261225)은 USDT로 끝나지 않아 여기서 걸러집니다.
    return [book(list(spot, "Binance 현물"), "symbol", "USDT", ticker), book(list(perp, "Binance 선물"), "symbol", "USDT", ticker)];
  },
  async OKX() {
    const base = "https://www.okx.com/api/v5/market/tickers?instType=";
    const [spot, perp] = await Promise.all([getJson(`${base}SPOT`), getJson(`${base}SWAP`)]);
    return [
      book(list((spot as Row).data, "OKX 현물"), "instId", "-USDT", (row) => ({ price: num(row.last), volumeUsdt: num(row.volCcy24h) })),
      // SWAP의 volCcy24h는 코인 수량입니다.
      book(list((perp as Row).data, "OKX 선물"), "instId", "-USDT-SWAP", (row) => ({ price: num(row.last), volumeUsdt: num(row.volCcy24h) * num(row.last) })),
    ];
  },
  async Bybit() {
    const base = "https://api.bybit.com/v5/market/tickers?category=";
    const [spot, perp] = await Promise.all([getJson(`${base}spot`), getJson(`${base}linear`)]);
    const ticker = (row: Row) => ({ price: num(row.lastPrice), volumeUsdt: num(row.turnover24h) });
    return [
      book(list(((spot as Row).result as Row)?.list, "Bybit 현물"), "symbol", "USDT", ticker),
      book(list(((perp as Row).result as Row)?.list, "Bybit 선물"), "symbol", "USDT", ticker),
    ];
  },
  async Bitget() {
    const [spot, perp] = await Promise.all([
      getJson("https://api.bitget.com/api/v2/spot/market/tickers"),
      getJson("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES"),
    ]);
    const ticker = (row: Row) => ({ price: num(row.lastPr), volumeUsdt: num(row.usdtVolume) });
    return [
      book(list((spot as Row).data, "Bitget 현물"), "symbol", "USDT", ticker),
      book(list((perp as Row).data, "Bitget 선물"), "symbol", "USDT", ticker),
    ];
  },
  async Gate() {
    const [spot, perp] = await Promise.all([
      getJson("https://api.gateio.ws/api/v4/spot/tickers"),
      getJson("https://api.gateio.ws/api/v4/futures/usdt/tickers"),
    ]);
    return [
      book(list(spot, "Gate 현물"), "currency_pair", "_USDT", (row) => ({ price: num(row.last), volumeUsdt: num(row.quote_volume) })),
      book(list(perp, "Gate 선물"), "contract", "_USDT", (row) => ({ price: num(row.last), volumeUsdt: num(row.volume_24h_quote) })),
    ];
  },
  async KuCoin() {
    const [spot, perp] = await Promise.all([
      getJson("https://api.kucoin.com/api/v1/market/allTickers"),
      getJson("https://api-futures.kucoin.com/api/v1/contracts/active"),
    ]);
    const spotBook = book(
      list(((spot as Row).data as Row)?.ticker, "KuCoin 현물"),
      "symbol",
      "-USDT",
      (row) => ({ price: num(row.last), volumeUsdt: num(row.volValue) }),
    );
    const perpBook: BasisBook = new Map();
    for (const row of list((perp as Row).data, "KuCoin 선물")) {
      // FFWCSX = 무기한. 선물 쪽은 비트코인을 XBT로 표기합니다.
      if (row.type !== "FFWCSX" || row.quoteCurrency !== "USDT" || row.status !== "Open") continue;
      const coin = row.baseCurrency === "XBT" ? "BTC" : String(row.baseCurrency ?? "");
      if (coin) perpBook.set(coin, { price: num(row.lastTradePrice), volumeUsdt: num(row.turnoverOf24h) });
    }
    return [spotBook, perpBook];
  },
  async MEXC() {
    const [spot, perp] = await Promise.all([
      getJson("https://api.mexc.com/api/v3/ticker/24hr"),
      getJson("https://contract.mexc.com/api/v1/contract/ticker"),
    ]);
    return [
      book(list(spot, "MEXC 현물"), "symbol", "USDT", (row) => ({ price: num(row.lastPrice), volumeUsdt: num(row.quoteVolume) })),
      book(list((perp as Row).data, "MEXC 선물"), "symbol", "_USDT", (row) => ({ price: num(row.lastPrice), volumeUsdt: num(row.amount24) })),
    ];
  },
  async HTX() {
    const [spot, perp] = await Promise.all([
      getJson("https://api.huobi.pro/market/tickers"),
      getJson("https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged"),
    ]);
    const spotBook = book(
      list((spot as Row).data, "HTX 현물"),
      "symbol",
      "USDT",
      (row) => ({ price: num(row.close), volumeUsdt: num(row.vol) }),
      (symbol) => symbol.toUpperCase(),
    );
    const perpBook = book(
      list((perp as Row).ticks, "HTX 선물").filter((row) => row.business_type === "swap"),
      "contract_code",
      "-USDT",
      (row) => ({ price: num(row.close), volumeUsdt: num(row.trade_turnover) }),
    );
    return [spotBook, perpBook];
  },
};

/** 한 거래소가 실패해도 나머지는 계속 봅니다. */
export async function buildBasisSnapshot(limits: BasisLimits = BASIS_LIMITS): Promise<BasisSnapshot> {
  const results = await Promise.all(BASIS_EXCHANGES.map(async (exchange) => {
    try {
      const [spot, perp] = await FETCHERS[exchange]();
      return { exchange, gaps: calcBasisGaps(spot, perp, limits), error: null };
    } catch (error) {
      return { exchange, gaps: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return mergeBasisResults(results, limits);
}

let inFlight: { at: number; value: Promise<BasisSnapshot> } | null = null;

/** 화면 여러 개가 열려 있어도 거래소에는 8초에 한 번만 묻습니다. */
export function getBasisSnapshot(): Promise<BasisSnapshot> {
  const now = Date.now();
  if (inFlight && now - inFlight.at <= 8_000) return inFlight.value;
  const value = buildBasisSnapshot();
  const entry = { at: now, value };
  inFlight = entry;
  value.catch(() => {
    if (inFlight === entry) inFlight = null;
  });
  return value;
}
