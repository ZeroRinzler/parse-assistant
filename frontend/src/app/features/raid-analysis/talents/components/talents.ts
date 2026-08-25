import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { GameIcon } from '../../../../shared/components/game-icon/game-icon';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { TalentsFeatureService, TalentsView } from '../facade/talents-feature-service';
import { GearBench } from '../../../../domain/gear/gear-bench';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';
import { Result } from '../../../../core/http/result';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-talents',
  imports: [MatIconModule, GameIcon, LoadState],
  templateUrl: './talents.html',
})
export class Talents {
  private readonly loadRes = inject(LoadResourceService);
  private readonly talents = inject(TalentsFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly report = input<string>('');
  readonly fight = input<number>(0);
  readonly player = input<number>(0);
  /** Set only by the compare page: a bench synthesized from the other log's single parse, in place of the top-parse bench. */
  readonly compareBench = input<Result<GearBench> | null>(null);
  /** Set only by the compare page: the other log's player name, in place of "top parsers" in the card copy. */
  readonly peerLabel = input<string | null>(null);

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
    load: (p): Promise<Result<TalentsView>> => p.compareBench
      ? p.compareBench.ok
        ? this.talents.loadComparisonViewFromBench(p.compareBench.value, p.report, p.fight, p.player)
        : Promise.resolve(p.compareBench)
      : p.report && p.fight && p.player
        ? this.talents.loadComparisonView(p.spec, p.encounterId, p.report, p.fight, p.player)
        : this.talents.loadBenchView(p.spec, p.encounterId),
    context: 'talents.load',
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  protected readonly view = computed(() => this.load.value() ?? this.talents.emptyView());
  // available() is the load outcome, not a view flag: true only once an ok result lands.
  protected readonly available = this.load.available;
  protected readonly error = this.load.error;

  protected readonly pctCaption = computed(() => {
    const peer = this.peerLabel();
    return peer ? `on ${peer}'s pull` : 'of top parsers';
  });
}
