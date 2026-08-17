import { describe, it, expect } from 'vitest';
import { FillerInBuffCondition } from '../../../../../core/models/rulebook.models';
import { WRATH, STARFIRE, ECLIPSE_SOLAR, SHADOW_DANCE } from '../../../../../../testing/spell-ids';
import { cast, buffWindow } from '../../../../../../testing/builders/events';
import { band, judged, ruleCtx } from '../../../../../../testing/rule-fixtures';
import { ruleApplicable, ruleLabel, sampleRule } from '../engine';
import { evaluateFillerInBuff as rawFillerInBuff } from './filler-in-buff';

const evaluateFillerInBuff = judged(rawFillerInBuff);

describe('evaluateFillerInBuff', () => {
  // Fight-relative seconds for an Eclipse (Solar) window long enough to hold several fillers.
  const SOLAR_START_S = 10, SOLAR_END_S = 40;
  // What the field runs: Wrath is nearly every filler pressed inside Solar Eclipse.
  const FIELD_WRATH_SHARE = 0.9;
  const wrathInSolar: FillerInBuffCondition = {
    kind: 'filler_in_buff',
    spell_id: WRATH, spell_name: 'Wrath',
    alternative_spell_ids: [STARFIRE], alternative_spell_names: ['Starfire'],
    buff_spell_id: ECLIPSE_SOLAR, buff_spell_name: 'Eclipse (Solar)',
  };
  const solar = buffWindow(ECLIPSE_SOLAR, SOLAR_START_S, SOLAR_END_S);
  // hi pinned at 1 (the share's own domain max) so a full-share pass never trips the far side.
  const fieldFloor = band(FIELD_WRATH_SHARE, 1);

  it('flags a player filling with the wrong spell inside the buff', () => {
    // One Wrath to three Starfire is a 25% share, under the field's 90%.
    const ctx = ruleCtx([
      cast(WRATH, 12), cast(STARFIRE, 14), cast(STARFIRE, 16), cast(STARFIRE, 18),
    ], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')?.measured)
      .toEqual({ value: '25 / 90', unit: '% of fillers' });
  });

  it('passes a player whose share matches the field', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(WRATH, 14), cast(WRATH, 16)], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')).toBeNull();
  });

  it('ignores fillers cast outside the buff, which the rule says nothing about', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(STARFIRE, SOLAR_END_S + 5)], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')).toBeNull();
  });

  it('accepts a share exactly on the field floor but not one just under it', () => {
    // Nine Wrath to one Starfire is exactly 90%; eight to two is 80%.
    const nine = Array.from({ length: 9 }, (_, i) => cast(WRATH, 12 + i));
    const eight = Array.from({ length: 8 }, (_, i) => cast(WRATH, 12 + i));
    const onTheBar = ruleCtx([...nine, cast(STARFIRE, 22)], { buffs: solar });
    const underIt = ruleCtx([...eight, cast(STARFIRE, 22), cast(STARFIRE, 24)], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, onTheBar, fieldFloor, 'warning')).toBeNull();
    expect(evaluateFillerInBuff(wrathInSolar, underIt, fieldFloor, 'warning')).not.toBeNull();
  });

  it('is not applicable when the pull never filled inside the buff', () => {
    expect(ruleApplicable(wrathInSolar, ruleCtx([cast(WRATH, 5)], { buffs: solar }))).toBe(false);
  });

  it('excludes the cast that enters the state, which shares the applybuff timestamp but was cast outside it', () => {
    // The Starfire that grants Solar lands on the same millisecond as the buff, and it was not cast under it.
    const entering = ruleCtx([cast(STARFIRE, SOLAR_START_S)], { buffs: solar });
    expect(ruleApplicable(wrathInSolar, entering)).toBe(false);
    // The removal millisecond stays inside: a cast that consumes the state was made under it.
    const closing = ruleCtx([cast(STARFIRE, SOLAR_END_S)], { buffs: solar });
    expect(ruleApplicable(wrathInSolar, closing)).toBe(true);
  });

  it('drops casts made in a state that suspends the choice, so a burst window is not a violation', () => {
    const CELESTIAL_START_S = 15, CELESTIAL_END_S = 25;
    const suspendedByCelestial: FillerInBuffCondition = {
      ...wrathInSolar,
      except_buff_spell_ids: [SHADOW_DANCE], except_buff_spell_names: ['Celestial Alignment'],
    };
    const buffs = [...solar, ...buffWindow(SHADOW_DANCE, CELESTIAL_START_S, CELESTIAL_END_S)];
    // Three Starfire inside the suspending window, one Wrath outside it.
    const ctx = ruleCtx([
      cast(WRATH, 12), cast(STARFIRE, 16), cast(STARFIRE, 18), cast(STARFIRE, 20),
    ], { buffs });
    expect(evaluateFillerInBuff(suspendedByCelestial, ctx, fieldFloor, 'warning')).toBeNull();
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')).not.toBeNull();
  });

  it('is not applicable when every filler inside the buff sat in a suspending state', () => {
    const suspendedThroughout: FillerInBuffCondition = {
      ...wrathInSolar,
      except_buff_spell_ids: [SHADOW_DANCE], except_buff_spell_names: ['Celestial Alignment'],
    };
    const buffs = [...solar, ...buffWindow(SHADOW_DANCE, SOLAR_START_S, SOLAR_END_S)];
    const ctx = ruleCtx([cast(WRATH, 12), cast(STARFIRE, 16)], { buffs });
    expect(ruleApplicable(suspendedThroughout, ctx)).toBe(false);
    expect(sampleRule(suspendedThroughout, ctx).values).toEqual([]);
  });

  it('samples the share the pull ran, and nothing when it never filled inside the buff', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(WRATH, 14), cast(STARFIRE, 16), cast(STARFIRE, 18)], { buffs: solar });
    expect(sampleRule(wrathInSolar, ctx).values).toEqual([0.5]);
    expect(sampleRule(wrathInSolar, ruleCtx([], { buffs: solar })).values).toEqual([]);
  });

  it('a lower field floor forgives a share a tighter one would flag', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(WRATH, 14), cast(WRATH, 16), cast(STARFIRE, 18)], { buffs: solar });
    // Three Wrath to one Starfire is 75%.
    expect(evaluateFillerInBuff(wrathInSolar, ctx, band(0.7, 1), 'warning')).toBeNull();
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')).not.toBeNull();
  });

  it('leaves a coached share over the field\'s own high end alone, since running the coached filler more is not a mistake', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(WRATH, 14), cast(WRATH, 16)], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, ctx, band(0.5, 0.9), 'warning', 'do x')).toBeNull();
  });

  it('labels the rule as "<filler> in <buff>"', () => {
    expect(ruleLabel(wrathInSolar)).toBe('Wrath in Eclipse (Solar)');
  });
});

describe('occurrence strips', () => {
  it('filler_in_buff: a chip per filler cast inside the buff, coached vs alternative as the label', () => {
    const wrathInSolar: FillerInBuffCondition = {
      kind: 'filler_in_buff',
      spell_id: WRATH, spell_name: 'Wrath',
      alternative_spell_ids: [STARFIRE], alternative_spell_names: ['Starfire'],
      buff_spell_id: ECLIPSE_SOLAR, buff_spell_name: 'Eclipse (Solar)',
    };
    const ctx = ruleCtx([cast(WRATH, 12), cast(STARFIRE, 14), cast(STARFIRE, 20)], { buffs: buffWindow(ECLIPSE_SOLAR, 10, 40) });
    const finding = evaluateFillerInBuff(wrathInSolar, ctx, band(0.9, 1), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 12, ok: true, label: 'Wrath', detail: 'Wrath was the coached filler here.' },
      { atS: 14, ok: false, label: 'Starfire', detail: 'Starfire was pressed instead of Wrath here.' },
      { atS: 20, ok: false, label: 'Starfire', detail: 'Starfire was pressed instead of Wrath here.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('90% or more Wrath during Eclipse (Solar)');
  });
});
