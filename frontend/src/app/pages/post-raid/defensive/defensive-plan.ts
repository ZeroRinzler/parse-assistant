import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { PlanTableComponent } from '../../../shared/components/plan-table/plan-table';
import { loadResource } from '../../../shared/state/load-resource';
import { DefensiveFeatureService, DefensivePlanRow } from './defensive.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensive-plan',
  imports: [PlanTableComponent],
  templateUrl: './defensive-plan.html',
})
export class DefensivePlanComponent {
  private readonly defensive = inject(DefensiveFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();

  protected readonly heading = 'Defensive plan';
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
