import { describe, it, expect } from 'vitest';
import { Events, PLAYER, BOSS } from './events';
import { parseClock } from '../time';
import { SHADOW_BLADES, FEINT } from '../spell-ids';

describe('parseClock', () => {
  it.each([
    { t: '0:00', ms: 0 },
    { t: '0:15', ms: 15_000 },
    { t: '1:30', ms: 90_000 },
    { t: '1:30.5', ms: 90_500 },
    { t: 12, ms: 12_000 },
  ])('parses $t to $ms ms', ({ t, ms }) => {
    expect(parseClock(t)).toBe(ms);
  });

  it('rejects malformed strings', () => {
    expect(() => parseClock('90')).toThrow();
    expect(() => parseClock('1:75')).toThrow();
  });
});

describe('Events builder', () => {
  it('defaults a cast to player -> boss at the parsed timestamp', () => {
    const [e] = Events.cast(SHADOW_BLADES, '0:30').build();

    expect(e).toMatchObject({ type: 'cast', abilityGameID: SHADOW_BLADES, timestamp: 30_000, sourceID: PLAYER, targetID: BOSS });
  });

  it('buffWindow emits an apply then a remove for the same spell', () => {
    const events = Events.start().buffWindow(FEINT, '0:10', '0:16').build();

    expect(events.map((e) => e.type)).toEqual(['applybuff', 'removebuff']);
    expect(events.map((e) => e.timestamp)).toEqual([10_000, 16_000]);
  });

  it('damageTaken reverses the actors (boss -> player)', () => {
    const [e] = Events.start().damageTaken(123, '0:05', 500, { absorbed: 100 }).build();

    expect(e).toMatchObject({ type: 'damage', sourceID: BOSS, targetID: PLAYER, amount: 500, absorbed: 100 });
  });

  it('build returns a fresh array each call (no shared mutation)', () => {
    const b = Events.cast(SHADOW_BLADES, '0:01');
    expect(b.build()).not.toBe(b.build());
  });
});
