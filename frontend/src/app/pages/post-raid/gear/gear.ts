import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { slotName, statusIcon } from '../../../shared/gear/gear-comparison';
import { LatestLoad } from '../../../shared/latest-load';
import { GearFeatureService, GearComparisonView, emptyGearView } from './gear.service';

/**
 * Gear card. A feature component: it injects exactly one service
 * (`GearFeatureService`) and renders. Its bench data comes from the swappable
 * `GEAR_DATA_SOURCE` (file in prod, live transform under the dev flag).
 *
 * Dual-mode: when a `report`/`fight`/`player` selection is supplied (post-raid) the
 * card compares the player's combatant-info gear against the bench; with only
 * `spec`/`encounterId` (pre-fight) it shows the bench-only consensus.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-gear',
  imports: [MatIconModule, GameIconComponent, CollapsibleTextComponent],
  templateUrl: './gear.html',
})
export class GearComponent {
  private readonly gear = inject(GearFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  /** Post-raid selection - omit (or leave 0/'') for the pre-fight bench-only view. */
  readonly report = input<string>('');
  readonly fight = input<number>(0);
  readonly player = input<number>(0);

  /** Emits false when the card has finished loading; the page gates its spinner on it. */
  readonly busyChange = output<boolean>();

  private readonly _view = signal<GearComparisonView>(emptyGearView());
  protected readonly view = this._view.asReadonly();

  // Enchant rows partitioned for the comparison view (semantic data only, no styling).
  protected readonly enchantIssues = computed(() => this.view().enchantRows.filter(row => row.status !== 'ok'));
  protected readonly enchantOnPlan = computed(() => this.view().enchantRows.filter(row => row.status === 'ok'));

  protected readonly slotName = slotName;
  protected readonly statusIcon = statusIcon;

  private readonly loader = new LatestLoad();

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      const report = this.report();
      const fight = this.fight();
      const player = this.player();
      const load = report && fight && player
        ? this.gear.loadComparisonView(spec, encounterId, report, fight, player)
        : this.gear.loadBenchView(spec, encounterId);
      this.loader.run(load, {
        context: 'gear.loadComparisonView',
        apply: view => this._view.set(view),
        settled: () => this.busyChange.emit(false),
      });
    });
  }
}
