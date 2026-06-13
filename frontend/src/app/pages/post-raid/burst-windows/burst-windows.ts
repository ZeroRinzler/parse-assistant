import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { RangeChartComponent, RangeRow } from '../../../shared/components/range-chart/range-chart';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-burst-windows',
  imports: [RangeChartComponent, FormatDurationPipe, DecimalPipe],
  templateUrl: './burst-windows.html',
  styleUrl: './burst-windows.scss',
})
export class BurstWindowsComponent {
  readonly topWindows = input.required<BurstWindow[]>();
  readonly playerWindows = input<PlayerBurstWindow[]>([]);
  readonly fightDuration = input<number>(0);

  protected readonly expandedIdx = signal<number | null>(null);

  protected readonly maxVal = computed(() => {
    const allVals = this.topWindows().flatMap((bw, i) => {
      const p = this.playerWindows()[i]?.pct_of_total;
      return [bw.pct_avg, bw.pct_max, p].filter((v): v is number => v != null);
    });
    return Math.max(...allVals, 0.01);
  });

  protected cards = computed(() => {
    const fightDur = this.fightDuration();
    return this.topWindows().map((bw, idx) => {
      const notReached = bw.time_s > fightDur;
      const playerBw = notReached ? null : (this.playerWindows()[idx] ?? null);
      const topPct = bw.pct_avg ?? 0;
      const playerPct = playerBw?.pct_of_total ?? null;
      const minPct = bw.pct_min ?? topPct * 0.7;
      const maxPct = bw.pct_max ?? topPct * 1.3;

      let cls = 'bw-ok', badge = 'On Par';
      if (notReached) { cls = 'bw-future'; badge = 'Not reached'; }
      else if (playerPct === null) { cls = 'bw-missing'; badge = 'No data'; }
      else if (playerPct < minPct - (bw.pct_stddev ?? 0.01)) { cls = 'bw-low'; badge = 'Below range'; }
      else if (topPct > 0 && playerPct < topPct - (bw.pct_stddev ?? 0.005)) { cls = 'bw-warn'; badge = 'Slightly below'; }

      const playerAbMap: Record<number, { pct: number }> = {};
      for (const a of (playerBw?.ability_breakdown || [])) playerAbMap[a.spell_id] = a;

      const rangeRows: RangeRow[] = [{
        label: '',
        playerPct,
        topAvg: topPct,
        topMin: minPct,
        topMax: maxPct,
      }];

      return {
        bw, idx, notReached, playerPct, topPct, minPct, maxPct,
        cls, badge, playerAbMap, rangeRows,
        windowLength: bw.window_length_s,
      };
    });
  });

  protected abChartRows(cardIdx: number): RangeRow[] {
    const card = this.cards()[cardIdx];
    if (!card) return [];
    return (card.bw.ability_breakdown || []).map(ab => ({
      spellId: ab.spell_id,
      label: `Spell ${ab.spell_id}`,
      playerPct: card.playerAbMap[ab.spell_id]?.pct ?? null,
      topAvg: ab.avg_pct,
      topMin: ab.min_pct ?? ab.avg_pct * 0.7,
      topMax: ab.max_pct ?? ab.avg_pct * 1.3,
    }));
  }

  protected toggleExpand(idx: number): void {
    this.expandedIdx.update(v => v === idx ? null : idx);
  }
}
