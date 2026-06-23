import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { PositioningPanelService } from '../../../core/services/positioning-panel';
import { GameIconComponent } from '../game-icon/game-icon';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';
import type { FindingRow, OnPlanChip } from './finding-table.utils';

// Re-export so callers can import types + helpers from either this file or the utils module.
export type { FindingMeasure, FindingRow, OnPlanChip, FindingEntry, BucketOptions } from './finding-table.utils';
export { rowsFromEntries, onPlanFromEntries, bucketFindings, CAT_LABEL } from './finding-table.utils';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-finding-table',
  // Angular custom elements default to display:inline; block keeps the card full-width.
  host: { class: 'block' },
  imports: [MatIconModule, MatButtonModule, GameIconComponent, FormatDurationPipe],
  templateUrl: './finding-table.html',
})
export class FindingTableComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
  readonly rows = input.required<FindingRow[]>();
  readonly onPlan = input<OnPlanChip[]>([]);

  private readonly panel = inject(PositioningPanelService);
  /** Timed cooldown rows can open the positioning map once positions are loaded. */
  protected readonly showMap = computed(() => !!this.panel.positions());

  protected openMap(row: FindingRow): void {
    if (row.timestampMs == null || !row.name) return;
    this.panel.openAt(row.timestampMs / 1000, { kind: 'boss' }, row.name);
  }
}
