import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent, WclFight, WclReport, WclTableBlob } from '../../../core/models/wcl.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok, permanent } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';

/**
 * Pull overview - the first, always-on card on the post-raid page. Summarizes one pull from the
 * player's OWN log (WCL, no bench): DPS, pull time, boss % reached, the player's deaths, and the
 * kill/wipe outcome. Injects only `WclApiService`; no bench, no `*_DATA_SOURCE`, no transform.
 */

const MS_PER_S = 1000;

export type PullResult = 'kill' | 'wipe';

export interface PullDeathRow {
  /** 1-based ordinal ("Death 1", "Death 2"). */
  index: number;
  /** Fight-relative time of the death, in seconds. */
  timeS: number;
  /** Killing-blow ability name (empty when the death carried no ability). */
  ability: string;
}

export interface PullOverviewView {
  /** Attempt number of this boss within the report ("Pull N of this session"). */
  attempt: number;
  result: PullResult;
  /** Pull length in seconds. */
  durationS: number;
  /** Boss health % remaining when the pull ended; 0 on a kill. */
  bossPercentage: number;
  /** The player's damage per second over the pull. */
  dps: number;
  deaths: PullDeathRow[];
  /** Time of the closing row: fight end on a kill, the wipe moment on a wipe (see `wipeTimeS`). */
  outcomeTimeS: number;
}

/** The raid has wiped once WIPE_DEATHS players lie dead at the same time. */
const WIPE_DEATHS = 3;

/**
 * The wipe moment: the first instant WIPE_DEATHS players are simultaneously dead, however
 * far apart the deaths fall. Deaths and resurrects are walked as one time-ordered stream that
 * maintains a live set of who is currently dead - a battle-rezzed player leaves the set, so
 * earlier deaths that were recovered never count toward the wipe. At a tied timestamp a
 * resurrect is applied before a death. Falls back to the fight end when the raid never has
 * that many down at once.
 */
export function wipeTimeS(
  deathEvents: WclEvent[], resurrectEvents: WclEvent[], fightStartMs: number, fightDurationS: number,
): number {
  const timeline = [
    ...deathEvents.map(event => ({ t: event.timestamp, player: event.targetID, died: true })),
    ...resurrectEvents.map(event => ({ t: event.timestamp, player: event.targetID, died: false })),
  ].sort((a, b) => a.t - b.t || Number(a.died) - Number(b.died));
  const dead = new Set<number | undefined>();
  for (const event of timeline) {
    if (event.died) dead.add(event.player);
    else dead.delete(event.player);
    if (dead.size >= WIPE_DEATHS) return (event.t - fightStartMs) / MS_PER_S;
  }
  return fightDurationS;
}

/**
 * Parse WCL's `table` blob (string or object) into its source-actor entries. Returns null when
 * the blob is absent, unparseable, or missing its `data.entries` array - an unusable table, as
 * opposed to a valid table with an empty entry list (a real, played-but-no-damage pull).
 */
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

/**
 * The player's DPS from the damage-done table. An unusable table - absent, unparseable, or missing
 * its entries - is a load failure (a played pull would show a bogus 0), returned as a `permanent`
 * error. A player legitimately absent from a valid table (a healer) is a real 0, as is a
 * zero-length pull.
 */
export function dpsFromTable(
  blob: WclTableBlob | null, playerId: number, durationS: number,
): Result<number, LoadError> {
  if (durationS <= 0) return ok(0);
  const entries = tableEntries(blob);
  if (!entries) return permanent('Damage table missing for this pull.', 'pull-overview.damage-table');
  const entry = entries.find(row => row.id === playerId);
  return ok(entry ? entry.total / durationS : 0);
}

/** Report abilities keyed by game id -> name, for resolving a killing blow. */
export function abilityNameMap(report: WclReport): Map<number, string> {
  const map = new Map<number, string>();
  for (const ability of report.masterData?.abilities ?? []) map.set(ability.gameID, ability.name);
  return map;
}


/**
 * The player's deaths in a pull, oldest first: for each `death` event targeting the player,
 * resolve the killing-blow ability name.
 */
export function buildDeathRows(
  deathEvents: WclEvent[],
  playerId: number,
  fightStartMs: number,
  names: Map<number, string>,
): PullDeathRow[] {
  return deathEvents
    .filter(event => event.targetID === playerId)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((event, i) => {
      const abilityId = event.killingAbilityGameID ?? 0;
      return {
        index: i + 1,
        timeS: (event.timestamp - fightStartMs) / MS_PER_S,
        ability: abilityId ? (names.get(abilityId) ?? '') : '',
      };
    });
}

@Injectable({ providedIn: 'root' })
export class PullOverviewFeatureService {
  private readonly wclApi = inject(WclApiService);

  /** Build the pull overview for one player + pull, from the report, damage table and deaths. */
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

      const myDeaths = deathEvents.filter(event => event.targetID === playerId);
      const deaths = buildDeathRows(myDeaths, playerId, fight.startTime, names);
      let outcomeTimeS = fight.duration_s;
      if (result === 'wipe') {
        const resurrects = await this.wclApi.getResurrects(reportCode, fight.id, fight.startTime, fight.endTime);
        outcomeTimeS = wipeTimeS(deathEvents, resurrects, fight.startTime, fight.duration_s);
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
