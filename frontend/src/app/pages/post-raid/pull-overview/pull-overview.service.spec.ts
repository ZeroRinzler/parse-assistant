import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent, WclFight, WclReport, WclTableBlob } from '../../../core/models/wcl.models';
import { ok, permanent } from '../../../core/result';
import {
  PullOverviewFeatureService,
  dpsFromTable, abilityNameMap, lethalHitAmount, buildDeathRows, wipeTimeS,
} from './pull-overview.service';

const PLAYER_ID = 5;
const OTHER_PLAYER = 9;
const KILLER_ID = 88;
const ABSENT_PLAYER_ID = 77; // a player with no row in the damage table (e.g. a healer)

// A null/failed damage table blob is a permanent load failure, not a measured 0.
const MISSING_TABLE_ERROR = permanent('Damage table missing for this pull.', 'pull-overview.damage-table');

const OVERWHELMING_BLAST = 214001;
const FROST_BOMB = 198002;

const FIGHT_START_MS = 1_000_000; // report-absolute start of the pull
const MS_PER_S = 1000;

const FIGHT_DURATION_S = 132; // 2:12
const PLAYER_TOTAL = 163_680_000; // total damage -> 1.24M dps over the pull
const EXPECTED_DPS = PLAYER_TOTAL / FIGHT_DURATION_S;

const DEATH_1_AT_S = 41;
const DEATH_2_AT_S = 93;
const BLAST_UNMITIGATED = 214_000;
const BLAST_AMOUNT = 30_000; // post-mitigation; the row shows the unmitigated hit
const BOMB_AMOUNT = 198_000;

function deathEvent(targetID: number, atS: number, killingAbilityGameID: number): WclEvent {
  return { type: 'death', timestamp: FIGHT_START_MS + atS * MS_PER_S, abilityGameID: 0, targetID, sourceID: KILLER_ID, killingAbilityGameID };
}

function dtEvent(abilityGameID: number, atS: number, amount: number, unmitigatedAmount?: number): WclEvent {
  const event: WclEvent = { type: 'damage', timestamp: FIGHT_START_MS + atS * MS_PER_S, abilityGameID, targetID: PLAYER_ID, amount };
  if (unmitigatedAmount != null) event.unmitigatedAmount = unmitigatedAmount;
  return event;
}

function resEvent(targetID: number, atS: number): WclEvent {
  return { type: 'resurrect', timestamp: FIGHT_START_MS + atS * MS_PER_S, abilityGameID: 0, targetID };
}

function fight(over: Partial<WclFight> = {}): WclFight {
  return {
    id: 6, name: 'Boss', startTime: FIGHT_START_MS, endTime: FIGHT_START_MS + FIGHT_DURATION_S * MS_PER_S,
    kill: false, encounterID: 3183, attempt: 3, duration_s: FIGHT_DURATION_S, friendlyPlayers: [], fightPercentage: 41,
    ...over,
  };
}

function report(): WclReport {
  return {
    title: 'log', startTime: 0, fights: [fight()],
    masterData: {
      actors: [],
      abilities: [
        { gameID: OVERWHELMING_BLAST, name: 'Overwhelming Blast', icon: '' },
        { gameID: FROST_BOMB, name: 'Frost Bomb', icon: '' },
      ],
    },
  };
}

describe('dpsFromTable', () => {
  const blob = { data: { entries: [{ id: OTHER_PLAYER, total: 999 }, { id: PLAYER_ID, total: PLAYER_TOTAL }] } };

  it('divides the player entry total by the pull length', () => {
    expect(dpsFromTable(blob, PLAYER_ID, FIGHT_DURATION_S)).toEqual(ok(EXPECTED_DPS));
  });

  it('parses a JSON-string blob the same as an object blob', () => {
    expect(dpsFromTable(JSON.stringify(blob), PLAYER_ID, FIGHT_DURATION_S)).toEqual(ok(EXPECTED_DPS));
  });

  it('reports a null blob as a failed load, so the player never shows a bogus measured 0', () => {
    expect(dpsFromTable(null, PLAYER_ID, FIGHT_DURATION_S)).toEqual(MISSING_TABLE_ERROR);
  });

  it('reports an unparseable string blob as a failed load, not a measured 0', () => {
    expect(dpsFromTable('{ not json', PLAYER_ID, FIGHT_DURATION_S)).toEqual(MISSING_TABLE_ERROR);
  });

  it('reports a valid-JSON blob without a data.entries array as a failed load, not a measured 0', () => {
    expect(dpsFromTable({ data: {} }, PLAYER_ID, FIGHT_DURATION_S)).toEqual(MISSING_TABLE_ERROR);
  });

  it('reports a real 0 for a player absent from a valid table (a healer with no damage entry)', () => {
    expect(dpsFromTable(blob, ABSENT_PLAYER_ID, FIGHT_DURATION_S)).toEqual(ok(0));
  });

  it('reports a real 0 for a zero-length pull - an empty pull measures no damage, not a failure', () => {
    expect(dpsFromTable(blob, PLAYER_ID, 0)).toEqual(ok(0));
  });
});

describe('abilityNameMap', () => {
  it('keys ability names by game id', () => {
    const names = abilityNameMap(report());
    expect(names.get(OVERWHELMING_BLAST)).toBe('Overwhelming Blast');
    expect(names.get(FROST_BOMB)).toBe('Frost Bomb');
  });
});

describe('lethalHitAmount', () => {
  it('takes the matching-ability hit at or before the death, preferring the unmitigated amount', () => {
    const dt = [dtEvent(OVERWHELMING_BLAST, DEATH_1_AT_S, BLAST_AMOUNT, BLAST_UNMITIGATED)];
    expect(lethalHitAmount(dt, OVERWHELMING_BLAST, FIGHT_START_MS + DEATH_1_AT_S * MS_PER_S)).toBe(BLAST_UNMITIGATED);
  });

  it('picks the latest matching hit before the death, ignoring later or other-ability hits', () => {
    const deathTs = FIGHT_START_MS + DEATH_1_AT_S * MS_PER_S;
    const dt = [
      dtEvent(OVERWHELMING_BLAST, DEATH_1_AT_S - 20, 10),
      dtEvent(OVERWHELMING_BLAST, DEATH_1_AT_S - 1, BLAST_AMOUNT, BLAST_UNMITIGATED),
      // Other ability, and the latest hit at or before the death: dropping the ability filter would wrongly pick this.
      dtEvent(FROST_BOMB, DEATH_1_AT_S, 42),
      dtEvent(OVERWHELMING_BLAST, DEATH_1_AT_S + 5, 99), // after the death - ignored
    ];
    expect(lethalHitAmount(dt, OVERWHELMING_BLAST, deathTs)).toBe(BLAST_UNMITIGATED);
  });

  it('falls back to the recorded amount when there is no unmitigated value, and 0 when nothing matches', () => {
    const dt = [dtEvent(FROST_BOMB, DEATH_2_AT_S, BOMB_AMOUNT)];
    expect(lethalHitAmount(dt, FROST_BOMB, FIGHT_START_MS + DEATH_2_AT_S * MS_PER_S)).toBe(BOMB_AMOUNT);
    expect(lethalHitAmount([], OVERWHELMING_BLAST, FIGHT_START_MS)).toBe(0);
  });
});

describe('buildDeathRows', () => {
  const names = abilityNameMap(report());

  it('projects the player deaths oldest-first with 1-based index, relative time, ability and amount', () => {
    const deaths = [
      deathEvent(PLAYER_ID, DEATH_2_AT_S, FROST_BOMB),
      deathEvent(PLAYER_ID, DEATH_1_AT_S, OVERWHELMING_BLAST),
      deathEvent(OTHER_PLAYER, DEATH_1_AT_S, OVERWHELMING_BLAST), // a raidmate - excluded
    ];
    const dt = [
      dtEvent(OVERWHELMING_BLAST, DEATH_1_AT_S, BLAST_AMOUNT, BLAST_UNMITIGATED),
      dtEvent(FROST_BOMB, DEATH_2_AT_S, BOMB_AMOUNT),
    ];
    expect(buildDeathRows(deaths, dt, PLAYER_ID, FIGHT_START_MS, names)).toEqual([
      { index: 1, timeS: DEATH_1_AT_S, ability: 'Overwhelming Blast', amount: BLAST_UNMITIGATED },
      { index: 2, timeS: DEATH_2_AT_S, ability: 'Frost Bomb', amount: BOMB_AMOUNT },
    ]);
  });

  it('leaves the ability empty and amount 0 when the death carried no killing ability', () => {
    const deaths = [deathEvent(PLAYER_ID, DEATH_1_AT_S, 0)];
    expect(buildDeathRows(deaths, [], PLAYER_ID, FIGHT_START_MS, names)).toEqual([
      { index: 1, timeS: DEATH_1_AT_S, ability: '', amount: 0 },
    ]);
  });
});

describe('wipeTimeS', () => {
  const NO_REZ: WclEvent[] = [];

  it('marks the wipe the instant 3 players are simultaneously dead, however far apart the deaths fall', () => {
    const SPREAD_1_S = 20;
    const SPREAD_2_S = 100;
    const SPREAD_3_S = 200; // 49s+ gaps, no window - still the 3rd concurrent death
    const deaths = [deathEvent(1, SPREAD_1_S, 0), deathEvent(2, SPREAD_2_S, 0), deathEvent(3, SPREAD_3_S, 0)];
    expect(wipeTimeS(deaths, NO_REZ, FIGHT_START_MS, FIGHT_DURATION_S)).toBe(SPREAD_3_S);
  });

  it('drops a battle-rezzed player from the dead count, so the wipe waits for a later death', () => {
    const P1_DEATH_S = 20;
    const P2_DEATH_S = 30;
    const P1_REZ_S = 35; // player 1 back up before the 3rd death
    const P3_DEATH_S = 40; // only P2 + P3 down here (not a wipe)
    const P4_DEATH_S = 50; // P2 + P3 + P4 -> the wipe
    const deaths = [deathEvent(1, P1_DEATH_S, 0), deathEvent(2, P2_DEATH_S, 0), deathEvent(3, P3_DEATH_S, 0), deathEvent(4, P4_DEATH_S, 0)];
    expect(wipeTimeS(deaths, [resEvent(1, P1_REZ_S)], FIGHT_START_MS, FIGHT_DURATION_S)).toBe(P4_DEATH_S);
  });

  it('falls back to the fight end when resurrects keep fewer than 3 down at once, or nobody dies', () => {
    const A_DEATH_S = 20;
    const A_REZ_S = 25;
    const B_DEATH_S = 30;
    const B_REZ_S = 35;
    const C_DEATH_S = 40;
    const deaths = [deathEvent(1, A_DEATH_S, 0), deathEvent(2, B_DEATH_S, 0), deathEvent(3, C_DEATH_S, 0)];
    const rez = [resEvent(1, A_REZ_S), resEvent(2, B_REZ_S)];
    expect(wipeTimeS(deaths, rez, FIGHT_START_MS, FIGHT_DURATION_S)).toBe(FIGHT_DURATION_S);
    expect(wipeTimeS([], [], FIGHT_START_MS, FIGHT_DURATION_S)).toBe(FIGHT_DURATION_S);
  });
});

interface FakeCalls { dataTypes: string[] }

function makeService(over: {
  fight?: Partial<WclFight>; deaths?: WclEvent[]; damageTaken?: WclEvent[]; resurrects?: WclEvent[];
  table?: WclTableBlob | null;
} = {}): {
  service: PullOverviewFeatureService; calls: FakeCalls;
} {
  const calls: FakeCalls = { dataTypes: [] };
  const defaultTable: WclTableBlob = { data: { entries: [{ id: PLAYER_ID, total: PLAYER_TOTAL }] } };
  const wcl = {
    getReport: async () => report(),
    getDamageDoneTable: async () => ('table' in over ? over.table : defaultTable),
    getAllEvents: async (_c: string, _f: number, dataType: string) => {
      calls.dataTypes.push(dataType);
      if (dataType === 'Deaths') return over.deaths ?? [];
      return over.damageTaken ?? [];
    },
    getResurrects: async () => over.resurrects ?? [],
  };
  TestBed.configureTestingModule({ providers: [{ provide: WclApiService, useValue: wcl as unknown as WclApiService }] });
  return { service: TestBed.inject(PullOverviewFeatureService), calls };
}

describe('PullOverviewFeatureService.loadView', () => {
  const RAID_D2_AT_S = 60;
  const RAID_D3_AT_S = 90; // player@41 + 2 others, spread out - 3 dead at once, no window

  it('summarizes a wipe: player deaths listed, wipe timed when the 3rd player is concurrently dead', async () => {
    const { service, calls } = makeService({
      deaths: [
        deathEvent(PLAYER_ID, DEATH_1_AT_S, OVERWHELMING_BLAST),
        deathEvent(OTHER_PLAYER, RAID_D2_AT_S, FROST_BOMB),
        deathEvent(OTHER_PLAYER + 1, RAID_D3_AT_S, FROST_BOMB),
      ],
      damageTaken: [dtEvent(OVERWHELMING_BLAST, DEATH_1_AT_S, BLAST_AMOUNT, BLAST_UNMITIGATED)],
    });
    const result = await service.loadView('r', PLAYER_ID, fight());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value;
    expect(view.result).toBe('wipe');
    expect(view.bossPercentage).toBe(41);
    expect(view.durationS).toBe(FIGHT_DURATION_S);
    expect(view.dps).toBe(EXPECTED_DPS);
    expect(view.deaths).toEqual([{ index: 1, timeS: DEATH_1_AT_S, ability: 'Overwhelming Blast', amount: BLAST_UNMITIGATED }]);
    expect(view.outcomeTimeS).toBe(RAID_D3_AT_S);
    expect(calls.dataTypes).toContain('DamageTaken');
  });

  it('marks a clean kill at the fight end and skips the DamageTaken fetch when the player did not die', async () => {
    const { service, calls } = makeService({ deaths: [deathEvent(OTHER_PLAYER, DEATH_1_AT_S, OVERWHELMING_BLAST)] });
    const result = await service.loadView('r', PLAYER_ID, fight({ kill: true, fightPercentage: 0 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value;
    expect(view.result).toBe('kill');
    expect(view.deaths).toEqual([]);
    expect(view.outcomeTimeS).toBe(FIGHT_DURATION_S);
    expect(calls.dataTypes).not.toContain('DamageTaken');
  });

  it('fails the load when the damage table is missing, so the pull is not scored a bogus 0 DPS', async () => {
    const { service } = makeService({
      table: null,
      deaths: [deathEvent(OTHER_PLAYER, DEATH_1_AT_S, OVERWHELMING_BLAST)],
    });
    const result = await service.loadView('r', PLAYER_ID, fight({ kill: true, fightPercentage: 0 }));

    expect(result).toEqual(MISSING_TABLE_ERROR);
  });
});
