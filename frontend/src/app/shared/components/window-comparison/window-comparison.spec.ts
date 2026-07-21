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

  it('ignores a NaN value so one bad datum never blanks the whole bar', () => {
    expect(overviewMaxOf([win({ topAvg: 100, playerPct: NaN }), win({ topMax: 250 })])).toBe(250);
  });
});

describe('WindowComparisonComponent overviewDelta', () => {
  it('computes the signed percent gap for finite values', () => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [win({ playerPct: 90, topAvg: 100 })] });
    expect((vm['overviewDelta'] as () => number | null)()).toBeCloseTo(-10, 9);
  });

  it('is null (muted) when the player value is NaN, never a NaN badge', () => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [win({ playerPct: NaN, topAvg: 100 })] });
    expect((vm['overviewDelta'] as () => number | null)()).toBeNull();
    expect((vm['overviewDeltaStatus'] as () => string)()).toBe('muted');
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
  function winWithRows(rows: RangeRow[], status: WindowStatus = 'good'): ComparisonWindow {
    return { ...win({}, status), detailRows: rows };
  }

  // A muted window's breakdown has top-parse damage but no player value; the whole top value is the loss.
  const SMALL_TOP_DAMAGE = 40_000;
  const LARGE_TOP_DAMAGE = 900_000;
  const mutedNullRows = (): RangeRow[] => [
    { label: 'small', icon: '', playerPct: null, topAvg: SMALL_TOP_DAMAGE, topMin: null, topMax: null },
    { label: 'large', icon: '', playerPct: null, topAvg: LARGE_TOP_DAMAGE, topMin: null, topMax: null },
  ];

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

  it('ranks null-player rows (muted window) by top damage biggest-first when lower is better', () => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [winWithRows(mutedNullRows(), 'muted')], higherIsBetter: false });
    (vm['select'] as (i: number) => void)(0);
    const sorted = (vm['activeDetailRows'] as () => RangeRow[])();
    expect(sorted.map(r => r.label)).toEqual(['large', 'small']);
  });

  it('ranks null-player rows by top damage biggest-first when higher is better too', () => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [winWithRows(mutedNullRows(), 'muted')], higherIsBetter: true });
    (vm['select'] as (i: number) => void)(0);
    const sorted = (vm['activeDetailRows'] as () => RangeRow[])();
    expect(sorted.map(r => r.label)).toEqual(['large', 'small']);
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

describe('WindowComparisonComponent timelineCells', () => {
  // GAP_SLOT_SECONDS = 20: each dashed pacing slot stands for 20s of pause
  // (next.start - this.end), floored, so a sub-20s pause is the same burst (0 slots)
  // and longer lulls add proportionally more slots with no cap.
  const SLOT_SECONDS = 20;

  type Cell = { kind: 'window'; index: number } | { kind: 'gap'; id: string };

  const winSpan = (timeStartS: number, timeEndS: number): ComparisonWindow => ({
    ...win({}),
    timeStartS,
    timeEndS,
  });

  // One mount whose `windows` input is re-set per case (mountVm's TestBed configures
  // once, so a test never mounts twice). Two windows: the first ends at 0, the second
  // starts at `pauseS`, so the gap count is a direct function of the pause between them.
  const gapCounter = () => {
    const { vm, setInput } = mountVm(WindowComparisonComponent, { windows: [] as ComparisonWindow[] });
    const cells = vm['timelineCells'] as () => Cell[];
    return (pauseS: number): number => {
      setInput('windows', [winSpan(0, 0), winSpan(pauseS, pauseS + 10)]);
      return cells().filter(c => c.kind === 'gap').length;
    };
  };

  it('emits no gap slots for a pause under one slot (same burst)', () => {
    const gaps = gapCounter();
    expect(gaps(SLOT_SECONDS - 1)).toBe(0);
    expect(gaps(SLOT_SECONDS)).toBe(1);
  });

  it('adds one more slot per further 20s of pause', () => {
    const gaps = gapCounter();
    expect(gaps(2 * SLOT_SECONDS - 1)).toBe(1);
    expect(gaps(2 * SLOT_SECONDS)).toBe(2);
    expect(gaps(3 * SLOT_SECONDS)).toBe(3);
  });

  it('is uncapped, so a long lull keeps adding slots', () => {
    expect(gapCounter()(10 * SLOT_SECONDS)).toBe(10);
  });

  it('interleaves window and gap cells in fight order', () => {
    // 0->0 (start), then a 40s pause (2 slots) to the second window.
    const { vm } = mountVm(WindowComparisonComponent, { windows: [winSpan(0, 0), winSpan(2 * SLOT_SECONDS, 2 * SLOT_SECONDS + 10)] });
    const cells = (vm['timelineCells'] as () => Cell[])();
    expect(cells.map(c => c.kind)).toEqual(['window', 'gap', 'gap', 'window']);
    expect(cells.filter(c => c.kind === 'window').map(c => (c as { index: number }).index)).toEqual([0, 1]);
  });

  it('is empty when there are no windows', () => {
    const { vm } = mountVm(WindowComparisonComponent, { windows: [] });
    expect((vm['timelineCells'] as () => Cell[])()).toEqual([]);
  });
});
