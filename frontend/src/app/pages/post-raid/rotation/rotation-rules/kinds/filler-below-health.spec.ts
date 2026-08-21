import { describe, it, expect } from 'vitest';
import { FillerBelowHealthCondition } from '../../../../../core/models/rulebook.models';
import { EXECUTE, SLAM, SHADOW_BLADES_DAMAGE } from '../../../../../../testing/spell-ids';
import { cast, damage } from '../../../../../../testing/builders/events';
import { band, judged, ruleCtx } from '../rule-fixtures';
import { ruleApplicable, ruleLabel, sampleRule } from '../engine';
import { evaluateFillerBelowHealth as rawFillerBelowHealth } from './filler-below-health';

const evaluateFillerBelowHealth = judged(rawFillerBelowHealth);

describe('evaluateFillerBelowHealth', () => {
  const EXECUTE_PCT = 20;
  // What the field runs: nearly every filler below the threshold is the execute ability.
  const FIELD_EXECUTE_SHARE = 0.95;
  const executeBelow: FillerBelowHealthCondition = {
    kind: 'filler_below_health',
    spell_id: EXECUTE, spell_name: 'Execute',
    alternative_spell_ids: [SLAM], alternative_spell_names: ['Slam'],
    health_pct: EXECUTE_PCT,
  };
  // hi pinned at 1 so a fully-converted pass never trips the far side.
  const fieldFloor = band(FIELD_EXECUTE_SHARE, 1);
  // Health rides on damage rows, so each cast reads the last hit on the enemy it named.
  const hitAt = (atS: number, healthPct: number, target?: number) =>
    damage(SHADOW_BLADES_DAMAGE, atS, 1, { targetHealthPct: healthPct, ...(target !== undefined && { target }) });
  const EXECUTE_RANGE_PCT = 15, HEALTHY_PCT = 80;
  const HIT_S = 100;

  it('flags a player still pressing the wrong filler under the threshold', () => {
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(SLAM, HIT_S + 1), cast(SLAM, HIT_S + 1.5)],
      { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(evaluateFillerBelowHealth(executeBelow, ctx, fieldFloor, 'warning')?.measured)
      .toEqual({ value: '33 / 95', unit: '% of fillers' });
  });

  it('passes a player converting every filler under the threshold', () => {
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(EXECUTE, HIT_S + 1)], { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(evaluateFillerBelowHealth(executeBelow, ctx, fieldFloor, 'warning')).toBeNull();
  });

  it('ignores fillers cast above the threshold, which the rule says nothing about', () => {
    const ctx = ruleCtx([cast(SLAM, HIT_S + 0.5)], { damage: [hitAt(HIT_S, HEALTHY_PCT)] });
    expect(evaluateFillerBelowHealth(executeBelow, ctx, fieldFloor, 'warning')).toBeNull();
    expect(ruleApplicable(executeBelow, ctx)).toBe(false);
  });

  it('reads the health of the enemy the cast named, not whichever enemy was hit last', () => {
    const BOSS = 1, DYING_ADD = 2;
    // The add is at 15% and the boss at 80%; a Slam into the boss must not count as an execute-range filler.
    const ctx = ruleCtx([cast(SLAM, HIT_S + 1, { target: BOSS })], {
      damage: [hitAt(HIT_S, HEALTHY_PCT, BOSS), hitAt(HIT_S + 0.5, EXECUTE_RANGE_PCT, DYING_ADD)],
    });
    expect(ruleApplicable(executeBelow, ctx)).toBe(false);
  });

  it('is not applicable on a pull with no health reading to place the casts', () => {
    expect(ruleApplicable(executeBelow, ruleCtx([cast(SLAM, HIT_S)]))).toBe(false);
  });

  it('reads the newest snapshot at or before the cast, so a stale row does not outrank a fresh one', () => {
    const ctx = ruleCtx([cast(SLAM, HIT_S + 1)],
      { damage: [hitAt(HIT_S + 0.5, EXECUTE_RANGE_PCT), hitAt(HIT_S, HEALTHY_PCT)] });
    expect(ruleApplicable(executeBelow, ctx)).toBe(true);
  });

  it('ignores a snapshot older than the sample window, since health falls fast in execute range', () => {
    const STALE_S = 3;
    const ctx = ruleCtx([cast(SLAM, HIT_S + STALE_S)], { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(ruleApplicable(executeBelow, ctx)).toBe(false);
  });

  it('samples the share the pull converted, and nothing when it never reached the threshold', () => {
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(SLAM, HIT_S + 1)], { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(sampleRule(executeBelow, ctx).values).toEqual([0.5]);
    expect(sampleRule(executeBelow, ruleCtx([cast(SLAM, HIT_S + 0.5)], { damage: [hitAt(HIT_S, HEALTHY_PCT)] })).values).toEqual([]);
  });

  it('leaves a coached share over the field\'s own high end alone, since converting more often is not a mistake', () => {
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(EXECUTE, HIT_S + 1)], { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(evaluateFillerBelowHealth(executeBelow, ctx, band(0.5, 0.9), 'warning', 'do x')).toBeNull();
  });

  it('labels the rule as "<spell> under <pct>% health"', () => {
    expect(ruleLabel(executeBelow)).toBe('Execute under 20% health');
  });
});

describe('occurrence strips', () => {
  it('filler_below_health: a chip per filler cast under the health gate, coached vs alternative as the label', () => {
    const executeBelow: FillerBelowHealthCondition = {
      kind: 'filler_below_health',
      spell_id: EXECUTE, spell_name: 'Execute',
      alternative_spell_ids: [SLAM], alternative_spell_names: ['Slam'],
      health_pct: 20,
    };
    const HIT_S = 100;
    const hitAt = (atS: number, healthPct: number) => damage(SHADOW_BLADES_DAMAGE, atS, 1, { targetHealthPct: healthPct });
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(SLAM, HIT_S + 1)], { damage: [hitAt(HIT_S, 15)] });
    const finding = evaluateFillerBelowHealth(executeBelow, ctx, band(0.95, 1), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 100.5, ok: true, label: 'Execute', detail: 'Execute was the coached filler here.' },
      { atS: 101, ok: false, label: 'Slam', detail: 'Slam was pressed instead of Execute here.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('95% or more Execute under 20% health');
  });
});
