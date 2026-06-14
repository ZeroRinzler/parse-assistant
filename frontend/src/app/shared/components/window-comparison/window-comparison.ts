import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { RangeChartComponent, RangeRow } from '../range-chart/range-chart';
import { GameIconComponent } from '../game-icon/game-icon';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';

export type WindowStatus = 'good' | 'warn' | 'bad' | 'muted';

/**
 * One normalized comparison window. Domain components (burst windows,
 * defensive windows, …) map their data into this shape so the rendering,
 * scaling and expand/collapse behaviour can be shared.
 */
export interface ComparisonWindow {
  /** Window bounds in seconds; rendered as a `m:ss - m:ss` range. */
  timeStartS: number;
  timeEndS: number;
  /** Spell-icon ids shown in the header (CDs, or the defensive itself). */
  spellIds: number[];
  /** Plain-text header labels for entries that have no spell id. */
  labels: string[];
  /** Drives the status glyph colour. */
  status: WindowStatus;
  /** Material icon name for the status glyph. */
  statusIcon: string;
  /** Single comparison row drawn as the always-visible overview. */
  overview: RangeRow;
  /** Per-ability rows shown in the toggleable detail. */
  detailRows: RangeRow[];
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-window-comparison',
  imports: [MatIconModule, MatButtonModule, MatCardModule, MatDividerModule, RangeChartComponent, GameIconComponent, FormatDurationPipe],
  templateUrl: './window-comparison.html',
})
export class WindowComparisonComponent {
  readonly windows = input.required<ComparisonWindow[]>();
  /** Whether a higher bar is better (burst = true, damage taken = false). */
  readonly higherIsBetter = input<boolean>(true);

  private readonly expanded = signal(new Set<number>());

  protected toggle(i: number): void {
    this.expanded.update(s => {
      const next = new Set(s);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  protected isOpen(i: number): boolean {
    return this.expanded().has(i);
  }

  /** Shared scale across every overview row so cards are visually comparable. */
  protected readonly overviewMax = computed(() => {
    const vals = this.windows().flatMap(w =>
      [w.overview.topAvg, w.overview.topMax, w.overview.playerPct]
        .filter((v): v is number => v != null));
    return Math.max(...vals, 0.01);
  });

  protected detailMax(i: number): number {
    const rows = this.windows()[i]?.detailRows ?? [];
    const vals = rows.flatMap(r => [r.topMax, r.playerPct].filter((v): v is number => v != null));
    return Math.max(...vals, 0.001);
  }
}
