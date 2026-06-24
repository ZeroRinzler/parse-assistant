import { describe, it, expect } from 'vitest';
import { sortBySeverity } from './findings';
import { AnalysisFinding } from '../models/analysis.models';

const f = (severity: AnalysisFinding['severity'], tag = ''): AnalysisFinding => ({
  severity,
  category: 'test',
  message: tag || severity,
});

describe('sortBySeverity', () => {
  it('sorts mixed severities: critical first, success last', () => {
    const findings = [f('warning'), f('success'), f('critical'), f('info')];
    sortBySeverity(findings);
    expect(findings.map(x => x.severity)).toEqual(['critical', 'warning', 'info', 'success']);
  });

  it('mutates the array in place and returns void', () => {
    const arr = [f('success'), f('critical')];
    const result = sortBySeverity(arr);
    expect(result).toBeUndefined();
    expect(arr[0].severity).toBe('critical');
  });

  it('hold_suggestion ranks equally with info (both order 2)', () => {
    const findings = [f('success'), f('hold_suggestion'), f('info'), f('critical')];
    sortBySeverity(findings);
    expect(findings[0].severity).toBe('critical');
    expect(findings[3].severity).toBe('success');
    // info and hold_suggestion are both rank 2 - they precede success and follow critical/warning
    const middleTwo = findings.slice(1, 3).map(x => x.severity);
    expect(middleTwo).toContain('info');
    expect(middleTwo).toContain('hold_suggestion');
  });

  it('preserves relative order for equal-rank entries (stable sort)', () => {
    const findings = [f('warning', 'A'), f('critical'), f('warning', 'B')];
    sortBySeverity(findings);
    expect(findings[0].severity).toBe('critical');
    expect(findings[1].message).toBe('A');
    expect(findings[2].message).toBe('B');
  });

  it('unknown severity ranks after success (falls through to ?? 4)', () => {
    const unknown = { severity: 'unknown' as AnalysisFinding['severity'], category: 'test', message: 'x' };
    const findings = [unknown, f('warning'), f('success')];
    sortBySeverity(findings);
    expect(findings[0].severity).toBe('warning');
    expect(findings[1].severity).toBe('success');
    expect(findings[2].severity).toBe('unknown');
  });
});
