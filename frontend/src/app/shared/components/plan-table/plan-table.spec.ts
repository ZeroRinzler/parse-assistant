import { describe, it, expect } from 'vitest';
import { mountVm } from '../../../../testing/component-harness';
import { PlanTableComponent, PlanTableRow } from './plan-table';

function row(overrides: Partial<PlanTableRow> = {}): PlanTableRow {
  return {
    name: 'Shadow Blades', spellId: null, icon: '', firstCastS: null, typicalUses: null,
    usedSampleCount: 0, sampleCount: 0, holds: [], rule: null, ...overrides,
  };
}

const state = (inputs: Record<string, unknown>): string => {
  const { vm } = mountVm(PlanTableComponent, {
    heading: 'Cooldown plan', subtitle: 'Offensive cooldown usage across top parses.',
    rows: [row()], available: true, error: null, ...inputs,
  });
  return (vm['state'] as () => string)();
};

describe('PlanTableComponent state', () => {
  it('renders the rows when the bench loaded and there is at least one row', () => {
    expect(state({})).toBe('rows');
  });

  it('renders the load state when the bench is unavailable', () => {
    expect(state({ available: false })).toBe('unavailable');
  });

  it('renders the load state when the load failed, even with rows still applied', () => {
    expect(state({ error: { kind: 'transient', message: 'Network unreachable' } })).toBe('unavailable');
  });

  it('renders nothing when the bench loaded but the plan has no rows', () => {
    expect(state({ rows: [] })).toBe('empty');
  });
});
