import { describe, expect, it } from 'vitest';
import { EVISCERATE, FEINT, SHADOW_BLADES } from '../spell-ids';
import { applyBuff, buffWindow, cast, damage, damageTaken, removeBuff } from './events';

/** WCL timestamps are milliseconds; the factories take fight-relative seconds. */
const MS_PER_SECOND = 1000;

// Arbitrary fixture values; the factories pass them through unchanged.
const AT_S = 15;
const PLAYER_ID = 3;
const BOSS_ID = 9;
const HIT_AMOUNT = 500;
const ABSORBED_AMOUNT = 120;

const BARE_EVENTS = [
  { factory: 'cast', event: cast(SHADOW_BLADES, AT_S), type: 'cast', spellId: SHADOW_BLADES },
  { factory: 'applyBuff', event: applyBuff(FEINT, AT_S), type: 'applybuff', spellId: FEINT },
  { factory: 'removeBuff', event: removeBuff(FEINT, AT_S), type: 'removebuff', spellId: FEINT },
  { factory: 'damage', event: damage(EVISCERATE, AT_S, HIT_AMOUNT), type: 'damage', spellId: EVISCERATE },
  { factory: 'damageTaken', event: damageTaken(EVISCERATE, AT_S, HIT_AMOUNT), type: 'damage', spellId: EVISCERATE },
];

describe('event factories', () => {
  it.each([
    { atS: 0, expectedMs: 0 },
    { atS: 15, expectedMs: 15_000 },
    { atS: 90.5, expectedMs: 90_500 },
  ])('stamps an event at $atS s with the millisecond timestamp $expectedMs', ({ atS, expectedMs }) => {
    expect(cast(SHADOW_BLADES, atS).timestamp).toBe(expectedMs);
  });

  it.each(BARE_EVENTS)('$factory emits a $type event for the given spell and time', ({ event, type, spellId }) => {
    expect(event).toMatchObject({ type, abilityGameID: spellId, timestamp: AT_S * MS_PER_SECOND });
  });

  describe('omitted opts leave fields absent', () => {
    it.each(BARE_EVENTS)('$factory sets no actor ids', ({ event }) => {
      expect(event).not.toHaveProperty('sourceID');
      expect(event).not.toHaveProperty('targetID');
    });

    it.each([
      { factory: 'damage', event: damage(EVISCERATE, AT_S, HIT_AMOUNT) },
      { factory: 'damageTaken', event: damageTaken(EVISCERATE, AT_S, HIT_AMOUNT) },
    ])('$factory sets no absorbed field', ({ event }) => {
      expect(event).not.toHaveProperty('absorbed');
    });
  });

  describe('actor opts', () => {
    it('cast sets only the source when only source is provided', () => {
      const event = cast(SHADOW_BLADES, AT_S, { source: PLAYER_ID });
      expect(event.sourceID).toBe(PLAYER_ID);
      expect(event).not.toHaveProperty('targetID');
    });

    it('cast sets only the target when only target is provided', () => {
      const event = cast(SHADOW_BLADES, AT_S, { target: BOSS_ID });
      expect(event.targetID).toBe(BOSS_ID);
      expect(event).not.toHaveProperty('sourceID');
    });

    it('cast sets both actors when both are provided', () => {
      const event = cast(SHADOW_BLADES, AT_S, { source: PLAYER_ID, target: BOSS_ID });
      expect(event).toMatchObject({ sourceID: PLAYER_ID, targetID: BOSS_ID });
    });

    it.each([
      { factory: 'applyBuff', event: applyBuff(FEINT, AT_S, { target: PLAYER_ID }) },
      { factory: 'removeBuff', event: removeBuff(FEINT, AT_S, { target: PLAYER_ID }) },
    ])('$factory target sets both actor fields (a self-buff lands on its target)', ({ event }) => {
      expect(event).toMatchObject({ sourceID: PLAYER_ID, targetID: PLAYER_ID });
    });

    it('damage sets the attacker and the victim when provided', () => {
      const event = damage(EVISCERATE, AT_S, HIT_AMOUNT, { source: PLAYER_ID, target: BOSS_ID });
      expect(event).toMatchObject({ sourceID: PLAYER_ID, targetID: BOSS_ID });
    });

    it('damageTaken sets only the attacking source and never a target', () => {
      const event = damageTaken(EVISCERATE, AT_S, HIT_AMOUNT, { source: BOSS_ID });
      expect(event.sourceID).toBe(BOSS_ID);
      expect(event).not.toHaveProperty('targetID');
    });
  });

  describe('buffWindow', () => {
    const FROM_S = 10;
    const TO_S = 16;

    it('emits the applybuff then the removebuff spanning the window', () => {
      const window = buffWindow(FEINT, FROM_S, TO_S);

      expect(window).toHaveLength(2);
      const [applied, removed] = window;
      expect(applied).toMatchObject({ type: 'applybuff', abilityGameID: FEINT, timestamp: FROM_S * MS_PER_SECOND });
      expect(removed).toMatchObject({ type: 'removebuff', abilityGameID: FEINT, timestamp: TO_S * MS_PER_SECOND });
    });

    it('forwards the target to both edge events', () => {
      const edges = buffWindow(FEINT, FROM_S, TO_S, { target: PLAYER_ID });
      expect(edges).toHaveLength(2);
      for (const edge of edges) {
        expect(edge).toMatchObject({ sourceID: PLAYER_ID, targetID: PLAYER_ID });
      }
    });
  });

  describe('damage amounts', () => {
    it.each([
      { factory: 'damage', event: damage(EVISCERATE, AT_S, HIT_AMOUNT, { absorbed: ABSORBED_AMOUNT }) },
      { factory: 'damageTaken', event: damageTaken(EVISCERATE, AT_S, HIT_AMOUNT, { absorbed: ABSORBED_AMOUNT }) },
    ])('$factory carries the hit amount and passes absorbed through', ({ event }) => {
      expect(event).toMatchObject({ amount: HIT_AMOUNT, absorbed: ABSORBED_AMOUNT });
    });
  });
});
