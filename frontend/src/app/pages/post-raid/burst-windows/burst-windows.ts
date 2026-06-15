import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { IconCacheService } from '../../../core/services/icon-cache';
import { PositioningPanelService } from '../../../core/services/positioning-panel';
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
  private readonly panel = inject(PositioningPanelService);

  readonly topWindows = input.required<BurstWindow[]>();
  readonly playerWindows = input<PlayerBurstWindow[]>([]);
  readonly fightDuration = input<number>(0);
  readonly cdSpellIds = input<Record<string, number>>({});

  /** Map is available once the page has loaded top-parse positions. */
  protected readonly showMap = computed(() => !!this.panel.positions());

  protected onOpenMap(i: number): void {
    const bw = this.topWindows()[i];
    if (!bw) return;
    const label = (bw.common_cds ?? []).join(', ') || 'Burst window';
    // Burst windows are positioned relative to the boss.
    this.panel.openAt(bw.time_s, { kind: 'boss' }, label);
  }

  protected readonly windows = computed<ComparisonWindow[]>(() => {
    const fightDur = this.fightDuration();
    const cdSpellIds = this.cdSpellIds();
    const players = this.playerWindows();

    return this.topWindows().map((bw, idx) => {
      const notReached = bw.time_s > fightDur;
      const playerBw = notReached ? null : (players[idx] ?? null);
      const topDmg = bw.dmg_avg ?? 0;
      const playerDmg = playerBw?.window_damage ?? null;
      const minDmg = bw.dmg_min ?? topDmg * 0.7;
      const maxDmg = bw.dmg_max ?? topDmg * 1.3;
      const sd = bw.dmg_stddev ?? 0;

      // Burst: higher damage is better, so falling short is the problem.
      let status: WindowStatus = 'good';
      let statusIcon = 'check_circle';
      if (notReached) { status = 'muted'; statusIcon = 'schedule'; }
      else if (playerDmg === null) { status = 'muted'; statusIcon = 'help_outline'; }
      else if (playerDmg < minDmg - sd) { status = 'bad'; statusIcon = 'error'; }
      else if (topDmg > 0 && playerDmg < topDmg - sd) { status = 'warn'; statusIcon = 'warning_amber'; }

      const spellIds: number[] = [];
      const labels: string[] = [];
      for (const name of bw.common_cds ?? []) {
        const sid = cdSpellIds[name];
        sid ? spellIds.push(sid) : labels.push(name);
      }

      const playerAbMap: Record<number, { damage: number }> = {};
      for (const a of playerBw?.ability_breakdown ?? []) playerAbMap[a.spell_id] = a;

      const detailRows = (bw.ability_breakdown ?? []).map(ab => ({
        spellId: ab.spell_id,
        label: this.icons.get(ab.spell_id)?.name || `Spell ${ab.spell_id}`,
        playerPct: playerAbMap[ab.spell_id]?.damage ?? null,
        topAvg: ab.avg_damage,
        topMin: ab.min_damage ?? ab.avg_damage * 0.7,
        topMax: ab.max_damage ?? ab.avg_damage * 1.3,
      }));

      return {
        timeStartS: bw.time_s,
        timeEndS: bw.time_s + bw.window_length_s,
        spellIds,
        labels,
        status,
        statusIcon,
        overview: { label: '', playerPct: playerDmg, topAvg: topDmg, topMin: minDmg, topMax: maxDmg },
        detailRows,
      };
    });
  });
}
