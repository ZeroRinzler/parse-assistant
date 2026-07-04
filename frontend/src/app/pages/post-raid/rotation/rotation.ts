import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FindingTableComponent, OnPlanChip } from '../../../shared/components/finding-table/finding-table';
import { LatestLoad } from '../../../shared/latest-load';
import {
  RotationFeatureService, RotationFindingRow, RotationOnPlanChip,
} from './rotation.service';

/**
 * Rotation card (post-raid). A feature component: it injects exactly one service
 * (`RotationFeatureService`). It renders the "Rotation Rules" + "Offensives"
 * finding sections as two `wl-finding-table` cards. Its bench
 * comes from the swappable `ROTATION_DATA_SOURCE` (file in prod, live transform
 * under the dev flag); the player findings are computed from the player's own log,
 * fetched by the service. Spell art is baked onto each row and passed explicitly
 * to `wl-game-icon`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-rotation',
  imports: [FindingTableComponent],
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

  protected readonly ruleRows = signal<RotationFindingRow[]>([]);
  protected readonly ruleOnPlan = signal<string[]>([]);
  protected readonly offensiveRows = signal<RotationFindingRow[]>([]);
  protected readonly onPlan = signal<RotationOnPlanChip[]>([]);

  /** Followed-rule labels as spell-less chips for the shared finding table. */
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
        apply: view => {
          this.ruleRows.set(view.ruleRows);
          this.ruleOnPlan.set(view.ruleOnPlan);
          this.offensiveRows.set(view.offensiveRows);
          this.onPlan.set(view.onPlan);
        },
        settled: () => this.busyChange.emit(false),
      });
    });
  }
}
