import { describe, it, expect } from 'vitest';
import { WindowComparison } from './window-comparison';
import type { ComparisonWindow, WindowStatus, RangeRow } from '../../../domain/analysis/window-comparison.models';
import { badgeStatus, mountDom, MountedDom } from '../../../../testing/component-harness';

const CHIP = 'button[role="option"]';
const LISTBOX = '[role="listbox"]';
const BAR_TRACK = 'div.h-5';
const PLAYER_FILL = `${BAR_TRACK} > div[class*="opacity-"]`;
const AVG_MARKER = `${BAR_TRACK} > div[class*="w-[2px]"]`;
const DELTA_BADGE = 'span[class*="badge-"]';
const CELL = '[role="listbox"] div.flex-col.shrink-0';
const GAP_CELL = `${CELL}[aria-hidden="true"]`;

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

const render = (windows: ComparisonWindow[], inputs: Record<string, unknown> = {}): MountedDom =>
  mountDom(WindowComparison, { windows, ...inputs });

function selectedChip(dom: MountedDom): number {
  return dom.queryAll(CHIP).findIndex(chip => chip.getAttribute('aria-selected') === 'true');
}

function pressKey(dom: MountedDom, key: string): void {
  const listbox = dom.query(LISTBOX);
  if (!listbox) throw new Error('no listbox rendered');
  dom.dispatch(listbox, new KeyboardEvent('keydown', { key }));
}

const threeWindows = (): ComparisonWindow[] => [
  win({ playerPct: 95, topAvg: 100 }),
  win({ playerPct: 40, topAvg: 100 }),
  win({ playerPct: 120, topAvg: 100 }),
];

describe('WindowComparison chip selection', () => {
  it('renders one chip per window, labelled with its start time', () => {
    const LATE_START_S = 65;
    const dom = render([win({}), { ...win({}), timeStartS: LATE_START_S }]);

    const chips = dom.queryAll(CHIP);
    expect(chips).toHaveLength(2);
    expect(chips[0]?.getAttribute('aria-label')).toBe('0:00');
    expect(chips[1]?.getAttribute('aria-label')).toBe('1:05');
  });

  it('opens on the worst window (lowest player/top ratio) when higher is better', () => {
    expect(selectedChip(render(threeWindows(), { higherIsBetter: true }))).toBe(1);
  });

  it('opens on the highest player/top ratio when lower is better (damage taken)', () => {
    const windows = [
      win({ playerPct: 95, topAvg: 100 }),
      win({ playerPct: 40, topAvg: 100 }),
      win({ playerPct: 200, topAvg: 100 }),
    ];
    expect(selectedChip(render(windows, { higherIsBetter: false }))).toBe(2);
  });

  it('skips muted windows and windows with no player data when picking the opening chip', () => {
    const windows = [
      win({ playerPct: 10, topAvg: 100 }, 'muted'), // muted: ignored despite the worst ratio
      win({ playerPct: null, topAvg: 100 }),        // no player data: ignored
      win({ playerPct: 80, topAvg: 100 }),          // the only comparable window
    ];
    expect(selectedChip(render(windows))).toBe(2);
  });

  it('opens on the first chip when no window has comparable data', () => {
    expect(selectedChip(render([win({}, 'muted'), win({ playerPct: null, topAvg: null })]))).toBe(0);
  });

  it('activates the clicked chip, overriding the opening pick', () => {
    const dom = render(threeWindows());
    expect(selectedChip(dom)).toBe(1);

    dom.queryAll(CHIP)[2]?.click();
    dom.detectChanges();

    expect(selectedChip(dom)).toBe(2);
  });

  it('activates a muted window on click, so its top-parse breakdown is still reachable', () => {
    const dom = render([win({ playerPct: 80, topAvg: 100 }), win({}, 'muted')]);

    dom.queryAll(CHIP)[1]?.click();
    dom.detectChanges();

    expect(selectedChip(dom)).toBe(1);
  });

  it('drops a manual pick when the windows input swaps, reopening on the worst of the new set', () => {
    const MANUAL_PICK = 3;
    const dom = render([
      win({ playerPct: 40, topAvg: 100 }), // worst of this set, so the opening pick is 0
      win({ playerPct: 90, topAvg: 100 }),
      win({ playerPct: 85, topAvg: 100 }),
      win({ playerPct: 95, topAvg: 100 }),
    ]);
    dom.queryAll(CHIP)[MANUAL_PICK]?.click();
    dom.detectChanges();
    expect(selectedChip(dom)).toBe(MANUAL_PICK);

    // The shorter set has no index 3, so a pick that outlived its windows would blank the breakdown.
    const WORST_OF_SWAPPED = 1;
    dom.setInput('windows', [win({ playerPct: 95, topAvg: 100 }), win({ playerPct: 40, topAvg: 100 })]);

    expect(selectedChip(dom)).toBe(WORST_OF_SWAPPED);
    expect(dom.query(BAR_TRACK)).not.toBeNull();
  });
});

describe('WindowComparison keyboard navigation', () => {
  it('moves one chip right on ArrowRight', () => {
    const dom = render(threeWindows());
    expect(selectedChip(dom)).toBe(1);

    pressKey(dom, 'ArrowRight');

    expect(selectedChip(dom)).toBe(2);
  });

  it('moves one chip left on ArrowLeft', () => {
    const dom = render(threeWindows());

    pressKey(dom, 'ArrowLeft');

    expect(selectedChip(dom)).toBe(0);
  });

  it('clamps at the ends instead of wrapping', () => {
    const dom = render(threeWindows());

    pressKey(dom, 'ArrowLeft');
    pressKey(dom, 'ArrowLeft');

    expect(selectedChip(dom)).toBe(0);
  });

  it('ignores a key that is not a left/right arrow', () => {
    const dom = render(threeWindows());

    pressKey(dom, 'Enter');

    expect(selectedChip(dom)).toBe(1);
  });

  it('points aria-activedescendant at exactly the active chip, so a screen reader follows the selection', () => {
    const dom = render(threeWindows());
    const activeId = () => dom.query(LISTBOX)?.getAttribute('aria-activedescendant');

    expect(activeId()).toBe(dom.queryAll(CHIP)[1]?.id);

    pressKey(dom, 'ArrowRight');

    expect(activeId()).toBe(dom.queryAll(CHIP)[2]?.id);
  });
});

describe('WindowComparison damage bar', () => {
  it('scales the bars so the largest value across every window fills the track', () => {
    const MAX_PLAYER_PCT = 300;
    const dom = render([
      win({ topAvg: 100, topMax: 250, playerPct: 180 }),
      win({ topAvg: 90, topMax: 120, playerPct: MAX_PLAYER_PCT }),
    ]);

    // Window 1 has the worst ratio against its own top avg, so it opens: 180 of a 300 scale.
    expect(dom.query(PLAYER_FILL)?.style.width).toBe('60%');

    dom.queryAll(CHIP)[1]?.click();
    dom.detectChanges();

    expect(dom.query(PLAYER_FILL)?.style.width).toBe('100%');
  });

  it('places the top-average marker on the same scale', () => {
    const dom = render([win({ topAvg: 50, topMax: 100, topMin: 20, playerPct: 100 })]);
    expect(dom.query(AVG_MARKER)?.style.left).toBe('50%');
  });

  it('still renders a usable bar when one window carries a NaN value', () => {
    const dom = render([win({ topAvg: 100, playerPct: NaN }), win({ topMax: 250, playerPct: 250 })]);

    dom.queryAll(CHIP)[1]?.click();
    dom.detectChanges();

    expect(dom.query(PLAYER_FILL)?.style.width).toBe('100%');
  });

  it('renders the empty track, and no fill, for a window with nothing to compare', () => {
    const dom = render([win({})]);

    expect(dom.query(BAR_TRACK)).not.toBeNull();
    expect(dom.query(PLAYER_FILL)).toBeNull();
  });
});

describe('WindowComparison delta badge', () => {
  it('shows the signed percent gap against the top average', () => {
    const dom = render([win({ playerPct: 90, topAvg: 100 })]);
    expect(dom.query(DELTA_BADGE)?.textContent.trim()).toBe('-10%');
  });

  it('marks a player ahead of top average as better, and one behind as worse', () => {
    expect(badgeStatus(render([win({ playerPct: 110, topAvg: 100 })]).query(DELTA_BADGE))).toBe('success');
    expect(badgeStatus(render([win({ playerPct: 90, topAvg: 100 })]).query(DELTA_BADGE))).toBe('critical');
  });

  it('flips which direction counts as better for damage taken', () => {
    expect(badgeStatus(render([win({ playerPct: 90, topAvg: 100 })], { higherIsBetter: false }).query(DELTA_BADGE)))
      .toBe('success');
  });

  it('hides the badge entirely rather than rendering a NaN percentage', () => {
    const dom = render([win({ playerPct: NaN, topAvg: 100 })]);

    expect(dom.query(DELTA_BADGE)).toBeNull();
  });

  it('reads "not reached" instead of a player number for a muted window', () => {
    const dom = render([win({ playerPct: null, topAvg: 100 }, 'muted')]);

    expect(dom.text()).toContain('not reached');
    expect(dom.query(DELTA_BADGE)).toBeNull();
  });

  it('shows the top-parse damage, never the player\'s, for a bench-only window', () => {
    const PLAYER_DAMAGE = 2_000_000;
    const TOP_AVG_DAMAGE = 1_000_000;
    const dom = render([win({ playerPct: PLAYER_DAMAGE, topAvg: TOP_AVG_DAMAGE }, 'info')]);

    expect(dom.text()).toContain('1M');
    expect(dom.text()).not.toContain('2M');
    expect(dom.query(DELTA_BADGE)).toBeNull();
  });
});

describe('WindowComparison detail rows', () => {
  const detailRow = (label: string, spellId: number, playerPct: number | null, topAvg: number): RangeRow =>
    ({ label, icon: '', spellId, playerPct, topAvg, topMin: null, topMax: null });

  it('orders the breakdown worst loss first, so the biggest miss reads at the top', () => {
    const windows = [{
      ...win({ playerPct: 100, topAvg: 100 }),
      detailRows: [detailRow('Small miss', 1, 90, 100), detailRow('Big miss', 2, 20, 100), detailRow('Ahead', 3, 150, 100)],
    }];

    const labels = render(windows).queryAll('wl-compact-ability-row').map(el => el.textContent);

    expect(labels[0]).toContain('Big miss');
    expect(labels[1]).toContain('Small miss');
    expect(labels[2]).toContain('Ahead');
  });

  it('puts the most damage taken first when lower is better', () => {
    const windows = [{
      ...win({ playerPct: 100, topAvg: 100 }),
      detailRows: [
        detailRow('Middle hit', 1, 90, 100),
        detailRow('Biggest hit', 2, 150, 100),
        detailRow('Smallest hit', 3, 80, 100),
      ],
    }];

    const labels = render(windows, { higherIsBetter: false }).textAll('wl-compact-ability-row');

    expect(labels[0]).toContain('Biggest hit');
    expect(labels[1]).toContain('Middle hit');
    expect(labels[2]).toContain('Smallest hit');
  });

  it('ranks an unreached window\'s breakdown by top damage, biggest first, whichever direction is better', () => {
    const SMALL_TOP_DAMAGE = 40_000;
    const LARGE_TOP_DAMAGE = 900_000;
    // No player value means the whole top-parse damage is the loss, so the order cannot come from a gap.
    const windows = [{
      ...win({}, 'muted'),
      detailRows: [
        detailRow('Small window', 1, null, SMALL_TOP_DAMAGE),
        detailRow('Large window', 2, null, LARGE_TOP_DAMAGE),
      ],
    }];
    const firstLabel = (inputs: Record<string, unknown>): string =>
      render(windows, inputs).textAll('wl-compact-ability-row')[0] ?? '';

    expect(firstLabel({ higherIsBetter: true })).toContain('Large window');
    expect(firstLabel({ higherIsBetter: false })).toContain('Large window');
  });

  it('emits the active window index when the map button is used', () => {
    const dom = render(threeWindows(), { showMap: true });
    const opened = dom.on('openMap');

    dom.click('button[title="Open positioning map"]');
    expect(opened).toEqual([1]);

    dom.queryAll(CHIP)[2]?.click();
    dom.detectChanges();
    dom.click('button[title="Open positioning map"]');

    expect(opened).toEqual([1, 2]);
  });

  it('emits the active window index when the clip button is used', () => {
    const dom = render(threeWindows(), { showClip: true });
    const opened = dom.on('openClip');

    dom.click('button[title="Watch clip"]');

    expect(opened).toEqual([1]);
  });

  it('hides the map and clip actions unless the page asks for them', () => {
    const dom = render(threeWindows());
    expect(dom.query('button[title="Open positioning map"]')).toBeNull();
    expect(dom.query('button[title="Watch clip"]')).toBeNull();
  });
});

describe('WindowComparison pacing slots', () => {
  // One dashed slot stands for this many seconds of pause between two windows.
  const SLOT_SECONDS = 20;

  const spanning = (timeStartS: number, timeEndS: number): ComparisonWindow =>
    ({ ...win({}), timeStartS, timeEndS });

  const slotsAfterPause = (pauseS: number): number =>
    render([spanning(0, 0), spanning(pauseS, pauseS + 10)]).queryAll(GAP_CELL).length;

  it('draws no slot for a pause shorter than one, and one slot at exactly one', () => {
    expect(slotsAfterPause(SLOT_SECONDS - 1)).toBe(0);
    expect(slotsAfterPause(SLOT_SECONDS)).toBe(1);
  });

  it('adds one more slot per further 20s of pause', () => {
    expect(slotsAfterPause(2 * SLOT_SECONDS - 1)).toBe(1);
    expect(slotsAfterPause(2 * SLOT_SECONDS)).toBe(2);
    expect(slotsAfterPause(3 * SLOT_SECONDS)).toBe(3);
  });

  it('keeps adding slots through a long lull, with no cap', () => {
    const LONG_LULL_SLOTS = 10;
    expect(slotsAfterPause(LONG_LULL_SLOTS * SLOT_SECONDS)).toBe(LONG_LULL_SLOTS);
  });

  it('lays the slots between the two chips they separate, in fight order', () => {
    const dom = render([spanning(0, 0), spanning(2 * SLOT_SECONDS, 2 * SLOT_SECONDS + 10)]);

    const kinds = dom.queryAll(CELL).map(cell => cell.querySelector(CHIP) ? 'chip' : 'slot');

    expect(kinds).toEqual(['chip', 'slot', 'slot', 'chip']);
  });

  it('renders an empty row when there are no windows', () => {
    expect(render([]).queryAll(CELL)).toHaveLength(0);
  });
});
