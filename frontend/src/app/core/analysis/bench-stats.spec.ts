import { describe, it, expect } from 'vitest';
import { isOutlierAbove, isOutlierBeyond, isCriticallyBelow, expectedUses, benchExpectedUses, castEfficiencyPct, closestToZero } from './bench-stats';

describe('isOutlierAbove', () => {
  // mean 10, stddev 2, 2 sigma -> threshold is 14. Strictly greater than 14 is an outlier.
  it.each([
    { value: 15, outlier: true, why: 'above the 2-sigma threshold' },
    { value: 14, outlier: false, why: 'exactly at the threshold (strict comparison)' },
    { value: 13.999, outlier: false, why: 'just below the threshold' },
    { value: 0, outlier: false, why: 'far below the mean' },
  ])('treats $value as outlier=$outlier ($why)', ({ value, outlier }) => {
    expect(isOutlierAbove(value, 10, 2)).toBe(outlier);
  });

  it('honours a custom sigma count', () => {
    expect(isOutlierAbove(13, 10, 1, 3)).toBe(false); // threshold 13, not strictly greater
    expect(isOutlierAbove(13.1, 10, 1, 3)).toBe(true);
  });
});

describe('isOutlierBeyond (two-tailed)', () => {
  // mean 0, stddev 5, 2 sigma -> flag when |value| > 10.
  it.each([
    { value: 11, outlier: true },
    { value: -11, outlier: true },
    { value: 10, outlier: false },
    { value: -10, outlier: false },
    { value: 3, outlier: false },
  ])('flags $value as outlier=$outlier', ({ value, outlier }) => {
    expect(isOutlierBeyond(value, 0, 5)).toBe(outlier);
  });
});

describe('isCriticallyBelow', () => {
  // mean 70, stddev 4 -> critical when value < 66.
  it.each([
    { value: 65, critical: true },
    { value: 66, critical: false },
    { value: 80, critical: false },
  ])('treats $value as critical=$critical', ({ value, critical }) => {
    expect(isCriticallyBelow(value, 70, 4)).toBe(critical);
  });
});

describe('expectedUses', () => {
  it('is 1 + floor(fightDuration / cooldown)', () => {
    expect(expectedUses(300, 90)).toBe(4); // 1 + floor(3.33)
    expect(expectedUses(90, 90)).toBe(2); // 1 + floor(1)
    expect(expectedUses(89, 90)).toBe(1); // 1 + floor(0.98)
  });
});

describe('castEfficiencyPct', () => {
  it('is the share of fight time NOT spent in gaps', () => {
    expect(castEfficiencyPct(30, 300)).toBeCloseTo(90);
    expect(castEfficiencyPct(0, 300)).toBe(100);
  });

  it('clamps to zero when downtime exceeds the fight length', () => {
    expect(castEfficiencyPct(400, 300)).toBe(0);
  });
});

describe('closestToZero', () => {
  it('returns the value with the smallest absolute magnitude', () => {
    expect(closestToZero([5, -2, 8])).toBe(-2);
    expect(closestToZero([-1, 1])).toBe(-1); // ties keep the first-seen best
  });
});

describe('benchExpectedUses', () => {
  it('returns null when neither uses_per_min nor avg_uses_per_min is set', () => {
    expect(benchExpectedUses(300, undefined, null)).toBeNull();
  });

  it('uses uses_per_min.avg when provided', () => {
    // 0.5 uses/min * 5 min = 2.5 -> rounds to 3; stddev 0 -> floor 3
    const upm = { avg: 0.5, stddev: 0, min: 0.5, max: 0.5 };
    expect(benchExpectedUses(300, upm, null)).toEqual({ expected: 3, floor: 3 });
  });

  it('falls back to avg_uses_per_min when uses_per_min is absent', () => {
    // 0.4/min * 5 min = 2.0 -> rounds to 2; floor 2
    expect(benchExpectedUses(300, undefined, 0.4)).toEqual({ expected: 2, floor: 2 });
  });

  it('sets floor as expected minus scaled stddev (cohort - 1 sigma)', () => {
    // rate=0.5/min, stddev=0.2/min, fight=5min
    // expected = round(0.5*5) = round(2.5) = 3
    // sd = 0.2*5 = 1.0
    // floor = max(0, round(3 - 1)) = 2
    const upm = { avg: 0.5, stddev: 0.2, min: 0.3, max: 0.7 };
    expect(benchExpectedUses(300, upm, null)).toEqual({ expected: 3, floor: 2 });
  });

  it('clamps floor to zero when stddev is very large', () => {
    const upm = { avg: 0.5, stddev: 2, min: 0, max: 1 };
    expect(benchExpectedUses(300, upm, null)?.floor).toBe(0);
  });

  it('returns expected=0 for a very short fight at a low usage rate', () => {
    // 0.2/min * 1 min = 0.2 -> rounds to 0; allows zero-cast suppression
    const upm = { avg: 0.2, stddev: 0, min: 0.2, max: 0.2 };
    expect(benchExpectedUses(60, upm, null)).toEqual({ expected: 0, floor: 0 });
  });
});
