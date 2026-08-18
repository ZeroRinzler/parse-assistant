import { WclAbility, WclRawAbility } from '../../app/core/models/wcl.models';

interface FixtureActor { id: number; name: string; subType: string; server: string }
interface FixtureEnemy { id: number; name: string; gameID: number }

export interface FixtureReport {
  title: string;
  fights: {
    id: number; name: string; startTime: number; endTime: number;
    kill: boolean; encounterID: number; friendlyPlayers: number[];
  }[];
  masterData: { actors: FixtureActor[]; enemies: FixtureEnemy[]; abilities: WclAbility[] };
}

export interface ReportOverrides {
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
const ACTOR_ID_PER_PARSE = 10;

export function parseReport(over: ReportOverrides = {}): FixtureReport {
  const playerId = over.playerId ?? DEFAULT_PLAYER_ID;
  const playerName = over.playerName ?? DEFAULT_PLAYER_NAME;
  return {
    title: 't',
    fights: [{
      id: over.fightId ?? DEFAULT_FIGHT_ID,
      name: DEFAULT_FIGHT_NAME,
      startTime: 0,
      endTime: over.endTimeMs ?? DEFAULT_FIGHT_END_MS,
      kill: true,
      encounterID: over.encounterId ?? DEFAULT_ENCOUNTER_ID,
      friendlyPlayers: [],
    }],
    masterData: {
      actors: over.actors ?? [{ id: playerId, name: playerName, subType: 'Rogue', server: '' }],
      enemies: over.enemies ?? [],
      abilities: over.abilities ?? [],
    },
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
): (code: string) => Promise<FixtureReport> {
  const { privateCode, ...reportOver } = over;
  return async (code: string) => {
    if (code === privateCode) throw new Error(PRIVATE_REPORT_ERROR);
    const index = Number(code.slice(1));
    return parseReport({
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
