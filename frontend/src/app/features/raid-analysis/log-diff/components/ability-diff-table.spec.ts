import { describe, it, expect } from 'vitest';
import { mountVm } from '../../../../../testing/component-harness';
import { AbilityDiffTable } from './ability-diff-table';
import { ComparisonView } from '../domain/log-diff.models';

function view(rows: ComparisonView['rows']): ComparisonView {
  return { playerA: 'Ana', playerB: 'Bo', totalDpsA: 0, totalDpsB: 0, rows, targetRows: [] };
}

describe('AbilityDiffTable', () => {
  it('scales every bar against the row with the biggest |delta|', () => {
    const { vm } = mountVm(AbilityDiffTable, {
      view: view([
        { key: 'a', abilityId: 1, name: 'A', dpsA: 100, dpsB: 0, deltaDps: 100, castsA: 0, castsB: 0 },
        { key: 'b', abilityId: 2, name: 'B', dpsA: 25, dpsB: 0, deltaDps: 25, castsA: 0, castsB: 0 },
      ]),
    });
    expect(vm['barPct'](100)).toBe(100);
    expect(vm['barPct'](25)).toBe(25);
  });

  it('caps a bar at 100%, even past the recorded max (defensive floor)', () => {
    const { vm } = mountVm(AbilityDiffTable, { view: view([{ key: 'a', abilityId: 1, name: 'A', dpsA: 10, dpsB: 0, deltaDps: 10, castsA: 0, castsB: 0 }]) });
    expect(vm['barPct'](999)).toBe(100);
  });

  it('never divides by zero when every row ties at 0 delta', () => {
    const { vm } = mountVm(AbilityDiffTable, { view: view([{ key: 'a', abilityId: 1, name: 'A', dpsA: 5, dpsB: 5, deltaDps: 0, castsA: 0, castsB: 0 }]) });
    expect(vm['barPct'](0)).toBe(0);
  });
});
