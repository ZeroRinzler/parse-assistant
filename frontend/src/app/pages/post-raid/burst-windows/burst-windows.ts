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
    const cdIds = this.cdSpellIds();
    const spellIds = (bw.common_cds ?? []).map(n => cdIds[n]).filter((id): id is number => !!id);
    this.panel.openAt(bw.time_s, { kind: 'boss' }, label, spellIds);
  }

  protected readonly windows = computed<ComparisonWindow[]>(() => {
    const fightDur = this.fightDuration();
    const cdSpellIds = this.cdSpellIds();
    const players = this.playerWindows();

    return this.topWindows().map((bw, idx) => {
      const notReached = bw.time_s > fightDur;
      const playerBw = notReached ? null : (players[idx] ?? null);
      const topDmg = bw.dmg_avg;
      const playerDmg = playerBw?.window_damage ?? null;
      const minDmg = bw.dmg_min;
      const maxDmg = bw.dmg_max;
      const sd = bw.dmg_stddev;

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

      const playerAbMap: Record<number, { damage: number; casts?: number }> = {};
      for (const a of playerBw?.ability_breakdown ?? []) playerAbMap[a.spell_id] = a;

      const detailRows = bw.ability_breakdown.map(ab => ({
        spellId: ab.spell_id,
        label: this.icons.get(ab.spell_id)?.name || `Spell ${ab.spell_id}`,
        playerPct: playerAbMap[ab.spell_id]?.damage ?? null,
        topAvg: ab.avg_damage,
        topMin: ab.min_damage,
        topMax: ab.max_damage,
        playerCasts: playerAbMap[ab.spell_id]?.casts ?? null,
        topCasts: ab.avg_casts ?? null,
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
