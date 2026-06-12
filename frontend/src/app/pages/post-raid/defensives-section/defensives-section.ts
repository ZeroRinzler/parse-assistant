import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatExpansionModule } from '@angular/material/expansion';
import { AnalysisFinding, PlayerDefensive, BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { SpellIconComponent } from '../../../shared/components/spell-icon/spell-icon';
import { RangeChartComponent, RangeRow } from '../../../shared/components/range-chart/range-chart';

const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold tip',
};

interface CdBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; success?: AnalysisFinding; }

interface AbilityRow {
  spell_id: number;
  avg_pct: number;
  min_pct?: number;
  max_pct?: number;
  playerPct: number | null;
  tBar: number;
  tMinP: number;
  rW: number;
  avgOff: number;
  playerBar: number;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensives-section',
  imports: [MatExpansionModule, SpellIconComponent, RangeChartComponent, FormatDurationPipe, DecimalPipe],
  templateUrl: './defensives-section.html',
  styleUrl: './defensives-section.scss',
})
export class DefensivesSectionComponent {
  readonly defensives = input.required<PlayerDefensive[]>();
  readonly defensiveFindings = input<AnalysisFinding[]>([]);
  readonly topDefensiveWindows = input<BurstWindow[]>([]);
  readonly playerDefensiveWindows = input<PlayerBurstWindow[]>([]);
  readonly fightDuration = input<number>(0);

  protected readonly expandedIdx = signal<number | null>(null);

  protected readonly defEntries = computed(() => {
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
        name, bucket, spellId: spellMap[name] ?? null,
        hasCritical, hasIssue, metaItems,
        allFindings: [...bucket.issues, ...bucket.holds],
      };
    });
  });

  protected formatMs(ms: number | undefined): string {
    if (ms == null) return '';
    const s = ms / 1000;
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  protected readonly topDefWindows = computed(() => this.topDefensiveWindows());

  protected readonly maxDwVal = computed(() => {
    const allVals = this.topDefWindows().flatMap((dw, i) => {
      const p = this.playerDefensiveWindows()[i]?.pct_of_total;
      return [dw.pct_avg, dw.pct_max, p].filter((v): v is number => v != null);
    });
    return Math.max(...allVals, 0.01);
  });

  protected readonly dwCards = computed(() => {
    const fightDur = this.fightDuration();
    const maxV = this.maxDwVal();
    return this.topDefWindows().map((dw, idx) => {
      const notReached = dw.time_s > fightDur;
      const playerDw = notReached ? null : (this.playerDefensiveWindows()[idx] ?? null);
      const topPct = dw.pct_avg ?? 0;
      const playerPct = playerDw?.pct_of_total ?? null;
      const minPct = dw.pct_min ?? topPct * 0.7;
      const maxPct = dw.pct_max ?? topPct * 1.3;
      const winLenS = dw.window_length_s ?? 8;
      const spellId = dw.spell_id ?? null;
      const defensiveName = dw.defensive_name ?? dw.common_defensives?.[0] ?? '';

      let cls = 'bw-ok', badge = 'On Par';
      if (notReached) { cls = 'bw-future'; badge = 'Not reached'; }
      else if (playerPct === null) { cls = 'bw-missing'; badge = 'No data'; }
      else if (playerPct > maxPct + (dw.pct_stddev ?? 0.01)) { cls = 'bw-high-dtk'; badge = 'High damage taken'; }

      const pBar = playerPct != null ? Math.min(playerPct / maxV * 100, 100) : 0;
      const tBar = topPct > 0 ? Math.min(topPct / maxV * 100, 100) : 0;
      const tMinP = Math.min(minPct / maxV * 100, 100);
      const tMaxP = Math.min(maxPct / maxV * 100, 100);
      const rW = tMaxP - tMinP;
      const avgOff = rW > 0 ? Math.min(((tBar - tMinP) / rW) * 100, 100) : 50;

      const playerAbMap: Record<number, { pct: number }> = {};
      for (const a of (playerDw?.ability_breakdown || [])) playerAbMap[a.spell_id] = a;

      return { dw, idx, notReached, playerPct, topPct, minPct, maxPct, winLenS, spellId, defensiveName, cls, badge, pBar, tBar, tMinP, tMaxP, rW, avgOff, playerAbMap };
    });
  });

  protected dwAbChartRows(cardIdx: number): RangeRow[] {
    const card = this.dwCards()[cardIdx];
    if (!card) return [];
    return (card.dw.ability_breakdown || []).map(ab => ({
      spellId: ab.spell_id,
      label: `Spell ${ab.spell_id}`,
      playerPct: card.playerAbMap[ab.spell_id]?.pct ?? null,
      topAvg: ab.avg_pct,
      topMin: ab.min_pct ?? ab.avg_pct * 0.7,
      topMax: ab.max_pct ?? ab.avg_pct * 1.3,
    }));
  }

  protected dwAbRows(cardIdx: number): AbilityRow[] {
    const card = this.dwCards()[cardIdx];
    if (!card) return [];
    const abs = card.dw.ability_breakdown || [];
    const allAbPcts = abs.map(a => a.max_pct ?? a.avg_pct);
    const playerVals = Object.values(card.playerAbMap).map(a => a.pct);
    const maxAbVal = Math.max(...allAbPcts, ...playerVals, 0.01);
    return abs.map(ab => {
      const playerPct = card.playerAbMap[ab.spell_id]?.pct ?? null;
      const tBar = Math.min(ab.avg_pct / maxAbVal * 100, 100);
      const minPct = ab.min_pct ?? ab.avg_pct * 0.7;
      const maxPct = ab.max_pct ?? ab.avg_pct * 1.3;
      const tMinP = Math.min(minPct / maxAbVal * 100, 100);
      const tMaxP = Math.min(maxPct / maxAbVal * 100, 100);
      const rW = tMaxP - tMinP;
      const avgOff = rW > 0 ? Math.min(((tBar - tMinP) / rW) * 100, 100) : 50;
      const playerBar = playerPct != null ? Math.min(playerPct / maxAbVal * 100, 100) : 0;
      return { ...ab, playerPct, tBar, tMinP, rW, avgOff, playerBar };
    });
  }

  protected toggleExpand(idx: number): void {
    this.expandedIdx.update(v => v === idx ? null : idx);
  }
}
