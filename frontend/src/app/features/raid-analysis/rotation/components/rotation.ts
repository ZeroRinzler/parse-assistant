import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FindingTable, OnPlanChip } from '../../../../shared/components/finding-table/finding-table';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { FormatDurationPipe } from '../../../../shared/pipes/format-duration-pipe';
import {
  RotationFeatureService, RotationFindingRow, RotationOnPlanChip, RotationPlayerView,
} from '../facade/rotation-feature-service';
import { RotationBench } from '../data-access/rotation-data-source';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';
import { Result } from '../../../../core/http/result';
import { PotionUse } from '../../../../domain/analysis/buff-presence-service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-rotation',
  imports: [FindingTable, LoadState, FormatDurationPipe],
  templateUrl: './rotation.html',
})
export class Rotation {
  private readonly loadRes = inject(LoadResourceService);
  private readonly rotation = inject(RotationFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly reportCode = input.required<string>();
  readonly fightId = input.required<number>();
  readonly playerId = input.required<number>();
  /** Set only by the compare page: a bench synthesized from the other log's single parse, in place of the top-parse bench. */
  readonly compareBench = input<Result<RotationBench> | null>(null);
  /** Set only by the compare page: the other log's player name, in place of "top parses" in the card copy. */
  readonly peerLabel = input<string | null>(null);
  /** Set only by the compare page: the other log's own combat potions, for the side-by-side timeline. */
  readonly peerPotions = input<PotionUse[] | null>(null);

  protected readonly offensiveSubtitle = computed(() => {
    const peer = this.peerLabel();
    return peer ? `Offensive cooldowns vs ${peer}.` : 'Offensive cooldowns vs top parses.';
  });

  protected readonly potionsSubtitle = computed(() => {
    const peer = this.peerLabel();
    return peer ? `Potion timing next to ${peer}.` : 'Potion timing this pull.';
  });

  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = this.loadRes.loadResource({
    params: () => ({
      spec: this.spec(),
      encounterId: this.encounterId(),
      reportCode: this.reportCode(),
      fightId: this.fightId(),
      playerId: this.playerId(),
      compareBench: this.compareBench(),
    }),
    load: (p): Promise<Result<RotationPlayerView>> => p.compareBench
      ? p.compareBench.ok
        ? this.rotation.loadPlayerViewFromBench(p.compareBench.value, p.reportCode, p.fightId, p.playerId)
        : Promise.resolve(p.compareBench)
      : this.rotation.loadPlayerView(p.spec, p.encounterId, p.reportCode, p.fightId, p.playerId),
    context: 'rotation.loadPlayerView',
    initialAvailable: true,
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  protected readonly available = this.load.available;
  protected readonly error = this.load.error;
  protected readonly ruleRows = computed<RotationFindingRow[]>(() => this.load.value()?.ruleRows ?? []);
  protected readonly offensiveRows = computed<RotationFindingRow[]>(() => this.load.value()?.offensiveRows ?? []);
  protected readonly onPlan = computed<RotationOnPlanChip[]>(() => this.load.value()?.onPlan ?? []);
  protected readonly potions = computed<PotionUse[]>(() => this.load.value()?.potions ?? []);

  protected readonly ruleOnPlanChips = computed<OnPlanChip[]>(() =>
    (this.load.value()?.ruleOnPlan ?? []).map(label => ({ name: label, spellId: null, icon: '' })));
}
