import { describe, expect, it } from 'vitest';
import { LatestRun } from './latest-run';

describe('LatestRun', () => {
  it('treats the only run as current', () => {
    const runs = new LatestRun();
    const token = runs.begin();
    expect(runs.isCurrent(token)).toBe(true);
  });

  it('keeps the newest run current and retires the earlier one', () => {
    const runs = new LatestRun();
    const earlier = runs.begin();
    const later = runs.begin();
    expect(runs.isCurrent(earlier)).toBe(false);
    expect(runs.isCurrent(later)).toBe(true);
  });

  it('retires the run in flight on cancel', () => {
    const runs = new LatestRun();
    const token = runs.begin();
    runs.cancel();
    expect(runs.isCurrent(token)).toBe(false);
  });

  it('leaves a run begun after a cancel current', () => {
    const runs = new LatestRun();
    runs.begin();
    runs.cancel();
    const token = runs.begin();
    expect(runs.isCurrent(token)).toBe(true);
  });
});
