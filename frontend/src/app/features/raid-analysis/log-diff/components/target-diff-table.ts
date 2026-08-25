import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ComparisonView } from '../domain/log-diff.models';

// The ability table above already carries the loading/error/empty states for this same comparison; this only adds content once it exists.
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-target-diff-table',
  imports: [DecimalPipe],
  templateUrl: './target-diff-table.html',
  host: { class: 'block' },
})
export class TargetDiffTable {
  readonly view = input<ComparisonView | null>(null);

  // The widest |delta| sets the bar scale, so every row's bar is relative to the biggest priority gap in this table.
  protected readonly maxAbsDelta = computed(() => {
    const rows = this.view()?.targetRows ?? [];
    return Math.max(1, ...rows.map(r => Math.abs(r.deltaPct)));
  });

  protected barPct(deltaPct: number): number {
    return Math.min(100, (Math.abs(deltaPct) / this.maxAbsDelta()) * 100);
  }
}
