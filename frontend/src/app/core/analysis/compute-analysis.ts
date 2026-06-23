/**
 * Pure, framework-free analysis orchestrator.
 *
 * Composes the focused analysis modules into a single `AnalysisResult`. It has
 * no Angular dependencies, so it runs inside the Web Worker (`analysis.worker.ts`)
 * and keeps the heavy event crunching off the main thread. `AnalysisEngineService`
 * handles network I/O and delegates the computation here.
 */
import { AnalysisResult } from '../models/analysis.models';
import { EncounterBench } from '../models/encounter.models';
import { Rulebook } from '../models/rulebook.models';
import { WclEvent, WclAbility } from '../models/wcl.models';
import { analyzeCooldowns } from './cooldown-analysis';
import { analyzeDefensives, analyzeDefensiveFindings } from './defensive-analysis';
import { findPlayerBurstWindows, computePlayerDefensiveWindows } from './burst-windows';

/** Everything the pure computation needs - all data already fetched on the main thread. */
export interface AnalysisInput {
  playerName: string;
  spec: string;
  fStart: number;
  fEnd: number;
  castEvents: WclEvent[];
  buffEvents: WclEvent[];
  dmgEvents: WclEvent[];
  dtEvents: WclEvent[];
  rulebook: Rulebook | null;
  bench: EncounterBench | null;
  masterAbilities: WclAbility[];
}

/**
 * Run the full client-side analysis. Returns a plain `AnalysisResult` - safe to
 * `postMessage` back from a worker.
 */
export function computeAnalysis(input: AnalysisInput): AnalysisResult {
  const { playerName, spec, fStart, fEnd, castEvents, buffEvents, dmgEvents, dtEvents, rulebook, bench, masterAbilities } = input;

  const abilityMap: Record<string, { name: string; icon: string }> = {};
  for (const a of masterAbilities || []) {
    if (a.gameID) abilityMap[String(a.gameID)] = { name: a.name || '', icon: a.icon || '' };
  }
  // Stored once on the result; the main thread seeds the icon cache from this.
  const ability_icons = Object.fromEntries(
    Object.entries(abilityMap).map(([id, v]) => [id, { icon: v.icon.replace(/\.jpg$/i, ''), name: v.name }]),
  );

  const specCds = rulebook?.major_cooldowns ?? null;
  const rules = rulebook?.rules ?? [];
  const defensives = rulebook?.defensives ?? [];

  const result = analyzeCooldowns(playerName, spec, fStart, fEnd, castEvents, buffEvents, specCds, rules, bench);
  result.spec = spec;
  result.rulebook_source = rulebook ? 'generated' : 'none';
  result.player_fight_duration_s = result.player_fight_duration_s ?? (fEnd - fStart) / 1000;
  result.cd_spell_ids = Object.fromEntries((specCds ?? []).map((cd) => [cd.name, cd.spell_id]));
  result.ability_icons = ability_icons;

  if (bench) {
    if (bench.burst_windows.length) result.burst_windows = bench.burst_windows;
    if (bench.top_defensives_summary.length) result.top_defensives_summary = bench.top_defensives_summary;
    if (bench.defensive_windows.length) {
      result.top_defensive_windows = bench.defensive_windows;
      result.player_defensive_windows = computePlayerDefensiveWindows(bench.defensive_windows, dtEvents, fStart);
    }
  }

  if (result.burst_windows?.length) {
    result.player_burst_windows = findPlayerBurstWindows(result.burst_windows, dmgEvents, castEvents, fStart);
  }
  result.player_defensives = analyzeDefensives(defensives, castEvents, buffEvents, dtEvents, fStart, fEnd);

  if (bench && defensives.length && result.player_defensives.length) {
    result.defensive_findings = analyzeDefensiveFindings(
      result.player_defensives,
      bench.per_defensive_benchmarks,
      (fEnd - fStart) / 1000,
    );
  }

  return result;
}
