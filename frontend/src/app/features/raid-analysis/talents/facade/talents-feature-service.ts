import { Injectable, inject } from '@angular/core';
import { WclCombatantInfo } from '../../../../core/wcl/wcl.models';
import { EncounterGearStats } from '../../../../domain/encounter/encounter.models';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { Result, Results } from '../../../../core/http/result';
import { HttpLoadErrors } from '../../../../core/http/http-load-error';
import { GearStatus, TalentBuildRow, GearComparisonService } from '../../../../domain/gear/gear-comparison-service';
import { TalentKeyService } from '../../../../domain/gear/talent-key-service';
import { GEAR_DATA_SOURCE, GearBench } from '../../../../domain/gear/gear-bench';
import { LoggerService } from '../../../../core/observability/logger-service';

export interface TalentsView {
  comparison: boolean;
  talentBuilds: TalentBuildRow[];
  talentStatus: { status: GearStatus; note: string };
}

// Reuses the Gear slice's ingested bench (talent_builds is baked as part of it) - no separate DataSource/ingest artifact for talents alone.
@Injectable({ providedIn: 'root' })
export class TalentsFeatureService {
  private readonly logger = inject(LoggerService);
  private readonly talentKeys = inject(TalentKeyService);
  private readonly gearComparison = inject(GearComparisonService);
  private readonly source = inject(GEAR_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  async loadComparisonView(
    spec: string, encounterId: number,
    reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<TalentsView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    const playerKey = await this.fetchPlayerTalentKey(reportCode, fightId, playerId);
    if (!playerKey.ok) return playerKey;
    return Results.ok(this.buildView(playerKey.value, this.benchToStats(bench.value)));
  }

  // `bench` is caller-supplied (a compare view's synthesized 1-parse bench), not looked up from the DataSource.
  async loadComparisonViewFromBench(
    bench: GearBench, reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<TalentsView>> {
    const playerKey = await this.fetchPlayerTalentKey(reportCode, fightId, playerId);
    if (!playerKey.ok) return playerKey;
    return Results.ok(this.buildView(playerKey.value, this.benchToStats(bench)));
  }

  async loadBenchView(spec: string, encounterId: number): Promise<Result<TalentsView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return Results.ok(this.buildBenchView(this.benchToStats(bench.value)));
  }

  emptyView(): TalentsView {
    return { comparison: false, talentBuilds: [], talentStatus: { status: 'unknown', note: 'No talent data.' } };
  }

  // A log with no combatant info is a usable-looking 200 OK, so it is a permanent error, not a placeholder the caller silently discards.
  private async fetchPlayerTalentKey(reportCode: string, fightId: number, playerId: number): Promise<Result<string>> {
    try {
      const events = await this.wclApi.getCombatantInfo(reportCode, fightId, playerId);
      const event = this.selectCombatantInfo(events, playerId);
      if (!event?.gear?.length) return Results.permanent('No combatant info in this log.', 'talents.combatant-info');
      return Results.ok(this.talentKeys.talentKeyFromTree(event.talentTree));
    } catch (cause) {
      this.logger.logWarn(`TalentsFeatureService player talents ${reportCode}:${fightId}:${playerId}`, cause);
      return HttpLoadErrors.toLoadError(cause, 'talents.player-view');
    }
  }

  // WCL keys the CombatantInfo event by sourceID; falls back to the first event when there is no exact match.
  private selectCombatantInfo(events: WclCombatantInfo[], playerId: number): WclCombatantInfo | null {
    return events.find(event => event.sourceID === playerId) ?? events[0] ?? null;
  }

  private benchToStats(bench: GearBench): EncounterGearStats {
    return { talent_builds: bench.talent_builds, trinkets: {}, enchants: {} };
  }

  protected buildView(playerKey: string, stats: EncounterGearStats): TalentsView {
    return {
      comparison: true,
      talentBuilds: this.gearComparison.buildTalentBuilds(stats, playerKey),
      talentStatus: this.gearComparison.talentStatusOf(stats, playerKey),
    };
  }

  protected buildBenchView(stats: EncounterGearStats): TalentsView {
    return {
      comparison: false,
      talentBuilds: this.gearComparison.buildTalentBuilds(stats, ''),
      talentStatus: this.gearComparison.talentStatusOf(stats, ''),
    };
  }
}
