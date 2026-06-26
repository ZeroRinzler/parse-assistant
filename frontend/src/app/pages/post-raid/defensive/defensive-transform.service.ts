/**
 * Dev-flag `DefensiveDataSource`: computes the defensive bench live in the browser
 * (no ingestion). Self-contained per the slice rule - it imports ONLY the two API
 * services + models + `logWarn`, and reimplements its own defensive math below (it
 * does NOT reference the ingest analysis). Bound by `environment.useLiveTransform`.
 *
 * It fetches the encounter's top parses, refetches each parse's Buffs + DamageTaken
 * (and Casts as the no-self-buff fallback), builds per-parse buff-window-centric
 * defensive windows + usage summaries, then clusters them across parses and derives
 * the per-defensive benchmarks. Bench shape mirrors the ingest `DefensiveSliceFile`.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent, ParseRanking, WclReport, WclRawRanking } from '../../../core/models/wcl.models';
import { RulebookDefensive } from '../../../core/models/rulebook.models';
import { BurstWindow, TopDefensiveSummary } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { logWarn } from '../../../core/log';
import { DefensiveBench, DefensiveDataSource, DefensivePlanMeta, BakedAbility } from './defensive-data-source';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
/** Min cluster size as a fraction of samples to surface a defensive window. */
const CLUSTER_MIN_FRAC = 0.35;
/** "At least this share of member parses" - ability inclusion in a cluster. */
const MEMBER_MAJORITY_FRAC = 0.5;
/** Defensive windows within this many seconds cluster together. */
const CLUSTER_MERGE_S = 20;
/** Fraction of samples that must have held at a cast index to surface a hold target. */
const HOLD_TRIGGER_FRAC = 0.4;
/** A gap beyond this past the expected on-cooldown time counts as a deliberate hold. */
const HOLD_THRESHOLD_S = 8;
/** Fallback window length (s) when a defensive has no rulebook duration. */
const DEFAULT_WINDOW_S = 5;

/* ----------------------------- pure helpers (own math) ----------------------------- */

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

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function sampleStdev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Defensive name -> spell id, for the defensive window header icons. */
export function defensiveSpellIds(defensives: RulebookDefensive[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const defensive of defensives) if (defensive.spell_id) map[defensive.name] = defensive.spell_id;
  return map;
}

/** Rulebook defensives -> the static plan metadata carried in the slice. */
export function defensivePlanMeta(defensives: RulebookDefensive[]): DefensivePlanMeta[] {
  return defensives.map(defensive => ({
    name: defensive.name,
    spell_id: defensive.spell_id,
    cooldown: defensive.cooldown,
    duration: defensive.duration ?? null,
    usage_rule: defensive.usage_rule ?? null,
    talent_gated: !!defensive.talent_gated,
  }));
}

/** Map<spell_id, [[start_s, end_s | null], ...]> from the buff apply/remove stream. */
export function buildBuffWindows(buffEvents: WclEvent[], fightStartMs: number): Map<number, Array<[number, number | null]>> {
  const buffWindows = new Map<number, Array<[number, number | null]>>();
  for (const event of buffEvents) {
    const spellId = event.abilityGameID;
    if (spellId == null) continue;
    const timeS = (event.timestamp - fightStartMs) / 1000;
    if (event.type === 'applybuff') {
      if (!buffWindows.has(spellId)) buffWindows.set(spellId, []);
      buffWindows.get(spellId)!.push([timeS, null]);
    } else if (event.type === 'removebuff') {
      const windows = buffWindows.get(spellId) ?? [];
      for (let i = windows.length - 1; i >= 0; i--) {
        if (windows[i][1] == null) { windows[i][1] = timeS; break; }
      }
    }
  }
  return buffWindows;
}

/** One parse's defensive usage summary (buff-window-centric, cast fallback). */
export interface ParseDefensiveSummary {
  name: string;
  cast_times_s: number[];
  first_cast_s: number | null;
  uses: number;
  fight_duration_s: number;
  hold_windows: Array<{ cast_index: number; actual_s: number }>;
  cast_pattern: 'hold' | 'on_cooldown';
}

/** One parse's defensive window before cross-parse clustering. */
export interface ParseDefWindow {
  time_s: number;
  window_length_s: number;
  window_damage: number;
  defensive_name: string;
  spell_id: number;
  ref_game_id: number | null;
  ability_breakdown: Array<{ spell_id: number; damage: number }>;
}

/**
 * Per-defensive usage summary for one parse: each apply->remove buff span (or
 * explicit cast for self-buff-less defensives) is one use; hold windows mark casts
 * delayed > 8s past on-cooldown.
 */
export function summarizeDefensiveCasts(
  defensives: RulebookDefensive[],
  buffWindows: Map<number, Array<[number, number | null]>>,
  castEvents: WclEvent[],
  fightStartMs: number,
  fightDurationS: number,
): ParseDefensiveSummary[] {
  const summaries: ParseDefensiveSummary[] = [];
  for (const defensive of defensives) {
    const spellId = defensive.spell_id;
    const cooldownS = defensive.cooldown ?? 90;
    const castTimes: number[] = [];

    for (const buffWindow of (buffWindows.get(spellId) ?? [])) castTimes.push(round1(buffWindow[0]));

    if (castTimes.length === 0) {
      for (const cast of castEvents) {
        if (cast.type === 'cast' && cast.abilityGameID === spellId) {
          castTimes.push(round1((cast.timestamp - fightStartMs) / 1000));
        }
      }
    }

    castTimes.sort((a, b) => a - b);
    const holdWindows: Array<{ cast_index: number; actual_s: number }> = [];
    for (let castIndex = 1; castIndex < castTimes.length; castIndex++) {
      const expectedS = castTimes[castIndex - 1] + cooldownS;
      const actualS = castTimes[castIndex];
      if (actualS - expectedS > HOLD_THRESHOLD_S) holdWindows.push({ cast_index: castIndex, actual_s: round1(actualS) });
    }

    if (castTimes.length) {
      summaries.push({
        name: defensive.name,
        cast_times_s: castTimes,
        first_cast_s: castTimes[0],
        uses: castTimes.length,
        fight_duration_s: fightDurationS,
        hold_windows: holdWindows,
        cast_pattern: holdWindows.length ? 'hold' : 'on_cooldown',
      });
    }
  }
  return summaries;
}

/** Per-defensive windows for one parse: damage taken during each buff span + dominant enemy. */
export function findParseDefensiveWindows(
  damageTaken: WclEvent[], fightStartMs: number,
  buffWindows: Map<number, Array<[number, number | null]>>,
  defensives: RulebookDefensive[],
  gameIdByActorId: Map<number, number>,
): ParseDefWindow[] {
  const hits = damageTaken
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.timestamp, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID ?? 0, event.sourceID ?? null] as [number, number, number, number | null])
    .sort((a, b) => a[0] - b[0]);
  if (!hits.length) return [];

  const result: ParseDefWindow[] = [];
  for (const defensive of defensives) {
    const spellId = defensive.spell_id;
    const duration = defensive.duration ?? DEFAULT_WINDOW_S;

    for (const buffWindow of (buffWindows.get(spellId) ?? [])) {
      const startS = buffWindow[0];
      const endS = buffWindow[1] != null ? buffWindow[1] : startS + duration;
      const startMs = fightStartMs + startS * 1000;
      const endMs = fightStartMs + endS * 1000;
      const windowHits = hits.filter(hit => hit[0] >= startMs && hit[0] <= endMs);
      const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);

      const abilityDmg = new Map<number, number>();
      for (const [, damage, abilityId] of windowHits) {
        if (abilityId) abilityDmg.set(abilityId, (abilityDmg.get(abilityId) ?? 0) + damage);
      }
      const ability_breakdown = [...abilityDmg.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([spell_id, damage]) => ({ spell_id, damage }));

      const dmgBySource = new Map<number, number>();
      for (const [, damage, , sourceId] of windowHits) {
        if (sourceId != null && gameIdByActorId.has(sourceId)) dmgBySource.set(sourceId, (dmgBySource.get(sourceId) ?? 0) + damage);
      }
      const topSource = [...dmgBySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const refGameId = topSource != null ? (gameIdByActorId.get(topSource) ?? null) : null;

      result.push({
        time_s: round1(startS),
        window_length_s: round1(endS - startS),
        window_damage: windowDmg,
        defensive_name: defensive.name,
        spell_id: spellId,
        ref_game_id: refGameId,
        ability_breakdown,
      });
    }
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

/** Group windows whose time is within `mergeS` of the running cluster median. */
function groupByTime<T extends { time_s: number }>(windows: T[], mergeS: number): T[][] {
  const sorted = [...windows].sort((a, b) => a.time_s - b.time_s);
  const clusters: T[][] = [];
  let openTimes: number[] = [];
  for (const window of sorted) {
    if (clusters.length && Math.abs(window.time_s - median(openTimes)) <= mergeS) {
      clusters[clusters.length - 1].push(window);
      openTimes.push(window.time_s);
    } else {
      clusters.push([window]);
      openTimes = [window.time_s];
    }
  }
  return clusters;
}

/** Cluster per-parse defensive windows across parses into the bench `BurstWindow[]`. */
export function clusterDefensiveWindows(windows: ParseDefWindow[], sampleCount: number, mergeS = CLUSTER_MERGE_S): BurstWindow[] {
  if (!windows.length) return [];
  const byDefensive = new Map<string, ParseDefWindow[]>();
  for (const window of windows) {
    if (!byDefensive.has(window.defensive_name)) byDefensive.set(window.defensive_name, []);
    byDefensive.get(window.defensive_name)!.push(window);
  }

  const result: BurstWindow[] = [];
  for (const [defensiveName, group] of byDefensive.entries()) {
    for (const cluster of groupByTime(group, mergeS)) {
      if (cluster.length < Math.max(2, sampleCount * CLUSTER_MIN_FRAC)) continue;
      const damages = cluster.map(member => member.window_damage);

      const abilityDamage = new Map<number, number[]>();
      for (const member of cluster) {
        for (const ability of member.ability_breakdown) {
          if (!abilityDamage.has(ability.spell_id)) abilityDamage.set(ability.spell_id, []);
          abilityDamage.get(ability.spell_id)!.push(ability.damage);
        }
      }
      const ability_breakdown = [...abilityDamage.entries()]
        .filter(([, list]) => list.length >= cluster.length * MEMBER_MAJORITY_FRAC)
        .map(([spell_id, list]) => ({
          spell_id,
          avg_damage: Math.round(mean(list)),
          min_damage: Math.round(Math.min(...list)),
          max_damage: Math.round(Math.max(...list)),
          count: list.length,
        }))
        .sort((a, b) => b.avg_damage - a.avg_damage)
        .slice(0, 6);

      const refCounts = new Map<number, number>();
      for (const member of cluster) {
        if (member.ref_game_id != null) refCounts.set(member.ref_game_id, (refCounts.get(member.ref_game_id) ?? 0) + 1);
      }
      const ref_game_id = [...refCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      result.push({
        time_s: round1(median(cluster.map(member => member.time_s))),
        dmg_avg: Math.round(mean(damages)),
        dmg_stddev: Math.round(sampleStdev(damages)),
        dmg_min: Math.round(Math.min(...damages)),
        dmg_max: Math.round(Math.max(...damages)),
        window_length_s: round1(mean(cluster.map(member => member.window_length_s))),
        defensive_name: defensiveName,
        spell_id: cluster[0].spell_id,
        common_defensives: [defensiveName],
        common_cds: [defensiveName],
        ref_game_id,
        ability_breakdown,
      });
    }
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

/** Cast positions where >= 40% of parsers held, with the median delay target. */
export function buildHoldTargets(summaries: ParseDefensiveSummary[]): PerDefensiveBenchmark['hold_targets'] {
  const holdByCastIdx = new Map<number, number[]>();
  for (const summary of summaries) {
    for (const holdWindow of summary.hold_windows) {
      if (!holdByCastIdx.has(holdWindow.cast_index)) holdByCastIdx.set(holdWindow.cast_index, []);
      holdByCastIdx.get(holdWindow.cast_index)!.push(holdWindow.actual_s);
    }
  }
  const holdTargets: PerDefensiveBenchmark['hold_targets'] = {};
  for (const [castIndex, times] of holdByCastIdx.entries()) {
    if (times.length >= Math.max(2, summaries.length * HOLD_TRIGGER_FRAC)) {
      holdTargets[String(castIndex)] = {
        target_s: round1(median(times)),
        stddev_s: round1(sampleStdev(times)),
        count: times.length,
        total_samples: summaries.length,
      };
    }
  }
  return holdTargets;
}

/** Per-defensive benchmark from a defensive's per-parse summaries (excludes zero-use parses from uses-per-min). */
export function buildDefensiveBenchmark(summaries: ParseDefensiveSummary[]): PerDefensiveBenchmark {
  const firstCasts = summaries.map(summary => summary.first_cast_s).filter((value): value is number => value != null);
  const gaps: number[] = [];
  for (const summary of summaries) {
    const times = summary.cast_times_s;
    for (let j = 1; j < times.length; j++) gaps.push(times[j] - times[j - 1]);
  }
  const usesPerMinList = summaries
    .filter(summary => summary.fight_duration_s && summary.uses)
    .map(summary => summary.uses / (summary.fight_duration_s / 60));
  const benchUsesPerMin = summaries
    .filter(summary => summary.fight_duration_s > 0 && summary.uses > 0)
    .map(summary => Math.round(summary.uses / summary.fight_duration_s * 60 * 1000) / 1000);

  return {
    sample_count: summaries.length,
    avg_first_cast_s: firstCasts.length ? round1(mean(firstCasts)) : 0,
    stddev_first_cast_s: firstCasts.length ? round1(sampleStdev(firstCasts)) : 0,
    avg_gap_s: gaps.length ? round1(mean(gaps)) : null,
    stddev_gap_s: gaps.length ? round1(sampleStdev(gaps)) : null,
    hold_targets: buildHoldTargets(summaries),
    avg_uses: summaries.length ? round1(mean(summaries.map(summary => summary.uses))) : 0,
    avg_uses_per_min: usesPerMinList.length ? Math.round(mean(usesPerMinList) * 100) / 100 : 0,
    uses_per_min: benchUsesPerMin.length
      ? {
          avg: Math.round(mean(benchUsesPerMin) * 1000) / 1000,
          stddev: Math.round(sampleStdev(benchUsesPerMin) * 1000) / 1000,
          min: Math.min(...benchUsesPerMin),
          max: Math.max(...benchUsesPerMin),
        }
      : { avg: 0, stddev: 0, min: 0, max: 0 },
    majority_hold: summaries.filter(summary => summary.cast_pattern === 'hold').length > summaries.length * MEMBER_MAJORITY_FRAC,
  };
}

/** Aggregate per-parse summaries into the per-defensive benchmarks + top-defensives summary. */
export function aggregateDefensiveBenchmarks(
  perParseSummaries: ParseDefensiveSummary[][],
  defensives: RulebookDefensive[],
): { perDefensiveBenchmarks: Record<string, PerDefensiveBenchmark>; topDefensivesSummary: TopDefensiveSummary[] } {
  const byName = new Map<string, ParseDefensiveSummary[]>();
  for (const parse of perParseSummaries) {
    for (const summary of parse) {
      if (!byName.has(summary.name)) byName.set(summary.name, []);
      byName.get(summary.name)!.push(summary);
    }
  }

  const perDefensiveBenchmarks: Record<string, PerDefensiveBenchmark> = {};
  for (const [name, summaries] of byName.entries()) perDefensiveBenchmarks[name] = buildDefensiveBenchmark(summaries);

  const topDefensivesSummary: TopDefensiveSummary[] = [];
  for (const defensive of defensives) {
    const summaries = byName.get(defensive.name);
    if (!summaries?.length) continue;
    const uses = summaries.map(summary => summary.uses);
    topDefensivesSummary.push({
      spell_id: defensive.spell_id,
      avg_uses: round1(mean(uses)),
      min_uses: Math.min(...uses),
      max_uses: Math.max(...uses),
    });
  }
  return { perDefensiveBenchmarks, topDefensivesSummary };
}

/** Bake icon/name for every defensive spell + window ability referenced by the slice. */
export function bakeAbilityIcons(
  defensives: RulebookDefensive[],
  windows: BurstWindow[],
  abilityMeta: Map<number, { name: string; icon: string }>,
): Record<number, BakedAbility> {
  const wanted = new Set<number>();
  for (const defensive of defensives) if (defensive.spell_id) wanted.add(defensive.spell_id);
  for (const window of windows) for (const ability of window.ability_breakdown) wanted.add(ability.spell_id);

  const icons: Record<number, BakedAbility> = {};
  for (const spellId of wanted) {
    const meta = abilityMeta.get(spellId);
    if (!meta) continue;
    icons[spellId] = { icon: (meta.icon || '').replace(/\.jpg$/i, ''), name: meta.name || '' };
  }
  return icons;
}

/* ----------------------------- service shell ----------------------------- */

@Injectable({ providedIn: 'root' })
export class DefensiveTransformService implements DefensiveDataSource {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getDefensiveBench(spec: string, encounterId: number): Promise<DefensiveBench | null> {
    const rulebook = await this.dataFiles.getRulebook(spec);
    const defensives = rulebook?.defensives ?? [];
    if (!defensives.length) return null;

    const rankings = toParseRankings(await this.wclApi.getRankings(spec, encounterId), TOP_PARSE_COUNT);
    if (!rankings.length) return null;

    const allWindows: ParseDefWindow[] = [];
    const perParseSummaries: ParseDefensiveSummary[][] = [];
    const abilityMeta = new Map<number, { name: string; icon: string }>();
    let sampleCount = 0;
    let encounterName = '';
    for (const ranking of rankings) {
      const parse = await this.computeParse(ranking, defensives);
      if (!parse) continue;
      allWindows.push(...parse.windows);
      perParseSummaries.push(parse.summaries);
      for (const [id, meta] of parse.abilityMeta) if (!abilityMeta.has(id)) abilityMeta.set(id, meta);
      encounterName ||= parse.encounterName;
      sampleCount += 1;
    }
    if (!sampleCount) return null;

    const defensiveWindows = clusterDefensiveWindows(allWindows, sampleCount);
    const { perDefensiveBenchmarks, topDefensivesSummary } = aggregateDefensiveBenchmarks(perParseSummaries, defensives);

    return {
      spec,
      encounter_id: encounterId,
      encounter_name: encounterName,
      sample_count: sampleCount,
      per_defensive_benchmarks: perDefensiveBenchmarks,
      defensive_windows: defensiveWindows,
      top_defensives_summary: topDefensivesSummary,
      defensives: defensivePlanMeta(defensives),
      cd_spell_ids: defensiveSpellIds(defensives),
      ability_icons: bakeAbilityIcons(defensives, defensiveWindows, abilityMeta),
    };
  }

  /** One parse's defensive windows + usage summaries via the colocated pure fns; null on fetch failure. */
  private async computeParse(
    ranking: ParseRanking, defensives: RulebookDefensive[],
  ): Promise<{
    windows: ParseDefWindow[];
    summaries: ParseDefensiveSummary[];
    abilityMeta: Map<number, { name: string; icon: string }>;
    encounterName: string;
  } | null> {
    try {
      const report: WclReport = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = report.masterData?.actors?.find(actor => actor.name === ranking.player);
      if (!fight || !player) return null;

      const gameIdByActorId = new Map<number, number>();
      for (const enemy of report.masterData?.enemies ?? []) gameIdByActorId.set(enemy.id, enemy.gameID);
      const abilityMeta = new Map<number, { name: string; icon: string }>();
      for (const ability of report.masterData?.abilities ?? []) {
        abilityMeta.set(ability.gameID, { name: ability.name ?? '', icon: ability.icon ?? '' });
      }

      const [buffs, casts, dmgTaken] = await Promise.all([
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id),
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id),
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageTaken', fight.startTime, fight.endTime, player.id),
      ]);

      const fightDurationS = (fight.endTime - fight.startTime) / 1000;
      const buffWindows = buildBuffWindows(buffs, fight.startTime);
      const windows = findParseDefensiveWindows(dmgTaken, fight.startTime, buffWindows, defensives, gameIdByActorId);
      const summaries = summarizeDefensiveCasts(defensives, buffWindows, casts, fight.startTime, fightDurationS);
      return { windows, summaries, abilityMeta, encounterName: fight.name ?? '' };
    } catch (err) {
      logWarn(`DefensiveTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
