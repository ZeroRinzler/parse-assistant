import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclFight, WclReport, WclTableBlob } from '../../../core/models/wcl.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok, permanent } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { TimedEvent, withRelativeS } from '../../../shared/analysis/wcl-projections';

export type PullResult = 'kill' | 'wipe';

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

// At a tied timestamp a resurrect is applied before a death, so a battle-rez in the same instant prevents the wipe.
export function wipeTimeS(
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
function tableEntries(blob: WclTableBlob | null): { id: number; total: number }[] | null {
  if (!blob) return null;
  const parsed = typeof blob === 'string' ? safeJson(blob) : blob;
  const entries = parsed?.data?.entries;
  return Array.isArray(entries) ? entries : null;
}

function safeJson(raw: string): { data?: { entries?: { id: number; total: number }[] } } | null {
  try {
    return JSON.parse(raw);
  } catch (err) {
    logWarn('pull-overview.tableEntries', err);
    return null;
  }
}

// An unusable table is a permanent load failure (a played pull would show a bogus 0); a player absent from a valid table (a healer) is a real 0.
export function dpsFromTable(
  blob: WclTableBlob | null, playerId: number, durationS: number,
): Result<number, LoadError> {
  if (durationS <= 0) return ok(0);
  const entries = tableEntries(blob);
  if (!entries) return permanent('Damage table missing for this pull.', 'pull-overview.damage-table');
  const entry = entries.find(row => row.id === playerId);
  return ok(entry ? entry.total / durationS : 0);
}

export function abilityNameMap(report: WclReport): Map<number, string> {
  const map = new Map<number, string>();
  for (const ability of report.masterData?.abilities ?? []) map.set(ability.gameID, ability.name);
  return map;
}

export function buildDeathRows(
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

@Injectable({ providedIn: 'root' })
export class PullOverviewFeatureService {
  private readonly wclApi = inject(WclApiService);

  async loadView(
    reportCode: string, playerId: number, fight: WclFight,
  ): Promise<Result<PullOverviewView, LoadError>> {
    const result: PullResult = fight.kill ? 'kill' : 'wipe';

    try {
      const report = await this.wclApi.getReport(reportCode);
      const names = abilityNameMap(report);

      const [table, deathEvents] = await Promise.all([
        this.wclApi.getDamageDoneTable(reportCode, fight.id),
        this.wclApi.getAllEvents(reportCode, fight.id, 'Deaths', fight.startTime, fight.endTime),
      ]);

      const dps = dpsFromTable(table, playerId, fight.duration_s);
      if (!dps.ok) return dps;

      const deathEventsTimed = withRelativeS(deathEvents, fight.startTime);
      const myDeaths = deathEventsTimed.filter(event => event.targetID === playerId);
      const deaths = buildDeathRows(myDeaths, playerId, names);
      let outcomeTimeS = fight.duration_s;
      if (result === 'wipe') {
        const resurrects = await this.wclApi.getResurrects(reportCode, fight.id, fight.startTime, fight.endTime);
        outcomeTimeS = wipeTimeS(deathEventsTimed, withRelativeS(resurrects, fight.startTime), fight.duration_s);
      }

      return ok({
        attempt: fight.attempt,
        result,
        durationS: fight.duration_s,
        bossPercentage: fight.fightPercentage,
        dps: dps.value,
        deaths,
        outcomeTimeS,
      });
    } catch (cause) {
      logWarn('PullOverviewFeatureService.loadView', cause);
      return toLoadError(cause, 'pull-overview.view');
    }
  }
}
