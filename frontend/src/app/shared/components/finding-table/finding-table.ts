import { ChangeDetectionStrategy, Component, input, linkedSignal, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { GameIcon } from '../game-icon/game-icon';
import { CollapsibleText } from '../collapsible-text/collapsible-text';
import { FindingOccurrences } from './finding-occurrences';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';
import type { FindingRow, OnPlanChip } from './finding-rows-service';

// Re-export so callers can import types + helpers from either this file or the utils module.
export type { FindingRow, OnPlanChip } from './finding-rows-service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-finding-table',
  // Angular custom elements default to display:inline; block keeps the card full-width.
  host: { class: 'block' },
  imports: [
    MatIconModule, MatButtonModule, GameIcon, CollapsibleText, FindingOccurrences,
    FormatDurationPipe,
  ],
  templateUrl: './finding-table.html',
})
export class FindingTable {
  readonly heading = input.required<string>();
  readonly subtitle = input<string>('');
  readonly rows = input.required<FindingRow[]>();
  readonly onPlan = input<OnPlanChip[]>([]);
  readonly showMap = input<boolean>(false);
  readonly showClip = input<boolean>(false);
  readonly openMap = output<FindingRow>();
  readonly openClip = output<FindingRow>();

  // The table is reused across pull/player switches, so a stale open row must not survive a rows swap.
  readonly openIndex = linkedSignal<FindingRow[], number | null>({
    source: this.rows,
    computation: () => null,
  });

  toggle(index: number): void {
    this.openIndex.update(current => current === index ? null : index);
  }
}
