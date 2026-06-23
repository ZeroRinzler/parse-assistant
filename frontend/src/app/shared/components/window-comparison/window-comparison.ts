import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { RangeRow } from '../range-chart/range-chart';
import { GameIconComponent } from '../game-icon/game-icon';
import { CompactAbilityRowComponent } from '../compact-ability-row/compact-ability-row';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../pipes/format-damage-pipe';

export type WindowStatus = 'good' | 'warn' | 'bad' | 'muted';

export interface ComparisonWindow {
  timeStartS: number;
  timeEndS: number;
  spellIds: number[];
  labels: string[];
  status: WindowStatus;
  statusIcon: string;
  overview: RangeRow;
  detailRows: RangeRow[];
}

// Status -> Tailwind class maps. Colors reference the global design tokens
// (--success / --warning / --critical / --muted) instead of hardcoded hex.
const SEGMENT_CLASS: Record<WindowStatus, string> = {
  good: 'bg-[var(--success)]/55 border border-[var(--success)] text-[var(--success)]',
  warn: 'bg-[var(--warning)]/55 border border-[var(--warning)] text-[var(--warning)]',
  bad: 'bg-[var(--critical)]/55 border border-[var(--critical)] text-[var(--critical)]',
  muted: '',
};

const DOT_CLASS: Record<WindowStatus, string> = {
  good: 'bg-[var(--success)]',
  warn: 'bg-[var(--warning)]',
  bad: 'bg-[var(--critical)]',
  muted: 'bg-[var(--muted)]',
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-window-comparison',
  imports: [MatIconModule, MatButtonModule, MatCardModule, GameIconComponent, CompactAbilityRowComponent, FormatDurationPipe, FormatDamagePipe],
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

  // Per-segment Tailwind classes (color + active outline). Muted windows split
  // into "scheduled" (dashed neutral) vs "missing" (dashed critical tint).
  protected readonly segmentClasses = computed(() => {
    const activeIdx = this.activeIndex();
    return this.windows().map((w, i) => {
      const outline = activeIdx === i ? ' outline outline-2 outline-offset-2 outline-[var(--gold)]' : '';
      if (w.status === 'muted') {
        const muted = w.statusIcon === 'schedule'
          ? 'border border-dashed border-[var(--border)] text-[var(--muted)]'
          : 'bg-[var(--critical)]/10 border border-dashed border-[var(--critical)]/40 text-[var(--muted)]';
        return muted + outline;
      }
      return SEGMENT_CLASS[w.status] + outline;
    });
  });

  protected dotClass(status: WindowStatus): string {
    return DOT_CLASS[status];
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

  // Resolved `left` CSS value per segment, in percentage space so no DOM
  // measurement is needed and buttons can never overflow the track.
  // A two-pass collision algorithm nudges overlapping buttons apart.
  protected readonly segmentLefts = computed<string[]>(() => {
    const windows = this.windows();
    const minGap = WindowComparisonComponent.MIN_GAP_PCT;
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
    return centers.map(c =>
      `clamp(1.125rem, ${Math.max(0, c)}%, calc(100% - 1.125rem))`);
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

  protected readonly overviewDeltaClass = computed(() => {
    const delta = this.overviewDelta();
    if (delta == null) return 'text-[var(--muted)]';
    const isBetter = this.higherIsBetter() ? delta >= 0 : delta <= 0;
    return isBetter ? 'badge-success' : 'badge-critical';
  });

  // Overview bar geometry as plain percentages, bound via [style.left.%] /
  // [style.width.%] in the template; colors come from token classes there.
  protected readonly overviewPlayerWidthPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w || w.overview.playerPct == null) return null;
    return this.barPct(w.overview.playerPct, this.overviewMax());
  });

  protected readonly overviewPlayerFillClass = computed(() => {
    const w = this.activeWindow();
    return w ? DOT_CLASS[w.status] : '';
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
