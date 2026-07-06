import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { LatestLoad } from '../../../shared/latest-load';
import { RotationFeatureService, CdPlanRow } from './rotation.service';

/**
 * Pre-fight cooldown game plan (bench-only). A feature component: it injects
 * exactly one service (`RotationFeatureService`) and reads the plan rows from the
 * swappable `ROTATION_DATA_SOURCE`. No player log is needed. Spell art is baked
 * onto each row and passed explicitly to `wl-game-icon`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-rotation-cd-plan',
  imports: [DecimalPipe, GameIconComponent, CollapsibleTextComponent, LoadStateComponent, FormatDurationPipe],
  templateUrl: './rotation-cd-plan.html',
})
export class RotationCdPlanComponent {
  private readonly rotation = inject(RotationFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly title = input('Cooldown plan');
  readonly subtitle = input('Offensive cooldown usage across top parses.');

  /** Whether the top-parse bench exists. The page aggregates it for the banner. */
  readonly availableChange = output<boolean>();

  protected readonly available = signal(true);
  protected readonly items = signal<CdPlanRow[]>([]);

  private readonly loader = new LatestLoad();

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      this.loader.run(this.rotation.loadPlanView(spec, encounterId), {
        context: 'rotation.loadPlanView',
        apply: view => {
          this.available.set(view.available);
          this.availableChange.emit(view.available);
          this.items.set(view.rows);
        },
      });
    });
  }
}
