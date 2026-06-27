import { describe, it, expect } from 'vitest';
import { WindowComparisonComponent } from './window-comparison';
import { ComparisonWindow, WindowStatus, RangeRow } from '../../../core/models/window-comparison.models';
import { mountVm } from '../../../../testing/component-harness';

function win(overview: Partial<RangeRow>, status: WindowStatus = 'good'): ComparisonWindow {
  return {
    timeStartS: 0,
    timeEndS: 10,
    spells: [],
    labels: [],
    status,
    statusIcon: 'check_circle',
    overview: { label: '', icon: '', playerPct: null, topAvg: null, topMin: null, topMax: null, ...overview },
    detailRows: [],
  };
}

const overviewMaxOf = (windows: ComparisonWindow[]): number => {
  const { vm } = mountVm(WindowComparisonComponent, { windows });
  return (vm['overviewMax'] as () => number)();
};

const selectedIndexOf = (windows: ComparisonWindow[], higherIsBetter = true): number => {
  const { vm } = mountVm(WindowComparisonComponent, { windows, higherIsBetter });
  return (vm['selectedIndex'] as () => number)();
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

describe('WindowComparisonComponent selectedIndex', () => {
  it('picks the lowest player/top ratio when higher is better (burst)', () => {
    const windows = [
      win({ playerPct: 95, topAvg: 100 }), // ratio 0.95
      win({ playerPct: 40, topAvg: 100 }), // ratio 0.40 - worst
      win({ playerPct: 120, topAvg: 100 }),
    ];
    expect(selectedIndexOf(windows, true)).toBe(1);
  });

  it('picks the highest player/top ratio when lower is better (damage taken)', () => {
    const windows = [
      win({ playerPct: 95, topAvg: 100 }),
      win({ playerPct: 40, topAvg: 100 }),
      win({ playerPct: 200, topAvg: 100 }), // ratio 2.0 - worst (most damage taken)
    ];
    expect(selectedIndexOf(windows, false)).toBe(2);
  });

  it('skips muted windows and windows without player/top data', () => {
    const windows = [
      win({ playerPct: 10, topAvg: 100 }, 'muted'), // muted: ignored despite worst ratio
      win({ playerPct: null, topAvg: 100 }),        // no player data: ignored
      win({ playerPct: 80, topAvg: 100 }),          // only valid window
    ];
    expect(selectedIndexOf(windows, true)).toBe(2);
  });

  it('falls back to 0 when no window has comparable data', () => {
    expect(selectedIndexOf([win({}, 'muted'), win({ playerPct: null, topAvg: null })], true)).toBe(0);
  });
});

describe('WindowComparisonComponent selection', () => {
  it('activates a muted window on select so its top-parse breakdown is visible', () => {
    const windows = [win({ playerPct: 80, topAvg: 100 }), win({}, 'muted')];
    const { vm } = mountVm(WindowComparisonComponent, { windows });
    (vm['select'] as (i: number) => void)(1);
    expect((vm['activeIndex'] as () => number)()).toBe(1);
  });

  it('activates a non-muted window on select, overriding the default', () => {
    const windows = [win({ playerPct: 40, topAvg: 100 }), win({ playerPct: 95, topAvg: 100 })];
    const { vm } = mountVm(WindowComparisonComponent, { windows });
    expect((vm['activeIndex'] as () => number)()).toBe(0); // worst by default
    (vm['select'] as (i: number) => void)(1);
    expect((vm['activeIndex'] as () => number)()).toBe(1);
  });
});

describe('WindowComparisonComponent activeIsMuted', () => {
  const activeIsMutedFor = (status: WindowStatus): boolean => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [win({}, status)] });
    return (vm['activeIsMuted'] as () => boolean)();
  };

  it('treats info (bench-only) the same as muted so the player columns hide', () => {
    expect(activeIsMutedFor('info')).toBe(true);
  });

  it('still treats muted (not reached) as muted', () => {
    expect(activeIsMutedFor('muted')).toBe(true);
  });

  it('is false for a normal compared window', () => {
    expect(activeIsMutedFor('good')).toBe(false);
  });
});

describe('WindowComparisonComponent activeDetailRows', () => {
  function winWithRows(rows: RangeRow[]): ComparisonWindow {
    return { ...win({}), detailRows: rows };
  }

  it('sorts rows by gap ascending (biggest loss first) when higherIsBetter', () => {
    const rows: RangeRow[] = [
      { label: 'A', icon: '', playerPct: 90, topAvg: 100, topMin: null, topMax: null },
      { label: 'B', icon: '', playerPct: 50, topAvg: 100, topMin: null, topMax: null },
      { label: 'C', icon: '', playerPct: 120, topAvg: 100, topMin: null, topMax: null },
    ];
    const { vm } = mountVm(WindowComparisonComponent, { windows: [winWithRows(rows)], higherIsBetter: true });
    (vm['select'] as (i: number) => void)(0);
    const sorted = (vm['activeDetailRows'] as () => RangeRow[])();
    expect(sorted.map(r => r.label)).toEqual(['B', 'A', 'C']);
  });

  it('sorts rows so most damage taken (worst) is first when lower is better', () => {
    const rows: RangeRow[] = [
      { label: 'A', icon: '', playerPct: 90, topAvg: 100, topMin: null, topMax: null },  // loss = 10
      { label: 'B', icon: '', playerPct: 150, topAvg: 100, topMin: null, topMax: null }, // loss = -50 (worst)
      { label: 'C', icon: '', playerPct: 80, topAvg: 100, topMin: null, topMax: null },  // loss = 20 (best)
    ];
    const { vm } = mountVm(WindowComparisonComponent, { windows: [winWithRows(rows)], higherIsBetter: false });
    (vm['select'] as (i: number) => void)(0);
    const sorted = (vm['activeDetailRows'] as () => RangeRow[])();
    expect(sorted.map(r => r.label)).toEqual(['B', 'A', 'C']);
  });
});

describe('WindowComparisonComponent showCasts', () => {
  it('exposes the showCasts input value', () => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [], showCasts: false });
    expect((vm['showCasts'] as () => boolean)()).toBe(false);
  });

  it('defaults showCasts to true', () => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [] });
    expect((vm['showCasts'] as () => boolean)()).toBe(true);
  });
});

describe('WindowComparisonComponent segmentLeftPcts', () => {
  // MIN_GAP_PCT = 5, EDGE_INSET_PCT = 4 -> band [4, 96], default gap 5.
  const INSET = 4;
  const DEFAULT_GAP = 5;

  const winAt = (timeStartS: number, timeEndS: number): ComparisonWindow => ({
    ...win({}),
    timeStartS,
    timeEndS,
  });

  const leftPctsOf = (windows: ComparisonWindow[]): number[] => {
    const { vm } = mountVm(WindowComparisonComponent, { windows });
    return (vm['segmentLeftPcts'] as () => number[])();
  };

  it('leaves well-separated markers at their exact time position', () => {
    // timelineEnd = 100, so timeStartS maps 1:1 to a percent. 20 and 80 are far
    // apart and inside the band, so neither is nudged.
    expect(leftPctsOf([winAt(20, 100), winAt(80, 100)])).toEqual([20, 80]);
  });

  it('spreads near-coincident markers to at least the gap apart', () => {
    const pcts = leftPctsOf([winAt(50, 100), winAt(51, 100)]);
    expect(pcts[1] - pcts[0]).toBeGreaterThanOrEqual(DEFAULT_GAP - 1e-9);
  });

  it('keeps every marker inside the inset band and ordered', () => {
    const pcts = leftPctsOf([winAt(0, 100), winAt(50, 100), winAt(100, 100)]);
    expect(pcts[0]).toBeGreaterThanOrEqual(INSET);
    expect(pcts[pcts.length - 1]).toBeLessThanOrEqual(100 - INSET);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
  });

  it('never overlaps even when many markers crowd the right edge', () => {
    // 25 windows bunched into the last quarter of the fight. A fixed 5% gap
    // (24 * 5 = 120%) cannot fit, so the gap shrinks to fill the band exactly.
    const windows = Array.from({ length: 25 }, (_, i) => winAt(76 + i, 100));
    const pcts = leftPctsOf(windows);
    const band = 100 - 2 * INSET;
    const gap = Math.min(DEFAULT_GAP, band / (windows.length - 1));
    expect(pcts[0]).toBeGreaterThanOrEqual(INSET - 1e-9);
    expect(pcts[pcts.length - 1]).toBeLessThanOrEqual(100 - INSET + 1e-9);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i] - pcts[i - 1]).toBeGreaterThanOrEqual(gap - 1e-9);
    }
  });

  it('returns a lone marker at its exact time without spreading', () => {
    expect(leftPctsOf([winAt(50, 100)])).toEqual([50]);
  });
});

describe('WindowComparisonComponent timeTicks', () => {
  const ticksForEnd = (timeEndS: number): number[] => {
    const w = { ...win({}), timeEndS };
    const { vm } = mountVm(WindowComparisonComponent, { windows: [w] });
    return (vm['timeTicks'] as () => number[])();
  };

  it('returns 6 evenly spaced ticks from 0 to the max window end', () => {
    expect(ticksForEnd(300)).toEqual([0, 60, 120, 180, 240, 300]);
  });

  it('handles short fights', () => {
    expect(ticksForEnd(10)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('falls back to fightDuration when no windows are present', () => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [], fightDuration: 300 });
    expect((vm['timeTicks'] as () => number[])()).toEqual([0, 60, 120, 180, 240, 300]);
  });
});
