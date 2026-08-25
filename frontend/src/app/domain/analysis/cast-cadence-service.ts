import { inject, Injectable } from '@angular/core';
import { AnalysisFinding } from './analysis.models';
import { CadenceBenchmark } from '../encounter/encounter.models';
import { avgOr, stddevOr, medianOr, castGaps, round, fmtClock, isOutlierAbove } from './analysis-math';
import { HoldWindow, HOLD_CONSENSUS_FRAC } from './hold-targets-service';
import { HoldTargetsService } from './hold-targets-service';

@Injectable({ providedIn: 'root' })
export class CastCadenceService {
  private readonly holdTargets = inject(HoldTargetsService);

  buildCadenceBenchmark(users: CadenceEntry[], effectiveCd: number, totalParses: number): CadenceBenchmark {
    const firstCasts = users.map(user => user.first_cast_s).filter((value): value is number => value != null);
    const gaps = castGaps(users);
    const perMin = users
      .filter(user => user.fight_duration_s > 0 && user.cast_times_s.length > 0)
      .map(user => round(user.cast_times_s.length / user.fight_duration_s * 60, 3));

    return {
      sample_count: totalParses,
      used_sample_count: users.length,
      avg_first_cast_s: avgOr(firstCasts, 0),
      stddev_first_cast_s: stddevOr(firstCasts, 0),
      avg_gap_s: avgOr(gaps, null),
      stddev_gap_s: stddevOr(gaps, null),
      hold_targets: this.holdTargets.buildHoldTargets(users, effectiveCd, totalParses),
      median_uses: medianOr(users.map(user => user.cast_times_s.length), 0),
      uses_per_min: { avg: avgOr(perMin, 0, 3), stddev: stddevOr(perMin, 0, 3) },
      majority_hold: users.length > 0
        && users.filter(user => user.cast_pattern === 'hold').length >= users.length * HOLD_CONSENSUS_FRAC,
    };
  }

  usedByMajority(bench: CadenceBenchmark): boolean {
    return bench.used_sample_count / bench.sample_count >= MIN_USE_SHARE_FRAC;
  }

  checkLostUses(
    voice: CadenceVoice, name: string, actual: number, expected: number, floor: number, fightDurS: number,
    castTimesS: number[], bench: CadenceBenchmark,
  ): AnalysisFinding | null {
    if (actual === 0 && expected >= 1) return {
      severity: 'critical', category: 'lost_cooldown', cd_name: name,
      timestamp_s: bench.avg_first_cast_s,
      measured: { value: `0 / ${expected}`, unit: voice.unit },
      message: `${name} was never used. Top raiders get ${expected} on a ${fmtClock(fightDurS)} fight.`,
      details: { remedy: `Use ${name} ${expected}x this fight.` }, occurrences: [] };
    if (actual > 0 && actual < floor) {
      const lastCastS = castTimesS[actual - 1];
      // The last real cast plus the typical gap: roughly when the next one should have landed.
      const predictedS = lastCastS != null && bench.avg_gap_s != null ? lastCastS + bench.avg_gap_s : undefined;
      return {
        severity: 'critical', category: 'lost_cooldown', cd_name: name,
        timestamp_s: predictedS,
        measured: { value: `${actual} / ${expected}`, unit: voice.unit },
        message: `${name} was used ${actual} times. Top raiders get ${expected}.`,
        details: { remedy: voice.underuseRemedy(name, floor - actual) }, occurrences: [] };
    }
    return null;
  }

  checkFirstCastDelay(
    voice: CadenceVoice, name: string, castTimesS: number[], bench: CadenceBenchmark,
  ): AnalysisFinding | null {
    const firstS = castTimesS[0];
    if (firstS == null) return null;
    const delayS = firstS - bench.avg_first_cast_s;
    if (delayS <= MIN_HELD_DELAY_S) return null;
    // A 1-parse bench has no real variance to test (stddev degenerates toward 0), so the floor above is its only gate.
    if (bench.sample_count >= 2 && !isOutlierAbove(firstS, bench.avg_first_cast_s, bench.stddev_first_cast_s)) return null;
    const lateS = delayS.toFixed(0);
    return {
      severity: 'warning', category: 'cooldown_delay', cd_name: name,
      timestamp_s: firstS,
      measured: { value: `+${lateS}s`, unit: `top ${fmtClock(bench.avg_first_cast_s)}` },
      message: `${name} ${voice.firstCastPhrase} ${fmtClock(firstS)}, ${lateS}s later than top raiders. Aim for ${fmtClock(bench.avg_first_cast_s)}.`,
      details: { remedy: voice.firstCastRemedy(name) }, occurrences: [] };
  }

  checkGaps(
    voice: CadenceVoice, name: string, castTimesS: number[], bench: CadenceBenchmark,
  ): AnalysisFinding[] {
    const findings: AnalysisFinding[] = [];
    if (bench.avg_gap_s == null || bench.stddev_gap_s == null) return findings;
    const avgGapS = bench.avg_gap_s;
    let prevS: number | undefined;
    for (const timeS of castTimesS) {
      const gap = prevS != null ? timeS - prevS : null;
      prevS = timeS;
      if (gap == null) continue;
      if (gap - avgGapS <= MIN_HELD_DELAY_S) continue;
      // Unlike first-cast timing, one parse contributes a gap sample per cast pair, so stddev stays meaningful at sample_count 1.
      if (!isOutlierAbove(gap, avgGapS, bench.stddev_gap_s)) continue;
      findings.push({
        severity: 'warning', category: 'cooldown_delay', cd_name: name,
        timestamp_s: timeS,
        measured: { value: `${gap.toFixed(0)}s`, unit: `avg ${avgGapS.toFixed(0)}s` },
        message: `${name} sat ${gap.toFixed(0)}s between ${voice.gapNoun} at ${fmtClock(timeS)}. Top raiders average ${avgGapS.toFixed(0)}s.`,
        details: { remedy: voice.gapRemedy(name, avgGapS) }, occurrences: [] });
    }
    return findings;
  }

  holdsOf(bench: CadenceBenchmark | undefined): { castIndex: number; targetS: number }[] {
    if (!bench?.majority_hold) return [];
    return Object.entries(bench.hold_targets)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([idx, target]) => ({ castIndex: Number(idx), targetS: target.target_s }));
  }

  cadencePlanUsage(bench: CadenceBenchmark | undefined): CadencePlanUsage {
    if (!bench) return { typicalUses: null, usedSampleCount: 0, sampleCount: 0, firstCastS: null };
    return {
      // Any adoption yields a number here, unlike the use-share gate on firstCastS.
      typicalUses: bench.used_sample_count > 0 ? bench.median_uses : null,
      usedSampleCount: bench.used_sample_count,
      sampleCount: bench.sample_count,
      firstCastS: this.usedByMajority(bench) ? bench.avg_first_cast_s : null,
    };
  }
}

/** Rows are users-only; `totalParses` carries the non-users. */
export interface CadenceEntry {
  cast_times_s: number[];
  first_cast_s: number | null;
  fight_duration_s: number;
  hold_windows: HoldWindow[];
  cast_pattern: 'hold' | 'on_cooldown';
}

export interface CadenceVoice {
  unit: string;
  firstCastPhrase: string;
  gapNoun: string;
  underuseRemedy(name: string, missing: number): string;
  firstCastRemedy(name: string): string;
  gapRemedy(name: string, avgGapS: number): string;
}

/** A situational ability most top parses skip has a noisy expected count, so flagging against it would be a false positive. */
const MIN_USE_SHARE_FRAC = 0.5;

/** Below this delay, "held"/"cooldown_delay" never fires - a statistically significant sliver is still not a real delay. */
const MIN_HELD_DELAY_S = 5;

export interface CadencePlanUsage {
  typicalUses: number | null;
  usedSampleCount: number;
  sampleCount: number;
  firstCastS: number | null;
}
