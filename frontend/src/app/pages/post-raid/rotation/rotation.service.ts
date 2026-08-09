import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { AnalysisFinding, FindingOccurrence, FindingTimeline } from '../../../core/models/analysis.models';
import { PerCdBenchmark } from '../../../core/models/encounter.models';
import { RulebookCooldown } from '../../../core/models/rulebook.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok, permanent } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { holdSuggestionFindings } from '../../../shared/analysis/hold-targets';
import {
  isOutlierAbove, isOutlierBeyond, isOutlierBelow, castEfficiencyPct,
  closestToZero, benchExpectedUses, fmtClock, sortBySeverity,
} from '../../../shared/analysis/analysis-math';
import { TimedEvent, relativeS, withRelativeS } from '../../../shared/analysis/wcl-projections';
import {
  buildRuleContext, evaluateRules, rulesFollowed, rulesNeed, benchedRules, RULE_TYPE_LABEL,
} from './rotation-rules';
import { ROTATION_DATA_SOURCE, RotationBench } from './rotation-data-source';

export type AbilityIcons = Record<number, { icon: string; name: string }>;

export interface RotationFindingRow {
  severity: 'critical' | 'warning' | 'info';
  /** Empty for rule rows, which render `what` instead. */
  name: string;
  spellId?: number | null;
  icon: string;
  timestampS?: number | null;
  chip?: string;
  what?: string;
  measured: { value: string; unit?: string };
  fix?: string;
  occurrences: FindingOccurrence[];
  occurrenceTarget?: string;
  timeline?: FindingTimeline;
}

export interface RotationOnPlanChip {
  name: string;
  spellId: number | null;
  icon: string;
}

export interface CdPlanRow {
  name: string;
  spellId: number | null;
  icon: string;
  firstCastS: number | null;
  uses: number | null;
  usesPerMin: number | null;
  bloodlust: boolean;
  bloodlustPct: number | null;
  holds: { castIndex: number; targetS: number }[];
  rule: string | null;
}

/** An `ok` result implies the top-parse bench exists. */
export interface RotationPlayerView {
  ruleRows: RotationFindingRow[];
  ruleOnPlan: string[];
  offensiveRows: RotationFindingRow[];
  onPlan: RotationOnPlanChip[];
}

/** Bench-only cooldown plan; an `ok` result implies the top-parse bench exists. */
export interface RotationPlanView {
  rows: CdPlanRow[];
}

const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);
const BLOODLUST_DURATION_S = 40;
// A cast from BL_WINDOW_LEAD_S before BL through BL_WINDOW_TRAIL_S after it expires counts as aligned.
const BL_WINDOW_LEAD_S = 30;
const BL_WINDOW_TRAIL_S = 15;
/** A cooldown counts as Bloodlust-aligned when at least this share (%) of top parses align it. */
const BL_CONSENSUS_PCT = 50;

const MIN_USE_SHARE_FRAC = 0.5;

function usedShare(bench: PerCdBenchmark): number {
  return bench.used_sample_count / bench.sample_count;
}

export interface RotationScanInput {
  fightDurationS: number;
  castEvents: TimedEvent[];
  buffEvents: TimedEvent[];
  cooldowns: RulebookCooldown[];
  bench: RotationBench;
}

interface CooldownScan { issues: AnalysisFinding[]; holds: AnalysisFinding[]; blAligned: boolean; }

export function checkLostUses(
  cdName: string, actual: number, expected: number, floor: number, fightDurS: number,
): AnalysisFinding | null {
  if (actual === 0 && expected >= 1) return {
    severity: 'critical', category: 'lost_cooldown', cd_name: cdName,
    measured: { value: `0 / ${expected}`, unit: 'cast(s)' },
    message: `${cdName} unused. Expected ${expected} on a ${fmtClock(fightDurS)} fight.`,
    details: { remedy: `Use ${cdName} ${expected}x this fight.` }, occurrences: [] };
  if (actual > 0 && actual < floor) return {
    severity: 'critical', category: 'lost_cooldown', cd_name: cdName,
    measured: { value: `${actual} / ${expected}`, unit: 'cast(s)' },
    message: `${cdName}: ${actual} casts, expected ${expected}. ${floor - actual} lost.`,
    details: { remedy: `Press ${cdName} ${floor - actual}x more - sooner off cooldown.` }, occurrences: [] };
  return null;
}

export function checkFirstCastDelay(
  cdName: string, castTimesS: number[], cdBench: PerCdBenchmark,
): AnalysisFinding | null {
  if (!castTimesS.length) return null;
  const firstS = castTimesS[0];
  if (!isOutlierAbove(firstS, cdBench.avg_first_cast_s, cdBench.stddev_first_cast_s)) return null;
  const lateS = (firstS - cdBench.avg_first_cast_s).toFixed(0);
  return {
    severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
    timestamp_s: castTimesS[0],
    measured: { value: `+${lateS}s`, unit: `top ${fmtClock(cdBench.avg_first_cast_s)}` },
    message: `${cdName} opened at ${fmtClock(firstS)}, ${lateS}s late. Top: ${fmtClock(cdBench.avg_first_cast_s)}.`,
    details: { remedy: `Open with ${cdName} earlier.` }, occurrences: [] };
}

export function checkBloodlustAlignment(
  cdName: string, castTimesS: number[], cdBench: PerCdBenchmark, blTimeS: number | null, wantsBL: boolean,
): { blAligned: boolean; findings: AnalysisFinding[] } {
  if (blTimeS === null || !castTimesS.length) return { blAligned: false, findings: [] };
  const inWindow = castTimesS.filter(timeS =>
    timeS >= blTimeS - BL_WINDOW_LEAD_S && timeS <= blTimeS + BLOODLUST_DURATION_S + BL_WINDOW_TRAIL_S);
  const blAligned = inWindow.length > 0;
  const findings: AnalysisFinding[] = [];
  if (!blAligned && wantsBL) {
    findings.push({ severity: 'critical', category: 'cooldown_alignment', cd_name: cdName,
      timestamp_s: castTimesS[0],
      measured: { value: 'missed', unit: 'BL' },
      message: `${cdName} missed Bloodlust (BL at ${fmtClock(blTimeS)}, first cast at ${fmtClock(castTimesS[0])}).`,
      details: { remedy: `Align ${cdName} with Bloodlust.` }, occurrences: [] });
  } else if (blAligned && cdBench.avg_bl_offset_s != null && cdBench.stddev_bl_offset_s != null) {
    const offsets = inWindow.map(timeS => timeS - blTimeS);
    const playerOffset = closestToZero(offsets);
    if (isOutlierBeyond(playerOffset, cdBench.avg_bl_offset_s, cdBench.stddev_bl_offset_s)) {
      const dir = playerOffset > cdBench.avg_bl_offset_s ? 'late' : 'early';
      // The judged cast (closest-to-zero offset) is not always the earliest in the window.
      const judgedCastS = inWindow[offsets.indexOf(playerOffset)];
      findings.push({ severity: 'warning', category: 'cooldown_alignment', cd_name: cdName,
        timestamp_s: judgedCastS,
        measured: { value: dir, unit: 'in BL' },
        message: `${cdName} ${dir} in the Bloodlust window.`,
        details: { remedy: `Tighten ${cdName} to the Bloodlust window.` }, occurrences: [] });
    }
  }
  return { blAligned, findings };
}

export function checkGaps(cdName: string, castTimesS: number[], cdBench: PerCdBenchmark): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  if (cdBench.avg_gap_s == null || cdBench.stddev_gap_s == null) return findings;
  for (let i = 1; i < castTimesS.length; i++) {
    const gap = castTimesS[i] - castTimesS[i - 1];
    if (isOutlierAbove(gap, cdBench.avg_gap_s, cdBench.stddev_gap_s)) findings.push({
      severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
      timestamp_s: castTimesS[i],
      measured: { value: `${gap.toFixed(0)}s`, unit: `avg ${cdBench.avg_gap_s.toFixed(0)}s` },
      message: `${cdName} at ${fmtClock(castTimesS[i])}: ${gap.toFixed(0)}s gap, top ${cdBench.avg_gap_s.toFixed(0)}s.`,
      details: { remedy: `Press ${cdName} sooner - top gap ${cdBench.avg_gap_s.toFixed(0)}s.` }, occurrences: [] });
  }
  return findings;
}


export function checkCastEfficiency(
  castTimesS: number[], fightDurS: number, bench: RotationBench,
): AnalysisFinding | null {
  if (castTimesS.length < 2 || bench.downtime_threshold_s == null) return null;
  let totalDtS = 0;
  for (let i = 1; i < castTimesS.length; i++) {
    const gap = castTimesS[i] - castTimesS[i - 1];
    if (gap > bench.downtime_threshold_s) totalDtS += gap;
  }
  const topE = bench.top_avg_efficiency;
  const topSD = bench.top_efficiency_stddev;
  const effPct = castEfficiencyPct(totalDtS, fightDurS);
  // Flag only more than 1 sigma below the top-parse efficiency, so beating the top parses never trips a warning.
  const WARN_SIGMAS_BELOW = 1;
  if (!isOutlierBelow(effPct, topE, topSD, WARN_SIGMAS_BELOW)) return null;
  return {
    severity: 'warning', category: 'cast_efficiency',
    label: 'Low cast efficiency',
    measured: { value: `${effPct.toFixed(1)}%`, unit: `top ${topE.toFixed(0)}%` },
    message: `${effPct.toFixed(1)}% cast efficiency, ${totalDtS.toFixed(1)}s idle. Top: ${topE.toFixed(0)}%.`,
    details: { remedy: `Fill ${totalDtS.toFixed(1)}s of gaps. Top: ${topE.toFixed(0)}%.` }, occurrences: [] };
}

/** `castTimesS` are fight-relative seconds, ascending. Null when the cooldown is talent-gated and unused. */
export function analyzeOneCooldown(
  cd: RulebookCooldown, castTimesS: number[], cdBench: PerCdBenchmark | undefined,
  fightDurS: number, blTimeS: number | null,
): { success: AnalysisFinding | null; scan: CooldownScan } | null {
  const cdName = cd.name;
  const actual = castTimesS.length;
  if (cd.talent_gated && actual === 0) return null;

  if (!cdBench) {
    const success: AnalysisFinding | null = actual > 0
      ? { severity: 'success', category: 'cooldown_usage', cd_name: cdName, message: `${cdName}: ${actual} casts (no bench data).`, occurrences: [] }
      : null;
    return { success, scan: { issues: [], holds: [], blAligned: false } };
  }

  // BL alignment is data-driven: a cooldown "wants BL" when most top parses align it.
  const wantsBL = cdBench.bl_pct >= BL_CONSENSUS_PCT;
  const { expected, floor } = benchExpectedUses(fightDurS, cdBench.uses_per_min);

  const issues: AnalysisFinding[] = [];
  // A situational cd most parses skip has a noisy expected count and a meaningless avg_first_cast_s, so flagging it would punish the player for correctly matching the parses.
  if (usedShare(cdBench) >= MIN_USE_SHARE_FRAC) {
    const lost = checkLostUses(cdName, actual, expected, floor, fightDurS);
    if (lost) issues.push(lost);
    const lateOpener = checkFirstCastDelay(cdName, castTimesS, cdBench);
    if (lateOpener) issues.push(lateOpener);
  }
  const bl = checkBloodlustAlignment(cdName, castTimesS, cdBench, blTimeS, wantsBL);
  issues.push(...bl.findings);
  issues.push(...checkGaps(cdName, castTimesS, cdBench));
  const holds = holdSuggestionFindings(cdName, castTimesS, cdBench.hold_targets);

  const success: AnalysisFinding | null = issues.length || actual === 0
    ? null
    : { severity: 'success', category: 'cooldown_usage', cd_name: cdName,
        message: `${cdName} - ${actual}/${expected} casts${bl.blAligned && wantsBL ? ', BL-aligned' : ''}.`, occurrences: [] };
  return { success, scan: { issues, holds, blAligned: bl.blAligned } };
}

export function analyzeRotationFindings(input: RotationScanInput): AnalysisFinding[] {
  const { fightDurationS: fightDurS, castEvents, buffEvents, cooldowns, bench } = input;
  const inFight = (event: TimedEvent): boolean => event.atS >= 0 && event.atS <= fightDurS;
  const casts = castEvents
    .filter(event => event.type === 'cast' && inFight(event))
    .sort((a, b) => a.atS - b.atS);

  const findings: AnalysisFinding[] = [];

  let blTimeS: number | null = null;
  for (const event of buffEvents) {
    if (event.type === 'applybuff' && BLOODLUST_IDS.has(event.abilityGameID) && inFight(event)) {
      blTimeS = event.atS;
      break;
    }
  }

  const perCdBench = bench.per_cd_benchmarks ?? {};
  for (const cd of cooldowns) {
    const castTimesS = casts
      .filter(cast => cast.abilityGameID === cd.spell_id)
      .map(cast => cast.atS);
    const result = analyzeOneCooldown(cd, castTimesS, perCdBench[cd.name], fightDurS, blTimeS);
    if (!result) continue;
    if (result.scan.issues.length) findings.push(...result.scan.issues);
    else if (result.success) findings.push(result.success);
    if (castTimesS.length) findings.push(...result.scan.holds);
  }

  const efficiency = checkCastEfficiency(casts.map(cast => cast.atS), fightDurS, bench);
  if (efficiency) findings.push(efficiency);

  sortBySeverity(findings);
  return findings;
}

const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold',
};

interface FindingBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; }

interface ResolvedCd { spellId: number | null; icon: string; rowName: string }

function resolveCd(name: string, cdSpellIds: Record<string, number>, abilities: AbilityIcons): ResolvedCd {
  const spellId = cdSpellIds[name] ?? null;
  const ability = spellId != null ? abilities[spellId] : undefined;
  if (spellId != null && !ability) logWarn('resolveCd: ability id missing from ability map', spellId);
  return spellId != null
    ? { spellId, icon: ability?.icon ?? '', rowName: ability?.name ?? name }
    : { spellId: null, icon: '', rowName: name };
}

interface PartitionedFindings {
  ruleFindings: AnalysisFinding[];
  byName: Record<string, FindingBucket>;
  successNames: Set<string>;
}

export function partitionRotationFindings(findings: AnalysisFinding[]): PartitionedFindings {
  const ruleFindings: AnalysisFinding[] = [];
  const byName: Record<string, FindingBucket> = {};
  const successNames = new Set<string>();
  for (const finding of findings) {
    if (finding.severity === 'success') { if (finding.cd_name) successNames.add(finding.cd_name); continue; }
    if (finding.category === 'hold_suggestion' && finding.details?.cd_name) {
      (byName[finding.details.cd_name] ??= { issues: [], holds: [] }).holds.push(finding);
    } else if (finding.category === 'rule_violation' || !finding.cd_name) {
      ruleFindings.push(finding);
    } else {
      (byName[finding.cd_name] ??= { issues: [], holds: [] }).issues.push(finding);
    }
  }
  return { ruleFindings, byName, successNames };
}

export function buildRuleRows(ruleFindings: AnalysisFinding[]): RotationFindingRow[] {
  return ruleFindings.map(finding => ({
    severity: finding.severity === 'critical' ? 'critical' : finding.severity === 'info' ? 'info' : 'warning',
    name: '',
    icon: '',
    what: finding.label,
    chip: finding.rule_type ? RULE_TYPE_LABEL[finding.rule_type] : undefined,
    measured: finding.measured ?? { value: '-' },
    timestampS: finding.timestamp_s ?? null,
    fix: finding.details?.remedy,
    occurrences: finding.occurrences,
    occurrenceTarget: finding.occurrenceTarget,
    timeline: finding.timeline,
  }));
}

export function buildOffensiveRows(
  byName: Record<string, FindingBucket>, cdSpellIds: Record<string, number>, abilities: AbilityIcons,
): RotationFindingRow[] {
  const offensiveRows: RotationFindingRow[] = [];
  for (const [name, bucket] of Object.entries(byName)) {
    if (!bucket.issues.length && !bucket.holds.length) continue;
    const { spellId, icon, rowName } = resolveCd(name, cdSpellIds, abilities);
    for (const finding of [...bucket.issues, ...bucket.holds]) {
      offensiveRows.push({
        severity: finding.severity === 'critical' ? 'critical' : 'warning',
        name: rowName,
        spellId,
        icon,
        timestampS: finding.timestamp_s ?? null,
        chip: CAT_LABEL[finding.category],
        measured: finding.measured ?? { value: '-' },
        fix: finding.details?.remedy,
        occurrences: finding.occurrences,
      });
    }
  }
  return offensiveRows;
}

export function buildOnPlanChips(
  partition: PartitionedFindings, cdSpellIds: Record<string, number>, abilities: AbilityIcons,
): RotationOnPlanChip[] {
  const { byName, successNames } = partition;
  const onPlan: RotationOnPlanChip[] = [];
  for (const name of successNames) {
    if (!byName[name] || (!byName[name].issues.length && !byName[name].holds.length)) {
      const { spellId, icon, rowName } = resolveCd(name, cdSpellIds, abilities);
      onPlan.push({ name: rowName, spellId, icon });
    }
  }
  return onPlan;
}

export function bucketRotationFindings(
  findings: AnalysisFinding[], cdSpellIds: Record<string, number>, abilities: AbilityIcons,
): { ruleRows: RotationFindingRow[]; offensiveRows: RotationFindingRow[]; onPlan: RotationOnPlanChip[] } {
  const partition = partitionRotationFindings(findings);
  return {
    ruleRows: buildRuleRows(partition.ruleFindings),
    offensiveRows: buildOffensiveRows(partition.byName, cdSpellIds, abilities),
    onPlan: buildOnPlanChips(partition, cdSpellIds, abilities),
  };
}

export function buildCdPlan(
  cooldowns: RulebookCooldown[], benchmarks: Record<string, PerCdBenchmark>, abilities: AbilityIcons,
): CdPlanRow[] {
  const ordered = [...cooldowns].sort((a, b) => {
    const pa = a.opener_priority ?? 99;
    const pb = b.opener_priority ?? 99;
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
  });
  return ordered.map(cd => {
    const cdBench = benchmarks[cd.name];
    const holds = cdBench?.majority_hold && cdBench.hold_targets
      ? Object.entries(cdBench.hold_targets)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([idx, target]) => ({ castIndex: Number(idx), targetS: target.target_s }))
      : [];
    const spellId = cd.spell_id ?? null;
    const ability = spellId != null ? abilities[spellId] : undefined;
    if (spellId != null && !ability) logWarn('buildCdPlan: ability id missing from ability map', spellId);
    // First cast and uses/min are user-only stats; gate them on the same use-share majority the analysis uses.
    const usedByMajority = cdBench != null && usedShare(cdBench) >= MIN_USE_SHARE_FRAC;
    return {
      name: cd.name,
      spellId,
      icon: ability?.icon ?? '',
      firstCastS: usedByMajority ? cdBench!.avg_first_cast_s : null,
      uses: cdBench?.avg_uses ?? null,
      usesPerMin: usedByMajority ? cdBench!.uses_per_min.avg : null,
      bloodlust: (cdBench?.bl_pct ?? 0) >= BL_CONSENSUS_PCT,
      bloodlustPct: (cdBench?.bl_pct ?? 0) >= BL_CONSENSUS_PCT ? cdBench!.bl_pct : null,
      holds,
      rule: cd.usage_rule ?? null,
    };
  });
}

@Injectable({ providedIn: 'root' })
export class RotationFeatureService {
  private readonly source = inject(ROTATION_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  async loadPlayerView(
    spec: string, encounterId: number, reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<RotationPlayerView, LoadError>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;

    try {
      const report = await this.wclApi.getReport(reportCode);
      const fight = report.fights.find(entry => entry.id === fightId);
      if (!fight) return permanent('Fight not found in this report.', 'rotation.player-view');

      const rules = benchedRules(bench.value.rules);
      const conditions = rules.map(entry => entry.rule);
      const [casts, buffs, enemyAuras, damage, raidDeaths] = await Promise.all([
        this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fight.startTime, fight.endTime, playerId, true),
        this.wclApi.getAllEvents(reportCode, fightId, 'Buffs', fight.startTime, fight.endTime, playerId),
        // Unnarrowable, so it costs several raid-wide pages: `Enemies` plus a sourceID returns nothing, and WCL offers no other source filter here.
        rulesNeed(conditions, 'enemyAuras')
          ? this.wclApi.getAllEvents(reportCode, fightId, 'Debuffs', fight.startTime, fight.endTime, undefined, false, 'Enemies')
          : Promise.resolve([]),
        // Target health rides on the damage rows, and only the resource-bearing form carries it.
        rulesNeed(conditions, 'damage')
          ? this.wclApi.getAllEvents(reportCode, fightId, 'DamageDone', fight.startTime, fight.endTime, playerId,
            rulesNeed(conditions, 'targetHealth'))
          : Promise.resolve([]),
        // Deaths target the player rather than come from them, so a sourceID filter would drop every one.
        rulesNeed(conditions, 'deaths')
          ? this.wclApi.getAllEvents(reportCode, fightId, 'Deaths', fight.startTime, fight.endTime)
          : Promise.resolve([]),
      ]);
      const fightDurationS = relativeS(fight.endTime, fight.startTime);
      const castsTimed = withRelativeS(casts, fight.startTime);
      const buffsTimed = withRelativeS(buffs, fight.startTime);
      const debuffsTimed = withRelativeS(enemyAuras.filter(event => event.sourceID === playerId), fight.startTime);
      const deathsTimed = withRelativeS(raidDeaths.filter(event => event.targetID === playerId), fight.startTime);

      const offensiveFindings = analyzeRotationFindings({
        fightDurationS, castEvents: castsTimed, buffEvents: buffsTimed,
        cooldowns: bench.value.major_cooldowns, bench: bench.value,
      });
      const ruleCtx = buildRuleContext({
        casts: castsTimed, buffs: buffsTimed, debuffs: debuffsTimed, damage: withRelativeS(damage, fight.startTime), deaths: deathsTimed,
        fightDurationS,
      });
      const ruleFindings = evaluateRules(rules, ruleCtx);
      const findings = [...offensiveFindings, ...ruleFindings];
      sortBySeverity(findings);
      const { ruleRows, offensiveRows, onPlan } =
        bucketRotationFindings(findings, bench.value.cd_spell_ids, bench.value.ability_icons);
      const ruleOnPlan = rulesFollowed(rules, ruleCtx);
      return ok({ ruleRows, ruleOnPlan, offensiveRows, onPlan });
    } catch (cause) {
      logWarn(`RotationFeatureService.loadPlayerView ${reportCode}:${fightId}`, cause);
      return toLoadError(cause, 'rotation.player-view');
    }
  }

  async loadPlanView(spec: string, encounterId: number): Promise<Result<RotationPlanView, LoadError>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return ok({ rows: buildCdPlan(bench.value.major_cooldowns, bench.value.per_cd_benchmarks, bench.value.ability_icons) });
  }
}
