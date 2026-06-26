import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { CdPlanItem } from '../pre-fight.vm';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';

/**
 * Offensive cooldown game plan as a 3-column table (What / Plan / How to use).
 * The Plan column shows exactly four fields: first use, holds, avg uses and a
 * Bloodlust tag. Self-contained to /pre - shares no markup with the analyze page.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-cooldown-plan',
  imports: [DecimalPipe, GameIconComponent, FormatDurationPipe],
  templateUrl: './cooldown-plan.html',
})
export class CooldownPlanComponent {
  readonly items = input.required<CdPlanItem[]>();
  readonly title = input('Cooldown plan');
  readonly subtitle = input('How top parsers open and pace offensive cooldowns on this fight.');
}
