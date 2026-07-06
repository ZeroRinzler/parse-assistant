import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { LatestLoad } from '../../../shared/latest-load';
import { DefensiveFeatureService, DefensivePlanRow } from './defensive.service';

/**
 * Defensive game plan (pre-fight) as a 3-column table (What / Plan / How to use),
 * mirroring the cooldown plan schema. A feature component: injects exactly one
 * service (`DefensiveFeatureService`) and reads the bench-only plan rows via the
 * swappable `DEFENSIVE_DATA_SOURCE`. Defensives never align with Bloodlust so that
 * tag is omitted. Self-contained to /pre.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensive-plan',
  imports: [DecimalPipe, GameIconComponent, CollapsibleTextComponent, LoadStateComponent, FormatDurationPipe],
  templateUrl: './defensive-plan.html',
})
export class DefensivePlanComponent {
  private readonly defensive = inject(DefensiveFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly title = input('Defensive plan');
  readonly subtitle = input('Defensive usage across top parses.');

  /** Whether the top-parse bench exists. The page aggregates it for the banner. */
  readonly availableChange = output<boolean>();

  protected readonly available = signal(true);
  private readonly _items = signal<DefensivePlanRow[]>([]);
  protected readonly items = this._items.asReadonly();

  private readonly loader = new LatestLoad();

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      this.loader.run(this.defensive.loadPlan(spec, encounterId), {
        context: 'defensive.loadPlan',
        apply: view => {
          this.available.set(view.available);
          this.availableChange.emit(view.available);
          this._items.set(view.rows);
        },
      });
    });
  }
}
