import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { GameIconComponent } from '../game-icon/game-icon';
import { CollapsibleTextComponent } from '../collapsible-text/collapsible-text';
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
  imports: [MatIconModule, MatButtonModule, GameIconComponent, CollapsibleTextComponent, FormatDurationPipe],
  templateUrl: './finding-table.html',
})
export class FindingTableComponent {
  readonly heading = input.required<string>();
  readonly subtitle = input<string>('');
  readonly rows = input.required<FindingRow[]>();
  readonly onPlan = input<OnPlanChip[]>([]);
  /** Whether timed cooldown rows show an "open map" button (the page owns the map). */
  readonly showMap = input<boolean>(false);
  /** Whether timed cooldown rows show a "watch clip" button (the page owns recording). */
  readonly showClip = input<boolean>(false);
  /** Emitted when a timed finding's map button is clicked; the page forwards it. */
  readonly openMap = output<FindingRow>();
  /** Emitted when a timed finding's clip button is clicked; the page forwards it. */
  readonly openClip = output<FindingRow>();

  protected onOpenMap(row: FindingRow): void {
    if (row.timestampMs == null || !row.name) return;
    this.openMap.emit(row);
  }

  protected onOpenClip(row: FindingRow): void {
    if (row.timestampMs == null || !row.name) return;
    this.openClip.emit(row);
  }
}
