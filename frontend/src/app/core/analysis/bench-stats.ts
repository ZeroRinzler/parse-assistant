/**
 * Statistical predicates - the atoms of the bench comparison.
 *
 * Every "is the player an outlier vs top parses?" decision in the analysis
 * engine reduces to one of these tiny pure functions. Extracting them makes the
 * thresholds trivially unit-testable (pure arithmetic, no events or rulebook)
 * and gives the comparison a single, named definition instead of an inline
 * expression repeated across cooldown and defensive analysis.
 *
 * Boundary convention: comparisons are STRICT. A value exactly at
 * `mean + sigmas*stddev` is NOT an outlier; it must exceed it.
 */
import { UsesPerMin } from '../models/encounter.models';

/** True when `value` sits more than `sigmas` standard deviations ABOVE the mean. */
export function isOutlierAbove(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return value > mean + sigmas * stddev;
}

/** True when `value`'s distance from the mean exceeds `sigmas` stddev (two-tailed). */
export function isOutlierBeyond(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return Math.abs(value - mean) > sigmas * stddev;
}

/** True when `value` falls more than one stddev BELOW the mean (the "critical" band). */
export function isCriticallyBelow(value: number, mean: number, stddev: number): boolean {
  return value - mean < -stddev;
}

/** Expected number of uses of a cooldown over a fight: `1 + floor(fightDur / cd)`. */
export function expectedUses(fightDurS: number, cooldownS: number): number {
  return 1 + Math.floor(fightDurS / cooldownS);
}

/** Cast efficiency as a percentage given total downtime spent in gaps. Clamped to >= 0. */
export function castEfficiencyPct(totalDowntimeS: number, fightDurS: number): number {
  return Math.max(0, (1 - totalDowntimeS / fightDurS) * 100);
}

/** The value closest to zero (smallest absolute value) - the "primary" BL offset. */
export function closestToZero(values: number[]): number {
  return values.reduce((best, x) => (Math.abs(x) < Math.abs(best) ? x : best));
}

/**
 * Data-driven expected cooldown uses for a fight, derived from the top-parse
 * per-minute usage rate scaled to the player's actual fight length.
 *
 * `floor` is the cohort - 1 sigma threshold (rounded, >=0) below which the
 * player is genuinely under-using. Both `expected` and `floor` are rounded
 * integers so they can be compared directly against a cast count.
 *
 * Bench data is always assumed complete: `upm` must be the non-null
 * `uses_per_min` object from the per-CD/per-defensive benchmark row.
 */
export function benchExpectedUses(
  fightDurS: number,
  upm: UsesPerMin,
): { expected: number; floor: number } {
  const fightMin = fightDurS / 60;
  const expected = Math.round(upm.avg * fightMin);
  const sd = upm.stddev * fightMin;
  const floor = Math.max(0, Math.round(expected - sd));
  return { expected, floor };
}
