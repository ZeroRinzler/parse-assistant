import { Injectable, inject } from '@angular/core';
import * as z from '../../../../core/validation/zod-mini';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { WclFight, WclReport, WclTableBlob } from '../../../../core/wcl/wcl.models';
import { LoggerService } from '../../../../core/observability/logger-service';
import { Result, Results } from '../../../../core/http/result';
import { HttpLoadErrors } from '../../../../core/http/http-load-error';
import { WclProjectionsService, TimedEvent } from '../../../../domain/analysis/wcl-projections-service';
import { JsonCodecService } from '../../../../core/validation/json-codec-service';

type PullResult = 'kill' | 'wipe';

export interface PullDeathRow {
  index: number;
  timeS: number;
  ability: string;
}

export interface PullOverviewView {
  attempt: number;
  result: PullResult;
  durationS: number;
  bossPercentage: number;
  dps: number;
  deaths: PullDeathRow[];
  outcomeTimeS: number;
}

const WIPE_DEATHS = 3;

const DAMAGE_TABLE_SCHEMA = z.looseObject({
  data: z.optional(z.looseObject({
    entries: z.optional(z.array(z.looseObject({ id: z.number(), total: z.number() }))),
  })),
});

@Injectable({ providedIn: 'root' })
export class PullOverviewFeatureService {
  private readonly json = inject(JsonCodecService);
  private readonly logger = inject(LoggerService);
  private readonly wclProjections = inject(WclProjectionsService);
  private readonly wclApi = inject(WclApiService);

  async loadView(
    reportCode: string, playerId: number, fight: WclFight,
  ): Promise<Result<PullOverviewView>> {
    const result: PullResult = fight.kill ? 'kill' : 'wipe';

    try {
      const report = await this.wclApi.getReport(reportCode);
      const names = this.abilityNameMap(report);

      const [table, deathEvents] = await Promise.all([
        this.wclApi.getDamageDoneTable(reportCode, fight.id),
        this.wclApi.getAllEvents(reportCode, fight.id, 'Deaths', fight.startTime, fight.endTime),
      ]);

      const dps = this.dpsFromTable(table, playerId, fight.duration_s);
      if (!dps.ok) return dps;

      const deathEventsTimed = this.wclProjections.withRelativeS(deathEvents, fight.startTime);
      const deaths = this.buildDeathRows(deathEventsTimed, playerId, names);
      let outcomeTimeS = fight.duration_s;
      if (result === 'wipe') {
        const resurrects = await this.wclApi.getResurrects(reportCode, fight.id, fight.startTime, fight.endTime);
        outcomeTimeS = this.wipeTimeS(deathEventsTimed, this.wclProjections.withRelativeS(resurrects, fight.startTime), fight.duration_s);
      }

      return Results.ok({
        attempt: fight.attempt,
        result,
        durationS: fight.duration_s,
        bossPercentage: fight.fightPercentage,
        dps: dps.value,
        deaths,
        outcomeTimeS,
      });
    } catch (cause) {
      this.logger.logWarn('PullOverviewFeatureService.loadView', cause);
      return HttpLoadErrors.toLoadError(cause, 'pull-overview.view');
    }
  }

  // At a tied timestamp a resurrect is applied before a death, so a battle-rez in the same instant prevents the wipe.
  protected wipeTimeS(
    deathEvents: TimedEvent[], resurrectEvents: TimedEvent[], fightDurationS: number,
  ): number {
    const timeline = [
      ...deathEvents.map(event => ({ t: event.atS, player: event.targetID, died: true })),
      ...resurrectEvents.map(event => ({ t: event.atS, player: event.targetID, died: false })),
    ].sort((a, b) => a.t - b.t || Number(a.died) - Number(b.died));
    const dead = new Set<number | undefined>();
    for (const event of timeline) {
      if (event.died) dead.add(event.player);
      else dead.delete(event.player);
      if (dead.size >= WIPE_DEATHS) return event.t;
    }
    return fightDurationS;
  }

  // null means an unusable table (absent/unparseable/no entries array); a valid table can still have an empty entry list (a real 0-damage pull).
  private tableEntries(blob: WclTableBlob | null): { id: number; total: number }[] | null {
    if (!blob) return null;
    const parsed = typeof blob === 'string'
      ? this.json.parseJson(DAMAGE_TABLE_SCHEMA, blob, 'pull-overview.tableEntries')
      : blob;
    const entries = parsed?.data?.entries;
    return Array.isArray(entries) ? entries : null;
  }

  // An unusable table is a permanent load failure (a played pull would show a bogus 0); a player absent from a valid table (a healer) is a real 0.
  protected dpsFromTable(
    blob: WclTableBlob | null, playerId: number, durationS: number,
  ): Result<number> {
    if (durationS <= 0) return Results.ok(0);
    const entries = this.tableEntries(blob);
    if (!entries) return Results.permanent('Damage table missing for this pull.', 'pull-overview.damage-table');
    const entry = entries.find(row => row.id === playerId);
    return Results.ok(entry ? entry.total / durationS : 0);
  }

  protected abilityNameMap(report: WclReport): Map<number, string> {
    const map = new Map<number, string>();
    for (const ability of report.masterData?.abilities ?? []) map.set(ability.gameID, ability.name);
    return map;
  }

  protected buildDeathRows(
    deathEvents: TimedEvent[],
    playerId: number,
    names: Map<number, string>,
  ): PullDeathRow[] {
    return deathEvents
      .filter(event => event.targetID === playerId)
      .sort((a, b) => a.atS - b.atS)
      .map((event, i) => {
        const abilityId = event.killingAbilityGameID ?? 0;
        return {
          index: i + 1,
          timeS: event.atS,
          ability: abilityId ? (names.get(abilityId) ?? '') : '',
        };
      });
  }
}
