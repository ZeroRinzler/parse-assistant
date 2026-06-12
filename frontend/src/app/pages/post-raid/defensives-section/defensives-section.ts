import { Component, computed, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { PlayerDefensive, TopDefensiveSummary } from '../../../core/models/analysis.models';
import { SpellIconComponent } from '../../../shared/components/spell-icon/spell-icon';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';

@Component({
  selector: 'wl-defensives-section',
  imports: [SpellIconComponent, FormatDurationPipe, DecimalPipe],
  templateUrl: './defensives-section.html',
  styleUrl: './defensives-section.scss',
})
export class DefensivesSectionComponent {
  readonly defensives = input.required<PlayerDefensive[]>();
  readonly topSummary = input<TopDefensiveSummary[]>([]);
  readonly fightDuration = input<number>(0);

  protected readonly topBySpellId = computed(() => {
    const m: Record<number, TopDefensiveSummary> = {};
    for (const t of this.topSummary()) m[t.spell_id] = t;
    return m;
  });

  protected cards = computed(() => {
    const topMap = this.topBySpellId();
    return this.defensives().map(def => {
      const top = topMap[def.spell_id];
      const expected = def.cooldown > 0 ? Math.floor(this.fightDuration() / def.cooldown) : null;
      const maxVal = Math.max(def.uses, top?.max_uses ?? 0, expected ?? 0, 1);

      const pBar = Math.min(def.uses / maxVal * 100, 100);
      const tBar = top ? Math.min(top.avg_uses / maxVal * 100, 100) : null;
      const tMinP = top?.min_uses != null ? Math.min(top.min_uses / maxVal * 100, 100) : null;
      const tMaxP = top?.max_uses != null ? Math.min(top.max_uses / maxVal * 100, 100) : null;
      const rW = (tMinP != null && tMaxP != null && tMaxP > tMinP) ? tMaxP - tMinP : 0;
      const avgOff = rW > 0 && tBar != null ? Math.min(((tBar - tMinP!) / rW) * 100, 100) : 50;

      let pValCls = '';
      if (top) pValCls = def.uses >= top.avg_uses ? 'delta-good' : def.uses >= top.min_uses ? 'delta-warn' : 'delta-bad';
      const lowUse = expected != null && def.uses < (top?.min_uses ?? expected);

      return { def, top, expected, pBar, tBar, tMinP, tMaxP, rW, avgOff, pValCls, lowUse };
    });
  });
}
