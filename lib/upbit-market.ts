/**
 * Upbit KRW 현물 마켓의 시장 규칙을 한 곳에 모읍니다. 서버 라우트와 브라우저
 * 직접 복구 경로가 같은 상수를 쓰도록 클라이언트 안전한 순수 모듈로 유지합니다.
 */

export const UPBIT_QUOTE_CURRENCY = "KRW";

/** 앱에서 선택할 수 있는 봉 주기입니다. 모두 Upbit REST 캔들로 조회됩니다. */
export const UPBIT_CHART_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M",
] as const;

export type UpbitChartTimeframe = (typeof UPBIT_CHART_TIMEFRAMES)[number];

const TIMEFRAME_SET = new Set<string>(UPBIT_CHART_TIMEFRAMES);

export function isUpbitChartTimeframe(value: unknown): value is UpbitChartTimeframe {
  return typeof value === "string" && TIMEFRAME_SET.has(value);
}

/** `GET /v1/candles/...` 경로 조각입니다. */
const TIMEFRAME_PATH: Record<UpbitChartTimeframe, string> = {
  "1m": "minutes/1",
  "3m": "minutes/3",
  "5m": "minutes/5",
  "15m": "minutes/15",
  "30m": "minutes/30",
  "1h": "minutes/60",
  "4h": "minutes/240",
  "1d": "days",
  "1w": "weeks",
  "1M": "months",
};

export function upbitCandlePath(timeframe: UpbitChartTimeframe): string {
  return TIMEFRAME_PATH[timeframe];
}

/**
 * WebSocket `candle.*` 타입입니다. 일·주·월봉은 Upbit이 캔들 스트림을 제공하지
 * 않으므로 null을 돌려주고, 화면은 ticker 체결가로 마지막 봉만 갱신합니다.
 */
const TIMEFRAME_STREAM: Record<UpbitChartTimeframe, string | null> = {
  "1m": "candle.1m",
  "3m": "candle.3m",
  "5m": "candle.5m",
  "15m": "candle.15m",
  "30m": "candle.30m",
  "1h": "candle.60m",
  "4h": "candle.240m",
  "1d": null,
  "1w": null,
  "1M": null,
};

export function upbitCandleStreamType(timeframe: UpbitChartTimeframe): string | null {
  return TIMEFRAME_STREAM[timeframe];
}

const TIMEFRAME_MS: Record<Exclude<UpbitChartTimeframe, "1M">, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

/** 달력 월은 길이가 달라 별도로 계산합니다. */
export function upbitTimeframeDurationMs(
  timeframe: UpbitChartTimeframe,
): number | null {
  return timeframe === "1M" ? null : TIMEFRAME_MS[timeframe];
}

export function upbitNextCandleOpen(
  openTime: number,
  timeframe: UpbitChartTimeframe,
): number {
  if (timeframe === "1M") {
    const open = new Date(openTime);
    return Date.UTC(open.getUTCFullYear(), open.getUTCMonth() + 1, 1);
  }
  return openTime + TIMEFRAME_MS[timeframe];
}

/** `KRW-BTC` 형태만 허용합니다. 소문자·공백은 호출 측에서 정규화합니다. */
const KRW_MARKET_PATTERN = /^KRW-[A-Z0-9]{2,20}$/;

export function isUpbitKrwMarket(value: unknown): value is string {
  return typeof value === "string" && KRW_MARKET_PATTERN.test(value);
}

export function normalizeUpbitMarket(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/** `KRW-BTC` → `BTC`. */
export function upbitBaseAsset(market: string): string {
  const separator = market.indexOf("-");
  return separator >= 0 ? market.slice(separator + 1) : market;
}

/**
 * KRW 마켓 호가 단위입니다. 현재 거래 중인 150개 마켓의 호가창 간격 최대공약수로
 * 각 구간을 확인했고, 50만~200만원 구간은 해당 가격대 마켓이 없어 업비트가 공개한
 * 표값을 그대로 씁니다(두 구간 모두 정수 표시라 표시 정밀도에는 영향이 없습니다).
 * 호가 단위는 가격 표시 자릿수에만 쓰이며 주문에는 사용하지 않습니다.
 */
const KRW_TICK_TABLE: readonly (readonly [number, number])[] = [
  [2_000_000, 1_000],
  [1_000_000, 1_000],
  [500_000, 500],
  [100_000, 100],
  [10_000, 10],
  [1_000, 1],
  [100, 0.1],
  [10, 0.01],
  [1, 0.001],
  [0.1, 0.0001],
  [0.01, 0.00001],
  [0.001, 0.000001],
  [0.0001, 0.0000001],
];

const SMALLEST_KRW_TICK = 0.00000001;

export function upbitKrwTickSize(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return SMALLEST_KRW_TICK;
  for (const [floor, tick] of KRW_TICK_TABLE) {
    if (price >= floor) return tick;
  }
  return SMALLEST_KRW_TICK;
}

/** 소수 자릿수. 실측 가격이 호가 단위보다 잘게 표시되는 마켓(KRW-USDT 등)을 위해 둘 다 봅니다. */
export function upbitPriceDecimals(price: number, tickSize?: number): number {
  const tick = Number.isFinite(tickSize) && (tickSize ?? 0) > 0
    ? (tickSize as number)
    : upbitKrwTickSize(price);
  const fromTick = decimalsOf(tick);
  const fromPrice = Number.isFinite(price) ? decimalsOf(price) : 0;
  return Math.min(8, Math.max(fromTick, fromPrice));
}

function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const [coefficient, exponentText] = Math.abs(value)
    .toString()
    .toLowerCase()
    .split("e");
  const coefficientDecimals = coefficient.split(".")[1]?.length ?? 0;
  const exponent = exponentText ? Number(exponentText) : 0;
  return Math.max(0, coefficientDecimals - exponent);
}
