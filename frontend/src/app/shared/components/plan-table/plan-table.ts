import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameIconComponent } from '../game-icon/game-icon';
import { CollapsibleTextComponent } from '../collapsible-text/collapsible-text';
import { LoadStateComponent, RenderableLoadError } from '../load-state/load-state';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';

export interface PlanTableRow {
  name: string;
  spellId: number | null;
  icon: string;
  firstCastS: number | null;
  typicalUses: number | null;
  usedSampleCount: number;
  sampleCount: number;
  holds: { castIndex: number; targetS: number }[];
  rule: string | null;
  bloodlust?: boolean;
}

type PlanTableState = 'unavailable' | 'rows' | 'empty';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-plan-table',
  imports: [DecimalPipe, GameIconComponent, CollapsibleTextComponent, LoadStateComponent, FormatDurationPipe],
  templateUrl: './plan-table.html',
})
export class PlanTableComponent {
  readonly heading = input.required<string>();
  readonly subtitle = input.required<string>();
  readonly rows = input.required<PlanTableRow[]>();
  readonly available = input.required<boolean>();
  readonly error = input.required<RenderableLoadError | null>();

  protected readonly state = computed<PlanTableState>(() => {
    if (this.error() || !this.available()) return 'unavailable';
    return this.rows().length ? 'rows' : 'empty';
  });
}
