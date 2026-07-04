import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { GameIconComponent } from '../game-icon/game-icon';
import { CompactAbilityRowComponent } from '../compact-ability-row/compact-ability-row';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../pipes/format-damage-pipe';
import { SignedPercentPipe } from '../../pipes/signed-percent-pipe';
import { RangeRow, ComparisonWindow } from '../../../core/models/window-comparison.models';

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
  readonly fightDuration = input<number>(0);
  readonly showMap = input<boolean>(false);
  // Casts column is meaningful for burst (offensive) windows only; hidden for defensives.
  readonly showCasts = input<boolean>(true);
  readonly heading = input<string>('');
  readonly subtitle = input<string>('');
  readonly openMap = output<number>();

  // Minimum center-to-center gap between adjacent segments, as a percentage of
  // the track width, so buttons never visually collide on a crowded timeline.
  private static readonly MIN_GAP_PCT = 5;
  // Keep each segment center this far (in % of track width) from either rail end
  // so a half-button never overhangs the rail tips.
  private static readonly EDGE_INSET_PCT = 4;

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

  protected readonly timelineEnd = computed(() => {
    const windows = this.windows();
    if (!windows.length) return Math.max(this.fightDuration(), 1);
    return Math.max(...windows.map(w => w.timeEndS), 1);
  });

  protected readonly timeTicks = computed<number[]>(() => {
    const end = this.timelineEnd();
    const steps = 5;
    return Array.from({ length: steps + 1 }, (_, i) => (end / steps) * i);
  });

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

  // "Not reached" only applies to a real player window the player never entered
  // ('muted'); a bench-only ('info', pre-fight) window has no player to reach, so
  // the label is suppressed there.
  protected readonly activeIsNotReached = computed(() => this.activeWindow()?.status === 'muted');

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
      const gap = (row.playerPct ?? 0) - (row.topAvg ?? 0);
      return higherIsBetter ? gap : -gap; // negative = worse
    };
    return [...rows].sort((a, b) => loss(a) - loss(b));
  });

  protected leftPct(timeS: number): number {
    const end = this.timelineEnd();
    return Math.min(100, Math.max(0, (timeS / end) * 100));
  }

  // `left` per segment as a raw percentage (bound via [style.left.%]), so no DOM
  // measurement is needed. A two-pass collision algorithm nudges overlapping
  // buttons apart inside the inset band [inset, 100 - inset]. The inset is part
  // of the spread bounds (not a post-hoc clamp, which would re-collide the rail
  // markers), and the gap shrinks to fit when there are too many buttons to hold
  // the full MIN_GAP_PCT, so markers never visually overlap on a crowded timeline.
  protected readonly segmentLeftPcts = computed<number[]>(() => {
    const windows = this.windows();
    const inset = WindowComparisonComponent.EDGE_INSET_PCT;
    const lo = inset;
    const hi = 100 - inset;
    const centers = windows.map(w => Math.min(hi, Math.max(lo, this.leftPct(w.timeStartS))));
    if (centers.length < 2) return centers;
    // Effective gap fits all buttons edge-to-edge within the band when crowded.
    const gap = Math.min(WindowComparisonComponent.MIN_GAP_PCT, (hi - lo) / (centers.length - 1));
    // Forward pass: push later buttons right to clear the gap.
    for (let i = 1; i < centers.length; i++) {
      centers[i] = Math.max(centers[i], centers[i - 1] + gap);
    }
    // Anchor the rightmost inside the band, then backward pass pulls earlier
    // buttons left. (hi - lo) >= (n - 1) * gap by construction, so the backward
    // pass cannot push the leftmost below lo - no trailing clamp is needed.
    centers[centers.length - 1] = Math.min(centers[centers.length - 1], hi);
    for (let i = centers.length - 2; i >= 0; i--) {
      centers[i] = Math.min(centers[i], centers[i + 1] - gap);
    }
    return centers;
  });

  protected readonly overviewMax = computed(() => {
    const vals = this.windows().flatMap(w =>
      [w.overview.topAvg, w.overview.topMax, w.overview.playerPct]
        .filter((v): v is number => v != null));
    return Math.max(...vals, 0.01);
  });

  private barPct(value: number, max: number): number {
    return Math.min(100, Math.max(0, (value / max) * 100));
  }

  protected readonly overviewDelta = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w) return null;
    const { playerPct, topAvg } = w.overview;
    if (playerPct == null || topAvg == null || topAvg === 0) return null;
    return ((playerPct - topAvg) / topAvg) * 100;
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
