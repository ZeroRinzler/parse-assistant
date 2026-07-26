import { describe, it, expect } from 'vitest';
import { buildAuraWindows, isInsideAura, auraUptimePct } from './aura-windows';
import { applyBuff, removeBuff, applyDebuff, removeDebuff } from '../../../testing/builders/events';
import { CLOAK_OF_SHADOWS, RUPTURE } from '../../../testing/spell-ids';

// Spans are carried in raw fight-relative milliseconds; the fixtures take fight-relative seconds.
const MS_PER_S = 1000;
const APPLY_S = 10, REMOVE_S = 15;
const FIGHT_DUR_MS = 100 * MS_PER_S;

describe('buildAuraWindows', () => {
  it('pairs apply with the latest open remove, in raw milliseconds', () => {
    const windows = buildAuraWindows([applyBuff(CLOAK_OF_SHADOWS, APPLY_S), removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0);
    expect(windows.get(CLOAK_OF_SHADOWS)).toEqual([[APPLY_S * MS_PER_S, REMOVE_S * MS_PER_S]]);
  });

  it('leaves an unmatched apply open (null end)', () => {
    const windows = buildAuraWindows([applyBuff(CLOAK_OF_SHADOWS, APPLY_S)], 0);
    expect(windows.get(CLOAK_OF_SHADOWS)).toEqual([[APPLY_S * MS_PER_S, null]]);
  });

  it('reads debuff apply/remove the same way, so enemy dots build spans too', () => {
    const windows = buildAuraWindows([applyDebuff(RUPTURE, APPLY_S), removeDebuff(RUPTURE, REMOVE_S)], 0);
    expect(windows.get(RUPTURE)).toEqual([[APPLY_S * MS_PER_S, REMOVE_S * MS_PER_S]]);
  });
});

describe('isInsideAura', () => {
  const windows = buildAuraWindows([applyBuff(CLOAK_OF_SHADOWS, APPLY_S), removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0);

  it('counts both the apply and the remove instant, since the consuming cast lands on the removal', () => {
    expect(isInsideAura(windows, CLOAK_OF_SHADOWS, APPLY_S * MS_PER_S)).toBe(true);
    expect(isInsideAura(windows, CLOAK_OF_SHADOWS, REMOVE_S * MS_PER_S)).toBe(true);
  });

  it('is false outside the span and for an aura with no spans', () => {
    expect(isInsideAura(windows, CLOAK_OF_SHADOWS, (REMOVE_S + 1) * MS_PER_S)).toBe(false);
    expect(isInsideAura(windows, CLOAK_OF_SHADOWS, (APPLY_S - 1) * MS_PER_S)).toBe(false);
    expect(isInsideAura(windows, RUPTURE, APPLY_S * MS_PER_S)).toBe(false);
  });
});

describe('auraUptimePct', () => {
  it('measures a closed span against the fight length', () => {
    const windows = buildAuraWindows([applyBuff(CLOAK_OF_SHADOWS, 0), removeBuff(CLOAK_OF_SHADOWS, 25)], 0);
    expect(auraUptimePct(windows, CLOAK_OF_SHADOWS, FIGHT_DUR_MS)).toBe(25);
  });

  it('runs an open span to fight end', () => {
    const windows = buildAuraWindows([applyBuff(CLOAK_OF_SHADOWS, 50)], 0);
    expect(auraUptimePct(windows, CLOAK_OF_SHADOWS, FIGHT_DUR_MS)).toBe(50);
  });

  it('merges overlapping spans, so multi-target dots do not exceed 100%', () => {
    const windows = buildAuraWindows([
      applyDebuff(RUPTURE, 0), applyDebuff(RUPTURE, 10), applyDebuff(RUPTURE, 20),
      removeDebuff(RUPTURE, 25), removeDebuff(RUPTURE, 35), removeDebuff(RUPTURE, 40),
    ], 0);
    expect(auraUptimePct(windows, RUPTURE, FIGHT_DUR_MS)).toBe(40);
  });

  // Spans are keyed by spell only, so per-target pairing is lost; the union that a maintain rule reads is not.
  it('covers the same stretch whether the per-target dots are nested or interleaved', () => {
    const nested = buildAuraWindows([
      applyDebuff(RUPTURE, 0, { target: 1 }), applyDebuff(RUPTURE, 10, { target: 2 }),
      removeDebuff(RUPTURE, 20, { target: 2 }), removeDebuff(RUPTURE, 30, { target: 1 }),
    ], 0);
    const interleaved = buildAuraWindows([
      applyDebuff(RUPTURE, 0, { target: 1 }), applyDebuff(RUPTURE, 10, { target: 2 }),
      removeDebuff(RUPTURE, 20, { target: 1 }), removeDebuff(RUPTURE, 30, { target: 2 }),
    ], 0);
    expect(auraUptimePct(nested, RUPTURE, FIGHT_DUR_MS)).toBe(30);
    expect(auraUptimePct(interleaved, RUPTURE, FIGHT_DUR_MS)).toBe(30);
  });

  it('drops a lone remove, so a dot applied before the pull reads as no uptime rather than a full fight of it', () => {
    const windows = buildAuraWindows([removeDebuff(RUPTURE, 20)], 0);
    expect(auraUptimePct(windows, RUPTURE, FIGHT_DUR_MS)).toBe(0);
  });

  it('is zero for an aura that never went up', () => {
    expect(auraUptimePct(new Map(), RUPTURE, FIGHT_DUR_MS)).toBe(0);
  });
});
