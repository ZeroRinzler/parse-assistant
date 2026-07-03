/**
 * Gear slice runtime shell + its pure view-model assembly, colocated.
 *
 * `GearFeatureService` is the imperative shell (the component injects only it). It
 * reads the prepared gear bench via the swappable `GEAR_DATA_SOURCE`, optionally
 * fetches the analyzed player's combatant-info gear (post-raid mode), then calls the
 * pure `buildGearView` below to assemble the dual-mode view-model.
 *
 * Self-containment exception (blessed by CLAUDE.md): this slice MAY import the
 * cross-slice presentational helper `shared/gear/gear-comparison.ts` - it is
 * presentational, not a service. All gear math is delegated to it, so the feature
 * service itself contains no arithmetic.
 */
import { Injectable, inject } from '@angular/core';
import { CharacterGear, WclCombatantInfo } from '../../../core/models/wcl.models';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { WclApiService } from '../../../core/services/wcl-api';
import { logWarn } from '../../../core/log';
import { decodeHtmlEntities, extractGear, selectCombatantInfo, talentKeyFromTree } from './gear-extract';
import {
  GearStatus,
  buildEnchantRows, enchantStatusOf, EnchantRow,
  buildTrinketRows, trinketStatusOf, TrinketRow,
  buildTalentBuilds, talentStatusOf, TalentBuildRow,
  buildBenchEnchantRows, BenchEnchantRow,
  buildBenchTrinketRows, BenchTrinketRow,
} from '../../../shared/gear/gear-comparison';
import { GEAR_DATA_SOURCE, GearBench } from './gear-data-source';

/** Where the gear card seeks its data: a chosen player log, or bench-only consensus. */
export interface GearComparisonView {
  /** True when the player's own gear is shown alongside the bench (post-raid). */
  comparison: boolean;

  // Talents
  talentBuilds: TalentBuildRow[];
  talentStatus: { status: GearStatus; note: string };

  // Trinkets
  trinketRows: TrinketRow[];
  trinketStatus: GearStatus;
  benchTrinketRows: BenchTrinketRow[];

  // Enchants
  enchantRows: EnchantRow[];
  enchantStatus: GearStatus;
  benchEnchantRows: BenchEnchantRow[];
}

/** Empty bench-only view used when no bench data is available at all. */
export function emptyGearView(): GearComparisonView {
  return {
    comparison: false,
    talentBuilds: [], talentStatus: { status: 'unknown', note: 'No talent data.' },
    trinketRows: [], trinketStatus: 'ok', benchTrinketRows: [],
    enchantRows: [], enchantStatus: 'ok', benchEnchantRows: [],
  };
}

/* ----------------------------- pure gear extraction (own, colocated) ----------------------------- */

/**
 * Assemble a `CharacterGear` from a raw CombatantInfo event + the resolved item /
 * enchant name map (raw `i<id>` / `e<id>` aliases). Names already on the gear item
 * win; otherwise they are filled in from the name map and decoded. Returns a
 * `found:false` placeholder when the event carries no gear.
 */
export function buildCharacterGear(
  event: WclCombatantInfo | null,
  names: Record<string, { id: number; name: string }>,
  code: string,
  spec?: string,
): CharacterGear {
  if (!event?.gear?.length) {
    return { found: false, message: 'No combatant info in this log.' };
  }
  const { trinkets, enchants } = extractGear(event.gear);
  const talent_key = talentKeyFromTree(event.talentTree);

  for (const trinket of trinkets) {
    if (!trinket.name && trinket.id) trinket.name = decodeHtmlEntities(names[`i${trinket.id}`]?.name ?? '');
  }
  for (const enchant of enchants) {
    if (!enchant.name && enchant.id) enchant.name = decodeHtmlEntities(names[`e${enchant.id}`]?.name ?? '');
  }

  return { found: true, spec, source_report: code, talent_key, trinkets, enchants };
}

/* ----------------------------- pure view-model ----------------------------- */

/** Reshape a `GearBench` into the `EncounterGearStats` shape the helpers consume. */
export function benchToStats(bench: GearBench | null): EncounterGearStats | null {
  if (!bench) return null;
  return { talent_builds: bench.talent_builds, trinkets: bench.trinkets, enchants: bench.enchants };
}

/**
 * Build the gear card view-model in either mode. When `playerGear` is present the
 * card compares the player against the bench; otherwise it shows the bench-only
 * consensus. All derivation is delegated to the shared presentational helpers.
 */
export function buildGearView(
  playerGear: CharacterGear | null,
  stats: EncounterGearStats | null,
): GearComparisonView {
  const comparison = !!playerGear;
  const playerKey = playerGear?.talent_key ?? '';

  const enchantRows = buildEnchantRows(playerGear, stats);
  const trinketRows = buildTrinketRows(playerGear, stats);

  return {
    comparison,
    talentBuilds: buildTalentBuilds(stats, playerKey),
    talentStatus: talentStatusOf(stats, playerKey),
    trinketRows,
    trinketStatus: trinketStatusOf(trinketRows),
    benchTrinketRows: buildBenchTrinketRows(stats),
    enchantRows,
    enchantStatus: enchantStatusOf(enchantRows),
    benchEnchantRows: buildBenchEnchantRows(stats),
  };
}

/* ----------------------------- feature service ---------------------------- */

/**
 * Runtime shell for the gear card. Injects only its data source (swapped file /
 * live by the dev flag) plus the cached `WclApiService` (to read the analyzed
 * player's own combatant-info gear), then calls the pure functions above to build
 * the view-model. Contains no arithmetic of its own.
 */
@Injectable({ providedIn: 'root' })
export class GearFeatureService {
  private readonly source = inject(GEAR_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  /**
   * Post-raid: the analyzed player's gear vs the top-parse bench. Fetches the
   * player's combatant-info gear from the chosen log; falls back to bench-only when
   * the player has no recorded combatant info.
   */
  async loadComparisonView(
    spec: string, encounterId: number,
    reportCode: string, fightId: number, playerId: number,
  ): Promise<GearComparisonView> {
    const bench = await this.source.getBench(spec, encounterId);
    const stats = benchToStats(bench);
    const playerGear = await this.fetchPlayerGear(reportCode, fightId, playerId, spec);
    if (!stats && !playerGear) return emptyGearView();
    return buildGearView(playerGear, stats);
  }

  /** Pre-fight: bench-only consensus (no player log). */
  async loadBenchView(spec: string, encounterId: number): Promise<GearComparisonView> {
    const bench = await this.source.getBench(spec, encounterId);
    const stats = benchToStats(bench);
    if (!stats) return emptyGearView();
    return buildGearView(null, stats);
  }

  /**
   * Best-effort player gear; null when absent or the fetch fails. Reads the raw
   * CombatantInfo event, extracts gear via the colocated pure fns, then resolves
   * item / enchant names in one batched gameData round-trip.
   */
  private async fetchPlayerGear(
    reportCode: string, fightId: number, playerId: number, spec: string,
  ): Promise<CharacterGear | null> {
    if (!reportCode || !fightId || !playerId) return null;
    try {
      const event = selectCombatantInfo(await this.wclApi.getCombatantInfo(reportCode, fightId, playerId), playerId);
      if (!event?.gear?.length) return null;

      const { trinkets, enchants } = extractGear(event.gear);
      const itemIds = [...new Set(trinkets.filter(trinket => trinket.id).map(trinket => trinket.id))];
      const enchantIds = [...new Set(enchants.filter(enchant => enchant.id).map(enchant => enchant.id))];
      let names: Record<string, { id: number; name: string }> = {};
      try {
        names = await this.wclApi.getGameNames(itemIds, enchantIds);
      } catch (err) {
        logWarn(`GearFeatureService name resolution ${reportCode}:${fightId}:${playerId}`, err);
      }

      const gear = buildCharacterGear(event, names, reportCode, spec);
      return gear.found ? gear : null;
    } catch (err) {
      logWarn(`GearFeatureService player gear ${reportCode}:${fightId}:${playerId}`, err);
      return null;
    }
  }
}
