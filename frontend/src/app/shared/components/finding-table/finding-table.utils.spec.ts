import { assert, describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import {
  bucketFindings, rowsFromEntries, onPlanFromEntries, CAT_LABEL, FindingEntry, UNKNOWN_COOLDOWN_LABEL,
} from './finding-table.utils';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import { SHADOW_BLADES, VANISH } from '../../../../testing/spell-ids';

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
  occurrences: [],
  ...opts,
});

describe('bucketFindings', () => {
  // Spied to keep runner output clean and let tests assert on the logWarn call.
  let warnSpy: MockInstance<typeof console.warn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('groups critical issue under its cooldown name', () => {
    const finding = f('critical', 'lost_cooldown', 'Shadow Blades');
    const entries = bucketFindings([finding], { spellId, icon });

    expect(entries).toHaveLength(1);
    assert.exists(entries[0]);
    expect(entries[0].name).toBe('Shadow Blades');
    assert.exists(entries[0]);
    expect(entries[0].hasCritical).toBe(true);
    assert.exists(entries[0]);
    expect(entries[0].hasIssue).toBe(true);
  });

  it('routes hold_suggestion with details.cd_name to the holds bucket (not issues)', () => {
    // Note: hold_suggestion routing uses finding.details?.cd_name, NOT finding.cd_name.
    const finding: AnalysisFinding = {
      severity: 'info',
      category: 'hold_suggestion',
      message: 'hold tip',
      details: { cd_name: 'Feint' },
      occurrences: [],
    };
    const entries = bucketFindings([finding], { spellId, icon });

    expect(entries).toHaveLength(1);
    assert.exists(entries[0]);
    expect(entries[0].name).toBe('Feint');
    assert.exists(entries[0]);
    expect(entries[0].hasIssue).toBe(true);
    assert.exists(entries[0]);
    expect(entries[0].hasCritical).toBe(false);
    assert.exists(entries[0]);
    expect(entries[0].metaItems).toContain('1 hold');
  });

  it('buckets a rule_violation under its cooldown name', () => {
    const finding: AnalysisFinding = f('warning', 'rule_violation', 'Shadow Blades');
    const entries = bucketFindings([finding], { spellId, icon });

    expect(entries).toHaveLength(1);
    assert.exists(entries[0]);
    expect(entries[0].name).toBe('Shadow Blades');
  });

  it('success finding with cd_name creates an entry with hasIssue=false', () => {
    const finding = f('success', 'cooldown_usage', 'Shadow Blades');
    const entries = bucketFindings([finding], { spellId, icon });

    expect(entries).toHaveLength(1);
    assert.exists(entries[0]);
    expect(entries[0].name).toBe('Shadow Blades');
    assert.exists(entries[0]);
    expect(entries[0].hasIssue).toBe(false);
    assert.exists(entries[0]);
    expect(entries[0].hasCritical).toBe(false);
  });

  it('deduplicates metaItems for same-category issues under one CD', () => {
    const findings = [
      f('warning', 'cooldown_delay', 'Shadow Blades'),
      f('warning', 'cooldown_delay', 'Shadow Blades'),
    ];
    const entries = bucketFindings(findings, { spellId, icon });

    assert.exists(entries[0]);
    expect(entries[0].metaItems).toHaveLength(1);
    assert.exists(entries[0]);
    expect(entries[0].metaItems[0]).toBe('held');
  });

  it('pluralizes the hold label when there are multiple hold suggestions', () => {
    const findings: AnalysisFinding[] = [
      { severity: 'info', category: 'hold_suggestion', message: 'tip 1', details: { cd_name: 'Feint' }, occurrences: [] },
      { severity: 'info', category: 'hold_suggestion', message: 'tip 2', details: { cd_name: 'Feint' }, occurrences: [] },
    ];
    const entries = bucketFindings(findings, { spellId, icon });

    assert.exists(entries[0]);
    expect(entries[0].metaItems).toContain('2 holds');
  });

  it('returns no entries for empty input', () => {
    expect(bucketFindings([], { spellId, icon })).toHaveLength(0);
  });

  it('surfaces a finding with no cd_name as an Unknown cooldown entry', () => {
    const finding = f('warning', 'cast_efficiency');
    const entries = bucketFindings([finding], { spellId, icon });
    expect(entries).toHaveLength(1);
    assert.exists(entries[0]);
    expect(entries[0].name).toBe(UNKNOWN_COOLDOWN_LABEL);
    assert.exists(entries[0]);
    expect(entries[0].hasIssue).toBe(true);
    assert.exists(entries[0]);
    expect(entries[0].findings).toContain(finding);
  });

  it('logs a warning carrying the finding so an unidentified cooldown can be reproduced', () => {
    const finding = f('warning', 'cast_efficiency');
    bucketFindings([finding], { spellId, icon });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown-cooldown'), finding);
  });
});

describe('rowsFromEntries', () => {
  const issueEntry: FindingEntry = {
    name: 'Shadow Blades',
    spellId: SHADOW_BLADES,
    icon: '',
    hasIssue: true,
    hasCritical: true,
    metaItems: ['lost cast'],
    findings: [
      { severity: 'critical', category: 'lost_cooldown', message: 'lost', measured: { value: '0 / 2', unit: 'cast(s)' }, occurrences: [] },
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
    assert.exists(rows[0]);
    expect(rows[0].name).toBe('Shadow Blades');
    assert.exists(rows[0]);
    expect(rows[0].chip).toBe('lost cast');
    assert.exists(rows[0]);
    expect(rows[0].measured).toEqual({ value: '0 / 2', unit: 'cast(s)' });
  });

  it('skips entries with hasIssue=false', () => {
    expect(rowsFromEntries([onPlanEntry], CAT_LABEL)).toHaveLength(0);
  });

  it('uses a dash placeholder when finding.measured is absent', () => {
    const entry: FindingEntry = {
      name: 'Shadow Blades', spellId: null, icon: '', hasIssue: true, hasCritical: false,
      metaItems: [], findings: [{ severity: 'warning', category: 'rule_violation', message: 'bad', occurrences: [] }],
    };
    const rows = rowsFromEntries([entry], CAT_LABEL);
    assert.exists(rows[0]);
    expect(rows[0].measured).toEqual({ value: '-' });
  });

  it('maps critical to "critical", info to its own "info" state, everything else to "warning"', () => {
    const mixedEntry: FindingEntry = {
      ...issueEntry,
      findings: [
        { severity: 'critical', category: 'lost_cooldown',   message: '', measured: { value: '', unit: '' }, occurrences: [] },
        { severity: 'info',     category: 'cast_efficiency',  message: '', measured: { value: '', unit: '' }, occurrences: [] },
        { severity: 'warning',  category: 'cooldown_delay',   message: '', measured: { value: '', unit: '' }, occurrences: [] },
      ],
    };
    const rows = rowsFromEntries([mixedEntry], CAT_LABEL);
    assert.exists(rows[0]);
    expect(rows[0].severity).toBe('critical');
    assert.exists(rows[1]);
    expect(rows[1].severity).toBe('info');
    assert.exists(rows[2]);
    expect(rows[2].severity).toBe('warning');
  });
});

describe('onPlanFromEntries', () => {
  it('returns only entries with hasIssue=false', () => {
    const entries: FindingEntry[] = [
      { name: 'Shadow Blades', spellId: SHADOW_BLADES, icon: '', hasIssue: true,  hasCritical: true,  metaItems: [], findings: [] },
      { name: 'Vanish',        spellId: VANISH,   icon: '', hasIssue: false, hasCritical: false, metaItems: [], findings: [] },
    ];
    const chips = onPlanFromEntries(entries);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toEqual({ name: 'Vanish', spellId: VANISH, icon: '' });
  });

  it('returns empty array when all entries have issues', () => {
    const entries: FindingEntry[] = [
      { name: 'Shadow Blades', spellId: null, icon: '', hasIssue: true, hasCritical: false, metaItems: [], findings: [] },
    ];
    expect(onPlanFromEntries(entries)).toHaveLength(0);
  });
});
