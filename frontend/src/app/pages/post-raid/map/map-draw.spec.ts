import { describe, it, expect } from 'vitest';
import { EncounterPositions } from '../../../core/models/positioning.models';
import { ActorTimeline } from './map.service';
import {
  positionAt, toReferenceLocal, rowsToTimeline, topParsePoints, topParseTrails,
} from './map-draw';

const timeline = (samples: ActorTimeline['samples']): ActorTimeline => ({ id: 1, samples });

describe('positionAt', () => {
  const tl = timeline([
    { t: 0, x: 0, y: 0 },
    { t: 10, x: 100, y: 0 },
  ]);

  it('interpolates between samples', () => {
    expect(positionAt(tl, 5)).toMatchObject({ x: 50, y: 0 });
  });

  it('clamps at the ends within tolerance', () => {
    expect(positionAt(tl, -1)).toMatchObject({ x: 0 });
    expect(positionAt(tl, 11)).toMatchObject({ x: 100 });
  });

  it('returns null beyond the tolerance window', () => {
    expect(positionAt(tl, -10)).toBeNull();
    expect(positionAt(tl, 20)).toBeNull();
  });

  it('returns null for an empty timeline', () => {
    expect(positionAt(undefined, 1)).toBeNull();
    expect(positionAt(timeline([]), 1)).toBeNull();
  });
});

describe('toReferenceLocal', () => {
  it('with the reference facing world-up, a point ahead is +fwd', () => {
    // ref facing default (Math.PI/2) + offset (-Math.PI/2) = 0 -> forward axis = +x.
    const rel = toReferenceLocal({ t: 0, x: 5, y: 0 }, { t: 0, x: 0, y: 0 });
    expect(rel.fwd).toBeCloseTo(5, 6);
    expect(rel.dist).toBeCloseTo(5, 6);
  });

  it('reports distance regardless of orientation', () => {
    const rel = toReferenceLocal({ t: 0, x: 3, y: 4 }, { t: 0, x: 0, y: 0, facing: 1.2 });
    expect(rel.dist).toBeCloseTo(5, 6);
  });
});

describe('rowsToTimeline', () => {
  it('scales raw rows to yards and radians and passes null through', () => {
    const tl = rowsToTimeline(7, [[1, 250, 500, 1000, 3], [2, 0, 0, null, null]]);
    expect(tl.id).toBe(7);
    expect(tl.samples[0]).toEqual({ t: 1, x: 2.5, y: 5, facing: 1, mapID: 3 });
    expect(tl.samples[1]).toEqual({ t: 2, x: 0, y: 0, facing: undefined, mapID: undefined });
  });
});

describe('topParsePoints / topParseTrails', () => {
  const positions: EncounterPositions = {
    spec: 'X', encounter_id: 1, encounter_name: 'E', interval_s: 1.5, sample_count: 2,
    parses: [
      { report_code: 'a', fight_id: 1, player_name: 'P', duration_s: 6, interval_s: 1.5,
        player: [[0, 500, 0, null, null], [6, 500, 0, null, null]],
        enemies: [{ game_id: 100, name: 'Boss', is_boss: true, samples: [[0, 0, 0, null, null], [6, 0, 0, null, null]] }] },
      { report_code: 'b', fight_id: 2, player_name: 'Q', duration_s: 6, interval_s: 1.5,
        player: [[0, 500, 0, null, null], [6, 500, 0, null, null]],
        enemies: [{ game_id: 100, name: 'Boss', is_boss: true, samples: [[0, 0, 0, null, null], [6, 0, 0, null, null]] }] },
    ],
  };

  it('returns one relative point per parse at the anchor time', () => {
    const points = topParsePoints(positions, { kind: 'boss' }, 3);
    expect(points).toHaveLength(2);
    // 500 raw -> 5 yards forward of the boss
    expect(points[0].dist).toBeCloseTo(5, 6);
  });

  it('builds a trail per parse across the window', () => {
    const trails = topParseTrails(positions, { kind: 'boss' }, 3, 1.5, 1.5, 0.5);
    expect(trails).toHaveLength(2);
    expect(trails[0].length).toBeGreaterThan(1);
  });

  it('selects an enemy reference by gameId', () => {
    const points = topParsePoints(positions, { kind: 'enemy', gameId: 100 }, 0);
    expect(points).toHaveLength(2);
  });
});
