import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FormatDamagePipe } from '../../../../shared/pipes/format-damage-pipe';
import { LoadState, RenderableLoadError } from '../../../../shared/components/load-state/load-state';
import { LoadingSpinner } from '../../../../shared/components/loading-spinner/loading-spinner';
import { ComparisonView } from '../domain/log-diff.models';

/** Sorted ability breakdown between the two sides - inputs only, no injected services. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-ability-diff-table',
  imports: [FormatDamagePipe, LoadState, LoadingSpinner],
  templateUrl: './ability-diff-table.html',
  host: { class: 'block' },
})
export class AbilityDiffTable {
  readonly view = input<ComparisonView | null>(null);
  readonly loading = input(false);
  readonly error = input<RenderableLoadError | null>(null);

  // The widest |delta| sets the bar scale, so every row's bar is relative to the biggest gap in this table.
  protected readonly maxAbsDelta = computed(() => {
    const rows = this.view()?.rows ?? [];
    return Math.max(1, ...rows.map(r => Math.abs(r.deltaDps)));
  });

  protected barPct(deltaDps: number): number {
    return Math.min(100, (Math.abs(deltaDps) / this.maxAbsDelta()) * 100);
  }
}
