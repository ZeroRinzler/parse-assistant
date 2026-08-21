import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { loadResource } from '../../../shared/state/load-resource';
import { DefensiveFeatureService, DefensivePlanRow } from './defensive.service';

// Defensives never align with Bloodlust, so that tag is omitted.
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensive-plan',
  imports: [DecimalPipe, GameIconComponent, CollapsibleTextComponent, LoadStateComponent, FormatDurationPipe],
  templateUrl: './defensive-plan.html',
})
export class DefensivePlanComponent {
  private readonly defensive = inject(DefensiveFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();

  protected readonly title = 'Defensive plan';
  protected readonly subtitle = 'Defensive usage across top parses.';

  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = loadResource({
    params: () => ({ spec: this.spec(), encounterId: this.encounterId() }),
    load: ({ spec, encounterId }) => this.defensive.loadPlan(spec, encounterId),
    context: 'defensive.loadPlan',
    initialAvailable: true,
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  protected readonly available = this.load.available;
  protected readonly error = this.load.error;
  protected readonly items = computed<DefensivePlanRow[]>(() => this.load.value()?.rows ?? []);
}
