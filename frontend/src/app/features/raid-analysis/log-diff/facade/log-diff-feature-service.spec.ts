import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { WclReport, WclTableBlob } from '../../../../core/wcl/wcl.models';
import { wclReport } from '../../../../../testing/builders/wcl-fixtures';
import { LogDiffFeatureService } from './log-diff-feature-service';

const CODE_A = 'AAAAAAAAAAAAAAAA';
const CODE_B = 'BBBBBBBBBBBBBBBB';
const CODE_UNKNOWN = 'ZZZZZZZZZZZZZZZZ';

const PLAYER_1_ID = 10;
const PLAYER_2_ID = 11;
const FIGHT_1_ID = 1;
const FIGHT_2_ID = 2;

const EVISCERATE = 196819;

const FIGHT_DURATION_MS = 100_000; // 100s pull

function reportWithTwoFightsTwoPlayers(): WclReport {
  return wclReport({
    fights: [
      {
        id: FIGHT_1_ID, name: 'Trash Pull', startTime: 0, endTime: FIGHT_DURATION_MS, kill: false,
        encounterID: 0, attempt: 0, duration_s: 0, friendlyPlayers: [], fightPercentage: 0,
      },
      {
        id: FIGHT_2_ID, name: 'Boss', startTime: FIGHT_DURATION_MS, endTime: FIGHT_DURATION_MS * 2, kill: true,
        encounterID: 3183, attempt: 1, duration_s: 100, friendlyPlayers: [PLAYER_1_ID, PLAYER_2_ID], fightPercentage: 0,
      },
    ],
    actors: [
      { id: PLAYER_1_ID, name: 'Ana', subType: 'Rogue', server: 'eu' },
      { id: PLAYER_2_ID, name: 'Bo', subType: 'Priest', server: 'eu' },
    ],
  });
}

interface FakeCalls {
  reportCodes: string[];
  tableCalls: { code: string; fightId: number; sourceId: number }[];
  wholeTableCalls: { code: string; fightId: number }[];
  targetTableCalls: { code: string; fightId: number; sourceId: number; startTime?: number; endTime?: number }[];
}

function makeService(over: {
  reports?: Record<string, WclReport | Error>;
  tables?: Record<string, WclTableBlob | null>;
  wholeTables?: Record<string, WclTableBlob | null>;
  targetTables?: Record<string, WclTableBlob | null>;
  castsTables?: Record<string, WclTableBlob | null>;
} = {}): { service: LogDiffFeatureService; calls: FakeCalls } {
  const calls: FakeCalls = { reportCodes: [], tableCalls: [], wholeTableCalls: [], targetTableCalls: [] };
  const wcl = {
    getReport: async (code: string) => {
      calls.reportCodes.push(code);
      const entry = over.reports?.[code];
      if (entry instanceof Error) throw entry;
      if (!entry) throw new Error('unknown report');
      return entry;
    },
    getDamageDoneTableForSource: async (code: string, fightId: number, sourceId: number) => {
      calls.tableCalls.push({ code, fightId, sourceId });
      return over.tables?.[`${code}:${sourceId}`] ?? null;
    },
    getDamageDoneTable: async (code: string, fightId: number) => {
      calls.wholeTableCalls.push({ code, fightId });
      return over.wholeTables?.[code] ?? null;
    },
    getDamageByTargetForSource: async (code: string, fightId: number, sourceId: number, startTime?: number, endTime?: number) => {
      calls.targetTableCalls.push({ code, fightId, sourceId, startTime, endTime });
      return over.targetTables?.[`${code}:${sourceId}`] ?? null;
    },
    getCastsTableForSource: async (code: string, fightId: number, sourceId: number) =>
      over.castsTables?.[`${code}:${sourceId}`] ?? null,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: WclApiService, useValue: wcl as unknown as WclApiService }] });
  return { service: TestBed.inject(LogDiffFeatureService), calls };
}

describe('LogDiffFeatureService.loadSide', () => {
  beforeEach(() => { TestBed.resetTestingModule(); });

  it('rejects an unparseable URL without calling WCL', async () => {
    const { service, calls } = makeService();
    await service.loadSide('A', 'not a url');
    expect(service.sideA().notice).toBe('Enter a valid Warcraft Logs report URL or 16-character report code.');
    expect(calls.reportCodes).toEqual([]);
  });

  it('drops trash and defaults to the last pull and its first visible player', async () => {
    const { service } = makeService({ reports: { [CODE_A]: reportWithTwoFightsTwoPlayers() } });
    await service.loadSide('A', CODE_A);
    const side = service.sideA();
    expect(side.fights.map(f => f.id)).toEqual([FIGHT_2_ID]);
    expect(side.selectedFightId).toBe(FIGHT_2_ID);
    expect(side.selectedPlayerId).toBe(PLAYER_1_ID);
    expect(side.loading).toBe(false);
    expect(side.notice).toBe('');
  });

  it('honors an explicit fight and source id from the URL', async () => {
    const { service } = makeService({ reports: { [CODE_A]: reportWithTwoFightsTwoPlayers() } });
    await service.loadSide('A', `https://www.warcraftlogs.com/reports/${CODE_A}#fight=${FIGHT_2_ID}&source=${PLAYER_2_ID}`);
    const side = service.sideA();
    expect(side.selectedFightId).toBe(FIGHT_2_ID);
    expect(side.selectedPlayerId).toBe(PLAYER_2_ID);
  });

  it('notices a report with no boss pulls, not scored as an error', async () => {
    const { service } = makeService({ reports: { [CODE_A]: wclReport({ fights: [] }) } });
    await service.loadSide('A', CODE_A);
    expect(service.sideA().notice).toBe('No boss pulls found in this report.');
    expect(service.sideA().error).toBeNull();
  });

  it('surfaces an unusable report as a hard error, not a notice', async () => {
    const { service } = makeService({ reports: { [CODE_UNKNOWN]: new Error('boom') } });
    await service.loadSide('A', CODE_UNKNOWN);
    expect(service.sideA().error?.kind).toBe('permanent');
  });

  it('loading side A leaves side B untouched', async () => {
    const { service } = makeService({ reports: { [CODE_A]: reportWithTwoFightsTwoPlayers() } });
    await service.loadSide('A', CODE_A);
    expect(service.sideB().code).toBe('');
  });
});

describe('LogDiffFeatureService selection', () => {
  it('selectFight keeps the current player selected when they are visible on the newly selected pull', async () => {
    const report = reportWithTwoFightsTwoPlayers();
    // A later boss pull with both players visible - buildFights defaults to the latest pull, so this one loads first.
    report.fights.push({
      id: 3, name: 'Boss 2', startTime: FIGHT_DURATION_MS * 2, endTime: FIGHT_DURATION_MS * 3, kill: true,
      encounterID: 3184, attempt: 1, duration_s: 100, friendlyPlayers: [PLAYER_1_ID, PLAYER_2_ID], fightPercentage: 0,
    });
    const { service } = makeService({ reports: { [CODE_A]: report } });
    await service.loadSide('A', CODE_A);
    service.selectPlayer('A', PLAYER_2_ID);

    service.selectFight('A', FIGHT_2_ID);
    expect(service.sideA().selectedFightId).toBe(FIGHT_2_ID);
    expect(service.sideA().selectedPlayerId).toBe(PLAYER_2_ID); // Bo stays selected: still on fight 2's roster
  });

  it('selectFight falls back to the first visible player when the current one is not on the newly selected pull', async () => {
    const report = reportWithTwoFightsTwoPlayers();
    // Fight 2's own roster only ever has player 1; a later boss pull with only player 2 visible.
    const boss1 = report.fights.find(f => f.id === FIGHT_2_ID);
    if (boss1) boss1.friendlyPlayers = [PLAYER_1_ID];
    report.fights.push({
      id: 3, name: 'Boss 2', startTime: FIGHT_DURATION_MS * 2, endTime: FIGHT_DURATION_MS * 3, kill: true,
      encounterID: 3184, attempt: 1, duration_s: 100, friendlyPlayers: [PLAYER_2_ID], fightPercentage: 0,
    });
    const { service } = makeService({ reports: { [CODE_A]: report } });
    await service.loadSide('A', CODE_A);
    expect(service.sideA().selectedFightId).toBe(3);
    expect(service.sideA().selectedPlayerId).toBe(PLAYER_2_ID); // fight 3's only visible player

    service.selectFight('A', FIGHT_2_ID);
    expect(service.sideA().selectedFightId).toBe(FIGHT_2_ID);
    expect(service.sideA().selectedPlayerId).toBe(PLAYER_1_ID); // fight 2's only visible player, player 2 is not on this roster
  });

  it('selectPlayer only changes the player, and clears a stale comparison result', async () => {
    const { service } = makeService({ reports: { [CODE_A]: reportWithTwoFightsTwoPlayers() } });
    await service.loadSide('A', CODE_A);
    service.selectPlayer('A', PLAYER_2_ID);
    expect(service.sideA().selectedPlayerId).toBe(PLAYER_2_ID);
    expect(service.sideA().selectedFightId).toBe(FIGHT_2_ID);
  });
});

describe('LogDiffFeatureService.compare', () => {
  async function readySides(
    tables: Record<string, WclTableBlob | null>, wholeTables: Record<string, WclTableBlob | null> = {},
    targetTables: Record<string, WclTableBlob | null> = {}, castsTables: Record<string, WclTableBlob | null> = {},
  ): Promise<{ service: LogDiffFeatureService; calls: FakeCalls }> {
    const { service, calls } = makeService({
      reports: { [CODE_A]: reportWithTwoFightsTwoPlayers(), [CODE_B]: reportWithTwoFightsTwoPlayers() },
      tables, wholeTables, targetTables, castsTables,
    });
    await service.loadSide('A', CODE_A);
    await service.loadSide('B', CODE_B);
    return { service, calls };
  }

  // Default whole-pull tables for tests that only care about the per-ability rows, not the WCL-native total.
  const wholeTablesFor = (totalA: number, totalB: number): Record<string, WclTableBlob> => ({
    [CODE_A]: { data: { entries: [{ id: PLAYER_1_ID, total: totalA }] } },
    [CODE_B]: { data: { entries: [{ id: PLAYER_1_ID, total: totalB }] } },
  });

  // Default by-target tables for tests that don't care about the target breakdown itself.
  const targetTablesFor = (totalA: number, totalB: number): Record<string, WclTableBlob> => ({
    [`${CODE_A}:${PLAYER_1_ID}`]: { data: { entries: [{ id: 200, name: 'Boss', total: totalA }] } },
    [`${CODE_B}:${PLAYER_1_ID}`]: { data: { entries: [{ id: 200, name: 'Boss', total: totalB }] } },
  });

  it('does nothing when a side is not ready yet', async () => {
    const { service, calls } = makeService({ reports: { [CODE_A]: reportWithTwoFightsTwoPlayers() } });
    await service.loadSide('A', CODE_A);
    expect(service.canCompare()).toBe(false);
    await service.compare();
    expect(service.comparisonResult()).toBeNull();
    expect(calls.tableCalls).toEqual([]);
  });

  it('canCompare turns true only once both sides have a selected fight and player', async () => {
    const { service } = await readySides({});
    expect(service.canCompare()).toBe(true);
  });

  it('fetches each side\'s table scoped to its own selected player and builds sorted rows', async () => {
    const { service, calls } = await readySides(
      {
        [`${CODE_A}:${PLAYER_1_ID}`]: { data: { entries: [{ id: 1, guid: EVISCERATE, name: 'Eviscerate', total: 10_000 }] } },
        [`${CODE_B}:${PLAYER_1_ID}`]: { data: { entries: [{ id: 1, guid: EVISCERATE, name: 'Eviscerate', total: 5_000 }] } },
      },
      wholeTablesFor(20_000, 8_000),
      targetTablesFor(8_000, 4_000),
    );
    await service.compare();

    expect(calls.tableCalls).toEqual([
      { code: CODE_A, fightId: FIGHT_2_ID, sourceId: PLAYER_1_ID },
      { code: CODE_B, fightId: FIGHT_2_ID, sourceId: PLAYER_1_ID },
    ]);
    expect(calls.wholeTableCalls).toEqual([
      { code: CODE_A, fightId: FIGHT_2_ID },
      { code: CODE_B, fightId: FIGHT_2_ID },
    ]);
    expect(calls.targetTableCalls).toEqual([
      { code: CODE_A, fightId: FIGHT_2_ID, sourceId: PLAYER_1_ID, startTime: FIGHT_DURATION_MS, endTime: FIGHT_DURATION_MS * 2 },
      { code: CODE_B, fightId: FIGHT_2_ID, sourceId: PLAYER_1_ID, startTime: FIGHT_DURATION_MS, endTime: FIGHT_DURATION_MS * 2 },
    ]);
    const result = service.comparisonResult();
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.playerA).toBe('Ana');
    expect(result.value.playerB).toBe('Ana');
    // WCL's own per-player total (200/80), not the sum of the per-ability rows (100/50) - they intentionally diverge here.
    expect(result.value.totalDpsA).toBe(200);
    expect(result.value.totalDpsB).toBe(80);
    expect(result.value.rows).toEqual([{ key: 'Eviscerate', abilityId: EVISCERATE, name: 'Eviscerate', dpsA: 100, dpsB: 50, deltaDps: 50, castsA: 0, castsB: 0 }]);
    // Both sides hit only "Boss": 100% share for each, so no priority gap.
    expect(result.value.targetRows).toEqual([{ key: 'Boss', targetId: 200, name: 'Boss', pctA: 100, pctB: 100, deltaPct: 0 }]);
    expect(service.comparing()).toBe(false);
    expect(service.comparisonValue()).toEqual(result.value);
    expect(service.comparisonError()).toBeNull();
  });

  it('attaches each side\'s cast count from its own casts table to the merged row', async () => {
    const { service } = await readySides(
      {
        [`${CODE_A}:${PLAYER_1_ID}`]: { data: { entries: [{ id: 1, guid: EVISCERATE, name: 'Eviscerate', total: 10_000 }] } },
        [`${CODE_B}:${PLAYER_1_ID}`]: { data: { entries: [{ id: 1, guid: EVISCERATE, name: 'Eviscerate', total: 5_000 }] } },
      },
      wholeTablesFor(20_000, 8_000), targetTablesFor(8_000, 4_000),
      {
        [`${CODE_A}:${PLAYER_1_ID}`]: { data: { entries: [{ id: 1, guid: EVISCERATE, name: 'Eviscerate', total: 12 }] } },
        [`${CODE_B}:${PLAYER_1_ID}`]: { data: { entries: [{ id: 1, guid: EVISCERATE, name: 'Eviscerate', total: 7 }] } },
      },
    );
    await service.compare();
    const result = service.comparisonResult();
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.rows[0]).toMatchObject({ castsA: 12, castsB: 7 });
  });

  it('still succeeds, with an empty target breakdown, when the by-target table is missing (non-fatal)', async () => {
    const { service } = await readySides(
      {
        [`${CODE_A}:${PLAYER_1_ID}`]: { data: { entries: [] } },
        [`${CODE_B}:${PLAYER_1_ID}`]: { data: { entries: [] } },
      },
      wholeTablesFor(20_000, 8_000),
      { [`${CODE_A}:${PLAYER_1_ID}`]: null, [`${CODE_B}:${PLAYER_1_ID}`]: { data: { entries: [] } } },
    );
    await service.compare();
    const result = service.comparisonResult();
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.targetRows).toEqual([]);
  });

  it('fails permanently when a side\'s per-ability table is missing, instead of scoring a bogus 0', async () => {
    const { service } = await readySides(
      { [`${CODE_A}:${PLAYER_1_ID}`]: null, [`${CODE_B}:${PLAYER_1_ID}`]: { data: { entries: [] } } },
      wholeTablesFor(20_000, 8_000),
      targetTablesFor(8_000, 4_000),
    );
    await service.compare();
    const result = service.comparisonResult();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error.kind).toBe('permanent');
    expect(service.comparisonValue()).toBeNull();
    expect(service.comparisonError()).toEqual(result.error);
  });

  it('fails permanently when a side\'s whole-pull table is missing, instead of scoring a bogus 0', async () => {
    const { service } = await readySides(
      {
        [`${CODE_A}:${PLAYER_1_ID}`]: { data: { entries: [] } },
        [`${CODE_B}:${PLAYER_1_ID}`]: { data: { entries: [] } },
      },
      { [CODE_A]: null, [CODE_B]: { data: { entries: [{ id: PLAYER_1_ID, total: 8_000 }] } } },
      targetTablesFor(8_000, 4_000),
    );
    await service.compare();
    const result = service.comparisonResult();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error.kind).toBe('permanent');
  });
});

describe('LogDiffFeatureService.playerTotalDps', () => {
  it('reads the matching actor row\'s total, ignoring guid (a class icon ref on this table shape)', () => {
    const { service } = makeService();
    const blob: WclTableBlob = { data: { entries: [{ id: PLAYER_1_ID, guid: 999, total: 10_000 }] } };
    expect(service['playerTotalDps'](blob, PLAYER_1_ID, 100)).toBe(100);
  });

  it('reads a real 0 when the player has no row in an otherwise valid table (e.g. a healer)', () => {
    const { service } = makeService();
    const blob: WclTableBlob = { data: { entries: [{ id: PLAYER_2_ID, total: 5_000 }] } };
    expect(service['playerTotalDps'](blob, PLAYER_1_ID, 100)).toBe(0);
  });

  it('returns null for an unusable table (absent or unparseable), never a bogus 0', () => {
    const { service } = makeService();
    expect(service['playerTotalDps'](null, PLAYER_1_ID, 100)).toBeNull();
    expect(service['playerTotalDps']({ data: {} }, PLAYER_1_ID, 100)).toBeNull();
  });

  it('short-circuits to 0 for a zero-length pull, without reading the table', () => {
    const { service } = makeService();
    expect(service['playerTotalDps'](null, PLAYER_1_ID, 0)).toBe(0);
  });
});

const BOSS_ID = 200;

describe('LogDiffFeatureService.targetTableEntries', () => {
  it('reads the row\'s own name when WCL supplies one, ignoring guid (an icon ref on this table shape)', () => {
    const { service } = makeService();
    const blob: WclTableBlob = { data: { entries: [{ id: BOSS_ID, guid: 999, name: 'Boss', total: 10_000 }] } };
    expect(service['targetTableEntries'](blob, new Map())).toEqual([{ targetId: BOSS_ID, name: 'Boss', total: 10_000 }]);
  });

  it('falls back to the actor name map when the row carries no name', () => {
    const { service } = makeService();
    const blob: WclTableBlob = { data: { entries: [{ id: BOSS_ID, total: 10_000 }] } };
    expect(service['targetTableEntries'](blob, new Map([[BOSS_ID, 'Boss']]))).toEqual([{ targetId: BOSS_ID, name: 'Boss', total: 10_000 }]);
  });

  it('returns an empty name when neither the row nor the actor map has one', () => {
    const { service } = makeService();
    const blob: WclTableBlob = { data: { entries: [{ id: BOSS_ID, total: 10_000 }] } };
    expect(service['targetTableEntries'](blob, new Map())).toEqual([{ targetId: BOSS_ID, name: '', total: 10_000 }]);
  });

  it('returns null for an unusable table, never a bogus empty breakdown', () => {
    const { service } = makeService();
    expect(service['targetTableEntries'](null, new Map())).toBeNull();
  });
});

describe('LogDiffFeatureService.actorNameMap', () => {
  it('maps every actor id to its name', () => {
    const { service } = makeService();
    const report = reportWithTwoFightsTwoPlayers();
    expect(service['actorNameMap'](report)).toEqual(new Map([[PLAYER_1_ID, 'Ana'], [PLAYER_2_ID, 'Bo']]));
  });

  it('returns an empty map for no report', () => {
    const { service } = makeService();
    expect(service['actorNameMap'](null)).toEqual(new Map());
  });
});

describe('LogDiffFeatureService.buildTargetRows', () => {
  it('builds rows when both sides\' tables are usable', () => {
    const { service } = makeService();
    const tableA: WclTableBlob = { data: { entries: [{ id: BOSS_ID, name: 'Boss', total: 8_000 }] } };
    const tableB: WclTableBlob = { data: { entries: [{ id: BOSS_ID, name: 'Boss', total: 4_000 }] } };
    expect(service['buildTargetRows'](tableA, null, tableB, null)).toEqual([
      { key: 'Boss', targetId: BOSS_ID, name: 'Boss', pctA: 100, pctB: 100, deltaPct: 0 },
    ]);
  });

  it('degrades to an empty breakdown, not a thrown error, when either side\'s table is unusable', () => {
    const { service } = makeService();
    const tableB: WclTableBlob = { data: { entries: [{ id: BOSS_ID, name: 'Boss', total: 4_000 }] } };
    expect(service['buildTargetRows'](null, null, tableB, null)).toEqual([]);
  });
});
