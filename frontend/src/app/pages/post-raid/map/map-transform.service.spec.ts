import { describe, it, expect } from 'vitest';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  posActorId, collectPositionSamples, resampleTimeline, buildParsePositions,
  RawPosSample, EnemyMeta, POSITIONS_INTERVAL_S,
} from './map-transform.service';

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
  ])('$name', ({ e, expected }) => {
    expect(posActorId(resEvent(e))).toBe(expected);
  });

  it('is null without a position', () => {
    expect(posActorId({ type: 'cast', timestamp: 0, abilityGameID: 1, sourceID: 3 })).toBeNull();
  });
});

describe('collectPositionSamples', () => {
  it('groups raw (unscaled) samples per actor and sorts by time, carrying maxHp', () => {
    const byActor = collectPositionSamples([
      resEvent({ ts: 2000, source: 1, x: 200, y: 100, maxHp: 5000 }),
      resEvent({ ts: 1000, source: 1, x: 100, y: 50, facing: 1500, mapID: 7, maxHp: 5000 }),
    ], 0);
    const samples = byActor.get(1)!;
    expect(samples.map(s => s.t)).toEqual([1, 2]);
    expect(samples[0]).toEqual({ t: 1, x: 100, y: 50, facing: 1500, mapID: 7, maxHp: 5000 });
    // raw units, not scaled
    expect(samples[1].x).toBe(200);
  });
});

describe('resampleTimeline', () => {
  it('returns [] for no samples', () => {
    expect(resampleTimeline([], 10, 1.5)).toEqual([]);
  });

  it('linearly interpolates x/y and picks the nearest facing/mapID', () => {
    const samples: RawPosSample[] = [
      { t: 0, x: 0, y: 0, facing: 100, mapID: 1, maxHp: 0 },
      { t: 3, x: 300, y: 600, facing: 200, mapID: 2, maxHp: 0 },
    ];
    const rows = resampleTimeline(samples, 3, 1.5);
    // rows at t = 0, 1.5, 3
    expect(rows.map(r => r[0])).toEqual([0, 1.5, 3]);
    // midpoint interpolates x to 150, y to 300; facing nearest is the later (>=0.5 -> after)
    expect(rows[1]).toEqual([1.5, 150, 300, 200, 2]);
  });

  it('rounds coordinates and keeps null facing', () => {
    const rows = resampleTimeline([{ t: 0, x: 12.6, y: -3.4, facing: null, mapID: null, maxHp: 0 }], 0, 1.5);
    expect(rows).toEqual([[0, 13, -3, null, null]]);
  });
});

describe('buildParsePositions', () => {
  const enemyMeta = new Map<number, EnemyMeta>([
    [10, { gameID: 100, name: 'Boss' }],
    [11, { gameID: 200, name: 'Add' }],
  ]);

  it('emits the player timeline and picks the boss by highest maxHp', () => {
    // duration 6s, interval 1.5 -> rows resample at t = 0, 1.5, 3, 4.5, 6 when
    // samples span the fight, so an enemy with samples across the window clears
    // the MIN_ENEMY_SAMPLES (4) resampled-row gate.
    const events: WclEvent[] = [
      // player (id 5), not in enemyMeta
      resEvent({ ts: 0, source: 5, x: 0, y: 0 }),
      resEvent({ ts: 6000, source: 5, x: 150, y: 0 }),
      // boss (id 10) high HP
      resEvent({ ts: 0, source: 10, x: 0, y: 0, maxHp: 9000 }),
      resEvent({ ts: 6000, source: 10, x: 10, y: 0, maxHp: 9000 }),
      // add (id 11) lower HP, spans the fight so it keeps >= 4 resampled rows
      resEvent({ ts: 0, source: 11, x: 500, y: 0, maxHp: 1000 }),
      resEvent({ ts: 2000, source: 11, x: 500, y: 0, maxHp: 1000 }),
      resEvent({ ts: 4000, source: 11, x: 500, y: 0, maxHp: 1000 }),
      resEvent({ ts: 6000, source: 11, x: 500, y: 0, maxHp: 1000 }),
    ];
    const parse = buildParsePositions('rep', 1, 'Me', 5, enemyMeta, events, 0, 6);
    expect(parse.report_code).toBe('rep');
    expect(parse.player_name).toBe('Me');
    expect(parse.interval_s).toBe(POSITIONS_INTERVAL_S);
    expect(parse.player.length).toBeGreaterThan(0);
    const boss = parse.enemies.find(e => e.is_boss);
    expect(boss?.game_id).toBe(100);
    // the add is kept (>= 4 samples)
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
    const parse = buildParsePositions('rep', 1, 'Me', 5, enemyMeta, events, 0, 1.5);
    expect(parse.enemies.some(e => e.game_id === 200)).toBe(false);
    expect(parse.enemies.some(e => e.is_boss)).toBe(true);
  });
});
