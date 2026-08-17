import { assert, describe, it, expect } from 'vitest';
import { SHADOW_BLADES, SHADOW_DANCE } from '../../../../../../testing/spell-ids';
import { cast } from '../../../../../../testing/builders/events';
import {
  HOLD_WINDOW_S, HOLD_DANCE_FOR_BLADES, band, judged, ruleCtx,
} from '../../../../../../testing/rule-fixtures';
import { ruleLabel, sampleRule } from '../engine';
import { evaluateHoldForAnchor as rawHoldForAnchor } from './hold-cooldown-for-anchor';

const evaluateHoldForAnchor = judged(rawHoldForAnchor);

describe('rule engine', () => {
  it('flags Shadow Dance spent in the hold window before Shadow Blades', () => {
    // Shadow Blades at 10 and 120; the second (120) is the one evaluated; Shadow Dance at 110 is within 15s.
    const ctx = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)]);
    const finding = evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, ctx, band(HOLD_WINDOW_S), 'critical');
    expect(finding).not.toBeNull();
    assert.exists(finding);
    expect(finding.measured).toEqual({ value: '1 / 1', unit: 'charge(s)' });
  });

  it('accepts a charge spent exactly at the hold floor but not one a second inside it', () => {
    // Shadow Blades anchors at 10 and 130; lo is 15, so a gap of exactly 15 passes and 14 does not.
    const onFloor = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 130), cast(SHADOW_DANCE, 115)]);
    const pastFloor = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 130), cast(SHADOW_DANCE, 116)]);
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, onFloor, band(HOLD_WINDOW_S), 'critical')).toBeNull();
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, pastFloor, band(HOLD_WINDOW_S), 'critical')).not.toBeNull();
  });

  it('leaves a charge spent far earlier than the field alone, since a long gap is a prompt spend rather than a hold', () => {
    const FIELD_LO = 10, FIELD_HI = 40;
    const spentEarly = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 200), cast(SHADOW_DANCE, 50)]);
    const atLo = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 200), cast(SHADOW_DANCE, 20)]);
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, spentEarly, band(FIELD_LO, FIELD_HI), 'critical', 'do x')).toBeNull();
    // Exactly on the floor is inside the field's window; only under it is a hold.
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, atLo, band(FIELD_LO, FIELD_HI), 'critical', 'do x')).toBeNull();
  });
});

describe('ruleLabel', () => {
  it('describes a hold rule as "<spells> held for <anchor>"', () => {
    expect(ruleLabel(HOLD_DANCE_FOR_BLADES)).toBe('Shadow Dance held for Shadow Blades');
  });
});

describe('sampleRule', () => {
  it('samples the gap each judged cast keeps clear before its next non-opener anchor', () => {
    const CLEAR_GAP_S = 30;
    const ctx = ruleCtx([
      cast(SHADOW_BLADES, 10), cast(SHADOW_DANCE, 90), cast(SHADOW_BLADES, 90 + CLEAR_GAP_S),
    ]);
    expect(sampleRule(HOLD_DANCE_FOR_BLADES, ctx).values).toEqual([CLEAR_GAP_S]);
  });
});

describe('occurrence strips', () => {
  it('hold_cooldown_for_anchor: marks the anchor cast and reads each charge\'s gap to it', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)]);
    const finding = evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, ctx, band(HOLD_WINDOW_S), 'critical');
    expect(finding?.occurrences).toEqual([
      { atS: 110, ok: false, label: '10s', detail: 'Shadow Dance cast 10s before Shadow Blades.' },
      { atS: 120, ok: true, label: 'Shadow Blades', marker: true, detail: 'Shadow Blades cast here.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('saved when Shadow Blades is within 15s');
  });

  it('hold_cooldown_for_anchor: the chip and the window limit both read one decimal, so a violation gap reads visibly smaller than the limit', () => {
    const HOLD_LIMIT_S = 12;
    const ANCHOR_S = 100;
    const CLEARED_GAP_S = 12.4;
    const VIOLATION_GAP_S = 11.6;
    const ctx = ruleCtx([
      cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, ANCHOR_S),
      cast(SHADOW_DANCE, ANCHOR_S - CLEARED_GAP_S), cast(SHADOW_DANCE, ANCHOR_S - VIOLATION_GAP_S),
    ]);
    const finding = evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, ctx, band(HOLD_LIMIT_S, HOLD_LIMIT_S + 5), 'critical');
    expect(finding?.measured).toEqual({ value: '1 / 2', unit: 'charge(s)' });
    expect(finding?.message).toBe('Shadow Dance was used right before Shadow Blades 1 of 2 times. Save it when Shadow Blades is within 12s.');
    expect(finding?.occurrences).toEqual([
      { atS: ANCHOR_S - CLEARED_GAP_S, ok: true, label: '12.4s', detail: 'Shadow Dance cast 12.4s before Shadow Blades.' },
      { atS: ANCHOR_S - VIOLATION_GAP_S, ok: false, label: '11.6s', detail: 'Shadow Dance cast 11.6s before Shadow Blades.' },
      { atS: ANCHOR_S, ok: true, label: 'Shadow Blades', marker: true, detail: 'Shadow Blades cast here.' },
    ]);
  });

  it('hold_cooldown_for_anchor: a gap that clears the window is ok, and the low edge itself is strict', () => {
    const HOLD_LIMIT_S = 12;
    const ANCHOR_S = 100;
    const CLEARED_GAP_S = 12.4;
    const AT_LIMIT_GAP_S = 12;
    const UNDER_LIMIT_GAP_S = 11.6;
    // hi well above the cleared gap, so a compliant hold does not itself trip the far side.
    const field = band(HOLD_LIMIT_S, HOLD_LIMIT_S + 5);
    const held = (gapS: number) =>
      ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, ANCHOR_S), cast(SHADOW_DANCE, ANCHOR_S - gapS)]);
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, held(CLEARED_GAP_S), field, 'critical')).toBeNull();
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, held(AT_LIMIT_GAP_S), field, 'critical')).toBeNull();
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, held(UNDER_LIMIT_GAP_S), field, 'critical')).not.toBeNull();
  });
});
