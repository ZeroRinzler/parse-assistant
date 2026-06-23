import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AnalysisFinding, PlayerDefensive, BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { IconCacheService } from '../../../core/services/icon-cache';
import { PositioningPanelService } from '../../../core/services/positioning-panel';
import {
  bucketFindings,
  CAT_LABEL,
  FindingRow,
  FindingTableComponent,
  onPlanFromEntries,
  rowsFromEntries,
} from '../../../shared/components/finding-table/finding-table';
import {
  ComparisonWindow,
  WindowComparisonComponent,
  WindowStatus,
} from '../../../shared/components/window-comparison/window-comparison';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensives-section',
  imports: [FindingTableComponent, WindowComparisonComponent],
  templateUrl: './defensives-section.html',
})
export class DefensivesSectionComponent {
  private readonly icons = inject(IconCacheService);
  private readonly panel = inject(PositioningPanelService);

  readonly defensives = input.required<PlayerDefensive[]>();
  readonly defensiveFindings = input<AnalysisFinding[]>([]);
  readonly topDefensiveWindows = input<BurstWindow[]>([]);
  readonly playerDefensiveWindows = input<PlayerBurstWindow[]>([]);
  readonly fightDuration = input<number>(0);

  protected readonly showMap = computed(() => !!this.panel.positions());

  protected onOpenMap(i: number): void {
    const dw = this.topDefensiveWindows()[i];
    if (!dw) return;
    const ref = dw.ref_game_id != null ? { kind: 'enemy' as const, gameId: dw.ref_game_id } : { kind: 'boss' as const };
    const spellIds = dw.spell_id != null ? [dw.spell_id] : [];
    this.panel.openAt(dw.time_s, ref, dw.defensive_name ?? 'Defensive', spellIds);
  }

  /** Defensive cooldowns with issues, one flat table row per finding. */
  protected readonly defRows = computed<FindingRow[]>(() => rowsFromEntries(this.defEntries(), CAT_LABEL));
  /** Defensives used on plan, shown as success chips. */
  protected readonly defOnPlan = computed(() => onPlanFromEntries(this.defEntries()));

  private readonly defEntries = computed(() => {
    const spellMap: Record<string, number> = {};
    for (const def of this.defensives()) spellMap[def.name] = def.spell_id;
    return bucketFindings(this.defensiveFindings(), { spellId: name => spellMap[name] ?? null }).entries;
  });

  protected readonly defWindows = computed<ComparisonWindow[]>(() => {
    const fightDur = this.fightDuration();
    const players = this.playerDefensiveWindows();

    return this.topDefensiveWindows().map((dw, idx) => {
      const notReached = dw.time_s > fightDur;
      const playerDw = notReached ? null : (players[idx] ?? null);
      const topDmg = dw.dmg_avg;
      const playerDmg = playerDw?.window_damage ?? null;
      const minDmg = dw.dmg_min;
      const maxDmg = dw.dmg_max;
      const sd = dw.dmg_stddev;
      const spellId = dw.spell_id ?? null;
      const defensiveName = dw.defensive_name ?? dw.common_defensives?.[0] ?? '';

      // Defensive: less damage taken in the window is better, so taking more is bad.
      let status: WindowStatus = 'good';
      let statusIcon = 'check_circle';
      if (notReached) { status = 'muted'; statusIcon = 'schedule'; }
      else if (playerDmg === null) { status = 'muted'; statusIcon = 'help_outline'; }
      else if (playerDmg > maxDmg + sd) { status = 'bad'; statusIcon = 'error'; }
      else if (topDmg > 0 && playerDmg > topDmg + sd) { status = 'warn'; statusIcon = 'warning_amber'; }

      const spellIds = spellId != null ? [spellId] : [];
      const labels = spellId == null && defensiveName ? [defensiveName] : [];

      const playerAbMap: Record<number, { damage: number }> = {};
      for (const a of playerDw?.ability_breakdown ?? []) playerAbMap[a.spell_id] = a;

      const detailRows = dw.ability_breakdown.map(ab => ({
        spellId: ab.spell_id,
        label: this.icons.get(ab.spell_id)?.name || `Spell ${ab.spell_id}`,
        playerPct: playerAbMap[ab.spell_id]?.damage ?? null,
        topAvg: ab.avg_damage,
        topMin: ab.min_damage,
        topMax: ab.max_damage,
      }));

      return {
        timeStartS: dw.time_s,
        timeEndS: dw.time_s + dw.window_length_s,
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
