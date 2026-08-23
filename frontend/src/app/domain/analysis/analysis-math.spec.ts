import {
  round, getOrInsert, groupByTime, isOutlierAbove, isOutlierBeyond, isOutlierBelow,
  castEfficiencyPct, closestToZero, benchExpectedUses, fmtClock, sortBySeverity,
} from './analysis-math';
import { AnalysisFinding } from './analysis.models';

describe('round', () => {
  it('rounds to one decimal by default', () => {
    expect(round(1.249)).toBe(1.2);
  });
  it('honours an explicit decimal count', () => {
    expect(round(1.2349, 3)).toBe(1.235);
  });
});

describe('getOrInsert', () => {
  it('inserts and returns the default when the key is absent', () => {
    const map = new Map<string, number[]>();
    const list = getOrInsert(map, 'a', () => []);
    list.push(1);
    expect(map.get('a')).toEqual([1]);
  });
  it('returns the existing value without calling the factory again', () => {
    const map = new Map<string, number[]>();
    getOrInsert(map, 'a', () => []).push(1);
    let calls = 0;
    getOrInsert(map, 'a', () => { calls += 1; return []; }).push(2);
    expect(calls).toBe(0);
    expect(map.get('a')).toEqual([1, 2]);
  });
});

describe('groupByTime', () => {
  const MERGE_S = 5;
  it('keeps windows within mergeS of the running median in one cluster', () => {
    // 0 and 4 cluster (median 2); 6 is within 5 of that median, so all three merge.
    const clusters = groupByTime([{ time_s: 0 }, { time_s: 4 }, { time_s: 6 }], MERGE_S);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });
  it('opens a new cluster when a window is beyond mergeS of the median', () => {
    // 0 and 4 cluster (median 2); 20 is > 5 from the median, so it splits off.
    const clusters = groupByTime([{ time_s: 0 }, { time_s: 4 }, { time_s: 20 }], MERGE_S);
    expect(clusters).toHaveLength(2);
    expect(clusters[1]).toEqual([{ time_s: 20 }]);
  });
});

describe('isOutlierAbove', () => {
  const MEAN = 10;
  const STDDEV = 2;
  // mean + 2*stddev = 14 is the strict boundary.
  it('flags a value more than two sigma above the mean', () => {
    expect(isOutlierAbove(14.1, MEAN, STDDEV)).toBe(true);
  });
  it('does not flag a value exactly at the two-sigma boundary', () => {
    expect(isOutlierAbove(14, MEAN, STDDEV)).toBe(false);
  });
});

describe('isOutlierBeyond', () => {
  const MEAN = 10;
  const STDDEV = 2;
  it('flags a value more than two sigma below the mean', () => {
    expect(isOutlierBeyond(5.9, MEAN, STDDEV)).toBe(true);
  });
  it('does not flag a value exactly at the boundary', () => {
    expect(isOutlierBeyond(6, MEAN, STDDEV)).toBe(false);
  });
});

describe('isOutlierBelow', () => {
  const MEAN = 10;
  const STDDEV = 2;
  it('flags a value more than the default two sigma below the mean', () => {
    // mean - 2*stddev = 6 is the strict boundary.
    expect(isOutlierBelow(5.9, MEAN, STDDEV)).toBe(true);
    expect(isOutlierBelow(6, MEAN, STDDEV)).toBe(false);
  });
  it('honors an explicit sigma count (one sigma below)', () => {
    // mean - stddev = 8 is the strict boundary.
    expect(isOutlierBelow(7.9, MEAN, STDDEV, 1)).toBe(true);
    expect(isOutlierBelow(8, MEAN, STDDEV, 1)).toBe(false);
  });
});

describe('castEfficiencyPct', () => {
  const FIGHT_DUR_S = 100;
  it('reports the share of fight time spent casting', () => {
    expect(castEfficiencyPct(20, FIGHT_DUR_S)).toBe(80);
  });
  it('clamps to zero when downtime exceeds the fight', () => {
    expect(castEfficiencyPct(150, FIGHT_DUR_S)).toBe(0);
  });
});

describe('closestToZero', () => {
  it('returns the value with the smallest absolute magnitude', () => {
    expect(closestToZero([-3, 1, 4])).toBe(1);
  });
  it('returns 0 for an empty array', () => {
    expect(closestToZero([])).toBe(0);
  });
});

describe('benchExpectedUses', () => {
  const FIGHT_DUR_S = 120;
  it('scales avg uses/min by the fight length', () => {
    expect(benchExpectedUses(FIGHT_DUR_S, { avg: 2, stddev: 0 }).expected).toBe(4);
  });
  it('floors the -1 sigma estimate at zero', () => {
    expect(benchExpectedUses(FIGHT_DUR_S, { avg: 1, stddev: 5 }).floor).toBe(0);
  });
});

describe('fmtClock', () => {
  it('zero-pads minutes and seconds', () => {
    expect(fmtClock(65)).toBe('01:05');
  });
});

describe('sortBySeverity', () => {
  it('orders critical first and success last, stable for equal ranks', () => {
    // info and hold_suggestion share rank 2, so their input order must survive the sort.
    const findings = [
      { severity: 'success', message: 's' },
      { severity: 'info', message: 'i' },
      { severity: 'hold_suggestion', message: 'h' },
      { severity: 'critical', message: 'c' },
    ] as AnalysisFinding[];
    sortBySeverity(findings);
    expect(findings.map(finding => finding.message)).toEqual(['c', 'i', 'h', 's']);
  });
});
