import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { LoadStateComponent, RenderableLoadError } from '../../../shared/components/load-state/load-state';
import { slotName, statusIcon } from '../../../shared/gear/gear-comparison';
import { LatestLoad } from '../../../shared/latest-load';
import { logWarn } from '../../../core/log';
import { GearFeatureService, GearComparisonView, emptyGearView } from './gear.service';

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

  private readonly _view = signal<GearComparisonView>(emptyGearView());
  protected readonly view = this._view.asReadonly();
  // available() is the load outcome, not a view flag: true only once an ok result lands.
  private readonly _available = signal(false);
  protected readonly available = this._available.asReadonly();
  private readonly _error = signal<RenderableLoadError | null>(null);
  protected readonly error = this._error.asReadonly();

  // Partitioned in the component (semantic data only, no styling).
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
        context: 'gear.load',
        apply: result => {
          if (result.ok) {
            this._error.set(null);
            this._view.set(result.value);
            this._available.set(true);
            this.availableChange.emit(true);
          } else {
            if (result.error.kind === 'permanent') logWarn(result.error.id, result.error.context);
            this._error.set(result.error.kind === 'missing' ? null : result.error);
            this._view.set(emptyGearView());
            this._available.set(false);
            this.availableChange.emit(false);
          }
        },
        settled: () => this.busyChange.emit(false),
      });
    });
  }
}
