import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ProcWastedCondition } from '../../../../../../domain/rulebook/rulebook.models';
import { SHADOW_DANCE, SECRET_TECHNIQUE } from '../../../../../../../testing/spell-ids';
import { cast, applyBuff, buffWindow } from '../../../../../../../testing/builders/events';
import {
  DANCE_START_S, DANCE_END_S, FIELD_NEVER, RULE_FIGHT_END_S, band, judged, ruleCtx, sampleRule,
} from '../rule-fixtures';
import { ProcWastedKind } from './proc-wasted-kind';

const kind = TestBed.inject(ProcWastedKind);
const evaluateProcWasted = judged(kind);

describe('rule evaluator boundaries', () => {
  const dance = buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S);

  it('reads that same cast as having consumed the proc', () => {
    const spendDance: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });
});

describe('evaluateProcWasted', () => {
  const spendDance: ProcWastedCondition = {
    kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
    spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
  };
  const dance = buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S);

  it('flags a proc that expired with nothing spent into it', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S + 5)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')?.measured).toEqual({ value: '1 / 1', unit: 'proc(s)' });
  });

  it('passes a proc consumed inside its span', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });

  it('ignores a span still open at the end of the pull', () => {
    const ctx = ruleCtx([], { buffs: [applyBuff(SHADOW_DANCE, DANCE_START_S)] });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
    expect(kind.applicable(spendDance, ctx)).toBe(false);
  });

  it('ignores a span the log closes on the pull ending, which the kill took rather than the player wasting', () => {
    const ctx = ruleCtx([], { buffs: buffWindow(SHADOW_DANCE, 100, RULE_FIGHT_END_S) });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
    expect(kind.applicable(spendDance, ctx)).toBe(false);
  });

  it('leaves a wasted share under the field\'s own low end alone, since wasting fewer procs is not a mistake', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, band(0.5, 0.9), 'warning', 'do x')).toBeNull();
  });
});

describe('sampleRule', () => {
  it('samples the share of procs the parse let expire, so a lasting state is not read as a wasted proc', () => {
    const proc: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    const buffs = [...buffWindow(SHADOW_DANCE, 10, 20), ...buffWindow(SHADOW_DANCE, 30, 40)];
    const HALF_WASTED = 0.5;
    expect(sampleRule(kind, proc, ruleCtx([cast(SECRET_TECHNIQUE, 12)], { buffs })).values).toEqual([HALF_WASTED]);
  });

  it('samples nothing for a proc that never closed a span, so the parse abstains rather than voting zero', () => {
    const proc: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    expect(sampleRule(kind, proc, ruleCtx([])).values).toEqual([]);
  });
});

describe('occurrence strips', () => {
  it('proc_wasted: a chip per proc span, used vs wasted as the label', () => {
    const spendDance: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    const buffs = [...buffWindow(SHADOW_DANCE, 20, 28), ...buffWindow(SHADOW_DANCE, 40, 50)];
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, 22)], { buffs });
    const finding = evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 20, ok: true, label: 'used', detail: 'Shadow Dance was spent before it expired.' },
      { atS: 40, ok: false, label: 'wasted', detail: 'Shadow Dance expired unspent here.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('spent every time');
  });
});
