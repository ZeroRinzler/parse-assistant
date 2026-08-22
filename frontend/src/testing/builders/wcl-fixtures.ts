import { WclAbility, WclFight, WclRawAbility, WclReport } from '../../app/core/models/wcl.models';

interface FixtureActor { id: number; name: string; subType: string; server: string }
interface FixtureEnemy { id: number; name: string; gameID: number }

export interface ReportOverrides {
  startTimeMs?: number;
  fights?: WclFight[];
  playerId?: number;
  playerName?: string;
  fightId?: number;
  endTimeMs?: number;
  encounterId?: number;
  actors?: FixtureActor[];
  enemies?: FixtureEnemy[];
  abilities?: WclAbility[];
}

const DEFAULT_PLAYER_ID = 10;
const DEFAULT_PLAYER_NAME = 'P1';
const DEFAULT_FIGHT_ID = 1;
const DEFAULT_FIGHT_NAME = 'Boss';
const DEFAULT_ENCOUNTER_ID = 1;
const DEFAULT_FIGHT_END_MS = 300_000;
const MS_PER_S = 1000;
const ACTOR_ID_PER_PARSE = 10;

function defaultFight(over: ReportOverrides): WclFight {
  const endTime = over.endTimeMs ?? DEFAULT_FIGHT_END_MS;
  return {
    id: over.fightId ?? DEFAULT_FIGHT_ID,
    name: DEFAULT_FIGHT_NAME,
    startTime: 0,
    endTime,
    kill: true,
    encounterID: over.encounterId ?? DEFAULT_ENCOUNTER_ID,
    attempt: 1,
    duration_s: endTime / MS_PER_S,
    friendlyPlayers: [],
    fightPercentage: 0,
  };
}

function defaultMasterData(over: ReportOverrides): NonNullable<WclReport['masterData']> {
  return {
    actors: over.actors ?? [{
      id: over.playerId ?? DEFAULT_PLAYER_ID, name: over.playerName ?? DEFAULT_PLAYER_NAME, subType: 'Rogue', server: '',
    }],
    enemies: over.enemies ?? [],
    abilities: over.abilities ?? [],
  };
}

/** `fights` replaces the default pull wholesale, so `fightId` / `endTimeMs` / `encounterId` are ignored beside it. */
export function wclReport(over: ReportOverrides = {}): WclReport {
  return {
    title: 't',
    startTime: over.startTimeMs ?? 0,
    fights: over.fights ?? [defaultFight(over)],
    masterData: defaultMasterData(over),
  };
}

export interface FixtureRanking {
  name: string;
  server?: { name: string };
  report: { code: string; fightID: number };
}

export function rankingRow(index: number, over: { name?: string; server?: string } = {}): FixtureRanking {
  return {
    name: over.name ?? `P${index}`,
    ...(over.server !== undefined && { server: { name: over.server } }),
    report: { code: `r${index}`, fightID: index },
  };
}

export function parseRankings(count: number): FixtureRanking[] {
  return Array.from({ length: count }, (_unused, offset) => rankingRow(offset + 1));
}

const PRIVATE_REPORT_ERROR = 'You do not have permission to view this report.';

/** Decodes the codes {@link rankingRow} mints, so the two must change together. */
export function reportsByCode(
  over: ReportOverrides & { privateCode?: string } = {},
): (code: string) => Promise<WclReport> {
  const { privateCode, ...reportOver } = over;
  return async (code: string) => {
    if (code === privateCode) throw new Error(PRIVATE_REPORT_ERROR);
    const index = Number(code.slice(1));
    return wclReport({
      playerId: index * ACTOR_ID_PER_PARSE, playerName: `P${index}`, fightId: index, ...reportOver,
    });
  };
}

export function abilityLookup(
  named: Record<number, { icon: string; name: string }> = {},
): (ids: number[]) => Promise<Record<number, WclRawAbility>> {
  return async (ids: number[]) => Object.fromEntries(ids.map(id => {
    const entry = named[id] ?? { icon: `icon_${id}`, name: `name_${id}` };
    return [id, { id, icon: entry.icon, name: entry.name }];
  }));
}
