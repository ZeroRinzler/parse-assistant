import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state';
import { slotName, statusIcon } from '../../../shared/gear/gear-comparison';
import { loadResource } from '../../../shared/state/load-resource';
import { GearFeatureService, emptyGearView } from './gear.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-gear',
  imports: [MatIconModule, GameIconComponent, CollapsibleTextComponent, LoadStateComponent],
  templateUrl: './gear.html',
})
export class GearComponent {
  private readonly gear = inject(GearFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly report = input<string>('');
  readonly fight = input<number>(0);
  readonly player = input<number>(0);

  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = loadResource({
    params: () => ({
      spec: this.spec(),
      encounterId: this.encounterId(),
      report: this.report(),
      fight: this.fight(),
      player: this.player(),
    }),
    load: p => p.report && p.fight && p.player
      ? this.gear.loadComparisonView(p.spec, p.encounterId, p.report, p.fight, p.player)
      : this.gear.loadBenchView(p.spec, p.encounterId),
    context: 'gear.load',
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  protected readonly view = computed(() => this.load.value() ?? emptyGearView());
  // available() is the load outcome, not a view flag: true only once an ok result lands.
  protected readonly available = this.load.available;
  protected readonly error = this.load.error;

  // Partitioned in the component (semantic data only, no styling).
  protected readonly enchantIssues = computed(() => this.view().enchantRows.filter(row => row.status !== 'ok'));
  protected readonly enchantOnPlan = computed(() => this.view().enchantRows.filter(row => row.status === 'ok'));

  protected readonly slotName = slotName;
  protected readonly statusIcon = statusIcon;
}
