import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { DmgTakenAbility, TopDtkComparison, DmgTakenSegment } from '../../../core/models/analysis.models';
import { RangeChartComponent, RangeRow } from '../../../shared/components/range-chart/range-chart';
import { IconCacheService } from '../../../core/services/icon-cache';

const SEGMENT_LENGTH_S = 30;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-damage-taken',
  imports: [DecimalPipe, RangeChartComponent],
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

  // Shared x-axis max for the per-ability candlestick chart.
  protected readonly maxVal = computed(() => {
    const all = [...this.byAbility().map(a => a.pct), ...this.topComparison().map(t => t.avg_pct), ...this.topComparison().map(t => t.max_pct)];
    return Math.max(...all, 0.01);
  });

  // Shared x-axis max for the per-segment candlestick chart.
  protected readonly segMaxVal = computed(() => {
    const tsm = this.topSegMap();
    const all = this.segmentPcts().flatMap((p, i) => {
      const t = tsm[i];
      return [p, t?.avg_pct, t ? t.avg_pct + t.stddev_pct : null].filter((v): v is number => v != null);
    });
    return Math.max(...all, 0.01);
  });

  protected readonly segmentRows = computed((): RangeRow[] => {
    const tsm = this.topSegMap();
    return this.segmentPcts().map((p, i) => {
      const t = tsm[i];
      return {
        label: this.fmtTime(i * SEGMENT_LENGTH_S),
        playerPct: p,
        topAvg: t?.avg_pct ?? null,
        topMin: t ? Math.max(0, t.avg_pct - t.stddev_pct) : null,
        topMax: t ? t.avg_pct + t.stddev_pct : null,
      };
    });
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

  private fmtTime(s: number): string {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}
