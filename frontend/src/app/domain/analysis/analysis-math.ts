/** Generic, cross-slice analysis math + formatting helpers that several slices import instead of re-declaring. */
import { deviation, least, mean, median, pairs } from 'd3-array';
import { AnalysisFinding } from './analysis.models';

/** Round to `decimals` places (default 1). d3-array has no rounding helper. */
export function round(value: number, decimals = 1): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

/** Rounded mean, or `fallback` when there is nothing to average; the fallback type is the caller's, so a bench field can read 0 or null. */
export function avgOr<T>(values: number[], fallback: T, decimals = 1): number | T {
  return values.length ? round(mean(values) ?? 0, decimals) : fallback;
}

/** Rounded standard deviation, or `fallback` when there is nothing to measure. */
export function stddevOr<T>(values: number[], fallback: T, decimals = 1): number | T {
  return values.length ? round(deviation(values) ?? 0, decimals) : fallback;
}

/** Rounded median, or `fallback` when there is nothing to rank. */
export function medianOr<T>(values: number[], fallback: T): number | T {
  return values.length ? round(median(values) ?? 0) : fallback;
}

/** Gaps between successive casts, per entry: an entry's first cast opens no gap, and gaps never span two entries. */
export function castGaps(entries: { cast_times_s: number[] }[]): number[] {
  return entries.flatMap(entry => pairs(entry.cast_times_s, (prev, next) => next - prev));
}

/** Inserts `makeDefault()` first when `key` is absent, so a caller can group-and-append in one call instead of a has/set guard plus a non-null get. */
export function getOrInsert<K, V>(map: Map<K, V>, key: K, makeDefault: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = makeDefault();
    map.set(key, value);
  }
  return value;
}

/** Group windows whose time is within `mergeS` of the running cluster median. */
export function groupByTime<T extends { time_s: number }>(windows: T[], mergeS: number): T[][] {
  const sorted = [...windows].sort((a, b) => a.time_s - b.time_s);
  const clusters: T[][] = [];
  let open: { members: T[]; times: number[] } | null = null;
  for (const window of sorted) {
    if (open && Math.abs(window.time_s - (median(open.times) ?? 0)) <= mergeS) {
      open.members.push(window);
      open.times.push(window.time_s);
    } else {
      open = { members: [window], times: [window.time_s] };
      clusters.push(open.members);
    }
  }
  return clusters;
}

/** True when `value` sits more than `sigmas` stddev ABOVE the mean (strict). */
export function isOutlierAbove(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return value > mean + sigmas * stddev;
}

/** True when `|value - mean|` exceeds `sigmas` stddev (two-tailed, strict). */
export function isOutlierBeyond(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return Math.abs(value - mean) > sigmas * stddev;
}

/** True when `value` sits more than `sigmas` stddev BELOW the mean (strict). Mirror of `isOutlierAbove`. */
export function isOutlierBelow(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return value < mean - sigmas * stddev;
}

/** Cast efficiency percentage given total downtime in gaps (clamped to >= 0). */
export function castEfficiencyPct(totalDowntimeS: number, fightDurS: number): number {
  return Math.max(0, (1 - totalDowntimeS / fightDurS) * 100);
}

/** The value closest to zero (smallest absolute value) - the primary BL offset. */
export function closestToZero(values: number[]): number {
  return least(values, value => Math.abs(value)) ?? 0;
}

export function benchExpectedUses(
  fightDurS: number, upm: { avg: number; stddev: number },
): { expected: number; floor: number } {
  const fightMin = fightDurS / 60;
  const expected = Math.round(upm.avg * fightMin);
  const floor = Math.max(0, Math.round(expected - upm.stddev * fightMin));
  return { expected, floor };
}

/** Format seconds as `mm:ss` (zero-padded). */
export function fmtClock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

const SEVERITY_ORDER: Record<AnalysisFinding['severity'], number> = {
  critical: 0, warning: 1, info: 2, hold_suggestion: 2, success: 3,
};
/** Sort findings in place: critical first, success last (stable for equal ranks). */
export function sortBySeverity(findings: AnalysisFinding[]): void {
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
