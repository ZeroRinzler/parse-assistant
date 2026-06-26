import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { ComparisonEntry } from '../../../core/models/analysis.models';
import {
  RotationFeatureService, AbilityIcons, RotationFindingRow, RotationOnPlanChip,
} from './rotation.service';

/**
 * Rotation card (post-raid). A feature component: it injects exactly one service
 * (`RotationFeatureService`). It reproduces the legacy "Rotation Rules" +
 * "Offensives" finding sections plus the per-cooldown comparison table. Its bench
 * comes from the swappable `ROTATION_DATA_SOURCE` (file in prod, live transform
 * under the dev flag); the player findings are computed from the player's own log,
 * fetched by the service. Spell art is baked into `abilityIcons` and passed
 * explicitly to `wl-game-icon`, so this never touches the icon cache.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-rotation',
  imports: [DecimalPipe, MatIconModule, GameIconComponent, FormatDurationPipe],
  templateUrl: './rotation.html',
})
export class RotationComponent {
  private readonly rotation = inject(RotationFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly reportCode = input.required<string>();
  readonly fightId = input.required<number>();
  readonly playerId = input.required<number>();

  protected readonly ruleRows = signal<RotationFindingRow[]>([]);
  protected readonly offensiveRows = signal<RotationFindingRow[]>([]);
  protected readonly onPlan = signal<RotationOnPlanChip[]>([]);
  protected readonly comparison = signal<ComparisonEntry[]>([]);
  protected readonly abilityIcons = signal<AbilityIcons>({});

  // Bumped on every reload so a slow earlier response can't overwrite a newer one.
  private loadToken = 0;

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      const reportCode = this.reportCode();
      const fightId = this.fightId();
      const playerId = this.playerId();
      const token = ++this.loadToken;
      void this.rotation.loadPlayerView(spec, encounterId, reportCode, fightId, playerId).then(view => {
        if (token !== this.loadToken) return;
        this.ruleRows.set(view.ruleRows);
        this.offensiveRows.set(view.offensiveRows);
        this.onPlan.set(view.onPlan);
        this.comparison.set(view.comparison);
        this.abilityIcons.set(view.abilityIcons);
      });
    });
  }

  protected iconOf(spellId: number | null | undefined): string {
    return spellId != null ? (this.abilityIcons()[spellId]?.icon ?? '') : '';
  }
  protected nameOf(spellId: number | null | undefined, fallback = ''): string {
    return (spellId != null ? this.abilityIcons()[spellId]?.name : '') || fallback;
  }
}
