import { assert, describe, it, expect } from 'vitest';
import { CastAtTargetCountCondition, ResourceAtCastCondition } from '../../../../core/models/rulebook.models';
import { BLACK_POWDER, EVISCERATE } from '../../../../../testing/spell-ids';
import { cast, damage } from '../../../../../testing/builders/events';
import { COMBO_POINT_TYPE, MAX_COMBO_POINTS, band, judged, ruleCtx } from '../../../../../testing/rule-fixtures';
import { evaluateCastAtTargetCount as rawCastAtTargetCount } from './kinds/cast-at-target-count';
import { evaluateResourceAtCast as rawResourceAtCast } from './kinds/resource-at-cast';

const evaluateCastAtTargetCount = judged(rawCastAtTargetCount);
const evaluateResourceAtCast = judged(rawResourceAtCast);

describe('occurrence strips', () => {
  it('caps a finding at MAX_OCCURRENCES, keeping chronological order', () => {
    const OVER_CAP_CASTS = 30;
    const blackPowder: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
    };
    const casts = Array.from({ length: OVER_CAP_CASTS }, (_, i) => cast(BLACK_POWDER, i + 1));
    const dmg = Array.from({ length: OVER_CAP_CASTS }, (_, i) => damage(BLACK_POWDER, i + 1.5, 100, { target: 1 }));
    const finding = evaluateCastAtTargetCount(blackPowder, ruleCtx(casts, { damage: dmg }), band(3), 'warning');
    assert.exists(finding);
    const occurrences = finding.occurrences;
    expect(occurrences.length).toBe(24);
    assert.exists(occurrences[0]);
    expect(occurrences[0].atS).toBe(1);
    const timestamps = occurrences.map(o => o.atS);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it('never drops a violation from the sampled strip, even when passing casts alone exceed the cap', () => {
    const finisher: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Eviscerate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'min',
    };
    const atCombo = (atS: number, amount: number) =>
      cast(EVISCERATE, atS, { resources: [{ amount, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
    const FAIL_AT_S = [5, 15, 25];
    const fails = FAIL_AT_S.map(atS => atCombo(atS, 1));
    const PASSING_CASTS = 30; // clears MAX_OCCURRENCES (24) so sampling kicks in
    const passes = Array.from({ length: PASSING_CASTS }, (_, i) => atCombo(100 + i, MAX_COMBO_POINTS));
    const finding = evaluateResourceAtCast(finisher, ruleCtx([...fails, ...passes]), band(1), 'warning');
    assert.exists(finding);
    const occurrences = finding.occurrences;
    expect(occurrences.length).toBe(24);
    const failingAtS = occurrences.filter(occ => !occ.ok).map(occ => occ.atS);
    expect(failingAtS).toEqual(FAIL_AT_S);
  });
});
