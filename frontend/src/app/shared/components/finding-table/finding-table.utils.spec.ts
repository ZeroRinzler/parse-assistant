import { describe, it, expect } from 'vitest';
import { bucketFindings, rowsFromEntries, onPlanFromEntries, CAT_LABEL, FindingEntry } from './finding-table.utils';
import { AnalysisFinding } from '../../../core/models/analysis.models';

const spellId = (_name: string) => null;
const icon = (_name: string) => '';

const f = (
  severity: AnalysisFinding['severity'],
  category: string,
  cdName?: string,
  opts: Partial<AnalysisFinding> = {},
): AnalysisFinding => ({
  severity,
  category,
  cd_name: cdName,
  message: `${severity}/${category}`,
  ...opts,
});

describe('bucketFindings', () => {
  it('groups critical issue under its cooldown name', () => {
    const finding = f('critical', 'lost_cooldown', 'Shadow Blades');
    const { entries } = bucketFindings([finding], { spellId, icon });

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Shadow Blades');
    expect(entries[0].hasCritical).toBe(true);
    expect(entries[0].hasIssue).toBe(true);
  });

  it('routes hold_suggestion with details.cd_name to the holds bucket (not issues)', () => {
    // Note: hold_suggestion routing uses finding.details?.cd_name, NOT finding.cd_name.
    const finding: AnalysisFinding = {
      severity: 'info',
      category: 'hold_suggestion',
      message: 'hold tip',
      details: { cd_name: 'Feint' },
    };
    const { entries } = bucketFindings([finding], { spellId, icon });

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Feint');
    expect(entries[0].hasIssue).toBe(true);
    expect(entries[0].hasCritical).toBe(false);
    expect(entries[0].metaItems).toContain('1 hold');
  });

  it('routes rule_violation to ruleFindings when collectRules is true', () => {
    const finding = f('warning', 'rule_violation');
    const { entries, ruleFindings } = bucketFindings([finding], { spellId, icon, collectRules: true });

    expect(entries).toHaveLength(0);
    expect(ruleFindings).toHaveLength(1);
  });

  it('keeps rule_violation in entries when collectRules is false', () => {
    const finding: AnalysisFinding = f('warning', 'rule_violation', 'Shadow Blades');
    const { entries } = bucketFindings([finding], { spellId, icon, collectRules: false });

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Shadow Blades');
  });

  it('finding without cd_name goes to ruleFindings when collectRules is true', () => {
    const finding = f('critical', 'cast_efficiency');
    const { entries, ruleFindings } = bucketFindings([finding], { spellId, icon, collectRules: true });

    expect(ruleFindings).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  it('success finding with cd_name creates an entry with hasIssue=false', () => {
    const finding = f('success', 'cooldown_usage', 'Shadow Blades');
    const { entries } = bucketFindings([finding], { spellId, icon });

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Shadow Blades');
    expect(entries[0].hasIssue).toBe(false);
    expect(entries[0].hasCritical).toBe(false);
  });

  it('deduplicates metaItems for same-category issues under one CD', () => {
    const findings = [
      f('warning', 'cooldown_delay', 'Shadow Blades'),
      f('warning', 'cooldown_delay', 'Shadow Blades'),
    ];
    const { entries } = bucketFindings(findings, { spellId, icon });

    expect(entries[0].metaItems).toHaveLength(1);
    expect(entries[0].metaItems[0]).toBe('held');
  });

  it('pluralizes the hold label when there are multiple hold suggestions', () => {
    const findings: AnalysisFinding[] = [
      { severity: 'info', category: 'hold_suggestion', message: 'tip 1', details: { cd_name: 'Feint' } },
      { severity: 'info', category: 'hold_suggestion', message: 'tip 2', details: { cd_name: 'Feint' } },
    ];
    const { entries } = bucketFindings(findings, { spellId, icon });

    expect(entries[0].metaItems).toContain('2 holds');
  });

  it('returns empty entries and ruleFindings for empty input', () => {
    const { entries, ruleFindings } = bucketFindings([], { spellId, icon });
    expect(entries).toHaveLength(0);
    expect(ruleFindings).toHaveLength(0);
  });

  it('silently skips a finding with no cd_name when collectRules is false (no ghost "undefined" entry)', () => {
    const finding = f('warning', 'cast_efficiency'); // no cd_name
    const { entries, ruleFindings } = bucketFindings([finding], { spellId, icon, collectRules: false });
    expect(entries).toHaveLength(0);
    expect(ruleFindings).toHaveLength(0);
  });
});

describe('rowsFromEntries', () => {
  const issueEntry: FindingEntry = {
    name: 'Shadow Blades',
    spellId: 121471,
    icon: '',
    hasIssue: true,
    hasCritical: true,
    metaItems: ['lost cast'],
    findings: [
      { severity: 'critical', category: 'lost_cooldown', message: 'lost', measured: { value: '0 / 2', unit: 'cast(s)' } },
    ],
  };

  const onPlanEntry: FindingEntry = {
    name: 'Vanish',
    spellId: null,
    icon: '',
    hasIssue: false,
    hasCritical: false,
    metaItems: [],
    findings: [],
  };

  it('generates one row per finding for entries with hasIssue=true', () => {
    const rows = rowsFromEntries([issueEntry], CAT_LABEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Shadow Blades');
    expect(rows[0].chip).toBe('lost cast');
    expect(rows[0].measured).toEqual({ value: '0 / 2', unit: 'cast(s)' });
  });

  it('skips entries with hasIssue=false', () => {
    expect(rowsFromEntries([onPlanEntry], CAT_LABEL)).toHaveLength(0);
  });

  it('uses a dash placeholder when finding.measured is absent', () => {
    const entry: FindingEntry = {
      name: 'Shadow Blades', spellId: null, icon: '', hasIssue: true, hasCritical: false,
      metaItems: [], findings: [{ severity: 'warning', category: 'rule_violation', message: 'bad' }],
    };
    const rows = rowsFromEntries([entry], CAT_LABEL);
    expect(rows[0].measured).toEqual({ value: '-' });
  });

  it('maps critical severity to "critical", anything else to "warning"', () => {
    const mixedEntry: FindingEntry = {
      ...issueEntry,
      findings: [
        { severity: 'critical', category: 'lost_cooldown', message: '', measured: { value: '', unit: '' } },
        { severity: 'info',     category: 'cast_efficiency', message: '', measured: { value: '', unit: '' } },
      ],
    };
    const rows = rowsFromEntries([mixedEntry], CAT_LABEL);
    expect(rows[0].severity).toBe('critical');
    expect(rows[1].severity).toBe('warning');
  });
});

describe('onPlanFromEntries', () => {
  it('returns only entries with hasIssue=false', () => {
    const entries: FindingEntry[] = [
      { name: 'Shadow Blades', spellId: 121471, icon: '', hasIssue: true,  hasCritical: true,  metaItems: [], findings: [] },
      { name: 'Vanish',        spellId: 1856,   icon: '', hasIssue: false, hasCritical: false, metaItems: [], findings: [] },
    ];
    const chips = onPlanFromEntries(entries);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toEqual({ name: 'Vanish', spellId: 1856, icon: '' });
  });

  it('returns empty array when all entries have issues', () => {
    const entries: FindingEntry[] = [
      { name: 'Shadow Blades', spellId: null, icon: '', hasIssue: true, hasCritical: false, metaItems: [], findings: [] },
    ];
    expect(onPlanFromEntries(entries)).toHaveLength(0);
  });
});
