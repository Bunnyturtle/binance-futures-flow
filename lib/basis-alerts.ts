/**
 * 현선갭 알림 판단. gap-watch/gap_alert.py의 쿨다운 규칙을 그대로 따릅니다.
 *
 * - |갭|이 임계값 이상이면 알립니다.
 * - 같은 거래소·코인은 쿨다운 동안 다시 알리지 않습니다.
 * - 쿨다운 중이라도 지난 알림보다 |갭|이 realertStepPct 이상 더 벌어지면 다시 알립니다.
 */

export interface BasisAlertSettings {
  thresholdPct: number;
  cooldownSec: number;
  realertStepPct: number;
  /** 알림을 받을 거래소. 비어 있으면 아무 거래소도 알리지 않습니다. */
  exchanges: readonly string[];
}

export const DEFAULT_BASIS_ALERT_SETTINGS: Omit<BasisAlertSettings, "exchanges"> = {
  thresholdPct: 3,
  cooldownSec: 600,
  realertStepPct: 2,
};

export interface BasisAlertInput {
  exchange: string;
  coin: string;
  gapPct: number;
  spotPrice: number;
  perpPrice: number;
}

export interface BasisAlertEvent extends BasisAlertInput {
  key: string;
  at: number;
}

/** (거래소:코인) → 마지막 알림 시각(ms)과 그때의 |갭| */
export type BasisAlertMemory = Readonly<Record<string, { at: number; absGap: number }>>;

export function basisAlertKey(exchange: string, coin: string): string {
  return `${exchange}:${coin}`;
}

export function collectBasisAlerts(
  rows: readonly BasisAlertInput[],
  memory: BasisAlertMemory,
  settings: BasisAlertSettings,
  now: number,
): { events: BasisAlertEvent[]; memory: BasisAlertMemory } {
  const next: Record<string, { at: number; absGap: number }> = { ...memory };
  const enabled = new Set(settings.exchanges);
  const events: BasisAlertEvent[] = [];
  for (const row of rows) {
    if (!enabled.has(row.exchange)) continue;
    const absGap = Math.abs(row.gapPct);
    if (!(absGap >= settings.thresholdPct)) continue;
    const key = basisAlertKey(row.exchange, row.coin);
    const previous = next[key];
    if (
      previous
      && now - previous.at < settings.cooldownSec * 1000
      && absGap < previous.absGap + settings.realertStepPct
    ) continue;
    next[key] = { at: now, absGap };
    events.push({ ...row, key, at: now });
  }
  return { events, memory: next };
}

/** 오래된 기록을 지워 메모리가 끝없이 커지지 않게 합니다. */
export function pruneBasisAlertMemory(memory: BasisAlertMemory, cooldownSec: number, now: number): BasisAlertMemory {
  return Object.fromEntries(
    Object.entries(memory).filter(([, value]) => now - value.at < cooldownSec * 1000),
  );
}

export function describeBasisDirection(gapPct: number): string {
  return gapPct > 0 ? "현물 > 선물" : "선물 > 현물";
}
