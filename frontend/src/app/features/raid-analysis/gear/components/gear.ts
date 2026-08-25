import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { GameIcon } from '../../../../shared/components/game-icon/game-icon';
import { CollapsibleText } from '../../../../shared/components/collapsible-text/collapsible-text';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { GearComparisonService, GearStatus } from '../../../../domain/gear/gear-comparison-service';
import { GearFeatureService, GearComparisonView } from '../facade/gear-feature-service';
import { GearBench } from '../../../../domain/gear/gear-bench';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';
import { Result } from '../../../../core/http/result';

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
  /** Set only by the compare page: a bench synthesized from the other log's single parse, in place of the top-parse bench. */
  readonly compareBench = input<Result<GearBench> | null>(null);
  /** Set only by the compare page: the other log's player name, in place of "top parses"/"top parsers" in the card copy. */
  readonly peerLabel = input<string | null>(null);

  protected readonly subtitle = computed(() => {
    const peer = this.peerLabel();
    return peer ? `Gear vs ${peer}.` : 'Gear vs top parses.';
  });

  // "of top parsers" reads as a population share; with one comparison parse that share is always 100%, so it reads better as whose pull it came from.
  protected readonly pctCaption = computed(() => {
    const peer = this.peerLabel();
    return peer ? `on ${peer}'s pull` : 'of top parsers';
  });

  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = this.loadRes.loadResource({
    params: () => ({
      spec: this.spec(),
      encounterId: this.encounterId(),
      report: this.report(),
      fight: this.fight(),
      player: this.player(),
      compareBench: this.compareBench(),
    }),
    load: (p): Promise<Result<GearComparisonView>> => p.compareBench
      ? p.compareBench.ok
        ? this.gear.loadComparisonViewFromBench(p.compareBench.value, p.report, p.fight, p.player)
        : Promise.resolve(p.compareBench)
      : p.report && p.fight && p.player
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
