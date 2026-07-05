import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent, WclFight, WclReport, WclTableBlob } from '../../../core/models/wcl.models';
import { logWarn } from '../../../core/log';

/**
 * Pull overview - the first, always-on card on the post-raid page. It summarizes a single
 * pull from the player's OWN log alone (WCL, no bench): the player's DPS, the pull time and
 * boss % reached, and each of the player's deaths plus the kill/wipe outcome. It injects
 * only `WclApiService`; there is no bench, no `*_DATA_SOURCE`, and no transform.
 */

const MS_PER_S = 1000;

/** Whether the pull ended in a kill or a wipe. */
export type PullResult = 'kill' | 'wipe';

/** One of the player's deaths in the pull. */
export interface PullDeathRow {
  /** 1-based ordinal ("Death 1", "Death 2"). */
  index: number;
  /** Fight-relative time of the death, in seconds. */
  timeS: number;
  /** Killing-blow ability name (empty when the death carried no ability). */
  ability: string;
  /** Magnitude of the lethal hit (the full incoming amount); 0 when it could not be resolved. */
  amount: number;
}

/** The card's view-model: a single pull, entirely derived from the player's own log. */
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

/** Parse WCL's `table` blob (string or object) into its source-actor entries. */
function tableEntries(blob: WclTableBlob | null): { id: number; total: number }[] {
  if (!blob) return [];
  const parsed = typeof blob === 'string' ? safeJson(blob) : blob;
  return parsed?.data?.entries ?? [];
}

function safeJson(raw: string): { data?: { entries?: { id: number; total: number }[] } } | null {
  try {
    return JSON.parse(raw);
  } catch (err) {
    logWarn('pull-overview.tableEntries', err);
    return null;
  }
}

/** The player's DPS from the damage-done table: their entry's total over the pull length. */
export function dpsFromTable(blob: WclTableBlob | null, playerId: number, durationS: number): number {
  if (durationS <= 0) return 0;
  const entry = tableEntries(blob).find(row => row.id === playerId);
  return entry ? entry.total / durationS : 0;
}

/** Report abilities keyed by game id -> name, for resolving a killing blow. */
export function abilityNameMap(report: WclReport): Map<number, string> {
  const map = new Map<number, string>();
  for (const ability of report.masterData?.abilities ?? []) map.set(ability.gameID, ability.name);
  return map;
}

/**
 * The lethal hit's magnitude for a death: the matching-ability DamageTaken event landing
 * at or just before the death. Uses the full incoming (`unmitigatedAmount`) hit, falling
 * back to the recorded `amount`. Returns 0 when no matching hit is found.
 */
export function lethalHitAmount(damageTaken: WclEvent[], abilityId: number, deathTs: number): number {
  let lethal: WclEvent | null = null;
  for (const event of damageTaken) {
    if (event.abilityGameID !== abilityId || event.timestamp > deathTs) continue;
    if (!lethal || event.timestamp > lethal.timestamp) lethal = event;
  }
  return lethal ? (lethal.unmitigatedAmount ?? lethal.amount ?? 0) : 0;
}

/**
 * The player's deaths in a pull, oldest first: for each `death` event targeting the player,
 * resolve the killing-blow ability name and the lethal hit's magnitude.
 */
export function buildDeathRows(
  deathEvents: WclEvent[],
  damageTaken: WclEvent[],
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
        amount: abilityId ? lethalHitAmount(damageTaken, abilityId, event.timestamp) : 0,
      };
    });
}

@Injectable({ providedIn: 'root' })
export class PullOverviewFeatureService {
  private readonly wclApi = inject(WclApiService);

  /**
   * Build the pull overview for one player + pull. Fetches the report (cached, for
   * killing-blow names), the damage-done table (for DPS) and the pull's deaths; the
   * player's DamageTaken (for lethal-hit magnitudes) is fetched only when they died.
   */
  async loadView(reportCode: string, playerId: number, fight: WclFight): Promise<PullOverviewView> {
    const result: PullResult = fight.kill ? 'kill' : 'wipe';

    const report = await this.wclApi.getReport(reportCode);
    const names = abilityNameMap(report);

    const [table, deathEvents] = await Promise.all([
      this.wclApi.getDamageDoneTable(reportCode, fight.id),
      this.wclApi.getAllEvents(reportCode, fight.id, 'Deaths', fight.startTime, fight.endTime),
    ]);

    const dps = dpsFromTable(table, playerId, fight.duration_s);
    const myDeaths = deathEvents.filter(event => event.targetID === playerId);
    const damageTaken = myDeaths.length
      ? await this.wclApi.getAllEvents(reportCode, fight.id, 'DamageTaken', fight.startTime, fight.endTime, playerId)
      : [];
    const deaths = buildDeathRows(myDeaths, damageTaken, playerId, fight.startTime, names);
    let outcomeTimeS = fight.duration_s;
    if (result === 'wipe') {
      const resurrects = await this.wclApi.getResurrects(reportCode, fight.id, fight.startTime, fight.endTime);
      outcomeTimeS = wipeTimeS(deathEvents, resurrects, fight.startTime, fight.duration_s);
    }

    return {
      attempt: fight.attempt,
      result,
      durationS: fight.duration_s,
      bossPercentage: fight.fightPercentage,
      dps,
      deaths,
      outcomeTimeS,
    };
  }
}
