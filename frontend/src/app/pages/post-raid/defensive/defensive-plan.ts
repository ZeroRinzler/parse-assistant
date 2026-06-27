import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
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
  imports: [DecimalPipe, GameIconComponent, CollapsibleTextComponent, FormatDurationPipe],
  templateUrl: './defensive-plan.html',
})
export class DefensivePlanComponent {
  private readonly defensive = inject(DefensiveFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly title = input('Defensive plan');
  readonly subtitle = input('When top parsers use defensives, and how often, on this fight.');

  private readonly _items = signal<DefensivePlanRow[]>([]);
  protected readonly items = this._items.asReadonly();

  // Bumped on every reload so a slow earlier response can't overwrite a newer one.
  private loadToken = 0;

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      const token = ++this.loadToken;
      void this.defensive.loadPlan(spec, encounterId).then(rows => {
        if (token !== this.loadToken) return;
        this._items.set(rows);
      });
    });
  }
}
