import { describe, it, expect } from 'vitest';
import { mountDom } from '../../../../testing/component-harness';
import { PlanTable, PlanTableRow } from './plan-table';

const HEADING = 'Cooldown plan';
const SUBTITLE = 'Offensive cooldown usage across top parses.';

function row(overrides: Partial<PlanTableRow> = {}): PlanTableRow {
  return {
    name: 'Shadow Blades', spellId: null, icon: '', firstCastS: null, typicalUses: null,
    usedSampleCount: 0, sampleCount: 0, holds: [], rule: null, ...overrides,
  };
}

const render = (inputs: Record<string, unknown>) => mountDom(PlanTable, {
  heading: HEADING, subtitle: SUBTITLE, rows: [row()], available: true, error: null, ...inputs,
});

describe('PlanTable', () => {
  it('renders the plan rows when the bench loaded and there is at least one row', () => {
    const dom = render({ rows: [row({ name: 'Shadow Blades' }), row({ name: 'Vanish' })] });

    expect(dom.text()).toContain(HEADING);
    expect(dom.text()).toContain('Shadow Blades');
    expect(dom.text()).toContain('Vanish');
    expect(dom.query('wl-load-state')).toBeNull();
  });

  it('renders the waiting state instead of the table when the bench is unavailable', () => {
    const dom = render({ available: false });

    expect(dom.query('wl-load-state')).not.toBeNull();
    expect(dom.text()).not.toContain('Shadow Blades');
  });

  it('renders the error state when the load failed, even with rows still applied', () => {
    const MESSAGE = 'Network unreachable';
    const dom = render({ error: { kind: 'transient', message: MESSAGE } });

    expect(dom.query('wl-load-state')).not.toBeNull();
    expect(dom.text()).toContain(MESSAGE);
    expect(dom.text()).not.toContain('Shadow Blades');
  });

  it('renders nothing at all when the bench loaded but the plan has no rows', () => {
    const dom = render({ rows: [] });

    expect(dom.text()).toBe('');
    expect(dom.query('wl-load-state')).toBeNull();
  });

  it('shows the per-row plan numbers a raider reads off the table', () => {
    const FIRST_CAST_S = 65;
    const dom = render({
      rows: [row({ firstCastS: FIRST_CAST_S, typicalUses: 2, usedSampleCount: 8, sampleCount: 10 })],
    });

    expect(dom.text()).toContain('1:05');
    expect(dom.text()).toContain('8/10 parses');
  });

  it('marks a bloodlust row so its window is visible in the plan', () => {
    expect(render({ rows: [row({ bloodlust: true })] }).text()).toContain('Bloodlust');
    expect(render({ rows: [row({ bloodlust: false })] }).text()).not.toContain('Bloodlust');
  });

  it('lists a hold target as a clock time, and shows none when a cooldown is never held', () => {
    const HOLD_TARGET_S = 30;
    const HOLD_CLOCK = '0:30';
    expect(render({ rows: [row({ holds: [{ castIndex: 1, targetS: HOLD_TARGET_S }] })] }).text()).toContain(HOLD_CLOCK);
    expect(render({ rows: [row({ holds: [] })] }).text()).not.toContain(HOLD_CLOCK);
  });
});
