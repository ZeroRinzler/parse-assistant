/**
 * Generic, cross-slice analysis math + formatting helpers.
 *
 * These are pure, non-domain primitives (rounding, time clustering, outlier
 * predicates, expected-use arithmetic, clock formatting, severity ordering) that
 * several slices computed identically. They live here under `shared/` the same way
 * `shared/gear/gear-comparison.ts` does - a blessed cross-slice presentational/stats
 * derivation - so each slice imports one implementation instead of re-declaring it.
 *
 * Deliberately NOT here: each slice's WCL-response projection (`toParseRankings`) and
 * its domain clustering/benchmark math, which CLAUDE.md keeps self-contained per slice.
 */
import { median } from 'd3-array';
import { AnalysisFinding } from '../../core/models/analysis.models';

/** Round to `decimals` places (default 1). d3-array has no rounding helper. */
export function round(value: number, decimals = 1): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

/** Group windows whose time is within `mergeS` of the running cluster median. */
export function groupByTime<T extends { time_s: number }>(windows: T[], mergeS: number): T[][] {
  const sorted = [...windows].sort((a, b) => a.time_s - b.time_s);
  const clusters: T[][] = [];
  let openTimes: number[] = [];
  for (const window of sorted) {
    if (clusters.length && Math.abs(window.time_s - (median(openTimes) ?? 0)) <= mergeS) {
      clusters[clusters.length - 1].push(window);
      openTimes.push(window.time_s);
    } else {
      clusters.push([window]);
      openTimes = [window.time_s];
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

/** True when `value` is more than one stddev BELOW the mean (the critical band). */
export function isCriticallyBelow(value: number, mean: number, stddev: number): boolean {
  return value - mean < -stddev;
}

/** Cast efficiency percentage given total downtime in gaps (clamped to >= 0). */
export function castEfficiencyPct(totalDowntimeS: number, fightDurS: number): number {
  return Math.max(0, (1 - totalDowntimeS / fightDurS) * 100);
}

/** The value closest to zero (smallest absolute value) - the primary BL offset. */
export function closestToZero(values: number[]): number {
  return values.reduce((best, value) => (Math.abs(value) < Math.abs(best) ? value : best));
}

/** Data-driven expected + floor uses for a fight from the top-parse uses/min. */
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
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));
}
