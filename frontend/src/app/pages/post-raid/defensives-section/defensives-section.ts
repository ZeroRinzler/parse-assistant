import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AnalysisFinding, PlayerDefensive, BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { IconCacheService } from '../../../core/services/icon-cache';
import { PositioningPanelService } from '../../../core/services/positioning-panel';
import { FindingEntry, FindingListComponent } from '../../../shared/components/finding-list/finding-list';
import {
  ComparisonWindow,
  WindowComparisonComponent,
  WindowStatus,
} from '../../../shared/components/window-comparison/window-comparison';

const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold tip',
};

interface CdBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; success?: AnalysisFinding; }

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensives-section',
  imports: [FindingListComponent, WindowComparisonComponent],
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

  protected readonly defEntries = computed<FindingEntry[]>(() => {
    const findings = this.defensiveFindings();
    const defensives = this.defensives();
    const byName: Record<string, CdBucket> = {};

    for (const f of findings) {
      if (f.severity === 'success') continue;
      const n = f.cd_name!;
      if (!byName[n]) byName[n] = { issues: [], holds: [] };
      if (f.category === 'hold_suggestion' && f.details?.cd_name) {
        byName[n].holds.push(f);
      } else {
        byName[n].issues.push(f);
      }
    }
    for (const f of findings) {
      if (f.severity !== 'success') continue;
      const n = f.cd_name!;
      if (n && !byName[n]) byName[n] = { issues: [], holds: [] };
      if (n) byName[n].success = f;
    }

    const spellMap: Record<string, number> = {};
    for (const d of defensives) spellMap[d.name] = d.spell_id;

    return Object.entries(byName).map(([name, bucket]) => {
      const hasCritical = bucket.issues.some(f => f.severity === 'critical');
      const hasIssue = bucket.issues.length > 0 || bucket.holds.length > 0;
      const metaItems: string[] = [];
      for (const f of bucket.issues) {
        const lbl = CAT_LABEL[f.category];
        if (lbl && !metaItems.includes(lbl)) metaItems.push(lbl);
      }
      if (bucket.holds.length) metaItems.push(`${bucket.holds.length} hold tip${bucket.holds.length > 1 ? 's' : ''}`);
      return {
        name, spellId: spellMap[name] ?? null,
        hasCritical, hasIssue, metaItems,
        findings: [...bucket.issues, ...bucket.holds],
      };
    });
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
