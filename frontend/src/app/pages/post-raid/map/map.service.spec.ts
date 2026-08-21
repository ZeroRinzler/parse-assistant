import { assert, describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclEvent, WclFight } from '../../../core/models/wcl.models';
import { EncounterPositions } from '../../../core/models/positioning.models';
import { Result, ok, missing, transient } from '../../../core/result';
import { MAP_DATA_SOURCE, MapData } from './map-data-source';
import { DataSource } from '../../../core/data-source/data-source';
import { sliceService } from '../../../../testing/service-harness';
import {
  MapFeatureService, buildActorTimelines, listReferenceEnemies, buildLiveOverlay, resolveLiveReference,
  FACING_OFFSET_RAD,
} from './map.service';
import { withRelativeS } from '../../../shared/analysis/wcl-projections';
import { whenStable } from '../../../../testing/when-stable';

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed = withRelativeS;

function posEvent(
  fields: { ts: number; source?: number; target?: number; resourceActor?: number; x: number; y: number; facing?: number; mapID?: number },
): WclEvent {
  return {
    type: 'cast', timestamp: fields.ts, abilityGameID: 1,
    sourceID: fields.source, targetID: fields.target, resourceActor: fields.resourceActor,
    x: fields.x, y: fields.y, facing: fields.facing, mapID: fields.mapID,
  };
}

describe('buildActorTimelines', () => {
  it('attributes the flattened position to the source by default (resourceActor 1)', () => {
    const timelines = buildActorTimelines(timed([posEvent({ ts: 1000, source: 7, x: 200, y: 400 })], 0));
    const tl = timelines.get(7);
    assert.exists(tl);
    expect(tl.samples).toEqual([{ t: 1, x: 2, y: 4, facing: undefined, mapID: undefined }]);
  });

  it('attributes the position to the target when resourceActor is 2', () => {
    const timelines = buildActorTimelines(timed([posEvent({ ts: 0, source: 7, target: 9, resourceActor: 2, x: 100, y: 0 })], 0));
    expect([...timelines.keys()]).toEqual([9]);
  });

  it('scales x/y to yards and facing milliradians to radians, sorted by time', () => {
    const timelines = buildActorTimelines(timed([
      posEvent({ ts: 3000, source: 1, x: 300, y: 0, facing: 1000 }),
      posEvent({ ts: 1000, source: 1, x: 100, y: 0, facing: 2000 }),
    ], 0));
    const playerTimeline = timelines.get(1);
    assert.exists(playerTimeline);
    const samples = playerTimeline.samples;
    expect(samples.map(s => s.t)).toEqual([1, 3]);
    expect(samples[0]).toMatchObject({ x: 1, facing: 2 });
  });

  it('skips events without a position', () => {
    const noPos: WclEvent = { type: 'cast', timestamp: 0, abilityGameID: 1, sourceID: 5 };
    expect(buildActorTimelines(timed([noPos], 0)).size).toBe(0);
  });
});

describe('listReferenceEnemies', () => {
  const positions: EncounterPositions = {
    spec: 'X', encounter_id: 1, encounter_name: 'E', interval_s: 1.5, sample_count: 2,
    parses: [
      { report_code: 'a', fight_id: 1, player_name: 'P', duration_s: 10, interval_s: 1.5, player: [],
        // Add listed before Boss so insertion order is not already boss-first: the sort must do real work.
        enemies: [
          { game_id: 200, name: 'Add', is_boss: false, samples: [] },
          { game_id: 100, name: 'Boss', is_boss: true, samples: [] },
        ] },
      { report_code: 'b', fight_id: 2, player_name: 'Q', duration_s: 10, interval_s: 1.5, player: [],
        enemies: [{ game_id: 200, name: 'Add', is_boss: false, samples: [] }] },
    ],
  };

  it('dedupes enemies by gameId and sorts the boss first', () => {
    expect(listReferenceEnemies(positions)).toEqual([
      { gameId: 100, name: 'Boss', isBoss: true },
      { gameId: 200, name: 'Add', isBoss: false },
    ]);
  });

  it('promotes isBoss when any parse marks the gameId as boss', () => {
    assert.exists(positions.parses[0]);
    assert.exists(positions.parses[1]);
    const mixed: EncounterPositions = {
      ...positions,
      parses: [
        { ...positions.parses[0], enemies: [{ game_id: 200, name: 'Add', is_boss: false, samples: [] }] },
        { ...positions.parses[1], enemies: [{ game_id: 200, name: 'Add', is_boss: true, samples: [] }] },
      ],
    };
    expect(listReferenceEnemies(mixed)).toEqual([{ gameId: 200, name: 'Add', isBoss: true }]);
  });
});

describe('buildLiveOverlay', () => {
  const positions: EncounterPositions = {
    spec: 'X', encounter_id: 1, encounter_name: 'E', interval_s: 1.5, sample_count: 1,
    parses: [{ report_code: 'a', fight_id: 1, player_name: 'P', duration_s: 10, interval_s: 1.5, player: [],
      enemies: [{ game_id: 100, name: 'Boss', is_boss: true, samples: [] }] }],
  };

  it('maps the ingested boss gameId to the live actor id and keys enemies by gameId', () => {
    const events = timed([posEvent({ ts: 0, source: 5, x: 100, y: 0 })], 0);
    const overlay = buildLiveOverlay({ positions, events, playerId: 5, enemies: [{ id: 42, name: 'Boss', gameID: 100 }] });
    expect(overlay).not.toBeNull();
    assert.exists(overlay);
    expect(overlay.bossActorId).toBe(42);
    assert.exists(overlay);
    expect(overlay.refActorByGameId.get(100)).toBe(42);
    assert.exists(overlay);
    expect(overlay.playerId).toBe(5);
  });

  it('returns null when the player has no position samples', () => {
    const events = timed([posEvent({ ts: 0, source: 99, x: 1, y: 1 })], 0);
    expect(buildLiveOverlay({ positions, events, playerId: 5, enemies: [] })).toBeNull();
  });
});

describe('resolveLiveReference', () => {
  const positions: EncounterPositions = {
    spec: 'X', encounter_id: 1, encounter_name: 'E', interval_s: 1.5, sample_count: 1,
    parses: [{ report_code: 'a', fight_id: 1, player_name: 'P', duration_s: 10, interval_s: 1.5, player: [],
      enemies: [
        { game_id: 100, name: 'Boss', is_boss: true, samples: [] },
        { game_id: 200, name: 'Add', is_boss: false, samples: [] },
      ] }],
  };

  it('maps the ingested boss gameId to this pull boss actor and keys all enemies by gameId', () => {
    const ref = resolveLiveReference(positions, [{ id: 42, name: 'Boss', gameID: 100 }, { id: 7, name: 'Add', gameID: 200 }]);
    expect(ref.bossActorId).toBe(42);
    expect(ref.refActorByGameId.get(100)).toBe(42);
    expect(ref.refActorByGameId.get(200)).toBe(7);
  });

  it('has a null boss actor when the live pull has no matching boss gameId', () => {
    const ref = resolveLiveReference(positions, [{ id: 7, name: 'Add', gameID: 200 }]);
    expect(ref.bossActorId).toBeNull();
    expect(ref.refActorByGameId.get(200)).toBe(7);
  });
});

describe('FACING_OFFSET_RAD', () => {
  it('is a -90 degree offset', () => {
    expect(FACING_OFFSET_RAD).toBeCloseTo(-Math.PI / 2, 10);
  });
});

function withResult(result: Result<MapData>): { service: MapFeatureService; calls: [string, number][] } {
  const calls: [string, number][] = [];
  const source: DataSource<MapData> = {
    getBench: (spec, enc) => { calls.push([spec, enc]); return Promise.resolve(result); },
  };
  TestBed.configureTestingModule({ providers: [{ provide: MAP_DATA_SOURCE, useValue: source }] });
  return { service: TestBed.inject(MapFeatureService), calls };
}

const sampleData: EncounterPositions = {
  spec: 'SubtletyRogue', encounter_id: 3144, encounter_name: 'Test', interval_s: 1.5, sample_count: 1,
  parses: [{ report_code: 'a', fight_id: 1, player_name: 'P', duration_s: 10, interval_s: 1.5, player: [],
    enemies: [{ game_id: 100, name: 'Boss', is_boss: true, samples: [] }] }],
};

describe('MapFeatureService', () => {
  it('loads the bench through the data source and exposes it as a signal', async () => {
    const { service, calls } = withResult(ok(sampleData));
    const result = await service.loadBench('SubtletyRogue', 3144);
    expect(calls).toEqual([['SubtletyRogue', 3144]]);
    expect(result).toEqual(ok(sampleData));
    expect(service.positions()).toBe(sampleData);
    expect(service.error()).toBeNull();
    expect(service.ready()).toBe(true);
  });

  it('is not ready and stays error-free when the bench is missing', async () => {
    const { service } = withResult(missing('Not yet ingested.'));
    await service.loadBench('SubtletyRogue', 3144);
    expect(service.positions()).toBeNull();
    expect(service.live()).toBeNull();
    expect(service.ready()).toBe(false);
    // A missing bench drives the empty placeholder, so it never surfaces as an error.
    expect(service.error()).toBeNull();
  });

  it('surfaces a transient bench failure as an error rather than a silent empty map', async () => {
    const outage = transient('WCL is unreachable right now.');
    const { service } = withResult(outage);
    const result = await service.loadBench('SubtletyRogue', 3144);
    expect(result).toEqual(outage);
    expect(service.positions()).toBeNull();
    expect(service.ready()).toBe(false);
    if (!outage.ok) expect(service.error()).toEqual(outage.error);
  });

  it('openAt sets the panel state and opens it', () => {
    const { service } = withResult(ok(sampleData));
    service.openAt({ timeS: 42, reference: { kind: 'enemy', gameId: 200 } });
    expect(service.open()).toBe(true);
    expect(service.anchorTime()).toBe(42);
    expect(service.reference()).toEqual({ kind: 'enemy', gameId: 200 });
  });

  it('openAt defaults the reference to the boss', () => {
    const { service } = withResult(ok(sampleData));
    service.openAt({ timeS: 5 });
    expect(service.reference()).toEqual({ kind: 'boss' });
  });

  it('close hides the panel but keeps the loaded bench', async () => {
    const { service } = withResult(ok(sampleData));
    await service.loadBench('SubtletyRogue', 3144);
    service.openAt({ timeS: 1 });
    service.close();
    expect(service.open()).toBe(false);
    expect(service.positions()).toBe(sampleData);
  });

  it('clear drops everything', async () => {
    const { service } = withResult(ok(sampleData));
    await service.loadBench('SubtletyRogue', 3144);
    service.openAt({ timeS: 1 });
    service.clear();
    expect(service.open()).toBe(false);
    expect(service.positions()).toBeNull();
    expect(service.live()).toBeNull();
    expect(service.error()).toBeNull();
  });
});

interface RecordedFetch { dataType: string; sourceId?: number; includeResources?: boolean; hostilityType?: string; }

// Resolving in one turn would let a wait pass here that a real fetch (transport, interceptor, parse) would not.
const FETCH_TURNS = 20;

/** Returns no events, so no overlay is built (overlay content is covered above). */
class RecordingWclApi {
  readonly calls: RecordedFetch[] = [];
  get getAllEventsCalls(): number { return this.calls.length; }
  getAllEvents(
    _code: string, _fightId: number, dataType: string, _start: number, _end: number,
    sourceId?: number, includeResources?: boolean, hostilityType?: string,
  ): Promise<WclEvent[]> {
    this.calls.push({ dataType, sourceId, includeResources, hostilityType });
    let settling = Promise.resolve<WclEvent[]>([]);
    for (let turn = 0; turn < FETCH_TURNS; turn++) settling = settling.then(events => events);
    return settling;
  }
}

/** A minimal fight; prepare only reads id / encounterID / startTime / endTime. */
const sampleFight = { id: 1, encounterID: 3144, startTime: 0, endTime: 10_000, name: 'Test', kill: true } as WclFight;

const PLAYER_ACTOR_ID = 5;


describe('MapFeatureService deferred overlay', () => {
  function setup(): { service: MapFeatureService; api: RecordingWclApi } {
    const api = new RecordingWclApi();
    return { service: sliceService(MAP_DATA_SOURCE, MapFeatureService, ok(sampleData), api), api };
  }

  it('prepare loads the bench but defers the event fetch until the panel opens', async () => {
    const { service, api } = setup();
    await service.prepare('code', sampleFight, 5, 'SubtletyRogue', []);

    // Bench is loaded (so map buttons can light up) but nothing has hit the wire yet.
    expect(service.positions()).toBe(sampleData);
    expect(service.ready()).toBe(true);
    expect(service.live()).toBeNull();
    expect(api.getAllEventsCalls).toBe(0);

    service.openAt({ timeS: 1 });
    await whenStable();
    expect(api.getAllEventsCalls).toBeGreaterThan(0); // opening the panel triggers the fetch
  });

  it('does not refetch the overlay when the panel is re-opened for the same pull', async () => {
    const { service, api } = setup();
    await service.prepare('code', sampleFight, 5, 'SubtletyRogue', []);

    service.openAt({ timeS: 1 });
    await whenStable();
    const afterFirstOpen = api.getAllEventsCalls;
    expect(afterFirstOpen).toBeGreaterThan(0);

    service.close();
    service.openAt({ timeS: 2 });
    await whenStable();
    expect(api.getAllEventsCalls).toBe(afterFirstOpen);
  });

  it('does not fetch when the map is never opened', async () => {
    const { service, api } = setup();
    await service.prepare('code', sampleFight, 5, 'SubtletyRogue', []);
    await whenStable();
    expect(api.getAllEventsCalls).toBe(0);
  });

  it('fetches player casts (Friendlies) + enemy casts (Enemies) on open, never DamageDone', async () => {
    const { service, api } = setup();
    await service.prepare('code', sampleFight, PLAYER_ACTOR_ID, 'SubtletyRogue', []);
    service.openAt({ timeS: 1 });
    await whenStable();

    const EXPECTED_FETCH_COUNT = 2; // player casts + enemy casts, nothing else
    expect(api.calls).toHaveLength(EXPECTED_FETCH_COUNT);
    // Player casts: own source, positions on, default (Friendlies) hostility.
    expect(api.calls).toContainEqual({ dataType: 'Casts', sourceId: PLAYER_ACTOR_ID, includeResources: true, hostilityType: undefined });
    // Enemy casts: explicit Enemies hostility, since the query defaults to Friendlies.
    expect(api.calls).toContainEqual({ dataType: 'Casts', sourceId: undefined, includeResources: true, hostilityType: 'Enemies' });
    // The boss and add trails come from those enemy casts, so nothing fetches DamageDone.
    expect(api.calls.some(call => call.dataType === 'DamageDone')).toBe(false);
  });

  it('surfaces a permanent error when the loaded overlay has no player position samples', async () => {
    const NO_POSITIONS_ID = 'map.no-player-positions'; // repro id the no-samples permanent carries
    const { service } = setup(); // RecordingWclApi returns [] events, so the player has no samples
    await service.prepare('code', sampleFight, PLAYER_ACTOR_ID, 'SubtletyRogue', []);
    service.openAt({ timeS: 1 });
    await whenStable();

    // The overlay loaded but yielded no "you" trail: surfaced as a failure, not a silent bench-only map.
    expect(service.live()).toBeNull();
    expect(service.overlayLoading()).toBe(false);
    const error = service.error();
    expect(error?.kind).toBe('permanent');
    if (error?.kind === 'permanent') expect(error.id).toBe(NO_POSITIONS_ID);
  });

  it('drops a stale bench load so a rapid selection switch keeps the latest positions', async () => {
    const STALE_ENCOUNTER = 111;
    const LATEST_ENCOUNTER = 222;
    const staleData: EncounterPositions = { ...sampleData, encounter_id: STALE_ENCOUNTER };
    const latestData: EncounterPositions = { ...sampleData, encounter_id: LATEST_ENCOUNTER };
    const stale: { resolve?: () => void } = {};
    const source: DataSource<MapData> = {
      getBench: (_spec, enc) => enc === STALE_ENCOUNTER
        ? new Promise<Result<MapData>>(res => { stale.resolve = () => { res(ok(staleData)); }; })
        : Promise.resolve(ok(latestData)),
    };
    TestBed.configureTestingModule({ providers: [{ provide: MAP_DATA_SOURCE, useValue: source }] });
    const service = TestBed.inject(MapFeatureService);
    const staleFight = { ...sampleFight, encounterID: STALE_ENCOUNTER };
    const latestFight = { ...sampleFight, encounterID: LATEST_ENCOUNTER };

    const stalePrepare = service.prepare('code', staleFight, 5, 'SubtletyRogue', []); // bench never resolves yet
    await service.prepare('code', latestFight, 5, 'SubtletyRogue', []); // supersedes, resolves now
    expect(service.positions()).toBe(latestData);

    assert.exists(stale.resolve);
    stale.resolve(); // the earlier selection finally resolves, out of order
    await stalePrepare;
    // The stale bench does not overwrite the current selection.
    expect(service.positions()).toBe(latestData);
  });

  it('surfaces a failed overlay fetch as an error rather than a silent empty map', async () => {
    const OVERLAY_ERROR_ID = 'map.overlay'; // repro id a permanent overlay failure carries
    const throwingApi = {
      getAllEvents: () => Promise.reject(new Error('overlay boom')),
    };
    const service = sliceService(MAP_DATA_SOURCE, MapFeatureService, ok(sampleData), throwingApi);
    await service.prepare('code', sampleFight, PLAYER_ACTOR_ID, 'SubtletyRogue', []);
    service.openAt({ timeS: 1 });
    await whenStable();

    // The bench loaded fine, but the player's own trail fetch failed: no live overlay, spinner clears, failure surfaces.
    expect(service.live()).toBeNull();
    expect(service.overlayLoading()).toBe(false);
    const error = service.error();
    expect(error?.kind).toBe('permanent');
    if (error?.kind === 'permanent') expect(error.id).toBe(OVERLAY_ERROR_ID);
  });
});
