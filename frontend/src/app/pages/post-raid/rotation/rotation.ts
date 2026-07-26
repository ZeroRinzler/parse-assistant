import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FindingTableComponent, OnPlanChip } from '../../../shared/components/finding-table/finding-table';
import { LoadStateComponent, RenderableLoadError } from '../../../shared/components/load-state/load-state';
import { LatestLoad } from '../../../shared/latest-load';
import { logWarn } from '../../../core/log';
import {
  RotationFeatureService, RotationFindingRow, RotationOnPlanChip,
} from './rotation.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-rotation',
  imports: [FindingTableComponent, LoadStateComponent],
  templateUrl: './rotation.html',
})
export class RotationComponent {
  private readonly rotation = inject(RotationFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly reportCode = input.required<string>();
  readonly fightId = input.required<number>();
  readonly playerId = input.required<number>();

  /** Emits false when the card has finished loading; the page gates its spinner on it. */
  readonly busyChange = output<boolean>();
  /** Whether the top-parse bench exists (Offensives). The page aggregates it for the banner. */
  readonly availableChange = output<boolean>();

  protected readonly available = signal(true);
  protected readonly error = signal<RenderableLoadError | null>(null);
  protected readonly ruleRows = signal<RotationFindingRow[]>([]);
  protected readonly ruleOnPlan = signal<string[]>([]);
  protected readonly offensiveRows = signal<RotationFindingRow[]>([]);
  protected readonly onPlan = signal<RotationOnPlanChip[]>([]);

  protected readonly ruleOnPlanChips = computed<OnPlanChip[]>(() =>
    this.ruleOnPlan().map(label => ({ name: label, spellId: null, icon: '' })));

  private readonly loader = new LatestLoad();

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      const reportCode = this.reportCode();
      const fightId = this.fightId();
      const playerId = this.playerId();
      this.loader.run(this.rotation.loadPlayerView(spec, encounterId, reportCode, fightId, playerId), {
        context: 'rotation.loadPlayerView',
        apply: result => {
          if (result.ok) {
            this.error.set(null);
            this.available.set(true);
            this.availableChange.emit(true);
            this.ruleRows.set(result.value.ruleRows);
            this.ruleOnPlan.set(result.value.ruleOnPlan);
            this.offensiveRows.set(result.value.offensiveRows);
            this.onPlan.set(result.value.onPlan);
          } else {
            if (result.error.kind === 'permanent') logWarn(result.error.id, result.error.context);
            this.error.set(result.error.kind === 'missing' ? null : result.error);
            this.available.set(false);
            this.availableChange.emit(false);
            this.ruleRows.set([]);
            this.ruleOnPlan.set([]);
            this.offensiveRows.set([]);
            this.onPlan.set([]);
          }
        },
        settled: () => this.busyChange.emit(false),
      });
    });
  }
}
