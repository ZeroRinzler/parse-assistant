import { describe, it, expect } from 'vitest';
import { SELECTED_MARKER, type SpecReportRow, SpecReportService } from './spec-report-service';
import { TestBed } from '@angular/core/testing';

const specReports = TestBed.inject(SpecReportService);

const HOUR_S = 3600;
const NOW_S = Math.floor(Date.parse('2026-08-15T12:00:00.000Z') / 1000);

const row = (over: Partial<SpecReportRow> & { spec: string }): SpecReportRow => ({
  version: 23,
  ingestedAtS: NOW_S - 2 * HOUR_S,
  checkedCount: 5,
  emptyCount: 0,
  selected: false,
  ...over,
});

describe('formatSpecReport', () => {
  it('reports every spec, marking only the ones this run ingests', () => {
    const report = specReports.formatSpecReport(
      [
        row({ spec: 'AugmentationEvoker', version: 9, selected: true }),
        row({ spec: 'FuryWarrior' }),
      ],
      NOW_S,
    );
    expect(report).toBe(
      `${SELECTED_MARKER} AugmentationEvoker  v9   2h ago\n  FuryWarrior         v23  2h ago`,
    );
  });

  it('reports a spec checked against nothing as never checked, with no version or age', () => {
    expect(specReports.formatSpecReport([row({ spec: 'FuryWarrior', checkedCount: 0, version: null, ingestedAtS: null })], NOW_S))
      .toBe('  FuryWarrior      never checked');
  });

  it('reports the version and age once a single encounter has been checked', () => {
    expect(specReports.formatSpecReport([row({ spec: 'FuryWarrior', checkedCount: 1 })], NOW_S))
      .toBe('  FuryWarrior  v23  2h ago');
  });

  it('reports a stamped spec that has checked nothing as never checked', () => {
    expect(specReports.formatSpecReport([row({ spec: 'FuryWarrior', checkedCount: 0, version: 26 })], NOW_S))
      .toBe('  FuryWarrior  v26    never checked');
  });

  it('reports an unknown age for a checked spec whose files carry no timestamp', () => {
    expect(specReports.formatSpecReport([row({ spec: 'FuryWarrior', checkedCount: 9, version: null, ingestedAtS: null })], NOW_S))
      .toBe('  FuryWarrior    ?');
  });

  it('keeps every column aligned across never-checked and checked specs', () => {
    const report = specReports.formatSpecReport(
      [
        row({ spec: 'FeralDruid', checkedCount: 0, version: null, ingestedAtS: null, selected: true }),
        row({ spec: 'SubtletyRogue', version: 26, ingestedAtS: NOW_S - 19 * HOUR_S, checkedCount: 9, emptyCount: 8 }),
        row({ spec: 'BalanceDruid', version: 26, ingestedAtS: NOW_S - 9 * HOUR_S, checkedCount: 9, emptyCount: 8 }),
      ],
      NOW_S,
    );
    expect(report).toBe(
      `${SELECTED_MARKER} FeralDruid                   never checked`
      + '\n  SubtletyRogue  v26  19h ago  8 empty'
      + '\n  BalanceDruid   v26   9h ago  8 empty',
    );
  });

  it('reports how many encounters a spec was checked against with no parses', () => {
    expect(specReports.formatSpecReport([row({ spec: 'FuryWarrior', emptyCount: 9 })], NOW_S))
      .toBe('  FuryWarrior  v23  2h ago  9 empty');
  });

  it('omits the empty column for a spec with every checked encounter benched', () => {
    expect(specReports.formatSpecReport([row({ spec: 'FuryWarrior' })], NOW_S))
      .toBe('  FuryWarrior  v23  2h ago');
  });

  it('returns an empty report for no specs', () => {
    expect(specReports.formatSpecReport([], NOW_S)).toBe('');
  });
});
