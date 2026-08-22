import { describe, it, expect } from 'vitest';
import { formatSpecReport, SELECTED_MARKER, type SpecReportRow } from './spec-report';

const HOUR_S = 3600;
const NOW_S = Math.floor(Date.parse('2026-08-15T12:00:00.000Z') / 1000);

const row = (over: Partial<SpecReportRow> & { spec: string }): SpecReportRow => ({
  version: 23,
  ingestedAtS: NOW_S - 2 * HOUR_S,
  emptyCount: 0,
  selected: false,
  ...over,
});

describe('formatSpecReport', () => {
  it('reports every spec, marking only the ones this run ingests', () => {
    const report = formatSpecReport(
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

  it('reports an unknown version and age for a spec with no stamped data', () => {
    expect(formatSpecReport([row({ spec: 'FuryWarrior', version: null, ingestedAtS: null })], NOW_S))
      .toBe('  FuryWarrior  v?  ?');
  });

  it('reports how many encounters a spec was checked against with no parses', () => {
    expect(formatSpecReport([row({ spec: 'FuryWarrior', emptyCount: 9 })], NOW_S))
      .toBe('  FuryWarrior  v23  2h ago  9 empty');
  });

  it('omits the empty column for a spec with every checked encounter benched', () => {
    expect(formatSpecReport([row({ spec: 'FuryWarrior' })], NOW_S))
      .toBe('  FuryWarrior  v23  2h ago');
  });

  it('returns an empty report for no specs', () => {
    expect(formatSpecReport([], NOW_S)).toBe('');
  });
});
