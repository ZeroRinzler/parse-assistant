import { assert, describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclEvent } from '../../../../core/wcl/wcl.models';
import { MapTransformService, RawPosSample, EnemyMeta } from './map-transform-service';
import { MapDrawService } from '../domain/map-draw-service';
import { WclProjectionsService } from '../../../../domain/analysis/wcl-projections-service';
import { parseRankings, wclReport } from '../../../../../testing/builders/wcl-fixtures';
import { provideApiFakes } from '../../../../../testing/api-fakes';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';

const wclProjections = TestBed.inject(WclProjectionsService);
TestBed.resetTestingModule();
TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
] });
const svc = TestBed.inject(MapTransformService);
const mapDraw = TestBed.inject(MapDrawService);
TestBed.resetTestingModule();

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed: WclProjectionsService['withRelativeS'] = (events, startMs) => wclProjections.withRelativeS(events, startMs);

function resEvent(
  fields: { ts: number; source?: number; target?: number; resourceActor?: number; x: number; y: number; facing?: number; mapID?: number; maxHp?: number },
): WclEvent {
  const event: WclEvent & { maxHitPoints?: number } = {
    type: 'cast', timestamp: fields.ts, abilityGameID: 1,
    sourceID: fields.source, targetID: fields.target, resourceActor: fields.resourceActor,
    x: fields.x, y: fields.y, facing: fields.facing, mapID: fields.mapID,
  };
  if (fields.maxHp != null) event.maxHitPoints = fields.maxHp;
  return event;
}

describe('posActorId', () => {
  it.each([
    { name: 'source by default', e: { ts: 0, source: 3, x: 1, y: 1 }, expected: 3 },
    { name: 'target when resourceActor 2', e: { ts: 0, source: 3, target: 9, resourceActor: 2, x: 1, y: 1 }, expected: 9 },
    { name: 'target when resourceActor 2 without a sourceID', e: { ts: 0, target: 9, resourceActor: 2, x: 1, y: 1 }, expected: 9 },
    { name: 'null when resourceActor 2 has no targetID', e: { ts: 0, source: 3, resourceActor: 2, x: 1, y: 1 }, expected: null },
  ])('$name', ({ e, expected }) => {
    expect(mapDraw.posActorId(resEvent(e))).toBe(expected);
  });

  it('is null without a position', () => {
    expect(mapDraw.posActorId({ type: 'cast', timestamp: 0, abilityGameID: 1, sourceID: 3 })).toBeNull();
  });
});

describe('collectPositionSamples', () => {
  it('groups raw (unscaled) samples per actor and sorts by time, carrying maxHp', () => {
    const byActor = svc['collectPositionSamples'](timed([
      resEvent({ ts: 2000, source: 1, x: 200, y: 100, maxHp: 5000 }),
      resEvent({ ts: 1000, source: 1, x: 100, y: 50, facing: 1500, mapID: 7, maxHp: 5000 }),
    ], 0));
    const samples = byActor.get(1);
    assert.exists(samples);
    expect(samples.map(s => s.t)).toEqual([1, 2]);
    expect(samples[0]).toEqual({ t: 1, x: 100, y: 50, facing: 1500, mapID: 7, maxHp: 5000 });
    assert.exists(samples[1]);
    expect(samples[1].x).toBe(200);
  });
});

describe('resampleTimeline', () => {
  it('returns [] for no samples', () => {
    expect(svc['resampleTimeline']([], 10, 1.5)).toEqual([]);
  });

  it('linearly interpolates x/y within one mapID and picks the nearest facing', () => {
    const SHARED_MAP = 1;
    const samples: RawPosSample[] = [
      { t: 0, x: 0, y: 0, facing: 100, mapID: SHARED_MAP, maxHp: 0 },
      { t: 3, x: 300, y: 600, facing: 200, mapID: SHARED_MAP, maxHp: 0 },
    ];
    const rows = svc['resampleTimeline'](samples, 3, 1.5);
    expect(rows.map(r => r[0])).toEqual([0, 1.5, 3]);
    // same mapID: midpoint interpolates x to 150, y to 300; facing/mapID from the nearer (>=0.5 -> after)
    expect(rows[1]).toEqual([1.5, 150, 300, 200, SHARED_MAP]);
  });

  it('snaps to the nearest sample verbatim across a mapID change instead of blending', () => {
    const NEAR_MAP = 1;
    const FAR_MAP = 2;
    const samples: RawPosSample[] = [
      { t: 0, x: 0, y: 0, facing: 100, mapID: NEAR_MAP, maxHp: 0 },
      { t: 3, x: 300, y: 600, facing: 200, mapID: FAR_MAP, maxHp: 0 },
    ];
    const rows = svc['resampleTimeline'](samples, 3, 1.5);
    expect(rows.map(r => r[0])).toEqual([0, 1.5, 3]);
    // mapIDs differ: the midpoint (fraction 0.5 -> after) emits the far sample's own x/y/facing, never the blend (150, 300)
    expect(rows[1]).toEqual([1.5, 300, 600, 200, FAR_MAP]);
  });

  it('snaps a cadence point nearer the far-side sample to that sample across a mapID change', () => {
    const NEAR_MAP = 1;
    const FAR_MAP = 2;
    const FAR_X = 400;
    const FAR_Y = 800;
    const FAR_FACING = 250;
    const samples: RawPosSample[] = [
      { t: 0, x: 0, y: 0, facing: 100, mapID: NEAR_MAP, maxHp: 0 },
      { t: 4, x: FAR_X, y: FAR_Y, facing: FAR_FACING, mapID: FAR_MAP, maxHp: 0 },
    ];
    const rows = svc['resampleTimeline'](samples, 4, 1.5);
    // t=3 sits 3/4 toward the far sample (fraction 0.75 -> after): snap emits its verbatim x/y/facing/mapID, not the blend (300, 600)
    expect(rows.find(r => r[0] === 3)).toEqual([3, FAR_X, FAR_Y, FAR_FACING, FAR_MAP]);
  });

  it('snaps a cadence point nearer the near-side sample to that sample across a mapID change', () => {
    const NEAR_MAP = 1;
    const FAR_MAP = 2;
    const NEAR_X = 0;
    const NEAR_Y = 0;
    const NEAR_FACING = 100;
    const samples: RawPosSample[] = [
      { t: 0, x: NEAR_X, y: NEAR_Y, facing: NEAR_FACING, mapID: NEAR_MAP, maxHp: 0 },
      { t: 4, x: 400, y: 800, facing: 250, mapID: FAR_MAP, maxHp: 0 },
    ];
    const rows = svc['resampleTimeline'](samples, 4, 1.5);
    // t=1.5 sits 3/8 toward the far sample (fraction < 0.5 -> before): snap emits the near sample's verbatim x/y, not the blend (150, 300)
    expect(rows.find(r => r[0] === 1.5)).toEqual([1.5, NEAR_X, NEAR_Y, NEAR_FACING, NEAR_MAP]);
  });

  it('rounds coordinates and keeps null facing', () => {
    const rows = svc['resampleTimeline']([{ t: 0, x: 12.6, y: -3.4, facing: null, mapID: null, maxHp: 0 }], 0, 1.5);
    expect(rows).toEqual([[0, 13, -3, null, null]]);
  });
});

describe('resamplePlayerTimeline', () => {
  it('returns [] for no samples', () => {
    expect(svc['resamplePlayerTimeline']([], 10, 1.5)).toEqual([]);
  });

  it('emits [t, x, y, mapID] rows with no facing element, lerping within one mapID', () => {
    const SHARED_MAP = 1;
    const samples: RawPosSample[] = [
      { t: 0, x: 0, y: 0, facing: 100, mapID: SHARED_MAP, maxHp: 0 },
      { t: 3, x: 300, y: 600, facing: 200, mapID: SHARED_MAP, maxHp: 0 },
    ];
    const rows = svc['resamplePlayerTimeline'](samples, 3, 1.5);
    expect(rows.map(r => r[0])).toEqual([0, 1.5, 3]);
    // same mapID: midpoint interpolates x to 150, y to 300; the sampled facing is dropped from the row
    expect(rows[1]).toEqual([1.5, 150, 300, SHARED_MAP]);
  });

  it('snaps to the nearest sample across a mapID change, like the enemy resample', () => {
    const NEAR_MAP = 1;
    const FAR_MAP = 2;
    const samples: RawPosSample[] = [
      { t: 0, x: 0, y: 0, facing: 100, mapID: NEAR_MAP, maxHp: 0 },
      { t: 3, x: 300, y: 600, facing: 200, mapID: FAR_MAP, maxHp: 0 },
    ];
    const rows = svc['resamplePlayerTimeline'](samples, 3, 1.5);
    // mapIDs differ: the midpoint (fraction 0.5 -> after) emits the far sample's own x/y, never the blend (150, 300)
    expect(rows[1]).toEqual([1.5, 300, 600, FAR_MAP]);
  });
});

describe('selectBossAndEnemies', () => {
  // Mirrors the module-private MAX_TRACKED_ENEMIES (kept enemy cap, boss excepted).
  const MAX_TRACKED_ENEMIES = 5;
  const PLAYER_ID = 1;
  const BOSS_ID = 10;

  function sample(maxHp: number): RawPosSample {
    return { t: 0, x: 0, y: 0, facing: null, mapID: null, maxHp };
  }

  function actorMap(entries: [number, number, number][]): Map<number, RawPosSample[]> {
    const byActor = new Map<number, RawPosSample[]>();
    for (const [actorId, count, maxHp] of entries) {
      byActor.set(actorId, Array.from({ length: count }, () => sample(maxHp)));
    }
    return byActor;
  }

  function meta(actorIds: number[]): Map<number, EnemyMeta> {
    return new Map(actorIds.map(actorId => [actorId, { gameID: actorId * 10, name: `actor-${actorId}` }]));
  }

  it('picks the boss by highest observed maxHp, ignoring sample count', () => {
    const LOW_HP = 1000;
    const HIGH_HP = 9000;
    // The add has more samples, but the boss out-HPs it.
    const byActor = actorMap([[BOSS_ID, 2, HIGH_HP], [11, 8, LOW_HP]]);
    const { bossId, kept } = svc['selectBossAndEnemies'](byActor, PLAYER_ID, meta([BOSS_ID, 11]));
    expect(bossId).toBe(BOSS_ID);
    expect(kept.map(enemy => enemy.actorId).sort((a, b) => a - b)).toEqual([BOSS_ID, 11]);
  });

  it('excludes the player and unknown (non-enemy) actors', () => {
    const HP = 5000;
    const byActor = actorMap([[PLAYER_ID, 9, HP], [BOSS_ID, 3, HP], [99, 3, HP]]);
    // 99 has no meta entry, so it is not an enemy candidate.
    const { kept } = svc['selectBossAndEnemies'](byActor, PLAYER_ID, meta([BOSS_ID]));
    expect(kept.map(enemy => enemy.actorId)).toEqual([BOSS_ID]);
  });

  it('caps the kept set at MAX_TRACKED_ENEMIES, keeping the most-sampled', () => {
    const BASE_HP = 1000;
    // Two past the cap so it truncates a NON-boss (id 16) here, not just the boss (id 20, fewest samples, max HP).
    const BOSS_OF_MANY = 20;
    const CAPPED_OUT_ADD = 16;
    const entries: [number, number, number][] = [
      [11, 60, BASE_HP], [12, 50, BASE_HP], [13, 40, BASE_HP],
      [14, 30, BASE_HP], [15, 20, BASE_HP], [CAPPED_OUT_ADD, 15, BASE_HP], [BOSS_OF_MANY, 10, BASE_HP + 1],
    ];
    const enemyIds = entries.map(([actorId]) => actorId);
    const { bossId, kept } = svc['selectBossAndEnemies'](actorMap(entries), PLAYER_ID, meta(enemyIds));
    expect(bossId).toBe(BOSS_OF_MANY);
    // The cap takes the 5 most-sampled (11..15); the boss is appended past the cap; the extra add is dropped.
    expect(kept).toHaveLength(MAX_TRACKED_ENEMIES + 1);
    expect(kept.some(enemy => enemy.actorId === BOSS_OF_MANY)).toBe(true);
    expect(kept.some(enemy => enemy.actorId === 15)).toBe(true);
    expect(kept.some(enemy => enemy.actorId === CAPPED_OUT_ADD)).toBe(false);
  });

  it('drops the lowest-sampled enemy when over the cap and it is not the boss', () => {
    const BASE_HP = 1000;
    const BOSS_HP = 9000;
    const LOW_SAMPLE_ADD = 16;
    const entries: [number, number, number][] = [
      [BOSS_ID, 60, BOSS_HP], [11, 50, BASE_HP], [12, 40, BASE_HP],
      [13, 30, BASE_HP], [14, 20, BASE_HP], [LOW_SAMPLE_ADD, 5, BASE_HP],
    ];
    const enemyIds = entries.map(([actorId]) => actorId);
    const { kept } = svc['selectBossAndEnemies'](actorMap(entries), PLAYER_ID, meta(enemyIds));
    expect(kept).toHaveLength(MAX_TRACKED_ENEMIES);
    expect(kept.some(enemy => enemy.actorId === LOW_SAMPLE_ADD)).toBe(false);
  });

  it('returns no boss when there are no enemy candidates', () => {
    const { bossId, kept } = svc['selectBossAndEnemies'](actorMap([[PLAYER_ID, 5, 5000]]), PLAYER_ID, meta([]));
    expect(bossId).toBeNull();
    expect(kept).toEqual([]);
  });
});

describe('buildParsePositions', () => {
  const enemyMeta = new Map<number, EnemyMeta>([
    [10, { gameID: 100, name: 'Boss' }],
    [11, { gameID: 200, name: 'Add' }],
  ]);

  it('emits the player timeline and picks the boss by highest maxHp', () => {
    // duration 6s, interval 1.5 -> rows resample at t = 0, 1.5, 3, 4.5, 6, clearing the MIN_ENEMY_SAMPLES (4) resampled-row gate.
    const PLAYER_FACING = 1500; // sampled on the wire, but player rows store no facing
    const events: WclEvent[] = [
      // player (id 5), not in enemyMeta
      resEvent({ ts: 0, source: 5, x: 0, y: 0, facing: PLAYER_FACING }),
      resEvent({ ts: 6000, source: 5, x: 150, y: 0, facing: PLAYER_FACING }),
      // boss (id 10) high HP
      resEvent({ ts: 0, source: 10, x: 0, y: 0, maxHp: 9000 }),
      resEvent({ ts: 6000, source: 10, x: 10, y: 0, maxHp: 9000 }),
      // add (id 11) lower HP, spans the fight so it keeps >= 4 resampled rows
      resEvent({ ts: 0, source: 11, x: 500, y: 0, maxHp: 1000 }),
      resEvent({ ts: 2000, source: 11, x: 500, y: 0, maxHp: 1000 }),
      resEvent({ ts: 4000, source: 11, x: 500, y: 0, maxHp: 1000 }),
      resEvent({ ts: 6000, source: 11, x: 500, y: 0, maxHp: 1000 }),
    ];
    const parse = svc['buildParsePositions']({
      reportCode: 'rep', fightId: 1, playerName: 'Me', playerId: 5,
      enemyMetaById: enemyMeta, posEvents: timed(events, 0), durationS: 6,
    });
    expect(parse.report_code).toBe('rep');
    expect(parse.player_name).toBe('Me');
    const RESAMPLE_CADENCE_S = 1.5; // the ingest position cadence, pinned independently of the SUT constant
    expect(parse.interval_s).toBe(RESAMPLE_CADENCE_S);
    // player samples span 0..6s, so they resample onto the 1.5s grid: 0, 1.5, 3, 4.5, 6.
    expect(parse.player.map(row => row[0])).toEqual([0, 1.5, 3, 4.5, 6]);
    // player rows are [t, x, y, mapID]; enemy rows keep facing at index 3
    parse.player.forEach(row => { expect(row.length).toBe(4); });
    parse.enemies.forEach(enemy => { enemy.samples.forEach(row => { expect(row.length).toBe(5); }); });
    const boss = parse.enemies.find(e => e.is_boss);
    expect(boss?.game_id).toBe(100);
    expect(parse.enemies.some(e => e.game_id === 200 && !e.is_boss)).toBe(true);
  });

  it('drops a non-boss enemy with too few samples', () => {
    const events: WclEvent[] = [
      resEvent({ ts: 0, source: 5, x: 0, y: 0 }),
      resEvent({ ts: 0, source: 10, x: 0, y: 0, maxHp: 9000 }),
      resEvent({ ts: 1500, source: 10, x: 0, y: 0, maxHp: 9000 }),
      // add: only 1 sample -> below MIN_ENEMY_SAMPLES
      resEvent({ ts: 0, source: 11, x: 9, y: 9, maxHp: 1000 }),
    ];
    const parse = svc['buildParsePositions']({
      reportCode: 'rep', fightId: 1, playerName: 'Me', playerId: 5,
      enemyMetaById: enemyMeta, posEvents: timed(events, 0), durationS: 1.5,
    });
    expect(parse.enemies.some(e => e.game_id === 200)).toBe(false);
    expect(parse.enemies.some(e => e.is_boss)).toBe(true);
  });
});

/** One recorded getAllEvents call, reduced to the fields that decide what WCL returns. */
interface RecordedFetch { dataType: string; sourceId?: number; includeResources?: boolean; hostilityType?: string; }

describe('MapTransformService.getBench', () => {
  const SPEC = 'SubtletyRogue';
  const ENCOUNTER_ID = 3144;
  const FIGHT_ID = 1;
  const SIX_SEC_MS = 6000;                 // short fight span [0, endTime)
  const PLAYER_ACTOR_ID = 5;
  const BOSS_ACTOR_ID = 10;
  const BOSS_GAME_ID = 100;
  const EXPECTED_FETCH_COUNT = 2;          // player casts + enemy casts, nothing else

  const report = wclReport({
    playerId: PLAYER_ACTOR_ID, fightId: FIGHT_ID, endTimeMs: SIX_SEC_MS, encounterId: ENCOUNTER_ID,
    enemies: [{ id: BOSS_ACTOR_ID, name: 'Boss', gameID: BOSS_GAME_ID }],
  });

  /** `onFetch` records each position-event fetch so the fetch-shape assertion still sees every call. */
  function serviceWith(over: { onFetch?: (call: RecordedFetch) => void } = {}): MapTransformService {
    const wclFake = {
      getRankings: async () => ({ rankings: parseRankings(1) }),
      getReport: async () => report,
      getAllEvents: async (
        _code: string, _fightId: number, dataType: string, _start: number, _end: number,
        sourceId?: number, includeResources?: boolean, hostilityType?: string,
      ): Promise<WclEvent[]> => {
        over.onFetch?.({ dataType, sourceId, includeResources, hostilityType });
        return [];
      },
    };
    TestBed.configureTestingModule({ providers: provideApiFakes({ wcl: wclFake }) });
    return TestBed.inject(MapTransformService);
  }

  it('fetches player casts (Friendlies) + enemy casts (Enemies), never DamageDone, and returns ok', async () => {
    const calls: RecordedFetch[] = [];
    const result = await serviceWith({ onFetch: call => calls.push(call) }).getBench(SPEC, ENCOUNTER_ID);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(EXPECTED_FETCH_COUNT);
    expect(calls).toContainEqual({ dataType: 'Casts', sourceId: PLAYER_ACTOR_ID, includeResources: true, hostilityType: undefined });
    expect(calls).toContainEqual({ dataType: 'Casts', sourceId: undefined, includeResources: true, hostilityType: 'Enemies' });
    expect(calls.some(call => call.dataType === 'DamageDone')).toBe(false);
  });
});
