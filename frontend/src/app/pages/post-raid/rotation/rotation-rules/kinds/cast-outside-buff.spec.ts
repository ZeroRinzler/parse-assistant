import { describe, it, expect } from 'vitest';
import { CastOutsideBuffCondition } from '../../../../../core/models/rulebook.models';
import { SHADOW_DANCE, SECRET_TECHNIQUE } from '../../../../../../testing/spell-ids';
import { cast, buffWindow, removeBuff } from '../../../../../../testing/builders/events';
import {
  DANCE_START_S, DANCE_END_S, FIELD_NEVER, band, judged, ruleCtx,
} from '../rule-fixtures';
import { ruleApplicable, sampleRule } from '../engine';
import { evaluateCastOutsideBuff as rawCastOutsideBuff } from './cast-outside-buff';

const evaluateCastOutsideBuff = judged(rawCastOutsideBuff);

describe('evaluateCastOutsideBuff', () => {
  const insideDance: CastOutsideBuffCondition = {
    kind: 'cast_outside_buff', spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
    buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance', require: 'inside',
  };
  const dance = buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S);

  it('flags a cast made while the buff was down', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S + 5)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('passes a cast made inside the buff span', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });

  it('inverts for require "outside", flagging the cast made while the buff was up', () => {
    const outsideDance: CastOutsideBuffCondition = { ...insideDance, require: 'outside' };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateCastOutsideBuff(outsideDance, ctx, FIELD_NEVER, 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('is not applicable when the judged spell was never cast', () => {
    expect(ruleApplicable(insideDance, ruleCtx([], { buffs: dance }))).toBe(false);
  });

  it('reads an opener cast inside a buff pre-cast before the pull as inside it', () => {
    const OPENER_S = 2;  // well before DANCE_END_S, inside the back-filled pre-pull window
    const preCastDance = [removeBuff(SHADOW_DANCE, DANCE_END_S)];
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, OPENER_S)], { buffs: preCastDance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });

  it('still flags a cast made after that pre-cast buff has already fallen', () => {
    const preCastDance = [removeBuff(SHADOW_DANCE, DANCE_END_S)];
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S + 5)], { buffs: preCastDance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('leaves an off-side share under the field\'s own low end alone, since beating the field is not a mistake', () => {
    // A single on-side cast reads a 0% off-side share, under a field whose own low end sits at 50%.
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, band(0.5, 0.9), 'warning', 'do x')).toBeNull();
  });
});

describe('rule evaluator boundaries', () => {
  const dance = buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S);

  // Measured on a real pull: 75 of 197 Hot Streak removals share the consuming cast's exact millisecond, so reading it as outside flags perfect play twice.
  it('reads a cast on the removal instant as inside the buff', () => {
    const insideDance: CastOutsideBuffCondition = {
      kind: 'cast_outside_buff', spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
      buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance', require: 'inside',
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });
});

describe('sampleRule', () => {
  it('samples the share of casts the parse put on the wrong side of a buff', () => {
    const insideDance: CastOutsideBuffCondition = {
      kind: 'cast_outside_buff', spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
      buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance', require: 'inside',
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2), cast(SECRET_TECHNIQUE, DANCE_END_S + 5)],
      { buffs: buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S) });
    const HALF_OFF_SIDE = 0.5;
    expect(sampleRule(insideDance, ctx).values).toEqual([HALF_OFF_SIDE]);
  });
});

describe('occurrence strips', () => {
  it('cast_outside_buff: a chip per cast, the buff state as the label', () => {
    const outsideDance: CastOutsideBuffCondition = {
      kind: 'cast_outside_buff', spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
      buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance', require: 'inside',
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, 22), cast(SECRET_TECHNIQUE, 35)], { buffs: buffWindow(SHADOW_DANCE, 20, 28) });
    const finding = evaluateCastOutsideBuff(outsideDance, ctx, FIELD_NEVER, 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 22, ok: true, label: 'up', detail: 'Shadow Dance was up at this cast.' },
      { atS: 35, ok: false, label: 'down', detail: 'Shadow Dance was down at this cast.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Shadow Dance up every cast');
  });
});
