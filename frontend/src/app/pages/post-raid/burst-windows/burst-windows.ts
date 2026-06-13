import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { IconCacheService } from '../../../core/services/icon-cache';
import {
  ComparisonWindow,
  WindowComparisonComponent,
  WindowStatus,
} from '../../../shared/components/window-comparison/window-comparison';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-burst-windows',
  imports: [WindowComparisonComponent],
  templateUrl: './burst-windows.html',
})
export class BurstWindowsComponent {
  private readonly icons = inject(IconCacheService);

  readonly topWindows = input.required<BurstWindow[]>();
  readonly playerWindows = input<PlayerBurstWindow[]>([]);
  readonly fightDuration = input<number>(0);
  readonly cdSpellIds = input<Record<string, number>>({});

  protected readonly windows = computed<ComparisonWindow[]>(() => {
    const fightDur = this.fightDuration();
    const cdSpellIds = this.cdSpellIds();
    const players = this.playerWindows();

    return this.topWindows().map((bw, idx) => {
      const notReached = bw.time_s > fightDur;
      const playerBw = notReached ? null : (players[idx] ?? null);
      const topPct = bw.pct_avg ?? 0;
      const playerPct = playerBw?.pct_of_total ?? null;
      const minPct = bw.pct_min ?? topPct * 0.7;
      const maxPct = bw.pct_max ?? topPct * 1.3;

      // Burst: higher damage share is better, so falling short is the problem.
      let status: WindowStatus = 'good';
      let statusIcon = 'check_circle';
      if (notReached) { status = 'muted'; statusIcon = 'schedule'; }
      else if (playerPct === null) { status = 'muted'; statusIcon = 'help_outline'; }
      else if (playerPct < minPct - (bw.pct_stddev ?? 0.01)) { status = 'bad'; statusIcon = 'error'; }
      else if (topPct > 0 && playerPct < topPct - (bw.pct_stddev ?? 0.005)) { status = 'warn'; statusIcon = 'warning_amber'; }

      const spellIds: number[] = [];
      const labels: string[] = [];
      for (const name of bw.common_cds ?? []) {
        const sid = cdSpellIds[name];
        sid ? spellIds.push(sid) : labels.push(name);
      }

      const playerAbMap: Record<number, { pct: number }> = {};
      for (const a of playerBw?.ability_breakdown ?? []) playerAbMap[a.spell_id] = a;

      const detailRows = (bw.ability_breakdown ?? []).map(ab => ({
        spellId: ab.spell_id,
        label: this.icons.get(ab.spell_id)?.name || `Spell ${ab.spell_id}`,
        playerPct: playerAbMap[ab.spell_id]?.pct ?? null,
        topAvg: ab.avg_pct,
        topMin: ab.min_pct ?? ab.avg_pct * 0.7,
        topMax: ab.max_pct ?? ab.avg_pct * 1.3,
      }));

      return {
        timeStartS: bw.time_s,
        timeEndS: bw.time_s + bw.window_length_s,
        spellIds,
        labels,
        status,
        statusIcon,
        overview: { label: '', playerPct, topAvg: topPct, topMin: minPct, topMax: maxPct },
        detailRows,
      };
    });
  });
}
