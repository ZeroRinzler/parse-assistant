import { describe, it, expect } from 'vitest';
import { AuraClippedCondition } from '../../../../../core/models/rulebook.models';
import { MOONFIRE, MOONFIRE_DOT, SHADOW_DANCE } from '../../../../../../testing/spell-ids';
import { cast, applyDebuff, refreshDebuff, buffWindow } from '../../../../../../testing/builders/events';
import { band, judged, ruleCtx } from '../../../../../../testing/rule-fixtures';
import { ruleApplicable, ruleLabel, sampleRule } from '../engine';
import { evaluateAuraClipped as rawAuraClipped } from './aura-clipped';

const evaluateAuraClipped = judged(rawAuraClipped);

describe('evaluateAuraClipped', () => {
  // Where the field refreshes: it lets the dot run this long before re-applying.
  const FIELD_ELAPSED_S = 12;
  const moonfireClipped: AuraClippedCondition = {
    kind: 'aura_clipped',
    aura_spell_id: MOONFIRE_DOT, aura_spell_name: 'Moonfire',
    cast_spell_id: MOONFIRE, cast_spell_name: 'Moonfire', on: 'target',
  };
  const APPLY_AT_S = 20, CLIPPED_ELAPSED_S = 4;
  const reapplied = (elapsed: number) => [applyDebuff(MOONFIRE_DOT, APPLY_AT_S), refreshDebuff(MOONFIRE_DOT, APPLY_AT_S + elapsed)];

  it('flags a refresh the player cast well before the field would have', () => {
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S)], { debuffs: reapplied(CLIPPED_ELAPSED_S) });
    expect(evaluateAuraClipped(moonfireClipped, ctx, band(FIELD_ELAPSED_S), 'warning')?.measured)
      .toEqual({ value: '1 / 1', unit: 'refresh(es)' });
  });

  it('accepts a refresh exactly at the field bar but not one a second inside it', () => {
    const at = (elapsed: number) =>
      ruleCtx([cast(MOONFIRE, APPLY_AT_S + elapsed)], { debuffs: reapplied(elapsed) });
    expect(evaluateAuraClipped(moonfireClipped, at(FIELD_ELAPSED_S), band(FIELD_ELAPSED_S), 'warning')).toBeNull();
    expect(evaluateAuraClipped(moonfireClipped, at(FIELD_ELAPSED_S - 1), band(FIELD_ELAPSED_S), 'warning')).not.toBeNull();
  });

  it('leaves a refresh later than the field\'s own high end alone, since letting the aura run is not clipping it', () => {
    const LATE_ELAPSED_S = 20;
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S + LATE_ELAPSED_S)], { debuffs: reapplied(LATE_ELAPSED_S) });
    expect(evaluateAuraClipped(moonfireClipped, ctx, band(4, 12), 'warning', 'do x')).toBeNull();
  });

  it('ignores a refresh no cast produced, since most refreshes in a log are procs', () => {
    const ctx = ruleCtx([], { debuffs: reapplied(CLIPPED_ELAPSED_S) });
    expect(evaluateAuraClipped(moonfireClipped, ctx, band(FIELD_ELAPSED_S), 'warning')).toBeNull();
    expect(ruleApplicable(moonfireClipped, ctx)).toBe(false);
  });

  it('ignores a bare refresh with no known prior application, since the true elapsed time is unknown', () => {
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S)], { debuffs: [refreshDebuff(MOONFIRE_DOT, APPLY_AT_S)] });
    expect(evaluateAuraClipped(moonfireClipped, ctx, band(FIELD_ELAPSED_S), 'warning')).toBeNull();
    expect(ruleApplicable(moonfireClipped, ctx)).toBe(false);
  });

  it('ignores a cast that came after the refresh, which cannot have caused it', () => {
    const LATER_S = 0.1;
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S + LATER_S)], { debuffs: reapplied(CLIPPED_ELAPSED_S) });
    expect(ruleApplicable(moonfireClipped, ctx)).toBe(false);
  });

  it('drops a refresh made in a state that suspends the rule', () => {
    const suspended: AuraClippedCondition = {
      ...moonfireClipped, except_buff_spell_ids: [SHADOW_DANCE], except_buff_spell_names: ['Celestial Alignment'],
    };
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S)], {
      debuffs: reapplied(CLIPPED_ELAPSED_S),
      buffs: buffWindow(SHADOW_DANCE, APPLY_AT_S, APPLY_AT_S + 10),
    });
    expect(ruleApplicable(suspended, ctx)).toBe(false);
    expect(ruleApplicable(moonfireClipped, ctx)).toBe(true);
  });

  it('keeps each enemy on its own clock, so a second target is not measured against the first', () => {
    const OTHER_ENEMY = 77, SECOND_APPLY_S = 30;
    const debuffs = [
      applyDebuff(MOONFIRE_DOT, APPLY_AT_S),
      applyDebuff(MOONFIRE_DOT, SECOND_APPLY_S, { target: OTHER_ENEMY }),
      refreshDebuff(MOONFIRE_DOT, SECOND_APPLY_S + CLIPPED_ELAPSED_S, { target: OTHER_ENEMY }),
    ];
    const ctx = ruleCtx([cast(MOONFIRE, SECOND_APPLY_S + CLIPPED_ELAPSED_S)], { debuffs });
    // Its own clock reads 4s; measured against the first enemy's application it would read 14s.
    expect(sampleRule(moonfireClipped, ctx).values).toEqual([CLIPPED_ELAPSED_S]);
  });

  it('samples the earliest and latest the pull re-applied, and nothing when it never did', () => {
    const LATE_ELAPSED_S = 10;
    const debuffs = [
      ...reapplied(CLIPPED_ELAPSED_S),
      refreshDebuff(MOONFIRE_DOT, APPLY_AT_S + CLIPPED_ELAPSED_S + LATE_ELAPSED_S),
    ];
    const ctx = ruleCtx([
      cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S), cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S + LATE_ELAPSED_S),
    ], { debuffs });
    expect(sampleRule(moonfireClipped, ctx).values).toEqual([CLIPPED_ELAPSED_S, LATE_ELAPSED_S]);
    expect(sampleRule(moonfireClipped, ruleCtx([])).values).toEqual([]);
  });

  it('labels the rule as "<aura> clipped"', () => {
    expect(ruleLabel(moonfireClipped)).toBe('Moonfire clipped');
  });
});

describe('occurrence strips', () => {
  it('aura_clipped: a chip per hard-cast refresh, the elapsed time as the label', () => {
    const moonfireClipped: AuraClippedCondition = {
      kind: 'aura_clipped',
      aura_spell_id: MOONFIRE_DOT, aura_spell_name: 'Moonfire',
      cast_spell_id: MOONFIRE, cast_spell_name: 'Moonfire', on: 'target',
    };
    const debuffs = [applyDebuff(MOONFIRE_DOT, 20), refreshDebuff(MOONFIRE_DOT, 24), refreshDebuff(MOONFIRE_DOT, 36)];
    const ctx = ruleCtx([cast(MOONFIRE, 24), cast(MOONFIRE, 36)], { debuffs });
    const finding = evaluateAuraClipped(moonfireClipped, ctx, band(10, 12), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 24, ok: false, label: '4s', detail: 'Refreshed 4s into the aura.' },
      { atS: 36, ok: true, label: '12s', detail: 'Refreshed 12s into the aura.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('let it run at least 10s');
  });
});
