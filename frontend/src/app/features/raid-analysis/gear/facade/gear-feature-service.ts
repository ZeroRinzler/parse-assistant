// Self-containment exception (blessed by CLAUDE.md): this slice MAY import the cross-slice `shared/gear/gear-comparison.ts`.
import { Injectable, inject } from '@angular/core';
import { CharacterGear, WclCombatantInfo } from '../../../../core/wcl/wcl.models';
import { EncounterGearStats } from '../../../../domain/encounter/encounter.models';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { Result, Results } from '../../../../core/http/result';
import { HttpLoadErrors } from '../../../../core/http/http-load-error';
import { GearExtractService, GameNames } from '../domain/gear-extract-service';
import { GearStatus, EnchantRow, TrinketRow, TalentBuildRow, BenchEnchantRow, BenchTrinketRow } from '../../../../domain/gear/gear-comparison-service';
import { GEAR_DATA_SOURCE, GearBench } from '../data-access/gear-data-source';
import { LoggerService } from '../../../../core/observability/logger-service';
import { TalentKeyService } from '../../../../domain/gear/talent-key-service';
import { GearComparisonService } from '../../../../domain/gear/gear-comparison-service';

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

@Injectable({ providedIn: 'root' })
export class GearFeatureService {
  private readonly logger = inject(LoggerService);
  private readonly talentKeys = inject(TalentKeyService);
  private readonly gearComparison = inject(GearComparisonService);
  private readonly gearExtract = inject(GearExtractService);
  private readonly source = inject(GEAR_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  // Propagates a non-ok bench and the player's own no-combatant-info error unchanged, never degrading to bench-only.
  async loadComparisonView(
    spec: string, encounterId: number,
    reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<GearComparisonView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    const playerGear = await this.fetchPlayerGear(reportCode, fightId, playerId);
    if (!playerGear.ok) return playerGear;
    return Results.ok(this.buildGearView(playerGear.value, this.benchToStats(bench.value)));
  }

  async loadBenchView(spec: string, encounterId: number): Promise<Result<GearComparisonView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return Results.ok(this.buildBenchGearView(this.benchToStats(bench.value)));
  }

  // A WCL fetch failure becomes a mapped LoadError, never a silent fallback.
  private async fetchPlayerGear(
    reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<CharacterGear>> {
    try {
      const event = this.gearExtract.selectCombatantInfo(await this.wclApi.getCombatantInfo(reportCode, fightId, playerId), playerId);
      let names: GameNames = {};
      if (event?.gear?.length) {
        const { trinkets, enchants } = this.gearExtract.extractGear(event.gear);
        const itemIds = [...new Set(trinkets.filter(trinket => trinket.id).map(trinket => trinket.id))];
        const enchantIds = [...new Set(enchants.filter(enchant => enchant.id).map(enchant => enchant.id))];
        try {
          names = await this.wclApi.getGameNames(itemIds, enchantIds);
        } catch (err) {
          this.logger.logWarn(`GearFeatureService name resolution ${reportCode}:${fightId}:${playerId}`, err);
        }
      }
      return this.buildCharacterGear(event, names);
    } catch (cause) {
      this.logger.logWarn(`GearFeatureService player gear ${reportCode}:${fightId}:${playerId}`, cause);
      return HttpLoadErrors.toLoadError(cause, 'gear.player-view');
    }
  }

  emptyGearView(): GearComparisonView {
    return {
      comparison: false,
      talentBuilds: [], talentStatus: { status: 'unknown', note: 'No talent data.' },
      trinketRows: [], trinketStatus: 'ok', benchTrinketRows: [],
      enchantRows: [], enchantStatus: 'ok', benchEnchantRows: [],
    };
  }

  // A log with no combatant info is a usable-looking 200 OK, so it is a permanent error, not a placeholder the caller silently discards.
  protected buildCharacterGear(
    event: WclCombatantInfo | null,
    names: GameNames,
  ): Result<CharacterGear> {
    if (!event?.gear?.length) {
      return Results.permanent('No combatant info in this log.', 'gear.combatant-info');
    }
    const { trinkets, enchants } = this.gearExtract.extractGear(event.gear);
    const talent_key = this.talentKeys.talentKeyFromTree(event.talentTree);

    this.gearExtract.fillGameNames(trinkets, 'i', names);
    this.gearExtract.fillGameNames(enchants, 'e', names);

    return Results.ok({ talent_key, trinkets, enchants });
  }

  protected benchToStats(bench: GearBench): EncounterGearStats {
    return { talent_builds: bench.talent_builds, trinkets: bench.trinkets, enchants: bench.enchants };
  }

  // playerGear is never null: the card builds comparison rows only once the combatant-info gear is in hand.
  protected buildGearView(playerGear: CharacterGear, stats: EncounterGearStats): GearComparisonView {
    const playerKey = playerGear.talent_key ?? '';
    const enchantRows = this.gearComparison.buildEnchantRows(playerGear, stats);
    const trinketRows = this.gearComparison.buildTrinketRows(playerGear, stats);

    return {
      comparison: true,
      talentBuilds: this.gearComparison.buildTalentBuilds(stats, playerKey),
      talentStatus: this.gearComparison.talentStatusOf(stats, playerKey),
      trinketRows,
      trinketStatus: this.gearComparison.trinketStatusOf(trinketRows),
      benchTrinketRows: [],
      enchantRows,
      enchantStatus: this.gearComparison.enchantStatusOf(enchantRows),
      benchEnchantRows: [],
    };
  }

  // Uses the dedicated bench builders, so the comparison builders are never reached without a player.
  protected buildBenchGearView(stats: EncounterGearStats): GearComparisonView {
    return {
      comparison: false,
      talentBuilds: this.gearComparison.buildTalentBuilds(stats, ''),
      talentStatus: this.gearComparison.talentStatusOf(stats, ''),
      trinketRows: [],
      trinketStatus: 'ok',
      benchTrinketRows: this.gearComparison.buildBenchTrinketRows(stats),
      enchantRows: [],
      enchantStatus: 'ok',
      benchEnchantRows: this.gearComparison.buildBenchEnchantRows(stats),
    };
  }
}
