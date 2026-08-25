import { Injectable, inject } from '@angular/core';
import { SecondaryStats, WclCombatantInfo } from '../../../../core/wcl/wcl.models';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { Result, Results } from '../../../../core/http/result';
import { HttpLoadErrors } from '../../../../core/http/http-load-error';
import { StatsExtractService } from '../../../../domain/gear/stats-extract-service';
import { GEAR_DATA_SOURCE, GearBench } from '../../../../domain/gear/gear-bench';
import { LoggerService } from '../../../../core/observability/logger-service';

/** `delta` = player - bench, so a positive value is more of that stat, not necessarily better. */
interface StatRow { label: string; player: number; bench: number; delta: number }
interface StatBenchRow { label: string; value: number }

export interface StatsView {
  comparison: boolean;
  /** Populated only when both sides carry stats. */
  rows: StatRow[];
  /** Populated in bench-only mode (no player to diff against). */
  benchRows: StatBenchRow[];
}

interface PlayerStats { stats: SecondaryStats; itemLevel: number }

// Field order mirrors what the Gear card used to list; label pairs with the SecondaryStats key it reads.
const STAT_FIELDS: { key: keyof SecondaryStats; label: string }[] = [
  { key: 'crit', label: 'Crit' },
  { key: 'haste', label: 'Haste' },
  { key: 'mastery', label: 'Mastery' },
  { key: 'versatility', label: 'Versatility' },
  { key: 'stamina', label: 'Stamina' },
  { key: 'avoidance', label: 'Avoidance' },
  { key: 'leech', label: 'Leech' },
  { key: 'speed', label: 'Speed' },
];

// Reuses the Gear slice's ingested bench (avg_stats/avg_item_level is baked as part of it) - no separate DataSource/ingest artifact for stats alone.
@Injectable({ providedIn: 'root' })
export class StatsFeatureService {
  private readonly logger = inject(LoggerService);
  private readonly statsExtract = inject(StatsExtractService);
  private readonly source = inject(GEAR_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  async loadComparisonView(
    spec: string, encounterId: number,
    reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<StatsView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    const player = await this.fetchPlayerStats(reportCode, fightId, playerId);
    if (!player.ok) return player;
    return Results.ok(this.buildView(player.value, bench.value));
  }

  // `bench` is caller-supplied (a compare view's synthesized 1-parse bench), not looked up from the DataSource.
  async loadComparisonViewFromBench(
    bench: GearBench, reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<StatsView>> {
    const player = await this.fetchPlayerStats(reportCode, fightId, playerId);
    if (!player.ok) return player;
    return Results.ok(this.buildView(player.value, bench));
  }

  async loadBenchView(spec: string, encounterId: number): Promise<Result<StatsView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return Results.ok(this.buildBenchView(bench.value));
  }

  emptyView(): StatsView {
    return { comparison: false, rows: [], benchRows: [] };
  }

  // A log with no combatant info is a usable-looking 200 OK, so it is a permanent error, not a placeholder the caller silently discards.
  private async fetchPlayerStats(reportCode: string, fightId: number, playerId: number): Promise<Result<PlayerStats>> {
    try {
      const events = await this.wclApi.getCombatantInfo(reportCode, fightId, playerId);
      const event = this.selectCombatantInfo(events, playerId);
      if (!event?.gear?.length) return Results.permanent('No combatant info in this log.', 'stats.combatant-info');
      return Results.ok({ stats: this.statsExtract.extractStats(event), itemLevel: this.statsExtract.averageItemLevel(event.gear) ?? 0 });
    } catch (cause) {
      this.logger.logWarn(`StatsFeatureService player stats ${reportCode}:${fightId}:${playerId}`, cause);
      return HttpLoadErrors.toLoadError(cause, 'stats.player-view');
    }
  }

  // WCL keys the CombatantInfo event by sourceID; falls back to the first event when there is no exact match.
  private selectCombatantInfo(events: WclCombatantInfo[], playerId: number): WclCombatantInfo | null {
    return events.find(event => event.sourceID === playerId) ?? events[0] ?? null;
  }

  protected buildView(player: PlayerStats, bench: GearBench): StatsView {
    if (!bench.avg_stats || bench.avg_item_level == null) return { comparison: true, rows: [], benchRows: [] };
    const benchStats: PlayerStats = { stats: bench.avg_stats, itemLevel: bench.avg_item_level };
    const rows: StatRow[] = [
      { label: 'Item level', player: player.itemLevel, bench: benchStats.itemLevel, delta: player.itemLevel - benchStats.itemLevel },
      ...STAT_FIELDS.map(f => ({
        label: f.label, player: player.stats[f.key], bench: benchStats.stats[f.key], delta: player.stats[f.key] - benchStats.stats[f.key],
      })),
    ];
    return { comparison: true, rows, benchRows: [] };
  }

  protected buildBenchView(bench: GearBench): StatsView {
    const avgStats = bench.avg_stats;
    if (!avgStats || bench.avg_item_level == null) return { comparison: false, rows: [], benchRows: [] };
    const benchRows: StatBenchRow[] = [
      { label: 'Item level', value: bench.avg_item_level },
      ...STAT_FIELDS.map(f => ({ label: f.label, value: avgStats[f.key] })),
    ];
    return { comparison: false, rows: [], benchRows };
  }
}
