import { assert, describe, it, expect } from 'vitest';
import { AnalysisFinding } from '../../../../domain/analysis/analysis.models';
import { SHADOW_BLADES, SECRET_TECHNIQUE, VANISH } from '../../../../../testing/spell-ids';
import { RotationFeatureService } from './rotation-feature-service';
import { TestBed } from '@angular/core/testing';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';
import { ROTATION_DATA_SOURCE } from '../data-access/rotation-data-source';

TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
  { provide: ROTATION_DATA_SOURCE, useValue: {} },
] });
const svc = TestBed.inject(RotationFeatureService);
TestBed.resetTestingModule();

describe('bucketRotationFindings', () => {
  const abilities = { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' }, [VANISH]: { icon: 'vanish', name: 'Vanish' } };
  it('splits rule rows, cd issue rows and on-plan chips', () => {
    const findings: AnalysisFinding[] = [
      { severity: 'critical', category: 'rule_violation', label: 'Shadow Dance without Secret Technique', message: '', measured: { value: '1 / 1' }, details: { remedy: 'fix' }, occurrences: [] },
      { severity: 'warning', category: 'cooldown_delay', cd_name: 'Shadow Blades', message: '', measured: { value: '+3s' }, timestamp_s: 4, occurrences: [] },
      { severity: 'success', category: 'cooldown_usage', cd_name: 'Vanish', message: '', occurrences: [] },
    ];
    const out = svc['bucketRotationFindings'](findings, { 'Shadow Blades': SHADOW_BLADES, 'Vanish': VANISH }, abilities);
    expect(out.ruleRows).toHaveLength(1);
    assert.exists(out.ruleRows[0]);
    expect(out.ruleRows[0].what).toBe('Shadow Dance without Secret Technique');
    expect(out.offensiveRows).toHaveLength(1);
    expect(out.offensiveRows[0]).toMatchObject({ name: 'Shadow Blades', spellId: SHADOW_BLADES, icon: 'sb', chip: 'held' });
    expect(out.onPlan).toEqual([{ name: 'Vanish', spellId: VANISH, icon: 'vanish' }]);
  });
});

describe('rotation finding partition and row builders', () => {
  const abilities = { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' }, [VANISH]: { icon: 'vanish', name: 'Vanish' } };
  const ruleFinding: AnalysisFinding = { severity: 'critical', category: 'rule_violation', label: 'Dance without Secret Technique', message: '', measured: { value: '1 / 1' }, details: { remedy: 'fix' }, occurrences: [] };
  const issueFinding: AnalysisFinding = { severity: 'warning', category: 'cooldown_delay', cd_name: 'Shadow Blades', message: '', measured: { value: '+3s' }, timestamp_s: 4, occurrences: [] };
  const holdFinding: AnalysisFinding = { severity: 'info', category: 'hold_suggestion', message: '', measured: { value: '1:00' }, details: { cd_name: 'Shadow Blades', remedy: 'hold' }, occurrences: [] };
  const successFinding: AnalysisFinding = { severity: 'success', category: 'cooldown_usage', cd_name: 'Vanish', message: '', occurrences: [] };

  it('partitions rule findings, per-cd buckets, and success names', () => {
    const partition = svc['partitionRotationFindings']([ruleFinding, issueFinding, holdFinding, successFinding]);
    expect(partition.ruleFindings).toEqual([ruleFinding]);
    assert.exists(partition.byName['Shadow Blades']);
    expect(partition.byName['Shadow Blades'].issues).toEqual([issueFinding]);
    assert.exists(partition.byName['Shadow Blades']);
    expect(partition.byName['Shadow Blades'].holds).toEqual([holdFinding]);
    expect([...partition.successNames]).toEqual(['Vanish']);
  });

  it('builds a rule row carrying the finding label and remedy', () => {
    const rows = svc['buildRuleRows']([ruleFinding]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ what: 'Dance without Secret Technique', fix: 'fix' });
  });

  it('chips a rule row with its rule type and keeps the info tier', () => {
    const medium: AnalysisFinding = { ...ruleFinding, severity: 'info', rule_type: 'cooldown_pairing' };
    expect(svc['buildRuleRows']([medium])[0]).toMatchObject({ severity: 'info', chip: 'pairing' });
  });

  it('builds offensive rows with resolved icon + chip per finding', () => {
    const rows = svc['buildOffensiveRows']({ 'Shadow Blades': { issues: [issueFinding], holds: [] } }, { 'Shadow Blades': SHADOW_BLADES }, abilities);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Shadow Blades', spellId: SHADOW_BLADES, icon: 'sb', chip: 'held', severity: 'warning' });
  });

  it('keeps a critical issue finding critical in the offensive row', () => {
    const criticalFinding: AnalysisFinding = { ...issueFinding, severity: 'critical', category: 'lost_cooldown' };
    const rows = svc['buildOffensiveRows']({ 'Shadow Blades': { issues: [criticalFinding], holds: [] } }, { 'Shadow Blades': SHADOW_BLADES }, abilities);
    expect(rows[0]).toMatchObject({ severity: 'critical', chip: 'lost cast' });
  });

  it('keeps an info-severity hold suggestion info in the offensive row, not warning', () => {
    const rows = svc['buildOffensiveRows']({ 'Shadow Blades': { issues: [], holds: [holdFinding] } }, { 'Shadow Blades': SHADOW_BLADES }, abilities);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'info', chip: 'hold' });
  });

  it('builds an offensive row with an empty icon and the raw cd name when its spell id is missing from the ability map', () => {
    // SECRET_TECHNIQUE is deliberately absent from `abilities`, so the guarded lookup must not throw.
    const missingIdFinding: AnalysisFinding = { ...issueFinding, cd_name: 'Secret Move' };
    const rows = svc['buildOffensiveRows']({ 'Secret Move': { issues: [missingIdFinding], holds: [] } }, { 'Secret Move': SECRET_TECHNIQUE }, abilities);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Secret Move', spellId: SECRET_TECHNIQUE, icon: '' });
  });

  it('builds on-plan chips only for clean successes', () => {
    const clean = svc['partitionRotationFindings']([successFinding]);
    expect(svc['buildOnPlanChips'](clean, { 'Vanish': VANISH }, abilities)).toEqual([{ name: 'Vanish', spellId: VANISH, icon: 'vanish' }]);
    // A success that also has an issue is not on plan.
    const dirty = svc['partitionRotationFindings']([successFinding, { ...issueFinding, cd_name: 'Vanish' }]);
    expect(svc['buildOnPlanChips'](dirty, { 'Vanish': VANISH }, abilities)).toEqual([]);
  });
});
