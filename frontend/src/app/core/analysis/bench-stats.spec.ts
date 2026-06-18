import { describe, it, expect } from 'vitest';
import { isOutlierAbove, isOutlierBeyond, isCriticallyBelow, expectedUses, castEfficiencyPct, closestToZero } from './bench-stats';

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
