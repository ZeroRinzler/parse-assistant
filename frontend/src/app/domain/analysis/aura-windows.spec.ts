import { describe, it, expect } from 'vitest';
import { AuraWindowsService } from './aura-windows-service';
import { WclProjectionsService } from './wcl-projections-service';
import {
  applyBuff, removeBuff, applyBuffStack, applyDebuff, removeDebuff, refreshDebuff,
} from '../../../testing/builders/events';
import { CLOAK_OF_SHADOWS, RUPTURE, MAELSTROM_WEAPON } from '../../../testing/spell-ids';
import { TestBed } from '@angular/core/testing';

const auraWindows = TestBed.inject(AuraWindowsService);
const wclProjections = TestBed.inject(WclProjectionsService);

// Spans are carried in fight-relative seconds; the fixtures pass fight-relative seconds straight through.
const APPLY_S = 10, REMOVE_S = 15;
const FIGHT_DUR_S = 100;

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed: WclProjectionsService['withRelativeS'] = (events, startMs) => wclProjections.withRelativeS(events, startMs);

describe('buildAuraWindows', () => {
  it('pairs apply with the latest open remove, in fight-relative seconds', () => {
    const windows = auraWindows.buildAuraWindows(timed([applyBuff(CLOAK_OF_SHADOWS, APPLY_S), removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0));
    expect(windows.get(CLOAK_OF_SHADOWS)).toEqual([[APPLY_S, REMOVE_S]]);
  });

  it('leaves an unmatched apply open (null end)', () => {
    const windows = auraWindows.buildAuraWindows(timed([applyBuff(CLOAK_OF_SHADOWS, APPLY_S)], 0));
    expect(windows.get(CLOAK_OF_SHADOWS)).toEqual([[APPLY_S, null]]);
  });

  it('reads debuff apply/remove the same way, so enemy dots build spans too', () => {
    const windows = auraWindows.buildAuraWindows(timed([applyDebuff(RUPTURE, APPLY_S), removeDebuff(RUPTURE, REMOVE_S)], 0));
    expect(windows.get(RUPTURE)).toEqual([[APPLY_S, REMOVE_S]]);
  });

  it('back-fills a bare remove to fight start, since a pre-pull aura leaves only its remove in the log', () => {
    const windows = auraWindows.buildAuraWindows(timed([removeDebuff(RUPTURE, REMOVE_S)], 0));
    expect(windows.get(RUPTURE)).toEqual([[0, REMOVE_S]]);
  });

  it('back-fills a bare refresh to an open window at fight start, since a refresh means the aura was already up', () => {
    const windows = auraWindows.buildAuraWindows(timed([refreshDebuff(RUPTURE, REMOVE_S)], 0));
    expect(windows.get(RUPTURE)).toEqual([[0, null]]);
  });

  it('leaves an already-open window alone on a refresh, since the aura is continuous', () => {
    const windows = auraWindows.buildAuraWindows(timed([applyDebuff(RUPTURE, APPLY_S), refreshDebuff(RUPTURE, APPLY_S + 2)], 0));
    expect(windows.get(RUPTURE)).toEqual([[APPLY_S, null]]);
  });
});

describe('auraUpAt', () => {
  const windows = auraWindows.buildAuraWindows(timed([applyBuff(CLOAK_OF_SHADOWS, APPLY_S), removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0));

  it('counts both the apply and the remove instant, since the consuming cast lands on the removal', () => {
    expect(auraWindows.auraUpAt(windows, CLOAK_OF_SHADOWS, APPLY_S)).toBe(true);
    expect(auraWindows.auraUpAt(windows, CLOAK_OF_SHADOWS, REMOVE_S)).toBe(true);
  });

  it('is false outside the span and for an aura with no spans', () => {
    expect(auraWindows.auraUpAt(windows, CLOAK_OF_SHADOWS, REMOVE_S + 1)).toBe(false);
    expect(auraWindows.auraUpAt(windows, CLOAK_OF_SHADOWS, APPLY_S - 1)).toBe(false);
    expect(auraWindows.auraUpAt(windows, RUPTURE, APPLY_S)).toBe(false);
  });

  it('reads a back-filled remove as up before it and down after', () => {
    const preCast = auraWindows.buildAuraWindows(timed([removeDebuff(RUPTURE, REMOVE_S)], 0));
    expect(auraWindows.auraUpAt(preCast, RUPTURE, REMOVE_S - 1)).toBe(true);
    expect(auraWindows.auraUpAt(preCast, RUPTURE, REMOVE_S + 1)).toBe(false);
  });
});

describe('auraAlreadyUpAt', () => {
  const windows = auraWindows.buildAuraWindows(timed([applyBuff(CLOAK_OF_SHADOWS, APPLY_S), removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0));

  it('excludes the apply instant and keeps the remove one, since the cast that grants a state shares its timestamp', () => {
    expect(auraWindows.auraAlreadyUpAt(windows, CLOAK_OF_SHADOWS, APPLY_S)).toBe(false);
    expect(auraWindows.auraAlreadyUpAt(windows, CLOAK_OF_SHADOWS, REMOVE_S)).toBe(true);
    expect(auraWindows.auraAlreadyUpAt(windows, CLOAK_OF_SHADOWS, APPLY_S + 1)).toBe(true);
  });

  it('reads a back-filled remove as already up before it, with no apply instant to exclude', () => {
    const preCast = auraWindows.buildAuraWindows(timed([removeDebuff(RUPTURE, REMOVE_S)], 0));
    expect(auraWindows.auraAlreadyUpAt(preCast, RUPTURE, REMOVE_S - 1)).toBe(true);
    // A cast logged at exactly fight start is not credited: 0 is the span's own start instant, excluded like any apply.
    expect(auraWindows.auraAlreadyUpAt(preCast, RUPTURE, 0)).toBe(false);
    expect(auraWindows.auraAlreadyUpAt(preCast, RUPTURE, REMOVE_S + 1)).toBe(false);
  });
});

describe('buildStackTimeline and stacksAt', () => {
  const FIRST_S = 5, SECOND_S = 6, DROP_S = 9;
  const events = timed([
    applyBuff(MAELSTROM_WEAPON, FIRST_S),
    applyBuffStack(MAELSTROM_WEAPON, SECOND_S, 2),
    removeBuff(MAELSTROM_WEAPON, DROP_S),
  ], 0);
  const stacks = auraWindows.buildStackTimeline(events, MAELSTROM_WEAPON);

  it('treats a bare apply as one stack and a stack event as the new total', () => {
    expect(stacks).toEqual({ groundedFromStart: true, entries: [[FIRST_S, 1], [SECOND_S, 2], [DROP_S, 0]] });
  });

  it('reads the count going INTO a moment, so a spend logged on the cast timestamp does not erase it', () => {
    expect(auraWindows.stacksAt(stacks, DROP_S)).toBe(2);
    expect(auraWindows.stacksAt(stacks, DROP_S + 1)).toBe(0);
    expect(auraWindows.stacksAt(stacks, FIRST_S)).toBe(0);
    expect(auraWindows.stacksAt(stacks, FIRST_S + 1)).toBe(1);
  });

  it('builds only the aura it was asked for, so a pull pays for what its rulebook names', () => {
    expect(auraWindows.buildStackTimeline(events, RUPTURE)).toEqual({ groundedFromStart: false, entries: [] });
    expect(auraWindows.stacksAt(auraWindows.buildStackTimeline(events, RUPTURE), DROP_S)).toBeNull();
  });

  it('reads a bare apply as a real zero before it, since the aura genuinely was not up yet', () => {
    expect(auraWindows.stacksAt(stacks, FIRST_S - 1)).toBe(0);
  });

  it('does not know the count before a bare remove opening the timeline, but knows it from that instant on', () => {
    // The aura was already up at pull; its first trace inside the fight window is this bare remove.
    const preExisting = auraWindows.buildStackTimeline(timed([removeBuff(MAELSTROM_WEAPON, DROP_S)], 0), MAELSTROM_WEAPON);
    expect(auraWindows.stacksAt(preExisting, DROP_S - 1)).toBeNull();
    expect(auraWindows.stacksAt(preExisting, DROP_S + 1)).toBe(0);
  });

  it('does not know the count before a bare stack event opening the timeline, but knows it from that instant on', () => {
    const preExisting = auraWindows.buildStackTimeline(timed([applyBuffStack(MAELSTROM_WEAPON, SECOND_S, 4)], 0), MAELSTROM_WEAPON);
    expect(auraWindows.stacksAt(preExisting, SECOND_S - 1)).toBeNull();
    expect(auraWindows.stacksAt(preExisting, SECOND_S + 1)).toBe(4);
  });

  it('clamps a stack event reporting a negative total to zero', () => {
    const negative = auraWindows.buildStackTimeline(timed([
      applyBuff(MAELSTROM_WEAPON, FIRST_S), applyBuffStack(MAELSTROM_WEAPON, SECOND_S, -3),
    ], 0), MAELSTROM_WEAPON);
    expect(auraWindows.stacksAt(negative, SECOND_S + 1)).toBe(0);
  });
});

describe('buildAuraSpansByTarget', () => {
  const OTHER = 42, REFRESH_S = 12;

  it('splits a span at a refresh and marks how it ended', () => {
    const spans = auraWindows.buildAuraSpansByTarget(timed([
      applyDebuff(RUPTURE, APPLY_S), refreshDebuff(RUPTURE, REFRESH_S), removeDebuff(RUPTURE, REMOVE_S),
    ], 0), RUPTURE);
    expect(spans.get('0:0')).toEqual([
      { startS: APPLY_S, endS: REFRESH_S, endedByRefresh: true },
      { startS: REFRESH_S, endS: REMOVE_S, endedByRefresh: false },
    ]);
  });

  it('keeps each enemy on its own list, since a clip is only visible per target', () => {
    const spans = auraWindows.buildAuraSpansByTarget(timed([
      applyDebuff(RUPTURE, APPLY_S), applyDebuff(RUPTURE, REFRESH_S, { target: OTHER }),
    ], 0), RUPTURE);
    expect(spans.size).toBe(2);
    expect(spans.get(`${OTHER}:0`)).toEqual([{ startS: REFRESH_S, endS: null, endedByRefresh: false }]);
  });

  it('ignores every other aura in the stream', () => {
    const spans = auraWindows.buildAuraSpansByTarget(timed([applyDebuff(RUPTURE, APPLY_S), applyDebuff(CLOAK_OF_SHADOWS, APPLY_S)], 0), CLOAK_OF_SHADOWS);
    expect([...spans.values()].flat()).toHaveLength(1);
  });

  it('does not back-fill a bare refresh, since the true pre-pull start is unknown', () => {
    const spans = auraWindows.buildAuraSpansByTarget(timed([refreshDebuff(RUPTURE, REFRESH_S)], 0), RUPTURE);
    expect(spans.get('0:0')).toEqual([{ startS: REFRESH_S, endS: null, endedByRefresh: false }]);
  });
});

describe('auraUptimePct', () => {
  it('measures a closed span against the fight length', () => {
    const windows = auraWindows.buildAuraWindows(timed([applyBuff(CLOAK_OF_SHADOWS, 0), removeBuff(CLOAK_OF_SHADOWS, 25)], 0));
    expect(auraWindows.auraUptimePct(windows, CLOAK_OF_SHADOWS, FIGHT_DUR_S)).toBe(25);
  });

  it('runs an open span to fight end', () => {
    const windows = auraWindows.buildAuraWindows(timed([applyBuff(CLOAK_OF_SHADOWS, 50)], 0));
    expect(auraWindows.auraUptimePct(windows, CLOAK_OF_SHADOWS, FIGHT_DUR_S)).toBe(50);
  });

  it('merges overlapping spans, so multi-target dots do not exceed 100%', () => {
    const windows = auraWindows.buildAuraWindows(timed([
      applyDebuff(RUPTURE, 0), applyDebuff(RUPTURE, 10), applyDebuff(RUPTURE, 20),
      removeDebuff(RUPTURE, 25), removeDebuff(RUPTURE, 35), removeDebuff(RUPTURE, 40),
    ], 0));
    expect(auraWindows.auraUptimePct(windows, RUPTURE, FIGHT_DUR_S)).toBe(40);
  });

  // Spans are keyed by spell only, so per-target pairing is lost; the union that a maintain rule reads is not.
  it('covers the same stretch whether the per-target dots are nested or interleaved', () => {
    const nested = auraWindows.buildAuraWindows(timed([
      applyDebuff(RUPTURE, 0, { target: 1 }), applyDebuff(RUPTURE, 10, { target: 2 }),
      removeDebuff(RUPTURE, 20, { target: 2 }), removeDebuff(RUPTURE, 30, { target: 1 }),
    ], 0));
    const interleaved = auraWindows.buildAuraWindows(timed([
      applyDebuff(RUPTURE, 0, { target: 1 }), applyDebuff(RUPTURE, 10, { target: 2 }),
      removeDebuff(RUPTURE, 20, { target: 1 }), removeDebuff(RUPTURE, 30, { target: 2 }),
    ], 0));
    expect(auraWindows.auraUptimePct(nested, RUPTURE, FIGHT_DUR_S)).toBe(30);
    expect(auraWindows.auraUptimePct(interleaved, RUPTURE, FIGHT_DUR_S)).toBe(30);
  });

  it('counts a lone remove as uptime from fight start, since a pre-pull aura leaves no apply', () => {
    const PREPULL_REMOVE_S = 20; // the back-filled [0, 20] span is 20/100 of FIGHT_DUR_S -> 20% uptime
    const windows = auraWindows.buildAuraWindows(timed([removeDebuff(RUPTURE, PREPULL_REMOVE_S)], 0));
    expect(auraWindows.auraUptimePct(windows, RUPTURE, FIGHT_DUR_S)).toBe(PREPULL_REMOVE_S);
  });

  it('is zero for an aura that never went up', () => {
    expect(auraWindows.auraUptimePct(new Map(), RUPTURE, FIGHT_DUR_S)).toBe(0);
  });
});
