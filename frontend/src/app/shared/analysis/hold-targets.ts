import { deviation, median } from 'd3-array';
import { round, fmtClock } from './analysis-math';
import { CdHoldTargets } from '../../core/models/encounter.models';
import { AnalysisFinding } from '../../core/models/analysis.models';

/** A gap beyond this past the expected on-cooldown time counts as a deliberate hold. */
export const HOLD_THRESHOLD_S = 8.0;
/** A hold target surfaces only when a MAJORITY of sampled parses hold at that index. */
export const HOLD_CONSENSUS_FRAC = 0.5;
/** Floor on the runtime tolerance band half-width, so a tight cluster still tolerates jitter. */
export const HOLD_BAND_MIN_S = 5.0;

export interface HoldWindow {
  cast_index: number;
  actual_s: number;
  delay_s: number;
}

/** Anything carrying the per-parse hold windows a bench aggregates over. */
export interface HoldWindowSource {
  hold_windows: HoldWindow[];
}

// Prior-relative: each cast is measured against the prior ACTUAL cast + the cooldown, not a
// cumulative ideal schedule, so a single hold does not cascade into every later cast looking held.
export function detectHoldWindows(castTimesS: number[], effectiveCd: number): HoldWindow[] {
  const holdWindows: HoldWindow[] = [];
  for (let castIndex = 1; castIndex < castTimesS.length; castIndex++) {
    const expected = castTimesS[castIndex - 1] + effectiveCd;
    const actual = castTimesS[castIndex];
    const delay = actual - expected;
    if (delay > HOLD_THRESHOLD_S) {
      holdWindows.push({ cast_index: castIndex + 1, actual_s: round(actual), delay_s: round(delay) });
    }
  }
  return holdWindows;
}

// `target_s` is the absolute clock median (display); `delay_s`/`band_s`/`effective_cd_s` are the
// prior-relative band the runtime compares the player's own gap against.
export function buildHoldTargets(
  entries: HoldWindowSource[], effectiveCd: number, totalSamples = entries.length,
): CdHoldTargets {
  const byIndex = new Map<number, { actuals: number[]; delays: number[] }>();
  for (const entry of entries) {
    for (const hold of entry.hold_windows) {
      const bucket = byIndex.get(hold.cast_index) ?? { actuals: [], delays: [] };
      bucket.actuals.push(hold.actual_s);
      bucket.delays.push(hold.delay_s);
      byIndex.set(hold.cast_index, bucket);
    }
  }
  const targets: CdHoldTargets = {};
  for (const [castIndex, { actuals, delays }] of byIndex.entries()) {
    if (actuals.length >= Math.max(2, totalSamples * HOLD_CONSENSUS_FRAC)) {
      const delayStddev = round(deviation(delays) ?? 0);
      targets[String(castIndex)] = {
        target_s: round(median(actuals) ?? 0),
        stddev_s: round(deviation(actuals) ?? 0),
        delay_s: round(median(delays) ?? 0),
        delay_stddev_s: delayStddev,
        band_s: round(Math.max(delayStddev, HOLD_BAND_MIN_S)),
        effective_cd_s: round(effectiveCd),
        count: actuals.length,
        total_samples: totalSamples,
      };
    }
  }
  return targets;
}

/**
 * Prior-relative (cascade-free): compares the player's own gap from their previous cast against
 * the band. Flags only an under-hold clearly below it; over-holding is tolerated.
 */
export function holdSuggestionFindings(
  name: string, castTimesS: number[], holdTargets: CdHoldTargets,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  if (!castTimesS.length) return findings;
  for (const [idxStr, target] of Object.entries(holdTargets)) {
    const index = parseInt(idxStr, 10) - 1;
    // Need a prior cast to measure a prior-relative gap; index 0 has none.
    if (index < 1 || index >= castTimesS.length) continue;
    const playerDelay = castTimesS[index] - castTimesS[index - 1] - target.effective_cd_s;
    if (playerDelay < target.delay_s - target.band_s) {
      findings.push({
        severity: 'info',
        category: 'hold_suggestion',
        timestamp_ms: Math.round(castTimesS[index] * 1000),
        measured: { value: fmtClock(castTimesS[index]), unit: `top ${fmtClock(target.target_s)}` },
        message: `${name} cast ${idxStr} at ${fmtClock(castTimesS[index])}. ${target.count}/${target.total_samples} top parses hold to ${fmtClock(target.target_s)}.`,
        details: { remedy: `Hold ${name} to ${fmtClock(target.target_s)}.`, cd_name: name },
        occurrences: [],
      });
    }
  }
  return findings;
}
