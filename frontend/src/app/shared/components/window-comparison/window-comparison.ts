import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { GameIconComponent } from '../game-icon/game-icon';
import { CompactAbilityRowComponent } from '../compact-ability-row/compact-ability-row';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../pipes/format-damage-pipe';
import { SignedPercentPipe } from '../../pipes/signed-percent-pipe';
import { RangeRow, ComparisonWindow } from '../../../core/models/window-comparison.models';

/** One slot on the timeline row: a real window chip, or a dashed pacing spacer. */
type TimelineCell =
  | { readonly kind: 'window'; readonly index: number }
  | { readonly kind: 'gap'; readonly id: string };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-window-comparison',
  // Angular custom elements default to display:inline; block keeps the card full-width.
  host: { class: 'block' },
  imports: [MatIconModule, MatButtonModule, GameIconComponent, CompactAbilityRowComponent, FormatDurationPipe, FormatDamagePipe, SignedPercentPipe],
  templateUrl: './window-comparison.html',
})
export class WindowComparisonComponent {
  readonly windows = input.required<ComparisonWindow[]>();
  readonly higherIsBetter = input<boolean>(true);
  readonly showMap = input<boolean>(false);
  /** Whether a "watch clip" button shows (the page owns recording + the clip panel). */
  readonly showClip = input<boolean>(false);
  // Casts column is meaningful for burst (offensive) windows only; hidden for defensives.
  readonly showCasts = input<boolean>(true);
  readonly heading = input<string>('');
  readonly subtitle = input<string>('');
  readonly openMap = output<number>();
  /** Emits the active window index when its clip button is clicked; the page forwards it. */
  readonly openClip = output<number>();

  // Each dashed pacing slot stands for this many seconds of pause before the next
  // window, so a sub-slot pause is the same burst (0 slots) and longer lulls add
  // proportionally more slots.
  private static readonly GAP_SLOT_SECONDS = 20;

  protected readonly selectedIndex = computed(() => {
    const windows = this.windows();
    const higherIsBetter = this.higherIsBetter();
    let worst = 0;
    let worstRatio = higherIsBetter ? Infinity : -Infinity;
    windows.forEach((w, i) => {
      if (w.status === 'muted') return;
      const player = w.overview.playerPct;
      const top = w.overview.topAvg;
      if (player == null || !top || top <= 0) return;
      const ratio = player / top;
      if (higherIsBetter ? ratio < worstRatio : ratio > worstRatio) {
        worstRatio = ratio;
        worst = i;
      }
    });
    return worst;
  });

  private readonly _manualIndex = signal<number | null>(null);

  protected readonly activeIndex = computed(() =>
    this._manualIndex() ?? this.selectedIndex());

  protected readonly activeWindow = computed(() =>
    this.windows()[this.activeIndex()] ?? null);

  // Flat left-to-right sequence of chips interleaved with dashed pacing slots, so
  // the template renders one row without measuring time: chip size is fixed and
  // the gap count carries the rhythm of the fight.
  protected readonly timelineCells = computed<TimelineCell[]>(() => {
    const windows = this.windows();
    const cells: TimelineCell[] = [];
    windows.forEach((w, i) => {
      cells.push({ kind: 'window', index: i });
      const next = windows[i + 1];
      if (!next) return;
      const slots = this.gapSlots(next.timeStartS - w.timeEndS);
      for (let s = 0; s < slots; s++) cells.push({ kind: 'gap', id: `${i}-${s}` });
    });
    return cells;
  });

  private gapSlots(pauseS: number): number {
    return Math.max(0, Math.floor(pauseS / WindowComparisonComponent.GAP_SLOT_SECONDS));
  }

  protected select(i: number): void {
    this._manualIndex.set(i);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = this.activeIndex() + delta;
    if (next >= 0 && next < this.windows().length) this.select(next);
  }

  // 'info' (bench-only, pre-fight) has no player overlay, so it hides the
  // absent player columns/delta exactly like a muted (not-reached) window.
  protected readonly activeIsMuted = computed(() => {
    const status = this.activeWindow()?.status;
    return status === 'muted' || status === 'info';
  });

  // Bench-only (pre-fight) window: no player overlay at all, so the You/Top
  // comparison bar is hidden and the header shows the top-parse damage instead.
  protected readonly activeIsBenchOnly = computed(() => this.activeWindow()?.status === 'info');

  // Active window's ability rows, sorted by absolute gap (biggest damage loss
  // first) so the most actionable abilities surface at the top of the table.
  // Direction-aware: burst wants player >= top (loss = negative gap); defensives
  // want player <= top (loss = positive gap, i.e. more damage taken).
  protected readonly activeDetailRows = computed<RangeRow[]>(() => {
    const rows = this.activeWindow()?.detailRows ?? [];
    const higherIsBetter = this.higherIsBetter();
    const loss = (row: RangeRow): number => {
      // No player value (an unreached window's breakdown): the loss is the whole top-parse damage.
      if (row.playerPct == null) return -(row.topAvg ?? 0);
      const gap = row.playerPct - (row.topAvg ?? 0);
      return higherIsBetter ? gap : -gap; // negative = worse
    };
    return [...rows].sort((a, b) => loss(a) - loss(b));
  });

  protected readonly overviewMax = computed(() => {
    // Filter NaN as well as null: a single NaN would make Math.max return NaN and blank the bar.
    const vals = this.windows().flatMap(w =>
      [w.overview.topAvg, w.overview.topMax, w.overview.playerPct]
        .filter((v): v is number => v != null && Number.isFinite(v)));
    return Math.max(...vals, 0.01);
  });

  private barPct(value: number, max: number): number {
    const pct = (value / max) * 100;
    return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  }

  protected readonly overviewDelta = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w) return null;
    const { playerPct, topAvg } = w.overview;
    if (playerPct == null || topAvg == null || topAvg === 0) return null;
    const delta = ((playerPct - topAvg) / topAvg) * 100;
    // A NaN player/top value would otherwise render a "NaN%" badge; drop it to the muted state.
    return Number.isFinite(delta) ? delta : null;
  });

  // Semantic delta state only - the template maps it to a badge-* class.
  protected readonly overviewDeltaStatus = computed<'muted' | 'better' | 'worse'>(() => {
    const delta = this.overviewDelta();
    if (delta == null) return 'muted';
    const isBetter = this.higherIsBetter() ? delta >= 0 : delta <= 0;
    return isBetter ? 'better' : 'worse';
  });

  // Overview bar geometry as plain percentages, bound via [style.left.%] /
  // [style.width.%] in the template; colors come from token classes there.
  protected readonly overviewPlayerWidthPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w || w.overview.playerPct == null) return null;
    return this.barPct(w.overview.playerPct, this.overviewMax());
  });

  protected readonly overviewRangeLeftPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w || w.overview.topMin == null || w.overview.topMax == null) return null;
    return this.barPct(w.overview.topMin, this.overviewMax());
  });

  protected readonly overviewRangeWidthPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w || w.overview.topMin == null || w.overview.topMax == null) return null;
    const max = this.overviewMax();
    return Math.max(0, this.barPct(w.overview.topMax, max) - this.barPct(w.overview.topMin, max));
  });

  protected readonly overviewAvgLeftPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w || w.overview.topAvg == null) return null;
    return this.barPct(w.overview.topAvg, this.overviewMax());
  });
}
