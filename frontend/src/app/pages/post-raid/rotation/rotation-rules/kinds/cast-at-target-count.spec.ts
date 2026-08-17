import { describe, it, expect } from 'vitest';
import { CastAtTargetCountCondition } from '../../../../../core/models/rulebook.models';
import { BLACK_POWDER, EVISCERATE, RUPTURE } from '../../../../../../testing/spell-ids';
import { cast, damage } from '../../../../../../testing/builders/events';
import { band, judged, ruleCtx } from '../../../../../../testing/rule-fixtures';
import { evaluateCastAtTargetCount as rawCastAtTargetCount } from './cast-at-target-count';

const evaluateCastAtTargetCount = judged(rawCastAtTargetCount);

describe('evaluateCastAtTargetCount', () => {
  const MIN_AOE_TARGETS = 3;
  const TARGET_FLOOR = MIN_AOE_TARGETS;  // the count the field uses it at, measured
  const CAST_S = 10;
  const blackPowder: CastAtTargetCountCondition = {
    kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
  };
  const hits = (targets: number[]) => targets.map(id => damage(BLACK_POWDER, CAST_S + 1, 100, { target: id }));

  it('flags an AoE finisher pressed under the target floor', () => {
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('passes the same cast once enough enemies are hit', () => {
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2, 3]) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('flags a single-target ability pressed over its ceiling', () => {
    const FIELD_CEILING = 2;  // the field stops using it above this, measured
    const capped: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: EVISCERATE, spell_name: 'Eviscerate', bound: 'max',
    };
    const ctx = ruleCtx([cast(EVISCERATE, CAST_S)],
      { damage: [1, 2, 3].map(id => damage(EVISCERATE, CAST_S + 1, 100, { target: id })) });
    expect(evaluateCastAtTargetCount(capped, ctx, band(FIELD_CEILING), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('accepts a cast exactly at the target ceiling but not one over it', () => {
    const FIELD_CEILING = 2;
    const capped: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: EVISCERATE, spell_name: 'Eviscerate', bound: 'max',
    };
    const onCeiling = ruleCtx([cast(EVISCERATE, CAST_S)], { damage: [1, 2].map(id => damage(EVISCERATE, CAST_S + 1, 100, { target: id })) });
    const overCeiling = ruleCtx([cast(EVISCERATE, CAST_S)], { damage: [1, 2, 3].map(id => damage(EVISCERATE, CAST_S + 1, 100, { target: id })) });
    expect(evaluateCastAtTargetCount(capped, onCeiling, band(FIELD_CEILING), 'warning')).toBeNull();
    expect(evaluateCastAtTargetCount(capped, overCeiling, band(FIELD_CEILING), 'warning')).not.toBeNull();
  });

  it('counts copies of one add separately, since they share a targetID and differ only by instance', () => {
    const ADD_ID = 7;
    const copies = [1, 2, 3].map(instance =>
      ({ ...damage(BLACK_POWDER, CAST_S + 1, 100, { target: ADD_ID }), targetInstance: instance }));
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: copies });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('ignores a cast with no damage recorded near it, rather than reading it as zero targets', () => {
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]).map(e => ({ ...e, timestamp: 90_000 })) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('counts enemies reached by any ability, since the bound asks how many were up rather than how many this cast struck', () => {
    const FIELD_CEILING = 2;
    const capped: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: EVISCERATE, spell_name: 'Eviscerate', bound: 'max',
    };
    const ctx = ruleCtx([cast(EVISCERATE, CAST_S)], {
      damage: [
        damage(EVISCERATE, CAST_S + 1, 100, { target: 1 }),
        ...[1, 2, 3].map(id => damage(RUPTURE, CAST_S + 1, 50, { target: id })),
      ],
    });
    expect(evaluateCastAtTargetCount(capped, ctx, band(FIELD_CEILING), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('rounds a sub-target floor away, so a field whose true floor is 2.7 still flags a cast at 2', () => {
    const SUB_TARGET_FLOOR = 2.7;
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(SUB_TARGET_FLOOR), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('counts damage landing on the cast millisecond, which an instant ability does', () => {
    const onTheCast = [1, 2, 3].map(id => damage(BLACK_POWDER, CAST_S, 100, { target: id }));
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: onTheCast });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('bisects a sorted index, so a row logged out of order does not shift the window', () => {
    const EARLY_S = 1;
    const OTHER_ENEMY = 9;
    const rows = [...hits([1, 2]), damage(BLACK_POWDER, EARLY_S, 100, { target: OTHER_ENEMY }), ...hits([3])];
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: rows });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('folds rows that name no target into one enemy rather than dropping them', () => {
    const FIELD_CEILING = 0;  // any enemy at all is over this ceiling
    const capped: CastAtTargetCountCondition = { ...blackPowder, bound: 'max' };
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: [damage(BLACK_POWDER, CAST_S + 1, 100)] });
    expect(evaluateCastAtTargetCount(capped, ctx, band(FIELD_CEILING), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('leaves a cast at far more targets than the field alone, since clearing a floor costs nothing', () => {
    const FIELD_LO = 2, FIELD_HI = 5;
    const overCast = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2, 3, 4, 5, 6, 7, 8]) });
    const atLo = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]) });
    expect(evaluateCastAtTargetCount(blackPowder, overCast, band(FIELD_LO, FIELD_HI), 'warning', 'do x')).toBeNull();
    // Exactly on the floor is inside the field's range; only under it flags.
    expect(evaluateCastAtTargetCount(blackPowder, atLo, band(FIELD_LO, FIELD_HI), 'warning', 'do x')).toBeNull();
  });
});

describe('unanimous field', () => {
  it('produces no finding for a player exactly on a unanimous field, one for a step off it, and reads the copy as a single number', () => {
    const blackPowder: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
    };
    const unanimous = band(5);
    const onIt = ruleCtx([cast(BLACK_POWDER, 10)], { damage: [1, 2, 3, 4, 5].map(id => damage(BLACK_POWDER, 11, 100, { target: id })) });
    const oneOff = ruleCtx([cast(BLACK_POWDER, 10)], { damage: [1, 2, 3, 4].map(id => damage(BLACK_POWDER, 11, 100, { target: id })) });
    expect(evaluateCastAtTargetCount(blackPowder, onIt, unanimous, 'warning')).toBeNull();
    const finding = evaluateCastAtTargetCount(blackPowder, oneOff, unanimous, 'warning');
    expect(finding?.message).toBe('1 of 1 Black Powder casts hit fewer than 5 targets. Wait for 5 or more.');
  });
});

describe('occurrence strips', () => {
  it('cast_at_target_count: a chip per cast, the target count as the label', () => {
    const blackPowder: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
    };
    const ctx = ruleCtx([cast(BLACK_POWDER, 10), cast(BLACK_POWDER, 30)], {
      damage: [
        ...[1, 2].map(id => damage(BLACK_POWDER, 11, 100, { target: id })),
        ...[1, 2, 3].map(id => damage(BLACK_POWDER, 31, 100, { target: id })),
      ],
    });
    const finding = evaluateCastAtTargetCount(blackPowder, ctx, band(3), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 10, ok: false, label: '2', detail: 'Black Powder cast at 2.' },
      { atS: 30, ok: true, label: '3', detail: 'Black Powder cast at 3.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Wait for 3 or more.');
  });
});
