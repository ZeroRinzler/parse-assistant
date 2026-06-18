import { describe, it, expect } from 'vitest';
import { buildActorTimelines, positionAt } from './positioning-core';
import { Events, PLAYER } from '../../../testing/builders/events';
import { FIGHT_START } from '../../../testing/time';

describe('buildActorTimelines', () => {
  it('decodes WCL wire units (hundredths of a yard, milliradians) into yards and radians', () => {
    // The builder takes human units; the core must round-trip them back.
    const events = Events.start().positioned(123, '0:10', 10, 20, 90).build();

    const tl = buildActorTimelines(events, FIGHT_START).get(PLAYER);

    expect(tl?.samples[0]).toMatchObject({ t: 10, x: 10, y: 20 });
    expect(tl?.samples[0].facing).toBeCloseTo(Math.PI / 2); // 90 degrees
  });

  it('attributes the flattened position to the source actor when resourceActor = 1', () => {
    const events = Events.start().positioned(123, '0:10', 5, 5, 0, { source: 7 }).build();

    const timelines = buildActorTimelines(events, FIGHT_START);

    expect(timelines.has(7)).toBe(true);
  });
});

describe('positionAt', () => {
  const tl = buildActorTimelines(
    Events.start().positioned(1, '0:10', 0, 0, 0).positioned(1, '0:20', 10, 0, 0).build(),
    FIGHT_START,
  ).get(PLAYER);

  it('linearly interpolates between samples', () => {
    expect(positionAt(tl, 15)?.x).toBeCloseTo(5);
  });

  it('returns null when the requested time is beyond the tolerance window', () => {
    expect(positionAt(tl, 100, 3)).toBeNull();
  });
});
