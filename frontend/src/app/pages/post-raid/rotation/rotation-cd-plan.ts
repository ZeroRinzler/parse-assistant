import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { RotationFeatureService, AbilityIcons, CdPlanRow } from './rotation.service';

/**
 * Pre-fight cooldown game plan (bench-only). A feature component: it injects
 * exactly one service (`RotationFeatureService`) and reads the plan rows from the
 * swappable `ROTATION_DATA_SOURCE`. No player log is needed. Spell art is baked
 * into the bench and passed explicitly to `wl-game-icon`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-rotation-cd-plan',
  imports: [DecimalPipe, GameIconComponent, FormatDurationPipe],
  templateUrl: './rotation-cd-plan.html',
})
export class RotationCdPlanComponent {
  private readonly rotation = inject(RotationFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly title = input('Cooldown plan');
  readonly subtitle = input('How top parsers open and pace offensive cooldowns on this fight.');

  protected readonly items = signal<CdPlanRow[]>([]);
  protected readonly abilityIcons = signal<AbilityIcons>({});

  private loadToken = 0;

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      const token = ++this.loadToken;
      void this.rotation.loadPlanView(spec, encounterId).then(view => {
        if (token !== this.loadToken) return;
        this.items.set(view.rows);
        this.abilityIcons.set(view.abilityIcons);
      });
    });
  }

  protected iconOf(spellId: number | null): string {
    return spellId != null ? (this.abilityIcons()[spellId]?.icon ?? '') : '';
  }
  protected nameOf(spellId: number | null, fallback: string): string {
    return (spellId != null ? this.abilityIcons()[spellId]?.name : '') || fallback;
  }
}
