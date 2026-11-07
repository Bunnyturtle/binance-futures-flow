import { upbitPriceDecimals } from "./upbit-market";

const GROUPED = new Intl.NumberFormat("ko-KR");

const TRILLION = 1_000_000_000_000;
const HUNDRED_MILLION = 100_000_000;
const TEN_THOUSAND = 10_000;

function trimmed(value: number, digits: number): string {
  return new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * 거래대금·평가금액을 한국식 큰 단위로 줄입니다. 원화 금액은 자릿수가 커서
 * `compact` 영문 표기(K/M/B)보다 조·억·만이 훨씬 빨리 읽힙니다.
 */
export function formatKrwCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  if (magnitude >= TRILLION) return `${sign}${trimmed(magnitude / TRILLION, 2)}조`;
  if (magnitude >= HUNDRED_MILLION) {
    return `${sign}${trimmed(magnitude / HUNDRED_MILLION, magnitude >= 10 * HUNDRED_MILLION ? 0 : 1)}억`;
  }
  if (magnitude >= TEN_THOUSAND) return `${sign}${trimmed(magnitude / TEN_THOUSAND, 0)}만`;
  return `${sign}${GROUPED.format(Math.round(magnitude))}`;
}

/** 원 단위까지 그대로 보여 줍니다(잔고 합계 등). */
export function formatKrwExact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return GROUPED.format(Math.round(value));
}

/** 호가 단위에 맞춘 가격 표기입니다. */
export function formatKrwPrice(value: number, tickSize?: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const decimals = upbitPriceDecimals(value, tickSize);
  return new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatSignedPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function formatRatio(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  return `${value.toFixed(2)}×`;
}

/** 코인 수량은 소수점이 길어 유효 자릿수를 기준으로 줄입니다. */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 1_000 ? 2 : magnitude >= 1 ? 4 : 8;
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(value);
}
