import { describe, it, expect } from 'vitest';
import { AnalysisResultComponent } from './analysis-result';
import { AnalysisResult, AnalysisFinding } from '../../../core/models/analysis.models';
import { FindingEntry } from '../../../shared/components/finding-list/finding-list';
import { mountVm } from '../../../../testing/component-harness';

function result(findings: AnalysisFinding[], cdSpellIds: Record<string, number> = {}): AnalysisResult {
  return { player: 'Rogue', spec: 'Sub', rulebook_source: 'generated', findings, cd_spell_ids: cdSpellIds, ability_icons: {} };
}

/** Mount the component with a given analysis result and read its `cdEntries` computed. */
function cdEntriesFor(findings: AnalysisFinding[], cdSpellIds?: Record<string, number>): FindingEntry[] {
  const { vm } = mountVm(AnalysisResultComponent, { data: result(findings, cdSpellIds) });
  return (vm['cdEntries'] as () => FindingEntry[])();
}

describe('AnalysisResultComponent cdEntries', () => {
  it('groups a critical issue under its cooldown and labels it', () => {
    const [entry] = cdEntriesFor([
      { severity: 'critical', category: 'lost_cooldown', cd_name: 'Shadow Blades', message: 'never used' },
    ], { 'Shadow Blades': 121471 });

    expect(entry.name).toBe('Shadow Blades');
    expect(entry.spellId).toBe(121471);
    expect(entry.hasCritical).toBe(true);
    expect(entry.metaItems).toContain('lost cast');
  });

  it('routes hold suggestions into the cooldown bucket and counts them', () => {
    const [entry] = cdEntriesFor([
      { severity: 'info', category: 'hold_suggestion', message: 'hold tip', details: { cd_name: 'Vanish' } },
    ]);

    expect(entry.name).toBe('Vanish');
    expect(entry.hasCritical).toBe(false);
    expect(entry.metaItems).toContain('1 hold tip');
  });

  it('excludes success findings from the issue/hold lists', () => {
    const entries = cdEntriesFor([
      { severity: 'success', category: 'cooldown_usage', cd_name: 'Shadow Dance', message: 'good' },
    ]);

    const dance = entries.find((e) => e.name === 'Shadow Dance');
    expect(dance?.hasIssue).toBe(false);
    expect(dance?.metaItems).toEqual([]);
  });

  it('keeps rule violations out of the per-cooldown buckets', () => {
    const entries = cdEntriesFor([
      { severity: 'critical', category: 'rule_violation', message: 'paired wrong' },
    ]);

    expect(entries).toHaveLength(0);
  });
});
