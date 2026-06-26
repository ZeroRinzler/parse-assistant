/**
 * Dev-flag `RotationDataSource`: computes the rotation bench live in the browser
 * (no ingestion). Self-contained per the slice rule - it imports ONLY the two API
 * services + models + `logWarn`, and reimplements its own per-cooldown statistics
 * below (it does NOT reference the ingest analysis). Bound by
 * `environment.useLiveTransform`.
 *
 * It fetches the encounter's top parses, refetches each parse's Casts + Buffs (for
 * Bloodlust) + DamageDone, summarizes each cooldown's casts, and rolls the per-cd
 * benchmarks + efficiency thresholds across parses - mirroring the ingest bench.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent, ParseRanking, WclRawRanking } from '../../../core/models/wcl.models';
import { RulebookCooldown, RulebookDefensive } from '../../../core/models/rulebook.models';
import { PerCdBenchmark, UsesPerMin } from '../../../core/models/encounter.models';
import { logWarn } from '../../../core/log';
import { mean, median, deviation, quantile } from 'd3-array';
import { RotationBench, RotationDataSource } from './rotation-data-source';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
/** Bloodlust / Heroism / Time Warp / etc. - any of these starts a "BL window". */
const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);
/** BL window: a CD counts as aligned if cast 30s before to 55s after BL start. */
const BL_WINDOW_BEFORE_S = 30;
const BL_WINDOW_AFTER_S = 55;
/** A gap beyond this past the expected on-cooldown time counts as a deliberate hold. */
const HOLD_THRESHOLD_S = 8.0;
/** p90 of pooled cast gaps is the downtime floor. */
const DOWNTIME_PERCENTILE = 0.9;
const DEFAULT_DOWNTIME_THRESHOLD_MS = 1500;
/** Cast index needs this share of parsers holding for it to surface as a hold target. */
const HOLD_TRIGGER_FRAC = 0.4;

/* ----------------------------- pure stats helpers (own math) ----------------------------- */

// WCL anonymizes a privacy-protected parse's player name to "Character <id>-<id>",
// which can never match a report actor (real names are letters only), so the parse
// is unfetchable. Drop these before mapping.
const ANONYMIZED_NAME = /^Character \d+-\d+$/;

/** Map raw WCL rankings to the top `count` fetchable parses (report + fight + player). */
export function toParseRankings(raw: WclRawRanking[], count: number): ParseRanking[] {
  return raw
    .filter(ranking => ranking.report?.code && !ANONYMIZED_NAME.test(ranking.name ?? ''))
    .slice(0, count)
    .map(ranking => ({
      player: ranking.name ?? '',
      report_code: ranking.report?.code ?? '',
      fight_id: ranking.report?.fightID ?? 0,
    }));
}

/** Round to `decimals` places (default 1). d3-array has no rounding helper. */
function round(value: number, decimals = 1): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

/** Cooldown name -> spell id, for the row / header icons. */
export function rotationCdSpellIds(cooldowns: RulebookCooldown[], defensives: RulebookDefensive[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const cooldown of cooldowns) if (cooldown.spell_id) map[cooldown.name] = cooldown.spell_id;
  for (const defensive of defensives) if (defensive.spell_id) map[defensive.name] = defensive.spell_id;
  return map;
}

/** Fight-relative seconds of the first Bloodlust/Heroism/etc., or null if none. */
export function detectBloodlust(buffEvents: WclEvent[], fightStartMs: number): number | null {
  for (const event of buffEvents) {
    if (event.type === 'applybuff' && BLOODLUST_IDS.has(event.abilityGameID)) {
      return (event.timestamp - fightStartMs) / 1000;
    }
  }
  return null;
}

/** Per-parse, per-cd cast summary: count, first cast, BL alignment, hold windows. */
export interface CdSummary {
  name: string;
  total_uses: number;
  first_cast_s: number | null;
  bl_aligned: boolean;
  bl_offset_s: number | null;
  cast_times_s: number[];
  hold_windows: { cast_index: number; actual_s: number }[];
  cast_pattern: 'hold' | 'on_cooldown';
  fight_duration_s: number;
}

/** Summarize one parse's cooldown casts (mirrors ingest summarizeCooldownCasts). */
export function summarizeCooldownCasts(
  castEvents: WclEvent[], cooldowns: RulebookCooldown[],
  fightStartMs: number, fightDurS: number, blTimeS: number | null,
): CdSummary[] {
  return cooldowns.map(cooldown => {
    const castTimesS = castEvents
      .filter(cast => cast.type === 'cast' && cast.abilityGameID === cooldown.spell_id)
      .map(cast => (cast.timestamp - fightStartMs) / 1000)
      .sort((a, b) => a - b);

    let blAligned = false;
    let blOffsetS: number | null = null;
    if (blTimeS != null && castTimesS.length) {
      const windowOffsets = castTimesS
        .filter(timeS => blTimeS - BL_WINDOW_BEFORE_S <= timeS && timeS <= blTimeS + BL_WINDOW_AFTER_S)
        .map(timeS => timeS - blTimeS);
      blAligned = windowOffsets.length > 0;
      if (windowOffsets.length) {
        blOffsetS = round(windowOffsets.reduce((best, offset) => (Math.abs(offset) < Math.abs(best) ? offset : best)));
      }
    }

    const holdWindows: { cast_index: number; actual_s: number }[] = [];
    if (castTimesS.length > 1) {
      const cdSeconds = cooldown.cooldown ?? 90;
      let expectedT = castTimesS[0];
      for (let castIndex = 1; castIndex < castTimesS.length; castIndex++) {
        expectedT += cdSeconds;
        const actual = castTimesS[castIndex];
        if (actual - expectedT > HOLD_THRESHOLD_S) {
          holdWindows.push({ cast_index: castIndex + 1, actual_s: round(actual) });
        }
      }
    }

    return {
      name: cooldown.name,
      total_uses: castTimesS.length,
      first_cast_s: castTimesS.length ? round(castTimesS[0]) : null,
      bl_aligned: blAligned,
      bl_offset_s: blOffsetS,
      cast_times_s: castTimesS.map(timeS => round(timeS, 2)),
      hold_windows: holdWindows,
      cast_pattern: holdWindows.length ? 'hold' : 'on_cooldown',
      fight_duration_s: fightDurS,
    };
  });
}

/** Inter-cast gaps (ms, ascending) of all casts in a parse - for the downtime floor. */
export function castGapListMs(castEvents: WclEvent[]): number[] {
  const completed = castEvents.filter(event => event.type === 'cast').sort((a, b) => a.timestamp - b.timestamp);
  const gaps: number[] = [];
  for (let i = 1; i < completed.length; i++) gaps.push(Math.round(completed[i].timestamp - completed[i - 1].timestamp));
  return gaps.sort((a, b) => a - b);
}

/** uses-per-minute distribution across parses for one cooldown. */
function benchUsesPerMin(entries: CdSummary[]): UsesPerMin {
  const usesPerMin: number[] = [];
  for (const entry of entries) {
    if (entry.fight_duration_s > 0 && entry.cast_times_s.length) {
      usesPerMin.push(Math.round((entry.cast_times_s.length / entry.fight_duration_s) * 60 * 1000) / 1000);
    }
  }
  if (!usesPerMin.length) return { avg: 0, stddev: 0, min: 0, max: 0 };
  return {
    avg: round((mean(usesPerMin) ?? 0), 3),
    stddev: round((deviation(usesPerMin) ?? 0), 3),
    min: Math.min(...usesPerMin),
    max: Math.max(...usesPerMin),
  };
}

/** Per-cast-index hold targets where enough parsers delayed, with the median target. */
function buildHoldTargets(entries: CdSummary[]): PerCdBenchmark['hold_targets'] {
  const byIdx = new Map<number, number[]>();
  for (const entry of entries) {
    for (const hold of entry.hold_windows) {
      if (!byIdx.has(hold.cast_index)) byIdx.set(hold.cast_index, []);
      byIdx.get(hold.cast_index)!.push(hold.actual_s);
    }
  }
  const targets: PerCdBenchmark['hold_targets'] = {};
  for (const [castIndex, times] of byIdx.entries()) {
    if (times.length >= Math.max(2, entries.length * HOLD_TRIGGER_FRAC)) {
      targets[String(castIndex)] = {
        target_s: round((median(times) ?? 0)),
        stddev_s: round((deviation(times) ?? 0)),
        count: times.length,
        total_samples: entries.length,
      };
    }
  }
  return targets;
}

/** Roll one cooldown's per-parse summaries into a `PerCdBenchmark`. */
export function buildCdBenchmark(entries: CdSummary[]): PerCdBenchmark {
  const firstCasts = entries.map(entry => entry.first_cast_s).filter((value): value is number => value != null);
  const gaps: number[] = [];
  for (const entry of entries) {
    const times = entry.cast_times_s;
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  }
  const blOffsets = entries.map(entry => entry.bl_offset_s).filter((value): value is number => value != null);
  const blCount = entries.filter(entry => entry.bl_aligned).length;
  const upmList = entries
    .filter(entry => entry.fight_duration_s > 0)
    .map(entry => entry.total_uses / (entry.fight_duration_s / 60));
  const usesPerMin = benchUsesPerMin(entries);

  return {
    sample_count: entries.length,
    avg_first_cast_s: firstCasts.length ? round((mean(firstCasts) ?? 0)) : 0,
    stddev_first_cast_s: firstCasts.length ? round((deviation(firstCasts) ?? 0)) : 0,
    avg_gap_s: gaps.length ? round((mean(gaps) ?? 0)) : null,
    stddev_gap_s: gaps.length ? round((deviation(gaps) ?? 0)) : null,
    avg_bl_offset_s: blOffsets.length ? round((mean(blOffsets) ?? 0)) : null,
    stddev_bl_offset_s: blOffsets.length ? round((deviation(blOffsets) ?? 0)) : null,
    avg_uses: entries.length ? round(mean(entries.map(entry => entry.total_uses)) ?? 0) : 0,
    avg_uses_per_min: upmList.length ? round((mean(upmList) ?? 0), 2) : 0,
    uses_per_min: usesPerMin,
    bl_pct: entries.length ? Math.round((blCount / entries.length) * 100) : 0,
    majority_hold: entries.filter(entry => entry.cast_pattern === 'hold').length > entries.length * 0.5,
    hold_targets: buildHoldTargets(entries),
  };
}

/** Downtime floor (p90 of pooled gaps) + top-parse efficiency mean/stddev. */
export function computeEfficiencyThresholds(
  gapLists: number[][], durations: number[],
): { downtimeThresholdMs: number; topAvgEfficiency: number; topEfficiencyStddev: number } {
  const allGaps = gapLists.flat().sort((a, b) => a - b);
  let downtimeThresholdMs = DEFAULT_DOWNTIME_THRESHOLD_MS;
  if (allGaps.length) {
    downtimeThresholdMs = quantile(allGaps, DOWNTIME_PERCENTILE) ?? DEFAULT_DOWNTIME_THRESHOLD_MS;
  }
  const efficiencies: number[] = [];
  for (let i = 0; i < gapLists.length; i++) {
    const gaps = gapLists[i];
    const durationS = durations[i] ?? 0;
    if (gaps.length && durationS > 0) {
      const downtimeS = gaps.filter(gap => gap > downtimeThresholdMs).reduce((sum, gap) => sum + gap, 0) / 1000;
      efficiencies.push(round(Math.max(0, (1 - downtimeS / durationS) * 100)));
    }
  }
  return {
    downtimeThresholdMs: Math.round(downtimeThresholdMs),
    topAvgEfficiency: efficiencies.length ? round((mean(efficiencies) ?? 0)) : 0,
    topEfficiencyStddev: efficiencies.length ? round((deviation(efficiencies) ?? 0)) : 0,
  };
}

/** Roll per-parse cooldown summaries into the per-cd benchmark map. */
export function aggregateCdBenchmarks(perParse: CdSummary[][]): Record<string, PerCdBenchmark> {
  const byCd = new Map<string, CdSummary[]>();
  for (const summaries of perParse) {
    for (const summary of summaries) {
      if (!byCd.has(summary.name)) byCd.set(summary.name, []);
      byCd.get(summary.name)!.push(summary);
    }
  }
  const result: Record<string, PerCdBenchmark> = {};
  for (const [name, entries] of byCd.entries()) result[name] = buildCdBenchmark(entries);
  return result;
}

/* ----------------------------- service shell ----------------------------- */

interface ParseRotation {
  summaries: CdSummary[];
  gapListMs: number[];
  durationS: number;
  encounterName: string;
  abilityIcons: Record<number, { icon: string; name: string }>;
}

@Injectable({ providedIn: 'root' })
export class RotationTransformService implements RotationDataSource {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getRotationBench(spec: string, encounterId: number): Promise<RotationBench | null> {
    const rulebook = await this.dataFiles.getRulebook(spec);
    const cooldowns = rulebook?.major_cooldowns ?? [];
    if (!cooldowns.length) return null;
    const defensives = rulebook?.defensives ?? [];
    const rules = rulebook?.rules ?? [];

    const rankings = toParseRankings(await this.wclApi.getRankings(spec, encounterId), TOP_PARSE_COUNT);
    if (!rankings.length) return null;

    const perParse: CdSummary[][] = [];
    const gapLists: number[][] = [];
    const durations: number[] = [];
    const abilityIcons: Record<number, { icon: string; name: string }> = {};
    let encounterName = '';
    for (const ranking of rankings) {
      const parse = await this.computeParse(ranking, cooldowns);
      if (!parse) continue;
      perParse.push(parse.summaries);
      gapLists.push(parse.gapListMs);
      durations.push(parse.durationS);
      encounterName ||= parse.encounterName;
      Object.assign(abilityIcons, parse.abilityIcons);
    }
    if (!perParse.length) return null;

    const { downtimeThresholdMs, topAvgEfficiency, topEfficiencyStddev } = computeEfficiencyThresholds(gapLists, durations);

    return {
      spec,
      encounter_id: encounterId,
      encounter_name: encounterName,
      sample_count: perParse.length,
      avg_duration_s: durations.length ? round((mean(durations) ?? 0)) : 0,
      downtime_threshold_ms: downtimeThresholdMs,
      top_avg_efficiency: topAvgEfficiency,
      top_efficiency_stddev: topEfficiencyStddev,
      per_cd_benchmarks: aggregateCdBenchmarks(perParse),
      major_cooldowns: cooldowns,
      rules,
      cd_spell_ids: rotationCdSpellIds(cooldowns, defensives),
      ability_icons: abilityIcons,
    };
  }

  /** One parse's rotation summary via the colocated pure fns; null if unfetchable. */
  private async computeParse(
    ranking: ParseRanking, cooldowns: RulebookCooldown[],
  ): Promise<ParseRotation | null> {
    try {
      const report = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = report.masterData?.actors?.find(actor => actor.name === ranking.player);
      if (!fight || !player) return null;

      const abilityIcons: Record<number, { icon: string; name: string }> = {};
      for (const ability of report.masterData?.abilities ?? []) {
        abilityIcons[ability.gameID] = { icon: ability.icon, name: ability.name };
      }

      const [casts, buffs] = await Promise.all([
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id),
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id),
      ]);

      const fightDurS = (fight.endTime - fight.startTime) / 1000;
      const blTimeS = detectBloodlust(buffs, fight.startTime);
      return {
        summaries: summarizeCooldownCasts(casts, cooldowns, fight.startTime, fightDurS, blTimeS),
        gapListMs: castGapListMs(casts),
        durationS: fightDurS,
        encounterName: fight.name ?? '',
        abilityIcons,
      };
    } catch (err) {
      logWarn(`RotationTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
