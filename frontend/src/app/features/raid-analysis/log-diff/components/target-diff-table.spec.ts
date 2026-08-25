import { describe, it, expect } from 'vitest';
import { mountVm } from '../../../../../testing/component-harness';
import { TargetDiffTable } from './target-diff-table';
import { ComparisonView } from '../domain/log-diff.models';

function view(targetRows: ComparisonView['targetRows']): ComparisonView {
  return { playerA: 'Ana', playerB: 'Bo', totalDpsA: 0, totalDpsB: 0, rows: [], targetRows };
}

describe('TargetDiffTable', () => {
  it('scales every bar against the row with the biggest |delta|', () => {
    const { vm } = mountVm(TargetDiffTable, {
      view: view([
        { key: 'Boss', targetId: 1, name: 'Boss', pctA: 90, pctB: 40, deltaPct: 50 },
        { key: 'Add', targetId: 2, name: 'Add', pctA: 10, pctB: 60, deltaPct: -50 },
      ]),
    });
    expect(vm['barPct'](50)).toBe(100);
    expect(vm['barPct'](-25)).toBe(50);
  });

  it('caps a bar at 100%, even past the recorded max (defensive floor)', () => {
    const { vm } = mountVm(TargetDiffTable, { view: view([{ key: 'Boss', targetId: 1, name: 'Boss', pctA: 60, pctB: 50, deltaPct: 10 }]) });
    expect(vm['barPct'](999)).toBe(100);
  });

  it('never divides by zero when every row ties at 0 delta', () => {
    const { vm } = mountVm(TargetDiffTable, { view: view([{ key: 'Boss', targetId: 1, name: 'Boss', pctA: 50, pctB: 50, deltaPct: 0 }]) });
    expect(vm['barPct'](0)).toBe(0);
  });
});
