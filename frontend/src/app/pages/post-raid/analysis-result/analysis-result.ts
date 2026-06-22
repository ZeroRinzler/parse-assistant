import { ChangeDetectionStrategy, Component, computed, inject, input, OnChanges } from '@angular/core';
import { AnalysisResult as IAnalysisResult, AnalysisFinding } from '../../../core/models/analysis.models';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { IconCacheService } from '../../../core/services/icon-cache';
import {
  FindingEntry,
  FindingRow,
  FindingTableComponent,
  onPlanFromEntries,
  rowsFromEntries,
} from '../../../shared/components/finding-table/finding-table';
import { BurstWindowsComponent } from '../burst-windows/burst-windows';
import { DefensivesSectionComponent } from '../defensives-section/defensives-section';
import { DamageTakenComponent } from '../damage-taken/damage-taken';
import { GearSectionComponent } from '../gear-section/gear-section';

interface CdBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; success?: AnalysisFinding; }

const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold tip',
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-analysis-result',
  imports: [
    FindingTableComponent,
    BurstWindowsComponent, DefensivesSectionComponent, DamageTakenComponent, GearSectionComponent,
  ],
  templateUrl: './analysis-result.html',
})
export class AnalysisResultComponent implements OnChanges {
  private readonly icons = inject(IconCacheService);

  readonly data = input.required<IAnalysisResult>();
  readonly topGear = input<EncounterGearStats | null>(null);

  protected readonly cdBuckets = computed(() => {
    const byCD: Record<string, CdBucket> = {};
    const ruleFindings: AnalysisFinding[] = [];

    for (const f of this.data().findings) {
      if (f.severity === 'success') continue;
      if (f.category === 'hold_suggestion' && f.details?.cd_name) {
        const n = f.details.cd_name;
        if (!byCD[n]) byCD[n] = { issues: [], holds: [] };
        byCD[n].holds.push(f);
      } else if (f.category === 'rule_violation' || !f.cd_name) {
        ruleFindings.push(f);
      } else {
        const n = f.cd_name!;
        if (!byCD[n]) byCD[n] = { issues: [], holds: [] };
        byCD[n].issues.push(f);
      }
    }
    for (const f of this.data().findings) {
      if (f.severity !== 'success') continue;
      const n = f.cd_name;
      if (n && !byCD[n]) byCD[n] = { issues: [], holds: [] };
      if (n) byCD[n].success = f;
    }
    return { byCD, ruleFindings };
  });

  private readonly cdEntries = computed<FindingEntry[]>(() =>
    Object.entries(this.cdBuckets().byCD).map(([name, bucket]) => {
      const hasCritical = bucket.issues.some(f => f.severity === 'critical');
      const hasIssue = bucket.issues.length > 0 || bucket.holds.length > 0;
      const metaItems: string[] = [];
      for (const f of bucket.issues) {
        const lbl = CAT_LABEL[f.category];
        if (lbl && !metaItems.includes(lbl)) metaItems.push(lbl);
      }
      if (bucket.holds.length) metaItems.push(`${bucket.holds.length} hold tip${bucket.holds.length > 1 ? 's' : ''}`);
      return {
        name, spellId: this.data().cd_spell_ids?.[name] ?? null,
        hasCritical, hasIssue, metaItems,
        findings: [...bucket.issues, ...bucket.holds],
      };
    })
  );

  /** Rotation-rule findings as flat table rows. */
  protected readonly ruleRows = computed<FindingRow[]>(() =>
    this.cdBuckets().ruleFindings.map(f => ({
      severity: f.severity === 'critical' ? 'critical' : 'warning',
      what: f.label,
      measured: f.measured!,
      fix: f.details?.remedy,
    }))
  );

  /** Offensive cooldowns with issues, one row per finding. */
  protected readonly offensiveRows = computed<FindingRow[]>(() => rowsFromEntries(this.cdEntries(), CAT_LABEL));
  /** Offensive cooldowns used on plan, shown as success chips. */
  protected readonly offensiveOnPlan = computed(() => onPlanFromEntries(this.cdEntries()));

  ngOnChanges(): void {
    const d = this.data();
    if (d.ability_icons) this.icons.seedFromMap(d.ability_icons);
    const allIds = [
      ...Object.values(d.cd_spell_ids || {}),
      ...(d.burst_windows || []).flatMap(bw => bw.ability_breakdown.map(a => a.spell_id)),
      ...(d.player_defensives || []).map(def => def.spell_id),
      ...(d.player_dmg_taken_by_ability || []).map(a => a.spell_id),
      ...(d.top_dtk_comparison || []).map(t => t.spell_id),
    ];
    const missing = allIds.filter(id => !this.icons.get(id));
    if (missing.length) this.icons.fetchMissing(missing);
  }
}
