import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { GameIcon } from '../../../../shared/components/game-icon/game-icon';
import { CollapsibleText } from '../../../../shared/components/collapsible-text/collapsible-text';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { GearComparisonService, GearStatus } from '../../../../domain/gear/gear-comparison-service';
import { GearFeatureService } from '../facade/gear-feature-service';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-gear',
  imports: [MatIconModule, GameIcon, CollapsibleText, LoadState],
  templateUrl: './gear.html',
})
export class Gear {
  private readonly loadRes = inject(LoadResourceService);
  private readonly gearComparison = inject(GearComparisonService);
  private readonly gear = inject(GearFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly report = input<string>('');
  readonly fight = input<number>(0);
  readonly player = input<number>(0);

  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = this.loadRes.loadResource({
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

  protected readonly view = computed(() => this.load.value() ?? this.gear.emptyGearView());
  // available() is the load outcome, not a view flag: true only once an ok result lands.
  protected readonly available = this.load.available;
  protected readonly error = this.load.error;

  // Partitioned in the component (semantic data only, no styling).
  protected readonly enchantIssues = computed(() => this.view().enchantRows.filter(row => row.status !== 'ok'));
  protected readonly enchantOnPlan = computed(() => this.view().enchantRows.filter(row => row.status === 'ok'));

  protected slotName(slot: number): string {
    return this.gearComparison.slotName(slot);
  }

  protected statusIcon(status: GearStatus): string {
    return this.gearComparison.statusIcon(status);
  }
}
