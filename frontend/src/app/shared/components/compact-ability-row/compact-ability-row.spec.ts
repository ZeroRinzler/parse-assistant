import { describe, it, expect } from 'vitest';
import { CompactAbilityRowComponent } from './compact-ability-row';
import { RangeRow } from '../range-chart/range-chart';
import { mountVm } from '../../../../testing/component-harness';

function row(overrides: Partial<RangeRow>): RangeRow {
  return { label: 'Test', playerPct: null, topAvg: null, topMin: null, topMax: null, ...overrides };
}

const mount = (r: RangeRow, extra: Record<string, unknown> = {}) =>
  mountVm(CompactAbilityRowComponent, { row: r, ...extra }).vm;

describe('CompactAbilityRowComponent gap', () => {
  it('shows positive gap with + sign when player exceeds top avg', () => {
    const vm = mount(row({ playerPct: 150, topAvg: 100 }));
    expect((vm['gapSign'] as () => string)()).toBe('+');
    expect((vm['gapMagnitude'] as () => number)()).toBe(50);
    expect((vm['gapClass'] as () => string)()).toBe('badge-success');
  });

  it('shows negative gap with - sign when player falls short', () => {
    const vm = mount(row({ playerPct: 60, topAvg: 100 }));
    expect((vm['gapSign'] as () => string)()).toBe('-');
    expect((vm['gapMagnitude'] as () => number)()).toBe(40);
    expect((vm['gapClass'] as () => string)()).toBe('badge-critical');
  });

  it('uses the warning token when gap is within 10% of topAvg', () => {
    const vm = mount(row({ playerPct: 92, topAvg: 100 }));
    expect((vm['gapClass'] as () => string)()).toBe('badge-warning');
  });

  it('treats less damage taken as good for defensives (lower is better)', () => {
    const vm = mount(row({ playerPct: 60, topAvg: 100 }), { higherIsBetter: false });
    expect((vm['gapClass'] as () => string)()).toBe('badge-success');
  });

  it('treats more damage taken as critical for defensives', () => {
    const vm = mount(row({ playerPct: 150, topAvg: 100 }), { higherIsBetter: false });
    expect((vm['gapClass'] as () => string)()).toBe('badge-critical');
  });

  it('marks a missed ability (null player) as critical', () => {
    const vm = mount(row({ playerPct: null, topAvg: 100 }));
    expect((vm['gapClass'] as () => string)()).toBe('badge-critical');
  });

  it('falls back to muted when topAvg is unknown', () => {
    const vm = mount(row({ playerPct: 100, topAvg: null }));
    expect((vm['gapClass'] as () => string)()).toBe('text-[var(--muted)]');
  });
});

describe('CompactAbilityRowComponent casts badge', () => {
  it('uses the success token when player casts meet top', () => {
    const vm = mount(row({ playerCasts: 3, topCasts: 3 }));
    expect((vm['castsClass'] as () => string)()).toBe('badge-success');
  });

  it('uses the success token when player casts exceed top', () => {
    const vm = mount(row({ playerCasts: 4, topCasts: 3 }));
    expect((vm['castsClass'] as () => string)()).toBe('badge-success');
  });

  it('uses the warning token when player is within 1 cast of top', () => {
    const vm = mount(row({ playerCasts: 2, topCasts: 3 }));
    expect((vm['castsClass'] as () => string)()).toBe('badge-warning');
  });

  it('uses the critical token when player is 2+ casts below top', () => {
    const vm = mount(row({ playerCasts: 1, topCasts: 3 }));
    expect((vm['castsClass'] as () => string)()).toBe('badge-critical');
  });

  it('falls back to muted when top casts are unknown', () => {
    const vm = mount(row({ playerCasts: 2, topCasts: null }));
    expect((vm['castsClass'] as () => string)()).toBe('text-[var(--muted)]');
  });
});
