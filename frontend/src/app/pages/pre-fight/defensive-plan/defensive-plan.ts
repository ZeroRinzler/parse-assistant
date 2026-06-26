import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { DefPlanItem } from '../pre-fight.vm';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';

/**
 * Defensive game plan as a 3-column table (What / Plan / How to use), mirroring
 * the cooldown plan schema. Plan shows first use, holds and avg uses; defensives
 * never align with Bloodlust so that tag is omitted. Self-contained to /pre.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensive-plan',
  imports: [DecimalPipe, GameIconComponent, FormatDurationPipe],
  templateUrl: './defensive-plan.html',
})
export class DefensivePlanComponent {
  readonly items = input.required<DefPlanItem[]>();
  readonly title = input('Defensive plan');
  readonly subtitle = input('When top parsers use defensives, and how often, on this fight.');
}
