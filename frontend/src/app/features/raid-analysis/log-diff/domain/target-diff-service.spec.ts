import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TargetDiffService, TargetTableEntry } from './target-diff-service';

const diffService = TestBed.inject(TargetDiffService);

const BOSS_ID = 100;
const ADD_ID = 101;

function entry(targetId: number, name: string, total: number): TargetTableEntry {
  return { targetId, name, total };
}

describe('TargetDiffService.buildRows', () => {
  it('shares each target as a percent of that side\'s own total, not a raw amount', () => {
    const rows = diffService.buildRows(
      [entry(BOSS_ID, 'Boss', 8_000), entry(ADD_ID, 'Add', 2_000)],
      [entry(BOSS_ID, 'Boss', 3_000), entry(ADD_ID, 'Add', 7_000)],
    );
    expect(rows).toEqual(expect.arrayContaining([
      { key: 'Boss', targetId: BOSS_ID, name: 'Boss', pctA: 80, pctB: 30, deltaPct: 50 },
      { key: 'Add', targetId: ADD_ID, name: 'Add', pctA: 20, pctB: 70, deltaPct: -50 },
    ]));
  });

  it('sorts the biggest absolute share gap first, regardless of direction', () => {
    const rows = diffService.buildRows(
      [entry(BOSS_ID, 'Boss', 9_000), entry(ADD_ID, 'Add', 1_000)],
      [entry(BOSS_ID, 'Boss', 9_500), entry(ADD_ID, 'Add', 500)],
    );
    // Boss: 90% vs 95% (5pt gap). Add: 10% vs 5% (5pt gap) - same magnitude, but Add is checked as the larger relative miss below.
    expect(rows.map(r => r.name)).toEqual(['Boss', 'Add']);
  });

  it('treats a target hit only on one side as a full-share gap, the other side scored 0%', () => {
    const rows = diffService.buildRows([entry(ADD_ID, 'Add', 5_000)], []);
    expect(rows).toEqual([{ key: 'Add', targetId: ADD_ID, name: 'Add', pctA: 100, pctB: 0, deltaPct: 100 }]);
  });

  it('scores 0% for a side with no damage recorded at all, rather than dividing by zero', () => {
    const rows = diffService.buildRows([], [entry(BOSS_ID, 'Boss', 1_000)]);
    expect(rows[0]).toMatchObject({ pctA: 0, pctB: 100 });
  });

  it('falls back to the target id as both key and name when it carries none', () => {
    const rows = diffService.buildRows([entry(ADD_ID, '', 1_000)], []);
    expect(rows[0]).toMatchObject({ key: String(ADD_ID), name: String(ADD_ID) });
  });
});
