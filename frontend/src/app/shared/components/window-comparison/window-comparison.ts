import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { GameIconComponent } from '../game-icon/game-icon';
import { CompactAbilityRowComponent } from '../compact-ability-row/compact-ability-row';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../pipes/format-damage-pipe';
import { RangeRow, WindowStatus, ComparisonWindow } from '../../../core/models/window-comparison.models';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-window-comparison',
  imports: [MatIconModule, MatButtonModule, GameIconComponent, CompactAbilityRowComponent, FormatDurationPipe, FormatDamagePipe],
  templateUrl: './window-comparison.html',
})
export class WindowComparisonComponent {
  readonly windows = input.required<ComparisonWindow[]>();
  readonly higherIsBetter = input<boolean>(true);
  readonly fightDuration = input<number>(0);
  readonly showMap = input<boolean>(false);
  // Casts column is meaningful for burst (offensive) windows only; hidden for defensives.
  readonly showCasts = input<boolean>(true);
  readonly title = input<string>('');
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

  protected readonly activeIsMuted = computed(() =>
    this.activeWindow()?.status === 'muted');

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
  // buttons apart, then each center is held inside a small inset band so a
  // half-button never hangs off the rail ends.
  protected readonly segmentLeftPcts = computed<number[]>(() => {
    const windows = this.windows();
    const minGap = WindowComparisonComponent.MIN_GAP_PCT;
    const inset = WindowComparisonComponent.EDGE_INSET_PCT;
    const centers = windows.map(w => this.leftPct(w.timeStartS));
    // Forward pass: push later buttons right.
    for (let i = 1; i < centers.length; i++) {
      if (centers[i] < centers[i - 1] + minGap) centers[i] = centers[i - 1] + minGap;
    }
    // Clamp rightmost to 100%, then backward pass to pull earlier buttons left.
    centers[centers.length - 1] = Math.min(centers[centers.length - 1], 100);
    for (let i = centers.length - 2; i >= 0; i--) {
      centers[i] = Math.min(centers[i], centers[i + 1] - minGap);
    }
    return centers.map(c => Math.min(100 - inset, Math.max(inset, c)));
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

  protected readonly overviewDeltaText = computed(() => {
    const delta = this.overviewDelta();
    if (delta == null) return '';
    const sign = delta > 0 ? '+' : '';
    return `${sign}${delta.toFixed(0)}%`;
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
