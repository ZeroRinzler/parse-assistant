import { assert, describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CastWithoutPriorCondition } from '../../../../../../domain/rulebook/rulebook.models';
import { SHADOW_DANCE, SECRET_TECHNIQUE } from '../../../../../../../testing/spell-ids';
import { cast } from '../../../../../../../testing/builders/events';
import {
  PAIR_WINDOW_S, SECRET_TECH_NEEDS_DANCE, band, judged, ruleCtx, sampleRule,
} from '../rule-fixtures';
import { CastWithoutPriorKind } from './cast-without-prior-kind';

const kind = TestBed.inject(CastWithoutPriorKind);
const evaluateCastWithoutPrior = judged(kind);

describe('rule engine', () => {
  it('flags Secret Technique cast with no Shadow Dance in window', () => {
    const ctx = ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 30)]);
    const finding = evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(PAIR_WINDOW_S), 'warning', 'do x');
    expect(finding).not.toBeNull();
    assert.exists(finding);
    expect(finding.measured).toEqual({ value: '1 / 1', unit: 'cast(s)' });
    assert.exists(finding);
    expect(finding.details?.remedy).toBe('do x');
  });

  it('passes when Shadow Dance precedes Secret Technique inside the window', () => {
    const ctx = ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 12)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(PAIR_WINDOW_S), 'warning')).toBeNull();
  });

  it('flags a required cast that only follows the judged one, because position defaults to before', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('accepts a required cast on either side when position is either', () => {
    const paired: CastWithoutPriorCondition = { ...SECRET_TECH_NEEDS_DANCE, position: 'either' };
    const danceAfter = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    const danceBefore = ruleCtx([cast(SHADOW_DANCE, 8), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(paired, danceAfter, band(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(paired, danceBefore, band(PAIR_WINDOW_S), 'warning')).toBeNull();
  });

  it('requires the companion to follow when position is after', () => {
    const followUp: CastWithoutPriorCondition = { ...SECRET_TECH_NEEDS_DANCE, position: 'after' };
    const danceAfter = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    const danceBefore = ruleCtx([cast(SHADOW_DANCE, 8), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(followUp, danceAfter, band(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(followUp, danceBefore, band(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('accepts a companion exactly on the window edge but not past it', () => {
    // hi is 5, so a Shadow Dance at 5 covers a Secret Technique at 10 and one at 4.9 does not.
    const onEdge = ruleCtx([cast(SHADOW_DANCE, 5), cast(SECRET_TECHNIQUE, 10)]);
    const pastEdge = ruleCtx([cast(SHADOW_DANCE, 4.9), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, onEdge, band(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, pastEdge, band(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });
});

describe('ruleLabel', () => {
  it('describes a paired-cast rule as "<spell> with <required>"', () => {
    expect(kind.label(SECRET_TECH_NEEDS_DANCE)).toBe('Secret Technique with Shadow Dance');
  });
});

describe('sampleRule', () => {
  it('samples every paired cast\'s own lead, one instance per pairing', () => {
    const TIGHT_LEAD_S = 2, LOOSE_LEAD_S = 6;
    const ctx = ruleCtx([
      cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 10 + TIGHT_LEAD_S),
      cast(SHADOW_DANCE, 40), cast(SECRET_TECHNIQUE, 40 + LOOSE_LEAD_S),
    ]);
    expect(sampleRule(kind, SECRET_TECH_NEEDS_DANCE, ctx).values).toEqual([TIGHT_LEAD_S, LOOSE_LEAD_S]);
  });

  it('measures no lead for an unpaired cast, but still reports it as an instance the parse judged', () => {
    expect(sampleRule(kind, SECRET_TECH_NEEDS_DANCE, ruleCtx([cast(SECRET_TECHNIQUE, 10)])))
      .toEqual({ values: [], unmeasuredOut: 1 });
  });
});

describe('occurrence strips', () => {
  it('cast_without_prior: a chip per judged cast, its lead as the label', () => {
    const ctx = ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 12), cast(SECRET_TECHNIQUE, 40)]);
    const finding = evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(PAIR_WINDOW_S), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 12, ok: true, label: '2s', detail: 'Shadow Dance landed 2s from this cast.' },
      { atS: 40, ok: false, label: '30s', detail: 'Shadow Dance landed 30s from this cast.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('within 5s of Shadow Dance');
  });

  it('cast_without_prior: the chip and the window limit both read one decimal, so a lead just past it reads visibly larger', () => {
    const WINDOW_LIMIT_S = 12;
    const OVER_LIMIT_LEAD_S = 12.4;
    const ctx = ruleCtx([cast(SHADOW_DANCE, 0), cast(SECRET_TECHNIQUE, WINDOW_LIMIT_S), cast(SECRET_TECHNIQUE, OVER_LIMIT_LEAD_S)]);
    const finding = evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(WINDOW_LIMIT_S), 'warning');
    expect(finding?.measured).toEqual({ value: '1 / 2', unit: 'cast(s)' });
    expect(finding?.message).toBe('1 of 2 Secret Technique casts had no Shadow Dance before them. Cast it within 12s of Shadow Dance.');
    expect(finding?.occurrenceTarget).toBe('within 12s of Shadow Dance');
    expect(finding?.occurrences).toEqual([
      { atS: WINDOW_LIMIT_S, ok: true, label: '12s', detail: 'Shadow Dance landed 12s from this cast.' },
      { atS: OVER_LIMIT_LEAD_S, ok: false, label: '12.4s', detail: 'Shadow Dance landed 12.4s from this cast.' },
    ]);
  });
});
