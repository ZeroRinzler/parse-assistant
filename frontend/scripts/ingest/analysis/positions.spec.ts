import { describe, it, expect } from 'vitest';
import { posActorId, pickBossActorId, collectPositionSamples, resampleTimeline, buildParsePositions } from './positions.ts';
import { Events, PLAYER, BOSS } from '../testing/events.ts';
import { FIGHT_START } from '../testing/clock.ts';
import type { WclActorEntry, WclResourceEvent } from '../models/wcl.models.ts';

describe('posActorId', () => {
  it('returns null when the event carries no coordinates', () => {
    expect(posActorId({ type: 'cast', timestamp: 0, sourceID: 1 })).toBeNull();
  });

  it('attributes coords to the source by default and the target when resourceActor is 2', () => {
    expect(posActorId({ type: 'cast', timestamp: 0, x: 1, y: 2, sourceID: 7 })).toBe(7);
    expect(posActorId({ type: 'cast', timestamp: 0, x: 1, y: 2, resourceActor: 2, targetID: 9 })).toBe(9);
  });
});

describe('pickBossActorId', () => {
  it('returns the NPC actor with the highest maxHitPoints', () => {
    const events = Events.start()
      .position(BOSS, '0:01', 0, 0, { maxHp: 100 })
      .position(3, '0:01', 0, 0, { maxHp: 5000 })
      .build();
    const npcById = new Map<number, WclActorEntry>([
      [BOSS, { id: BOSS, name: 'Add', type: 'NPC' }],
      [3, { id: 3, name: 'Boss', type: 'NPC' }],
    ]);
    expect(pickBossActorId(events, npcById)).toBe(3);
  });

  it('ignores actors that are not in npcById (e.g. the player)', () => {
    const events = Events.start().position(PLAYER, '0:01', 0, 0, { maxHp: 9999 }).build();
    expect(pickBossActorId(events, new Map())).toBeNull();
  });
});

describe('collectPositionSamples', () => {
  it('groups samples per actor and sorts each by time', () => {
    const events = Events.start()
      .position(PLAYER, '0:02', 20, 0)
      .position(PLAYER, '0:00', 0, 0)
      .build();
    const byActor = collectPositionSamples(events, FIGHT_START);
    expect(byActor.get(PLAYER)!.map(s => s.t)).toEqual([0, 2]);
  });
});

describe('resampleTimeline', () => {
  it('linearly interpolates x/y onto the fixed cadence', () => {
    const samples = collectPositionSamples(
      Events.start().position(PLAYER, '0:00', 0, 0).position(PLAYER, '0:02', 20, 0).build(),
      FIGHT_START,
    ).get(PLAYER)!;
    const rows = resampleTimeline(samples, 2, 1);
    // rows are [t, x, y, facing, mapID]; x interpolates 0 -> 20 over 2s
    expect(rows.map(r => [r[0], r[1]])).toEqual([[0, 0], [1, 10], [2, 20]]);
  });

  it('returns [] for no samples', () => {
    expect(resampleTimeline([], 10, 1)).toEqual([]);
  });
});

describe('buildParsePositions', () => {
  it('keeps the boss and drops low-sample non-boss enemies', () => {
    const posEvents: WclResourceEvent[] = Events.start()
      // player: 3 samples
      .position(PLAYER, 0, 0, 0).position(PLAYER, 1.5, 10, 0).position(PLAYER, 3, 20, 0)
      // boss (actor 2): 4 samples, high HP
      .position(BOSS, 0, 5, 5, { maxHp: 1000 }).position(BOSS, 1.5, 5, 5, { maxHp: 1000 })
      .position(BOSS, 3, 5, 5, { maxHp: 1000 }).position(BOSS, 4.5, 5, 5, { maxHp: 1000 })
      // add (actor 3): only 2 samples, low HP -> filtered out
      .position(3, 0, 9, 9, { maxHp: 100 }).position(3, 1.5, 9, 9, { maxHp: 100 })
      .build();
    const npcById = new Map<number, WclActorEntry>([
      [BOSS, { id: BOSS, name: 'Boss', type: 'NPC', gameID: 5000 }],
      [3, { id: 3, name: 'Add', type: 'NPC', gameID: 6000 }],
    ]);

    const positions = buildParsePositions('rep', 1, 'Tester', PLAYER, npcById, posEvents, FIGHT_START, 4.5);

    expect(positions.report_code).toBe('rep');
    expect(positions.player.length).toBeGreaterThan(0);
    expect(positions.enemies).toHaveLength(1);
    expect(positions.enemies[0]).toMatchObject({ game_id: 5000, is_boss: true });
  });
});
