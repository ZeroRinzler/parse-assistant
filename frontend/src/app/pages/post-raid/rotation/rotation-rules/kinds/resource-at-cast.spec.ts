import { describe, it, expect } from 'vitest';
import { ResourceAtCastCondition } from '../../../../../core/models/rulebook.models';
import { BLACK_POWDER, EVISCERATE } from '../../../../../../testing/spell-ids';
import { cast } from '../../../../../../testing/builders/events';
import {
  COMBO_POINT_TYPE, MAX_COMBO_POINTS, band, judged, ruleCtx,
} from '../rule-fixtures';
import { ruleApplicable } from '../engine';
import { evaluateResourceAtCast as rawResourceAtCast } from './resource-at-cast';

const evaluateResourceAtCast = judged(rawResourceAtCast);

describe('evaluateResourceAtCast', () => {
  const RESOURCE_FLOOR = 1;  // the field spends at a full pool, measured as a share of cap
  const finisherAtMax: ResourceAtCastCondition = {
    kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Eviscerate',
    resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'min',
  };
  const atCombo = (atS: number, amount: number) =>
    cast(EVISCERATE, atS, { resources: [{ amount, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });

  it('flags a finisher spent below the field\'s floor', () => {
    const ctx = ruleCtx([atCombo(10, 3), atCombo(20, MAX_COMBO_POINTS)]);
    expect(evaluateResourceAtCast(finisherAtMax, ctx, band(RESOURCE_FLOOR), 'warning')?.measured).toEqual({ value: '1 / 2', unit: 'cast(s)' });
  });

  it('passes finishers spent at the floor', () => {
    expect(evaluateResourceAtCast(finisherAtMax, ruleCtx([atCombo(10, MAX_COMBO_POINTS)]), band(RESOURCE_FLOOR), 'warning')).toBeNull();
  });

  it('flags a generator pressed above its ceiling', () => {
    const FIELD_CEILING_FRAC = 0.8;  // the field generates below four fifths of the cap, measured
    const noOvercap: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: BLACK_POWDER, spell_name: 'Black Powder',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'max',
    };
    const ctx = ruleCtx([cast(BLACK_POWDER, 10,
      { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] })]);
    expect(evaluateResourceAtCast(noOvercap, ctx, band(FIELD_CEILING_FRAC), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('says the same thing in the chip and the sentence, so the two cannot drift', () => {
    const ctx = ruleCtx([atCombo(10, 3)]);
    const finding = evaluateResourceAtCast(finisherAtMax, ctx, band(RESOURCE_FLOOR), 'warning');
    expect(finding?.label).toBe('Eviscerate below 5/5 combo points');
    expect(finding?.message).toContain('Eviscerate casts were spent below 5/5 combo points');
  });

  it('quantizes the pool fraction back to the resource\'s own cap before it names the field\'s mark', () => {
    const TOP_FRAC = 0.8;  // a fraction other than 0 or 1, so quantizing must actually round it
    const ctx = ruleCtx([atCombo(10, 3), atCombo(20, MAX_COMBO_POINTS)]);
    // hi pinned at the pool's own cap so the full-pool cast does not itself trip the far side.
    const finding = evaluateResourceAtCast(finisherAtMax, ctx, band(TOP_FRAC, 1), 'warning');
    expect(finding?.message).toBe('1 of 2 Eviscerate casts were spent below 4/5 combo points. Spend at 4/5 or more.');
  });

  it('names the field\'s mark as a percent for a large pool (mana), the other branch of the scale', () => {
    const innervate: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Innervate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'mana', bound: 'min',
    };
    const MANA_MAX = 250_000;
    const TOP_FRAC = 0.75;
    const atMana = (atS: number, amount: number) =>
      cast(EVISCERATE, atS, { resources: [{ amount, max: MANA_MAX, type: COMBO_POINT_TYPE }] });
    const ctx = ruleCtx([atMana(10, MANA_MAX * 0.6), atMana(20, MANA_MAX)]);
    const finding = evaluateResourceAtCast(innervate, ctx, band(TOP_FRAC, 1), 'warning');
    expect(finding?.message).toBe('1 of 2 Innervate casts were spent below 75% mana. Spend at 75% or more.');
  });

  it('is not applicable when the casts carry no resource snapshot', () => {
    expect(evaluateResourceAtCast(finisherAtMax, ruleCtx([cast(EVISCERATE, 10)]), band(RESOURCE_FLOOR), 'warning')).toBeNull();
    expect(ruleApplicable(finisherAtMax, ruleCtx([cast(EVISCERATE, 10)]))).toBe(false);
  });

  it('ignores a pool the event flattened from the target rather than the caster', () => {
    const RESOURCE_ACTOR_TARGET = 2;
    const ctx = ruleCtx([{ ...atCombo(10, 1), resourceActor: RESOURCE_ACTOR_TARGET }]);
    expect(evaluateResourceAtCast(finisherAtMax, ctx, band(RESOURCE_FLOOR), 'warning')).toBeNull();
    expect(ruleApplicable(finisherAtMax, ctx)).toBe(false);
  });

  // Only a cast that spends the pool reports it, so every overcap rule judges a cast carrying no snapshot of its own.
  describe('a cast that spends nothing from the pool', () => {
    const OVERCAP_CEILING_FRAC = 0.6;  // the field generates below three fifths of the cap, measured
    const noOvercap: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: BLACK_POWDER, spell_name: 'Black Powder',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'max',
    };
    const SPENT_AT_S = 10;
    const finisher = cast(EVISCERATE, SPENT_AT_S,
      { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE, cost: MAX_COMBO_POINTS }] });

    it('reads the pool a neighbouring cast left behind', () => {
      const AT_CAP_S = 12;
      const atCap = cast(EVISCERATE, AT_CAP_S,
        { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
      const ctx = ruleCtx([atCap, cast(BLACK_POWDER, AT_CAP_S + 1)]);
      expect(evaluateResourceAtCast(noOvercap, ctx, band(OVERCAP_CEILING_FRAC), 'warning')?.measured?.value).toBe('1 / 1');
    });

    it('subtracts the neighbour\'s cost, so the pool it emptied does not read as full', () => {
      const ctx = ruleCtx([finisher, cast(BLACK_POWDER, SPENT_AT_S + 1)]);
      // lo pinned at 0 so the emptied pool does not itself trip the far side.
      expect(evaluateResourceAtCast(noOvercap, ctx, band(0, OVERCAP_CEILING_FRAC), 'warning')).toBeNull();
    });

    it('reads nothing from a neighbour further back than the sample window', () => {
      const PAST_WINDOW_S = 7;
      const atCap = cast(EVISCERATE, SPENT_AT_S,
        { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
      const ctx = ruleCtx([atCap, cast(BLACK_POWDER, SPENT_AT_S + PAST_WINDOW_S)]);
      expect(ruleApplicable(noOvercap, ctx)).toBe(false);
    });

    it('reads nothing from a neighbour that only follows it, which cannot describe the cast', () => {
      const atCap = cast(EVISCERATE, SPENT_AT_S,
        { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
      const ctx = ruleCtx([cast(BLACK_POWDER, SPENT_AT_S - 1), atCap]);
      expect(ruleApplicable(noOvercap, ctx)).toBe(false);
    });

    it('reads nothing from a neighbour reporting a different pool', () => {
      const ENERGY_TYPE = 3;
      const energyCast = cast(EVISCERATE, SPENT_AT_S, { resources: [{ amount: 100, max: 100, type: ENERGY_TYPE }] });
      const ctx = ruleCtx([energyCast, cast(BLACK_POWDER, SPENT_AT_S + 1)]);
      expect(ruleApplicable(noOvercap, ctx)).toBe(false);
    });
  });

  it('flags the far side: a finisher spent at the pool\'s own cap, over the field\'s own ceiling', () => {
    const FIELD_LO_FRAC = 0.4, FIELD_HI_FRAC = 0.8;
    const overCap = ruleCtx([atCombo(10, MAX_COMBO_POINTS)]);
    const atHi = ruleCtx([atCombo(10, 4)]);
    const finding = evaluateResourceAtCast(finisherAtMax, overCap, band(FIELD_LO_FRAC, FIELD_HI_FRAC), 'warning', 'do x');
    expect(finding?.message).toBe('1 of 1 Eviscerate casts were spent above 4/5 combo points. Spend before you cap.');
    // Spending sooner is what the authored action asks for, and it answers a capped pool too.
    expect(finding?.details?.remedy).toBe('do x');
    expect(evaluateResourceAtCast(finisherAtMax, atHi, band(FIELD_LO_FRAC, FIELD_HI_FRAC), 'warning', 'do x')).toBeNull();
  });
});

describe('occurrence strips', () => {
  it('resource_at_cast: a chip per cast, the raw amount over its own cap as the label (a small pool reads as a count, not a percent)', () => {
    const finisher: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Eviscerate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'min',
    };
    const atCombo = (atS: number, amount: number) =>
      cast(EVISCERATE, atS, { resources: [{ amount, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
    const ctx = ruleCtx([atCombo(10, 3), atCombo(20, MAX_COMBO_POINTS)]);
    const finding = evaluateResourceAtCast(finisher, ctx, band(1), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 10, ok: false, label: '3/5', detail: 'Eviscerate cast at 3/5.' },
      { atS: 20, ok: true, label: '5/5', detail: 'Eviscerate cast at 5/5.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Spend at 5/5 or more.');
  });

  it('resource_at_cast: a large pool (mana) still reads as a percent, since WCL reports it as a five/six-digit number', () => {
    const innervate: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Innervate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'mana', bound: 'min',
    };
    const MANA_MAX = 250_000;
    const atMana = (atS: number, amount: number) =>
      cast(EVISCERATE, atS, { resources: [{ amount, max: MANA_MAX, type: COMBO_POINT_TYPE }] });
    const ctx = ruleCtx([atMana(10, MANA_MAX * 0.6), atMana(20, MANA_MAX)]);
    const finding = evaluateResourceAtCast(innervate, ctx, band(1), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 10, ok: false, label: '60%', detail: 'Innervate cast at 60%.' },
      { atS: 20, ok: true, label: '100%', detail: 'Innervate cast at 100%.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Spend at 100% or more.');
  });
});
