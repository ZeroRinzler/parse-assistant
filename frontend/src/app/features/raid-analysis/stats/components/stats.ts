import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { SignedNumberPipe } from '../../../../shared/pipes/signed-number-pipe';
import { StatsFeatureService, StatsView } from '../facade/stats-feature-service';
import { GearBench } from '../../../../domain/gear/gear-bench';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';
import { Result } from '../../../../core/http/result';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-stats',
  imports: [LoadState, DecimalPipe, SignedNumberPipe],
  templateUrl: './stats.html',
})
export class Stats {
  private readonly loadRes = inject(LoadResourceService);
  private readonly statsFeature = inject(StatsFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly report = input<string>('');
  readonly fight = input<number>(0);
  readonly player = input<number>(0);
  /** Set only by the compare page: a bench synthesized from the other log's single parse, in place of the top-parse bench. */
  readonly compareBench = input<Result<GearBench> | null>(null);
  /** Set only by the compare page: the other log's player name, in place of "top parses" in the card copy. */
  readonly peerLabel = input<string | null>(null);
  /** Set only by the compare page: this log's own player name, in place of the generic "You" column header. */
  readonly youLabel = input<string | null>(null);

  protected readonly subtitle = computed(() => {
    const peer = this.peerLabel();
    return peer ? `Stats vs ${peer}.` : 'Stats vs top parses.';
  });

  protected readonly youColumnLabel = computed(() => this.youLabel() ?? 'You');
  protected readonly statsColumnLabel = computed(() => this.peerLabel() ?? 'Top parses avg');

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
    load: (p): Promise<Result<StatsView>> => p.compareBench
      ? p.compareBench.ok
        ? this.statsFeature.loadComparisonViewFromBench(p.compareBench.value, p.report, p.fight, p.player)
        : Promise.resolve(p.compareBench)
      : p.report && p.fight && p.player
        ? this.statsFeature.loadComparisonView(p.spec, p.encounterId, p.report, p.fight, p.player)
        : this.statsFeature.loadBenchView(p.spec, p.encounterId),
    context: 'stats.load',
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  protected readonly view = computed(() => this.load.value() ?? this.statsFeature.emptyView());
  // available() is the load outcome, not a view flag: true only once an ok result lands.
  protected readonly available = this.load.available;
  protected readonly error = this.load.error;
}
