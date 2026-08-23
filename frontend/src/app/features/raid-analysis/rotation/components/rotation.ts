import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FindingTable, OnPlanChip } from '../../../../shared/components/finding-table/finding-table';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import {
  RotationFeatureService, RotationFindingRow, RotationOnPlanChip,
} from '../facade/rotation-feature-service';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-rotation',
  imports: [FindingTable, LoadState],
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

  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = this.loadRes.loadResource({
    params: () => ({
      spec: this.spec(),
      encounterId: this.encounterId(),
      reportCode: this.reportCode(),
      fightId: this.fightId(),
      playerId: this.playerId(),
    }),
    load: p => this.rotation.loadPlayerView(p.spec, p.encounterId, p.reportCode, p.fightId, p.playerId),
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

  protected readonly ruleOnPlanChips = computed<OnPlanChip[]>(() =>
    (this.load.value()?.ruleOnPlan ?? []).map(label => ({ name: label, spellId: null, icon: '' })));
}
