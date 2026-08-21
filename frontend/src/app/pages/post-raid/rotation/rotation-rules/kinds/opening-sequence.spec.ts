import { assert, describe, it, expect } from 'vitest';
import { OpeningSequenceCondition } from '../../../../../core/models/rulebook.models';
import { SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, EVISCERATE } from '../../../../../../testing/spell-ids';
import { cast } from '../../../../../../testing/builders/events';
import { band, benched, judged, ruleCtx, ruleFor } from '../rule-fixtures';
import { evaluateRules, ruleApplicable, rulesFollowed } from '../engine';
import { evaluateOpeningSequence as rawOpeningSequence } from './opening-sequence';

const evaluateOpeningSequence = judged(rawOpeningSequence);

describe('rule evaluator boundaries', () => {
  it('accepts an opener step landing exactly on hi', () => {
    const OPENER_WINDOW_S = 12;
    const opener: OpeningSequenceCondition = {
      kind: 'opening_sequence', spell_ids: [SHADOW_BLADES, SECRET_TECHNIQUE],
      spell_names: ['Shadow Blades', 'Secret Technique'],
    };
    const ctx = ruleCtx([cast(SHADOW_BLADES, 0), cast(SECRET_TECHNIQUE, OPENER_WINDOW_S)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')).toBeNull();
  });
});

describe('evaluateOpeningSequence', () => {
  const OPENER_WINDOW_S = 12;
  const opener: OpeningSequenceCondition = {
    kind: 'opening_sequence',
    spell_ids: [SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE],
    spell_names: ['Shadow Blades', 'Shadow Dance', 'Secret Technique'],
  };

  it('passes the sequence cast in order inside the window', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')).toBeNull();
  });

  it('flags a sequence cast out of order, reporting the steps reached', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SECRET_TECHNIQUE, 3), cast(SHADOW_DANCE, 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')?.measured).toEqual({ value: '2 / 3', unit: 'step(s)' });
  });

  it('flags a step that lands past the opener window', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, OPENER_WINDOW_S + 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')?.measured?.value).toBe('2 / 3');
  });

  it('renders the window limit with one decimal, matching the pair and hold sentences', () => {
    const WINDOW_LIMIT_S = 12.4;
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, WINDOW_LIMIT_S + 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(WINDOW_LIMIT_S), 'warning')?.message)
      .toBe('Your opener got 2 of 3 steps out. Top raiders finish all 3 within 12.4s.');
  });

  it('tolerates unrelated casts between the steps', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(EVISCERATE, 2), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')).toBeNull();
  });

  it('is judged on neither side of a pull with none of the sequence spells', () => {
    const ctx = ruleCtx([cast(EVISCERATE, 1)]);
    const rule = ruleFor(opener);
    expect(ruleApplicable(opener, ctx)).toBe(false);
    expect(evaluateRules([benched(rule, band(OPENER_WINDOW_S))], ctx)).toEqual([]);
    expect(rulesFollowed([benched(rule, band(OPENER_WINDOW_S))], ctx)).toEqual([]);
  });

  it('still flags a first step landing past the window, which is why the gate reads casts and not progress', () => {
    const ctx = ruleCtx([cast(EVISCERATE, 1), cast(SHADOW_BLADES, 30)]);
    const rule = ruleFor(opener);
    const finding = evaluateRules([benched(rule, band(OPENER_WINDOW_S))], ctx)[0];
    assert.exists(finding);
    expect(finding.measured?.value).toBe('0 / 3');
  });
});

describe('occurrence strips', () => {
  it('opening_sequence: a chip per authored step, a missed one carrying a "not reached" note instead of a time', () => {
    const opener: OpeningSequenceCondition = {
      kind: 'opening_sequence',
      spell_ids: [SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE],
      spell_names: ['Shadow Blades', 'Shadow Dance', 'Secret Technique'],
    };
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SECRET_TECHNIQUE, 3)]);
    const OPENER_WINDOW_S = 12;
    const finding = evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 1, ok: true, label: 'Shadow Blades', detail: 'Shadow Blades landed on time in its slot.' },
      { ok: false, label: 'Shadow Dance', note: 'not reached', detail: 'Shadow Dance was never reached in the opener window.' },
      { atS: 3, ok: true, label: 'Secret Technique', detail: 'Secret Technique landed on time in its slot.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('expected order: Shadow Blades > Shadow Dance > Secret Technique');
  });
});
