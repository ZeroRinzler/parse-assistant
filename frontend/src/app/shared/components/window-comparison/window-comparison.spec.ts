import { describe, it, expect } from 'vitest';
import { WindowComparisonComponent, ComparisonWindow } from './window-comparison';
import { RangeRow } from '../range-chart/range-chart';
import { mountVm } from '../../../../testing/component-harness';

function win(overview: Partial<RangeRow>): ComparisonWindow {
  return {
    timeStartS: 0,
    timeEndS: 10,
    spellIds: [],
    labels: [],
    status: 'good',
    statusIcon: 'check_circle',
    overview: { label: '', playerPct: null, topAvg: null, topMin: null, topMax: null, ...overview },
    detailRows: [],
  };
}

const overviewMaxOf = (windows: ComparisonWindow[]): number => {
  const { vm } = mountVm(WindowComparisonComponent, { windows });
  return (vm['overviewMax'] as () => number)();
};

describe('WindowComparisonComponent overviewMax', () => {
  it('is the largest of topAvg / topMax / playerPct across every window', () => {
    expect(overviewMaxOf([win({ topAvg: 100, topMax: 250, playerPct: 180 }), win({ topAvg: 90, topMax: 120, playerPct: 300 })])).toBe(300);
  });

  it('ignores null comparison values', () => {
    expect(overviewMaxOf([win({ topAvg: null, topMax: 42, playerPct: null })])).toBe(42);
  });

  it('floors at 0.01 so an all-null/empty set never yields a zero scale', () => {
    expect(overviewMaxOf([win({})])).toBe(0.01);
  });
});
