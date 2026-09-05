export function applyTimeframeToAll<T>(
  current: T[],
  timeframe: T,
  slotCount: number,
) {
  if (
    current.length === slotCount &&
    current.every((value) => value === timeframe)
  ) {
    return current;
  }
  return Array.from({ length: slotCount }, () => timeframe);
}

export function applyTimeframeToActive<T>(
  current: T[],
  activeIndex: number,
  timeframe: T,
  slotCount: number,
) {
  if (!current.length || slotCount <= 0) return current;
  const targetIndex = Math.max(
    0,
    Math.min(slotCount - 1, current.length - 1, activeIndex),
  );
  if (current[targetIndex] === timeframe) return current;
  return current.map((value, index) =>
    index === targetIndex ? timeframe : value
  );
}
