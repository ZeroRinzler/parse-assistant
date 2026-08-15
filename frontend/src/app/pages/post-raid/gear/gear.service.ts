// Self-containment exception (blessed by CLAUDE.md): this slice MAY import the cross-slice `shared/gear/gear-comparison.ts`.
import { Injectable, inject } from '@angular/core';
import { CharacterGear, WclCombatantInfo } from '../../../core/models/wcl.models';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { WclApiService } from '../../../core/services/wcl-api';
import { logWarn } from '../../../core/log';
import { Result, ok, permanent } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { decodeHtmlEntities, extractGear, selectCombatantInfo } from './gear-extract';
import { talentKeyFromTree } from '../../../shared/gear/talent-key';
import {
  GearStatus,
  buildEnchantRows, enchantStatusOf, EnchantRow,
  buildTrinketRows, trinketStatusOf, TrinketRow,
  buildTalentBuilds, talentStatusOf, TalentBuildRow,
  buildBenchEnchantRows, BenchEnchantRow,
  buildBenchTrinketRows, BenchTrinketRow,
} from '../../../shared/gear/gear-comparison';
import { GEAR_DATA_SOURCE, GearBench } from './gear-data-source';

export interface GearComparisonView {
  comparison: boolean;

  talentBuilds: TalentBuildRow[];
  talentStatus: { status: GearStatus; note: string };

  trinketRows: TrinketRow[];
  trinketStatus: GearStatus;
  benchTrinketRows: BenchTrinketRow[];

  enchantRows: EnchantRow[];
  enchantStatus: GearStatus;
  benchEnchantRows: BenchEnchantRow[];
}

export function emptyGearView(): GearComparisonView {
  return {
    comparison: false,
    talentBuilds: [], talentStatus: { status: 'unknown', note: 'No talent data.' },
    trinketRows: [], trinketStatus: 'ok', benchTrinketRows: [],
    enchantRows: [], enchantStatus: 'ok', benchEnchantRows: [],
  };
}

// A log with no combatant info is a usable-looking 200 OK, so it is a permanent error, not a placeholder the caller silently discards.
export function buildCharacterGear(
  event: WclCombatantInfo | null,
  names: Record<string, { id: number; name: string }>,
  code: string,
  spec?: string,
): Result<CharacterGear> {
  if (!event?.gear?.length) {
    return permanent('No combatant info in this log.', 'gear.combatant-info');
  }
  const { trinkets, enchants } = extractGear(event.gear);
  const talent_key = talentKeyFromTree(event.talentTree);

  for (const trinket of trinkets) {
    if (!trinket.name && trinket.id) trinket.name = decodeHtmlEntities(names[`i${trinket.id}`]?.name ?? '');
  }
  for (const enchant of enchants) {
    if (!enchant.name && enchant.id) enchant.name = decodeHtmlEntities(names[`e${enchant.id}`]?.name ?? '');
  }

  return ok({ found: true, spec, source_report: code, talent_key, trinkets, enchants });
}

export function benchToStats(bench: GearBench): EncounterGearStats {
  return { talent_builds: bench.talent_builds, trinkets: bench.trinkets, enchants: bench.enchants };
}

// playerGear is never null: the card builds comparison rows only once the combatant-info gear is in hand.
export function buildGearView(playerGear: CharacterGear, stats: EncounterGearStats): GearComparisonView {
  const playerKey = playerGear.talent_key ?? '';
  const enchantRows = buildEnchantRows(playerGear, stats);
  const trinketRows = buildTrinketRows(playerGear, stats);

  return {
    comparison: true,
    talentBuilds: buildTalentBuilds(stats, playerKey),
    talentStatus: talentStatusOf(stats, playerKey),
    trinketRows,
    trinketStatus: trinketStatusOf(trinketRows),
    benchTrinketRows: [],
    enchantRows,
    enchantStatus: enchantStatusOf(enchantRows),
    benchEnchantRows: [],
  };
}

// Uses the dedicated bench builders, so the comparison builders are never reached without a player.
export function buildBenchGearView(stats: EncounterGearStats): GearComparisonView {
  return {
    comparison: false,
    talentBuilds: buildTalentBuilds(stats, ''),
    talentStatus: talentStatusOf(stats, ''),
    trinketRows: [],
    trinketStatus: 'ok',
    benchTrinketRows: buildBenchTrinketRows(stats),
    enchantRows: [],
    enchantStatus: 'ok',
    benchEnchantRows: buildBenchEnchantRows(stats),
  };
}

@Injectable({ providedIn: 'root' })
export class GearFeatureService {
  private readonly source = inject(GEAR_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  // Propagates a non-ok bench and the player's own no-combatant-info error unchanged, never degrading to bench-only.
  async loadComparisonView(
    spec: string, encounterId: number,
    reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<GearComparisonView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    const playerGear = await this.fetchPlayerGear(reportCode, fightId, playerId, spec);
    if (!playerGear.ok) return playerGear;
    return ok(buildGearView(playerGear.value, benchToStats(bench.value)));
  }

  async loadBenchView(spec: string, encounterId: number): Promise<Result<GearComparisonView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return ok(buildBenchGearView(benchToStats(bench.value)));
  }

  // A WCL fetch failure becomes a mapped LoadError, never a silent fallback.
  private async fetchPlayerGear(
    reportCode: string, fightId: number, playerId: number, spec: string,
  ): Promise<Result<CharacterGear>> {
    try {
      const event = selectCombatantInfo(await this.wclApi.getCombatantInfo(reportCode, fightId, playerId), playerId);
      let names: Record<string, { id: number; name: string }> = {};
      if (event?.gear?.length) {
        const { trinkets, enchants } = extractGear(event.gear);
        const itemIds = [...new Set(trinkets.filter(trinket => trinket.id).map(trinket => trinket.id))];
        const enchantIds = [...new Set(enchants.filter(enchant => enchant.id).map(enchant => enchant.id))];
        try {
          names = await this.wclApi.getGameNames(itemIds, enchantIds);
        } catch (err) {
          logWarn(`GearFeatureService name resolution ${reportCode}:${fightId}:${playerId}`, err);
        }
      }
      return buildCharacterGear(event, names, reportCode, spec);
    } catch (cause) {
      logWarn(`GearFeatureService player gear ${reportCode}:${fightId}:${playerId}`, cause);
      return toLoadError(cause, 'gear.player-view');
    }
  }
}
