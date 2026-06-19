/**
 * Major-cooldown analysis: lost casts, opener delay, Bloodlust alignment,
 * over-long gaps, hold suggestions, and overall cast efficiency.
 *
 * All bench comparisons go through the named predicates in `bench-stats.ts`, so
 * the thresholds (`> mean + 2 sigma`, etc.) have a single tested definition.
 */
import { AnalysisResult, AnalysisFinding } from '../models/analysis.models';
import { EncounterBench } from '../models/encounter.models';
import { RulebookCooldown, RulebookRule } from '../models/rulebook.models';
import { WclEvent } from '../models/wcl.models';
import { Severity, sortBySeverity } from './findings';
import { BLOODLUST_IDS, BLOODLUST_DURATION_S, fmtClock } from './format';
import { isOutlierAbove, isOutlierBeyond, isCriticallyBelow, expectedUses, castEfficiencyPct, closestToZero } from './bench-stats';
import { evaluateRules } from './rule-engine';

export function analyzeCooldowns(
  playerName: string,
  spec: string,
  fStart: number,
  fEnd: number,
  castEvents: WclEvent[],
  buffEvents: WclEvent[],
  specCds: RulebookCooldown[] | null,
  rules: RulebookRule[],
  bench: EncounterBench | null,
): AnalysisResult {
  const fightDurS = (fEnd - fStart) / 1000;
  const rel = (ts: number) => ts - fStart;
  const casts = castEvents
    .filter((e) => e.type === 'cast' && e.timestamp >= fStart && e.timestamp <= fEnd)
    .sort((a, b) => a.timestamp - b.timestamp);

  const findings: AnalysisFinding[] = [];

  let blTimeS: number | null = null;
  for (const e of buffEvents) {
    if (e.type === 'applybuff' && BLOODLUST_IDS.has(e.abilityGameID) && e.timestamp >= fStart && e.timestamp <= fEnd) {
      blTimeS = rel(e.timestamp) / 1000;
      break;
    }
  }

  const downtimeThreshMs = bench?.downtime_threshold_ms;
  const perCdBench = bench?.per_cd_benchmarks ?? {};

  if (!specCds) {
    findings.push({ severity: 'info', category: 'unsupported_spec', message: `${spec} is not yet in the rulebook. Cast efficiency analysis still applies.` });
  } else {
    for (const cd of specCds) {
      const { spell_id: sid, name: cdName, cooldown: cooldownS } = cd;
      const wantsBL = cd.align_with_bloodlust !== false;
      const cdCasts = casts.filter((c) => c.abilityGameID === sid);
      const actual = cdCasts.length;
      const expected = expectedUses(fightDurS, cooldownS);
      const cdIssues: AnalysisFinding[] = [];
      const cdSugg: AnalysisFinding[] = [];

      if (cd.talent_gated && actual === 0) continue;

      if (actual === 0) {
        cdIssues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: cdName, timestamp_ms: undefined,
          message: `${cdName} was never used. In a ${fmtClock(fightDurS)} fight with a ${cooldownS}s cooldown you should have ~${expected} cast(s).` });
      } else if (actual < expected) {
        cdIssues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: cdName, timestamp_ms: undefined,
          message: `${cdName} - ${actual} of ${expected} expected casts. Lost ${expected - actual} use(s) in a ${fmtClock(fightDurS)} fight.` });
      }

      const b = perCdBench[cdName];
      if (cdCasts.length) {
        const firstS = rel(cdCasts[0].timestamp) / 1000;
        if (b?.avg_first_cast_s != null && b.stddev_first_cast_s != null) {
          const sdF = b.stddev_first_cast_s;
          if (isOutlierAbove(firstS, b.avg_first_cast_s, sdF)) cdIssues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
            timestamp_ms: rel(cdCasts[0].timestamp),
            message: `${cdName} opener at ${fmtClock(firstS)} - ${(firstS - b.avg_first_cast_s).toFixed(0)}s later than top parsers (${fmtClock(b.avg_first_cast_s)} avg ±${sdF.toFixed(0)}s).` });
        }
      }

      let blAligned = false;
      if (blTimeS !== null && cdCasts.length) {
        const blWin = cdCasts.filter((c) => { const t = rel(c.timestamp) / 1000; return t >= blTimeS! - 30 && t <= blTimeS! + BLOODLUST_DURATION_S + 15; });
        blAligned = blWin.length > 0;
        if (!blAligned && wantsBL) {
          cdIssues.push({ severity: 'critical', category: 'cooldown_alignment', cd_name: cdName,
            timestamp_ms: rel(cdCasts[0].timestamp),
            message: `${cdName} missed Bloodlust (BL at ${fmtClock(blTimeS)}, first cast at ${fmtClock(rel(cdCasts[0].timestamp) / 1000)}).` });
        } else if (blAligned && b?.avg_bl_offset_s != null && b.stddev_bl_offset_s != null) {
          const offsets = blWin.map((c) => rel(c.timestamp) / 1000 - blTimeS!);
          const po = closestToZero(offsets);
          const sd = b.stddev_bl_offset_s;
          if (isOutlierBeyond(po, b.avg_bl_offset_s, sd)) {
            const dir = po > b.avg_bl_offset_s ? 'late' : 'early';
            cdIssues.push({ severity: 'warning', category: 'cooldown_alignment', cd_name: cdName,
              timestamp_ms: rel(blWin[0].timestamp),
              message: `${cdName} used ${dir} in the BL window vs top parsers.` });
          }
        }
      }

      for (let i = 1; i < cdCasts.length; i++) {
        const gap = (rel(cdCasts[i].timestamp) - rel(cdCasts[i - 1].timestamp)) / 1000;
        if (b?.avg_gap_s != null && b.stddev_gap_s != null) {
          const sdG = b.stddev_gap_s;
          if (isOutlierAbove(gap, b.avg_gap_s, sdG)) cdIssues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
            timestamp_ms: rel(cdCasts[i].timestamp),
            message: `${cdName} at ${fmtClock(rel(cdCasts[i].timestamp) / 1000)}: ${gap.toFixed(0)}s gap vs top-parse avg ${b.avg_gap_s.toFixed(0)}s ±${sdG.toFixed(0)}s.` });
        }
      }

      if (b?.hold_targets && cdCasts.length) {
        const times = cdCasts.map((c) => rel(c.timestamp) / 1000);
        for (const [idxStr, target] of Object.entries(b.hold_targets)) {
          const k = parseInt(idxStr, 10) - 1;
          if (k >= times.length) continue;
          const playerT = times[k];
          const tol = target.stddev_s;
          if (playerT < target.target_s - tol) cdSugg.push({ severity: 'info', category: 'hold_suggestion',
            timestamp_ms: rel(cdCasts[k].timestamp),
            message: `${cdName} cast ${idxStr} at ${fmtClock(playerT)} - ${target.count}/${target.total_samples} top parsers hold until ~${fmtClock(target.target_s)}.`,
            details: { remedy: `Consider holding ${cdName} until ~${fmtClock(target.target_s)}.`, cd_name: cdName } });
        }
      }

      if (cdIssues.length) findings.push(...cdIssues);
      else if (actual > 0) findings.push({ severity: 'success', category: 'cooldown_usage', cd_name: cdName,
        message: `${cdName} - ${actual}/${expected} casts${blAligned && wantsBL ? ', BL-aligned' : ''}.` });
      if (actual > 0) findings.push(...cdSugg);
    }
  }

  if (rules.length) findings.push(...evaluateRules(rules, casts, fStart));

  if (casts.length >= 2 && downtimeThreshMs != null) {
    const gaps: { start_ms: number; duration_ms: number }[] = [];
    for (let i = 1; i < casts.length; i++) {
      const gMs = rel(casts[i].timestamp) - rel(casts[i - 1].timestamp);
      if (gMs > downtimeThreshMs) gaps.push({ start_ms: rel(casts[i - 1].timestamp), duration_ms: gMs });
    }
    const totalDtS = gaps.reduce((s, g) => s + g.duration_ms, 0) / 1000;
    if (totalDtS > 5 && bench?.top_avg_efficiency != null && bench.top_efficiency_stddev != null) {
      const topE = bench.top_avg_efficiency;
      const topSD = bench.top_efficiency_stddev;
      const effPct = castEfficiencyPct(totalDtS, fightDurS);
      const severity: Severity = isCriticallyBelow(effPct, topE, topSD) ? 'critical' : 'warning';
      findings.push({ severity, category: 'cast_efficiency',
        message: `Cast efficiency: ${effPct.toFixed(1)}% (Top average ${topE.toFixed(0)}%) - ${totalDtS.toFixed(1)}s in gaps.` });
    }
  }

  sortBySeverity(findings);

  return {
    player: playerName,
    spec,
    rulebook_source: 'none',
    findings,
    cd_spell_ids: {},
    ability_icons: {},
    player_fight_duration_s: Math.round(fightDurS * 10) / 10,
  };
}
