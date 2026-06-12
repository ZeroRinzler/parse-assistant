import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { DmgTakenAbility, TopDtkComparison, DmgTakenSegment } from '../../../core/models/analysis.models';
import { ComparisonChartComponent, ChartRow } from '../../../shared/components/comparison-chart/comparison-chart';

import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { IconCacheService } from '../../../core/services/icon-cache';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-damage-taken',
  imports: [DecimalPipe, ComparisonChartComponent, FormatDurationPipe],
  templateUrl: './damage-taken.html',
  styleUrl: './damage-taken.scss',
})
export class DamageTakenComponent {
  private readonly icons = inject(IconCacheService);
  readonly byAbility = input<DmgTakenAbility[]>([]);
  readonly total = input<number>(0);
  readonly topComparison = input<TopDtkComparison[]>([]);
  readonly segmentPcts = input<number[]>([]);
  readonly topSegments = input<DmgTakenSegment[]>([]);

  protected readonly topMap = computed(() => {
    const m: Record<number, TopDtkComparison> = {};
    for (const t of this.topComparison()) m[t.spell_id] = t;
    return m;
  });

  protected readonly topSegMap = computed(() => {
    const m: Record<number, DmgTakenSegment> = {};
    for (const s of this.topSegments()) m[s.seg_index] = s;
    return m;
  });

  protected readonly maxVal = computed(() => {
    const all = [...this.byAbility().map(a => a.pct), ...this.topComparison().map(t => t.avg_pct), ...this.topComparison().map(t => t.max_pct)];
    return Math.max(...all, 0.01);
  });

  protected readonly segMaxVal = computed(() => {
    const tsm = this.topSegMap();
    const all = this.segmentPcts().flatMap((p, i) => {
      const t = tsm[i];
      return [p, t?.avg_pct, t ? t.avg_pct + t.stddev_pct : null].filter((v): v is number => v != null);
    });
    return Math.max(...all, 0.01);
  });

  protected readonly chartRows = computed((): ChartRow[] => {
    const topM = this.topMap();
    const playerMap: Record<number, DmgTakenAbility> = {};
    for (const ab of this.byAbility()) playerMap[ab.spell_id] = ab;
    const mergedIds = new Set([
      ...Object.keys(playerMap).map(Number),
      ...Object.keys(topM).map(Number),
    ]);
    return [...mergedIds].map(sid => {
      const ab = playerMap[sid] ?? { spell_id: sid, name: '', damage: 0, pct: 0 };
      const top = topM[sid];
      const icon = this.icons.get(sid);
      const name = icon?.name || ab.name || `Spell ${sid}`;
      const iconUrl = this.icons.iconUrl(sid, 'small');
      const iconHtml = iconUrl ? `<img src="${iconUrl}" width="18" height="18" style="border-radius:3px;vertical-align:middle" alt="">` : '';
      return {
        labelHtml: `<span style="display:flex;align-items:center;gap:6px">${iconHtml}
          <a href="https://www.wowhead.com/spell=${sid}" target="_blank">${name}</a>
        </span>`,
        playerVal: ab.pct,
        topAvg: top?.avg_pct ?? null,
        topMin: top?.min_pct ?? null,
        topMax: top?.max_pct ?? null,
        highlight: top != null && ab.pct > top.avg_pct + Math.max(top.stddev_pct ?? 0, 0.02),
      };
    }).sort((a, b) => {
      const ah = a.highlight ? 1 : 0, bh = b.highlight ? 1 : 0;
      if (ah !== bh) return bh - ah;
      return Math.max(b.playerVal ?? 0, b.topAvg ?? 0) - Math.max(a.playerVal ?? 0, a.topAvg ?? 0);
    });
  });

  protected readonly outliers = computed(() => this.chartRows().filter(r => r.highlight));

  protected barHeight(val: number, maxV: number): number {
    return Math.round(val / maxV * 78);
  }

  protected segTime(i: number): number {
    return i * 30;
  }

  protected isHighSeg(i: number): boolean {
    const t = this.topSegMap()[i];
    const p = this.segmentPcts()[i] ?? 0;
    return t != null && p > t.avg_pct + Math.max(t.stddev_pct ?? 0, 0.02);
  }
}
