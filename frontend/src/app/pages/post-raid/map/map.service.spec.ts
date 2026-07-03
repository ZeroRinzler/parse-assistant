import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclEvent, WclFight } from '../../../core/models/wcl.models';
import { EncounterPositions } from '../../../core/models/positioning.models';
import { WclApiService } from '../../../core/services/wcl-api';
import { MAP_DATA_SOURCE, MapData } from './map-data-source';
import { DataSource } from '../../../core/data-source/data-source';
import {
  MapFeatureService, buildActorTimelines, listReferenceEnemies, buildLiveOverlay, resolveLiveReference,
  FACING_OFFSET_RAD,
} from './map.service';
import { SHADOW_BLADES } from '../../../../testing/spell-ids';

function posEvent(
  fields: { ts: number; source?: number; target?: number; resourceActor?: number; x: number; y: number; facing?: number; mapID?: number },
): WclEvent {
  return {
    type: 'cast', timestamp: fields.ts, abilityGameID: 1,
    sourceID: fields.source, targetID: fields.target, resourceActor: fields.resourceActor,
    x: fields.x, y: fields.y, facing: fields.facing, mapID: fields.mapID,
  };
}

/* ----------------------------- pure functions ----------------------------- */

describe('buildActorTimelines', () => {
  it('attributes the flattened position to the source by default (resourceActor 1)', () => {
    const timelines = buildActorTimelines([posEvent({ ts: 1000, source: 7, x: 200, y: 400 })], 0);
    const tl = timelines.get(7)!;
    expect(tl.samples).toEqual([{ t: 1, x: 2, y: 4, facing: undefined, mapID: undefined }]);
  });

  it('attributes the position to the target when resourceActor is 2', () => {
    const timelines = buildActorTimelines([posEvent({ ts: 0, source: 7, target: 9, resourceActor: 2, x: 100, y: 0 })], 0);
    expect([...timelines.keys()]).toEqual([9]);
  });

  it('scales x/y to yards and facing milliradians to radians, sorted by time', () => {
    const timelines = buildActorTimelines([
      posEvent({ ts: 3000, source: 1, x: 300, y: 0, facing: 1000 }),
      posEvent({ ts: 1000, source: 1, x: 100, y: 0, facing: 2000 }),
    ], 0);
    const samples = timelines.get(1)!.samples;
    expect(samples.map(s => s.t)).toEqual([1, 3]);
    expect(samples[0]).toMatchObject({ x: 1, facing: 2 });
  });

  it('skips events without a position', () => {
    const noPos: WclEvent = { type: 'cast', timestamp: 0, abilityGameID: 1, sourceID: 5 };
    expect(buildActorTimelines([noPos], 0).size).toBe(0);
  });
});

describe('listReferenceEnemies', () => {
  const positions: EncounterPositions = {
    spec: 'X', encounter_id: 1, encounter_name: 'E', interval_s: 1.5, sample_count: 2,
    parses: [
      { report_code: 'a', fight_id: 1, player_name: 'P', duration_s: 10, interval_s: 1.5, player: [],
        enemies: [
          { game_id: 100, name: 'Boss', is_boss: true, samples: [] },
          { game_id: 200, name: 'Add', is_boss: false, samples: [] },
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
    const events = [posEvent({ ts: 0, source: 5, x: 100, y: 0 })];
    const overlay = buildLiveOverlay({ positions, events, fightStartMs: 0, playerId: 5, enemies: [{ id: 42, name: 'Boss', gameID: 100 }] });
    expect(overlay).not.toBeNull();
    expect(overlay!.bossActorId).toBe(42);
    expect(overlay!.refActorByGameId.get(100)).toBe(42);
    expect(overlay!.playerId).toBe(5);
  });

  it('returns null when the player has no position samples', () => {
    const events = [posEvent({ ts: 0, source: 99, x: 1, y: 1 })];
    expect(buildLiveOverlay({ positions, events, fightStartMs: 0, playerId: 5, enemies: [] })).toBeNull();
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

/* ----------------------------- feature service ---------------------------- */

function withData(data: MapData | null): { service: MapFeatureService; calls: [string, number][] } {
  const calls: [string, number][] = [];
  const source: DataSource<MapData> = {
    getBench: (spec, enc) => { calls.push([spec, enc]); return Promise.resolve(data); },
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
    const { service, calls } = withData(sampleData);
    const data = await service.loadBench('SubtletyRogue', 3144);
    expect(calls).toEqual([['SubtletyRogue', 3144]]);
    expect(data).toBe(sampleData);
    expect(service.positions()).toBe(sampleData);
    expect(service.ready()).toBe(true);
  });

  it('is not ready and clears live when the bench is absent', async () => {
    const { service } = withData(null);
    await service.loadBench('SubtletyRogue', 3144);
    expect(service.positions()).toBeNull();
    expect(service.live()).toBeNull();
    expect(service.ready()).toBe(false);
  });

  it('openAt sets the panel state and opens it', () => {
    const { service } = withData(sampleData);
    service.openAt({ timeS: 42, label: 'Burst', spells: [{ id: SHADOW_BLADES, icon: 'sb', name: 'Shadow Blades' }], reference: { kind: 'enemy', gameId: 200 } });
    expect(service.open()).toBe(true);
    expect(service.anchorTime()).toBe(42);
    expect(service.contextLabel()).toBe('Burst');
    expect(service.contextSpells()).toEqual([{ id: SHADOW_BLADES, icon: 'sb', name: 'Shadow Blades' }]);
    expect(service.reference()).toEqual({ kind: 'enemy', gameId: 200 });
  });

  it('openAt defaults the reference to the boss', () => {
    const { service } = withData(sampleData);
    service.openAt({ timeS: 5, label: '', spells: [] });
    expect(service.reference()).toEqual({ kind: 'boss' });
  });

  it('close hides the panel but keeps the loaded bench', async () => {
    const { service } = withData(sampleData);
    await service.loadBench('SubtletyRogue', 3144);
    service.openAt({ timeS: 1, label: '', spells: [] });
    service.close();
    expect(service.open()).toBe(false);
    expect(service.positions()).toBe(sampleData);
  });

  it('clear drops everything', async () => {
    const { service } = withData(sampleData);
    await service.loadBench('SubtletyRogue', 3144);
    service.openAt({ timeS: 1, label: '', spells: [] });
    service.clear();
    expect(service.open()).toBe(false);
    expect(service.positions()).toBeNull();
    expect(service.live()).toBeNull();
  });
});

/** One recorded getAllEvents call, reduced to the fields that decide what WCL returns. */
interface RecordedFetch { dataType: string; sourceId?: number; includeResources?: boolean; hostilityType?: string; }

/**
 * A WclApiService stub that records every `getAllEvents` call - enough to assert both WHEN the
 * deferred position-event streams are fetched (call count) and WHAT each fetch asks for
 * (dataType / source / hostility). It returns no events, so no overlay is built (the overlay
 * content itself is covered by the buildLiveOverlay tests above).
 */
class RecordingWclApi {
  readonly calls: RecordedFetch[] = [];
  get getAllEventsCalls(): number { return this.calls.length; }
  getAllEvents(
    _code: string, _fightId: number, dataType: string, _start: number, _end: number,
    sourceId?: number, includeResources?: boolean, hostilityType?: string,
  ): Promise<WclEvent[]> {
    this.calls.push({ dataType, sourceId, includeResources, hostilityType });
    return Promise.resolve([]);
  }
}

/** A minimal fight; prepare only reads id / encounterID / startTime / endTime. */
const sampleFight = { id: 1, encounterID: 3144, startTime: 0, endTime: 10_000, name: 'Test', kill: true } as WclFight;

/** This pull's player actor, whose casts are one of the two position-event streams. */
const PLAYER_ACTOR_ID = 5;

/** Drain microtasks + the macrotask queue so a fire-and-forget async load settles. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('MapFeatureService deferred overlay', () => {
  function setup(): { service: MapFeatureService; api: RecordingWclApi } {
    const api = new RecordingWclApi();
    const source: DataSource<MapData> = { getBench: () => Promise.resolve(sampleData) };
    TestBed.configureTestingModule({
      providers: [
        { provide: MAP_DATA_SOURCE, useValue: source },
        { provide: WclApiService, useValue: api as unknown as WclApiService },
      ],
    });
    return { service: TestBed.inject(MapFeatureService), api };
  }

  it('prepare loads the bench but defers the event fetch until the panel opens', async () => {
    const { service, api } = setup();
    await service.prepare('code', sampleFight, 5, 'SubtletyRogue', []);

    // Bench is loaded (so map buttons can light up) but nothing has hit the wire yet.
    expect(service.positions()).toBe(sampleData);
    expect(service.ready()).toBe(true);
    expect(service.live()).toBeNull();
    expect(api.getAllEventsCalls).toBe(0);

    service.openAt({ timeS: 1, label: '', spells: [] });
    await settle();
    expect(api.getAllEventsCalls).toBeGreaterThan(0); // opening the panel triggers the fetch
  });

  it('does not refetch the overlay when the panel is re-opened for the same pull', async () => {
    const { service, api } = setup();
    await service.prepare('code', sampleFight, 5, 'SubtletyRogue', []);

    service.openAt({ timeS: 1, label: '', spells: [] });
    await settle();
    const afterFirstOpen = api.getAllEventsCalls;
    expect(afterFirstOpen).toBeGreaterThan(0);

    service.close();
    service.openAt({ timeS: 2, label: '', spells: [] });
    await settle();
    expect(api.getAllEventsCalls).toBe(afterFirstOpen);
  });

  it('does not fetch when the map is never opened', async () => {
    const { service, api } = setup();
    await service.prepare('code', sampleFight, 5, 'SubtletyRogue', []);
    await settle();
    expect(api.getAllEventsCalls).toBe(0);
  });

  it('fetches player casts (Friendlies) + enemy casts (Enemies) on open, never DamageDone', async () => {
    const { service, api } = setup();
    await service.prepare('code', sampleFight, PLAYER_ACTOR_ID, 'SubtletyRogue', []);
    service.openAt({ timeS: 1, label: '', spells: [] });
    await settle();

    const EXPECTED_FETCH_COUNT = 2; // player casts + enemy casts, nothing else
    expect(api.calls).toHaveLength(EXPECTED_FETCH_COUNT);
    // Player casts: own source, positions on, default (Friendlies) hostility.
    expect(api.calls).toContainEqual({ dataType: 'Casts', sourceId: PLAYER_ACTOR_ID, includeResources: true, hostilityType: undefined });
    // Enemy casts: no source filter, positions on, explicit Enemies hostility (the query
    // defaults to Friendlies, so an enemy-side fetch without it returns nothing).
    expect(api.calls).toContainEqual({ dataType: 'Casts', sourceId: undefined, includeResources: true, hostilityType: 'Enemies' });
    // The boss and add trails come from those enemy casts, so nothing fetches DamageDone.
    expect(api.calls.some(call => call.dataType === 'DamageDone')).toBe(false);
  });
});
