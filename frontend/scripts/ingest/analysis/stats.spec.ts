import { describe, it, expect } from 'vitest';
import { mean, median, stdev, round, groupByTime, clusterBaseStats } from './stats.ts';

describe('mean / median / stdev / round (zero-on-empty contract)', () => {
  it('returns 0 for empty input rather than throwing', () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(stdev([])).toBe(0);
  });

  it('stdev returns 0 for a single sample (needs n >= 2)', () => {
    expect(stdev([42])).toBe(0);
  });

  it('computes mean and sample (n-1) stdev', () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdev([2, 4, 6])).toBe(2); // sample stddev of {2,4,6}
  });

  it('median handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('round defaults to 1 decimal and honors an explicit precision', () => {
    expect(round(1.2345)).toBe(1.2);
    expect(round(1.2345, 3)).toBe(1.235);
    expect(round(1.0)).toBe(1);
  });
});

describe('groupByTime', () => {
  it('clusters windows within mergeS of the running median and splits beyond it', () => {
    const windows = [{ time_s: 10 }, { time_s: 12 }, { time_s: 14 }, { time_s: 60 }];
    const groups = groupByTime(windows, 15);
    expect(groups).toHaveLength(2);
    expect(groups[0].map(w => w.time_s)).toEqual([10, 12, 14]);
    expect(groups[1].map(w => w.time_s)).toEqual([60]);
  });

  it('sorts by time before grouping (input order independent)', () => {
    const groups = groupByTime([{ time_s: 14 }, { time_s: 10 }, { time_s: 12 }], 15);
    expect(groups).toHaveLength(1);
    expect(groups[0].map(w => w.time_s)).toEqual([10, 12, 14]);
  });

  it('returns an empty array for no windows', () => {
    expect(groupByTime([], 15)).toEqual([]);
  });
});

describe('clusterBaseStats', () => {
  it('aggregates time/damage stats and drops abilities present in < half the members', () => {
    const cluster = [
      { time_s: 10, window_damage: 1000, ability_breakdown: [{ spell_id: 1, damage: 600, casts: 2 }, { spell_id: 2, damage: 400 }] },
      { time_s: 12, window_damage: 2000, ability_breakdown: [{ spell_id: 1, damage: 800, casts: 3 }] },
      { time_s: 14, window_damage: 3000, ability_breakdown: [{ spell_id: 1, damage: 900, casts: 4 }] },
    ];
    const stats = clusterBaseStats(cluster, 5);

    expect(stats.count).toBe(3);
    expect(stats.total_samples).toBe(5);
    expect(stats.time_s).toBe(12);
    expect(stats.dmg_avg).toBe(2000);
    expect(stats.dmg_min).toBe(1000);
    expect(stats.dmg_max).toBe(3000);
    // spell 1 is in all 3 members (>= 1.5); spell 2 only in 1 (< 1.5, dropped).
    expect(stats.ability_breakdown.map(a => a.spell_id)).toEqual([1]);
    expect(stats.ability_breakdown[0].avg_damage).toBe(767); // round(mean([600,800,900]))
    expect(stats.ability_breakdown[0].avg_casts).toBe(3); // round(mean([2,3,4]))
  });

  it('picks the majority ref_game_id and defaults to null when none present', () => {
    const withRef = clusterBaseStats([
      { time_s: 1, ref_game_id: 100 }, { time_s: 2, ref_game_id: 100 }, { time_s: 3, ref_game_id: 200 },
    ], 3);
    expect(withRef.ref_game_id).toBe(100);

    const noRef = clusterBaseStats([{ time_s: 1 }, { time_s: 2 }], 2);
    expect(noRef.ref_game_id).toBeNull();
  });
});
