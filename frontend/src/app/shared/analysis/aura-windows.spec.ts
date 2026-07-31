import { describe, it, expect } from 'vitest';
import {
  buildAuraWindows, buildStackTimeline, buildAuraSpansByTarget, auraUpAt, auraAlreadyUpAt, stacksAt, auraUptimePct,
} from './aura-windows';
import {
  applyBuff, removeBuff, applyBuffStack, applyDebuff, removeDebuff, refreshDebuff,
} from '../../../testing/builders/events';
import { CLOAK_OF_SHADOWS, RUPTURE, MAELSTROM_WEAPON } from '../../../testing/spell-ids';

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

describe('auraUpAt', () => {
  const windows = buildAuraWindows([applyBuff(CLOAK_OF_SHADOWS, APPLY_S), removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0);

  it('counts both the apply and the remove instant, since the consuming cast lands on the removal', () => {
    expect(auraUpAt(windows, CLOAK_OF_SHADOWS, APPLY_S * MS_PER_S)).toBe(true);
    expect(auraUpAt(windows, CLOAK_OF_SHADOWS, REMOVE_S * MS_PER_S)).toBe(true);
  });

  it('is false outside the span and for an aura with no spans', () => {
    expect(auraUpAt(windows, CLOAK_OF_SHADOWS, (REMOVE_S + 1) * MS_PER_S)).toBe(false);
    expect(auraUpAt(windows, CLOAK_OF_SHADOWS, (APPLY_S - 1) * MS_PER_S)).toBe(false);
    expect(auraUpAt(windows, RUPTURE, APPLY_S * MS_PER_S)).toBe(false);
  });
});

describe('auraAlreadyUpAt', () => {
  const windows = buildAuraWindows([applyBuff(CLOAK_OF_SHADOWS, APPLY_S), removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0);

  it('excludes the apply instant and keeps the remove one, since the cast that grants a state shares its timestamp', () => {
    expect(auraAlreadyUpAt(windows, CLOAK_OF_SHADOWS, APPLY_S * MS_PER_S)).toBe(false);
    expect(auraAlreadyUpAt(windows, CLOAK_OF_SHADOWS, REMOVE_S * MS_PER_S)).toBe(true);
    expect(auraAlreadyUpAt(windows, CLOAK_OF_SHADOWS, (APPLY_S + 1) * MS_PER_S)).toBe(true);
  });
});

describe('buildStackTimeline and stacksAt', () => {
  const FIRST_S = 5, SECOND_S = 6, DROP_S = 9;
  const events = [
    applyBuff(MAELSTROM_WEAPON, FIRST_S),
    applyBuffStack(MAELSTROM_WEAPON, SECOND_S, 2),
    removeBuff(MAELSTROM_WEAPON, DROP_S),
  ];
  const stacks = buildStackTimeline(events, 0, MAELSTROM_WEAPON);

  it('treats a bare apply as one stack and a stack event as the new total', () => {
    expect(stacks).toEqual([[FIRST_S * MS_PER_S, 1], [SECOND_S * MS_PER_S, 2], [DROP_S * MS_PER_S, 0]]);
  });

  it('reads the count going INTO a moment, so a spend logged on the cast timestamp does not erase it', () => {
    expect(stacksAt(stacks, DROP_S * MS_PER_S)).toBe(2);
    expect(stacksAt(stacks, (DROP_S + 1) * MS_PER_S)).toBe(0);
    expect(stacksAt(stacks, FIRST_S * MS_PER_S)).toBe(0);
    expect(stacksAt(stacks, (FIRST_S + 1) * MS_PER_S)).toBe(1);
  });

  it('builds only the aura it was asked for, so a pull pays for what its rulebook names', () => {
    expect(buildStackTimeline(events, 0, RUPTURE)).toEqual([]);
    expect(stacksAt(buildStackTimeline(events, 0, RUPTURE), DROP_S * MS_PER_S)).toBe(0);
  });
});

describe('buildAuraSpansByTarget', () => {
  const OTHER = 42, REFRESH_S = 12;

  it('splits a span at a refresh and marks how it ended', () => {
    const spans = buildAuraSpansByTarget([
      applyDebuff(RUPTURE, APPLY_S), refreshDebuff(RUPTURE, REFRESH_S), removeDebuff(RUPTURE, REMOVE_S),
    ], 0, RUPTURE);
    expect(spans.get('0:0')).toEqual([
      { startMs: APPLY_S * MS_PER_S, endMs: REFRESH_S * MS_PER_S, endedByRefresh: true },
      { startMs: REFRESH_S * MS_PER_S, endMs: REMOVE_S * MS_PER_S, endedByRefresh: false },
    ]);
  });

  it('keeps each enemy on its own list, since a clip is only visible per target', () => {
    const spans = buildAuraSpansByTarget([
      applyDebuff(RUPTURE, APPLY_S), applyDebuff(RUPTURE, REFRESH_S, { target: OTHER }),
    ], 0, RUPTURE);
    expect(spans.size).toBe(2);
    expect(spans.get(`${OTHER}:0`)).toEqual([{ startMs: REFRESH_S * MS_PER_S, endMs: null, endedByRefresh: false }]);
  });

  it('ignores every other aura in the stream', () => {
    const spans = buildAuraSpansByTarget([applyDebuff(RUPTURE, APPLY_S), applyDebuff(CLOAK_OF_SHADOWS, APPLY_S)], 0, CLOAK_OF_SHADOWS);
    expect([...spans.values()].flat()).toHaveLength(1);
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
