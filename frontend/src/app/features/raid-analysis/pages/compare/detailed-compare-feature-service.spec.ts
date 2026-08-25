import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { WclReport, PlayerDetailGroups } from '../../../../core/wcl/wcl.models';
import { wclReport } from '../../../../../testing/builders/wcl-fixtures';
import { applyBuff } from '../../../../../testing/builders/events';
import { BLOODLUST } from '../../../../../testing/spell-ids';
import { Results } from '../../../../core/http/result';
import { BenchParse } from '../../../../domain/analysis/bench-pipeline-service';
import { BurstBench } from '../../burst-windows/data-access/burst-data-source';
import { RotationTransformService } from '../../rotation/data-access/rotation-transform-service';
import { BurstTransformService } from '../../burst-windows/data-access/burst-transform-service';
import { DefensiveTransformService } from '../../defensive/data-access/defensive-transform-service';
import { GearTransformService } from '../../gear/data-access/gear-transform-service';
import { LogDiffFeatureService } from '../../log-diff/facade/log-diff-feature-service';
import { DetailedCompareFeatureService } from './detailed-compare-feature-service';

const CODE_A = 'AAAAAAAAAAAAAAAA';
const CODE_B = 'BBBBBBBBBBBBBBBB';
const PLAYER_A_ID = 10;
const PLAYER_B_ID = 20;
const FIGHT_ID = 1;
const ENCOUNTER_ID = 3183;

function report(playerId: number, playerName: string): WclReport {
  return wclReport({
    playerId, playerName,
    fights: [{
      id: FIGHT_ID, name: 'Boss', startTime: 0, endTime: 100_000, kill: true, encounterID: ENCOUNTER_ID,
      attempt: 1, duration_s: 100, friendlyPlayers: [], fightPercentage: 0,
    }],
  });
}

// specOf joins `type` (class) + `specs[0].spec` verbatim, e.g. className 'Rogue' + specLabel 'Subtlety' -> 'SubtletyRogue'.
function playerDetails(playerId: number, specLabel: string, className: string): PlayerDetailGroups {
  return { dps: [{ id: playerId, type: className, name: 'P', specs: [{ spec: specLabel }] }] };
}

interface Setup {
  service: DetailedCompareFeatureService;
  benchCalls: { rotation: number; burst: number; defensive: number; gear: number };
}

async function readySides(over: { specLabelB?: string; classB?: string } = {}): Promise<Setup> {
  const specLabelB = over.specLabelB ?? 'Subtlety';
  const classB = over.classB ?? 'Rogue';
  const benchCalls = { rotation: 0, burst: 0, defensive: 0, gear: 0 };

  const wcl = {
    getReport: async (code: string) => (code === CODE_A ? report(PLAYER_A_ID, 'Ana') : report(PLAYER_B_ID, 'Bo')),
    getPlayerDetails: async (code: string) => code === CODE_A
      ? playerDetails(PLAYER_A_ID, 'Subtlety', 'Rogue')
      : playerDetails(PLAYER_B_ID, specLabelB, classB),
  };
  const stubBench = (key: keyof typeof benchCalls) => ({
    getBenchFromParse: async () => { benchCalls[key]++; return Results.ok({}); },
  });

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: WclApiService, useValue: wcl as unknown as WclApiService },
      { provide: RotationTransformService, useValue: stubBench('rotation') as unknown as RotationTransformService },
      { provide: BurstTransformService, useValue: stubBench('burst') as unknown as BurstTransformService },
      { provide: DefensiveTransformService, useValue: stubBench('defensive') as unknown as DefensiveTransformService },
      { provide: GearTransformService, useValue: stubBench('gear') as unknown as GearTransformService },
    ],
  });

  const logDiff = TestBed.inject(LogDiffFeatureService);
  await logDiff.loadSide('A', CODE_A);
  await logDiff.loadSide('B', CODE_B);
  return { service: TestBed.inject(DetailedCompareFeatureService), benchCalls };
}

describe('DetailedCompareFeatureService.loadDetailed', () => {
  it('resolves both specs and, on a match, benches all 4 cards from side B\'s single parse', async () => {
    const { service, benchCalls } = await readySides();
    await service.loadDetailed();

    expect(service.attempted()).toBe(true);
    expect(service.sameSpec()).toBe(true);
    expect(service.specA()).toBe('SubtletyRogue');
    expect(benchCalls).toEqual({ rotation: 1, burst: 1, defensive: 1, gear: 1 });
    expect(service.loading()).toBe(false);
  });

  it('stops before benching anything when the two sides are different specs', async () => {
    const { service, benchCalls } = await readySides({ specLabelB: 'Frost', classB: 'Mage' });
    await service.loadDetailed();

    expect(service.sameSpec()).toBe(false);
    expect(benchCalls).toEqual({ rotation: 0, burst: 0, defensive: 0, gear: 0 });
    expect(service.rotationBench()).toBeNull();
  });

  it('a second load with a resolved-away spec clears the previous same-spec result', async () => {
    const { service } = await readySides();
    await service.loadDetailed();
    expect(service.sameSpec()).toBe(true);

    // clearResults() runs at the top of every loadDetailed(), so a stale sameSpec never survives a second call.
    const { service: second } = await readySides({ specLabelB: 'Frost', classB: 'Mage' });
    await second.loadDetailed();
    expect(second.sameSpec()).toBe(false);
  });
});

describe('DetailedCompareFeatureService.benchParseFor', () => {
  it('builds a ranking from the side\'s own code/fight/actor, not a WCL lookup', async () => {
    const { service } = await readySides();
    const side = TestBed.inject(LogDiffFeatureService).sideB();
    const parse = service['benchParseFor'](side);
    expect(parse).toMatchObject({
      ranking: { player: 'Bo', report_code: CODE_B, fight_id: FIGHT_ID },
      fight: { id: FIGHT_ID },
      player: { id: PLAYER_B_ID, name: 'Bo' },
    });
  });

  it('returns null when the side has no report yet', async () => {
    const { service } = await readySides();
    expect(service['benchParseFor']({
      code: '', title: '', report: null, fights: [], players: [],
      selectedFightId: null, selectedPlayerId: null, loading: false, error: null, notice: '',
    })).toBeNull();
  });
});

describe('DetailedCompareFeatureService.loadBurstPeerBuffs', () => {
  // Not tracked in testing/spell-ids.ts: this test only needs a stand-in "major cooldown" id, matched by name via cd_spell_ids.
  const TRUESHOT = 288613;
  const baseWindow = { time_s: 10, window_length_s: 20, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [] as string[], ability_breakdown: [] };
  const burstBenchFixture: BurstBench = {
    spec: 'SubtletyRogue', encounter_id: ENCOUNTER_ID, encounter_name: 'Boss', sample_count: 1,
    cd_spell_ids: {}, ability_icons: {},
    windows: [baseWindow],
  };

  const peer: BenchParse = {
    ranking: { player: 'Bo', server: 'EU', report_code: CODE_B, fight_id: FIGHT_ID },
    report: wclReport({ playerId: PLAYER_B_ID, playerName: 'Bo' }),
    fight: { id: FIGHT_ID, name: 'Boss', startTime: 0, endTime: 100_000, kill: true, encounterID: ENCOUNTER_ID, attempt: 1, duration_s: 100, friendlyPlayers: [], fightPercentage: 0 },
    player: { id: PLAYER_B_ID, name: 'Bo', subType: 'Rogue', server: 'EU' },
  };

  it('resolves the peer\'s buff presence for the bench\'s windows', async () => {
    const { service } = await readySides();
    TestBed.inject(WclApiService).getAllEvents = async () => [applyBuff(BLOODLUST, 15, { target: PLAYER_B_ID })];
    const out = await service['loadBurstPeerBuffs'](peer, burstBenchFixture);
    expect(out).toEqual([{ potion: false, powerInfusion: false, bloodlust: true, cooldowns: {} }]);
  });

  it('resolves the window\'s own recommended cooldown (by name via cd_spell_ids) too', async () => {
    const { service } = await readySides();
    const benchWithCd: BurstBench = {
      ...burstBenchFixture,
      cd_spell_ids: { Trueshot: TRUESHOT },
      windows: [{ ...baseWindow, common_cds: ['Trueshot'] }],
    };
    TestBed.inject(WclApiService).getAllEvents = async () => [applyBuff(TRUESHOT, 15, { target: PLAYER_B_ID })];
    const out = await service['loadBurstPeerBuffs'](peer, benchWithCd);
    expect(out).toEqual([{ potion: false, powerInfusion: false, bloodlust: false, cooldowns: { [TRUESHOT]: true } }]);
  });

  it('carries a cooldown recommended in only one window into every window\'s entry', async () => {
    const { service } = await readySides();
    const benchWithCd: BurstBench = {
      ...burstBenchFixture,
      cd_spell_ids: { Trueshot: TRUESHOT },
      windows: [{ ...baseWindow, common_cds: ['Trueshot'] }, { ...baseWindow, time_s: 60, common_cds: [] }],
    };
    TestBed.inject(WclApiService).getAllEvents = async () => [];
    const out = await service['loadBurstPeerBuffs'](peer, benchWithCd);
    expect(out?.[1]?.cooldowns).toEqual({ [TRUESHOT]: false });
  });

  describe('on a fetch failure', () => {
    let warnSpy: MockInstance<typeof console.warn>;
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('logs a warning and returns null instead of throwing', async () => {
      const { service } = await readySides();
      TestBed.inject(WclApiService).getAllEvents = async () => { throw new Error('WCL down'); };
      const out = await service['loadBurstPeerBuffs'](peer, burstBenchFixture);
      expect(out).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadBurstPeerBuffs'), expect.any(Error));
    });
  });
});
