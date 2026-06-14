import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DmgTakenAbility, TopDtkComparison } from '../../../core/models/analysis.models';
import { RangeChartComponent, RangeRow } from '../../../shared/components/range-chart/range-chart';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CalloutComponent } from '../../../shared/components/callout/callout';
import { IconCacheService } from '../../../core/services/icon-cache';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-damage-taken',
  imports: [RangeChartComponent, GameIconComponent, CalloutComponent],
  templateUrl: './damage-taken.html',
})
export class DamageTakenComponent {
  private readonly icons = inject(IconCacheService);
  readonly byAbility = input<DmgTakenAbility[]>([]);
  readonly topComparison = input<TopDtkComparison[]>([]);

  protected readonly topMap = computed(() => {
    const m: Record<number, TopDtkComparison> = {};
    for (const t of this.topComparison()) m[t.spell_id] = t;
    return m;
  });

  // Shared x-axis max for the per-ability candlestick chart.
  protected readonly maxVal = computed(() => {
    const all = [...this.byAbility().map(a => a.pct), ...this.topComparison().map(t => t.avg_pct), ...this.topComparison().map(t => t.max_pct)];
    return Math.max(...all, 0.01);
  });

  protected readonly abilityRows = computed((): RangeRow[] => {
    const topM = this.topMap();
    const playerMap: Record<number, DmgTakenAbility> = {};
    for (const ab of this.byAbility()) playerMap[ab.spell_id] = ab;
    const mergedIds = new Set([
      ...Object.keys(playerMap).map(Number),
      ...Object.keys(topM).map(Number),
    ]);
    return [...mergedIds].map(sid => {
      const ab = playerMap[sid];
      const top = topM[sid];
      const name = this.icons.get(sid)?.name || ab?.name || `Spell ${sid}`;
      return {
        spellId: sid,
        label: name,
        playerPct: ab?.pct ?? null,
        topAvg: top?.avg_pct ?? null,
        topMin: top?.min_pct ?? null,
        topMax: top?.max_pct ?? null,
      };
    }).sort((a, b) =>
      Math.max(b.playerPct ?? 0, b.topAvg ?? 0) - Math.max(a.playerPct ?? 0, a.topAvg ?? 0));
  });

  protected readonly outlierCount = computed(() => {
    const topM = this.topMap();
    return this.byAbility().filter(ab => {
      const t = topM[ab.spell_id];
      return t != null && ab.pct > t.avg_pct + Math.max(t.stddev_pct ?? 0, 0.02);
    }).length;
  });
}
