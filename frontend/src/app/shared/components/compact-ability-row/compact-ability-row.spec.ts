import { describe, it, expect } from 'vitest';
import { CompactAbilityRowComponent } from './compact-ability-row';
import { RangeRow } from '../../../core/models/window-comparison.models';
import { badgeStatus, mountDom } from '../../../../testing/component-harness';

function row(overrides: Partial<RangeRow>): RangeRow {
  return { label: 'Test', icon: '', playerPct: null, topAvg: null, topMin: null, topMax: null, ...overrides };
}

const BADGE = 'span[class*="badge-"]';

function render(r: RangeRow, extra: Record<string, unknown> = {}) {
  const dom = mountDom(CompactAbilityRowComponent, { row: r, ...extra });
  return {
    dom,
    gap: dom.query(`div > div:first-child ${BADGE}`),
    casts: dom.query(`div > div:last-child ${BADGE}`),
  };
}

const clean = (el: HTMLElement | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('CompactAbilityRowComponent gap', () => {
  it('shows a positive gap with a + sign and the success colour when the player exceeds top avg', () => {
    const { gap } = render(row({ playerPct: 150, topAvg: 100 }));
    expect(clean(gap)).toBe('+50');
    expect(badgeStatus(gap)).toBe('success');
  });

  it('shows a negative gap with a - sign and the critical colour when the player falls short', () => {
    const { gap } = render(row({ playerPct: 60, topAvg: 100 }));
    expect(clean(gap)).toBe('-40');
    expect(badgeStatus(gap)).toBe('critical');
  });

  it('shows the warning colour when the gap is within 10% of top avg', () => {
    expect(badgeStatus(render(row({ playerPct: 92, topAvg: 100 })).gap)).toBe('warning');
  });

  it('treats less damage taken as good for defensives (lower is better)', () => {
    expect(badgeStatus(render(row({ playerPct: 60, topAvg: 100 }), { higherIsBetter: false }).gap)).toBe('success');
  });

  it('treats more damage taken as critical for defensives', () => {
    expect(badgeStatus(render(row({ playerPct: 150, topAvg: 100 }), { higherIsBetter: false }).gap)).toBe('critical');
  });

  it('reads "missed" rather than a number for an ability the player never used', () => {
    const { gap } = render(row({ playerPct: null, topAvg: 100 }));
    expect(clean(gap)).toBe('missed');
    expect(badgeStatus(gap)).toBe('critical');
  });

  it('falls back to the muted colour when top avg is unknown', () => {
    expect(badgeStatus(render(row({ playerPct: 100, topAvg: null })).gap)).toBe('muted');
  });

  it('renders no player cell at all when the player column is hidden', () => {
    const { gap } = render(row({ playerPct: 150, topAvg: 100 }), { hidePlayer: true });
    expect(gap).toBeNull();
  });
});

describe('CompactAbilityRowComponent casts badge', () => {
  it('shows the player and top counts, in the success colour when the player meets top', () => {
    const { casts } = render(row({ playerCasts: 3, topCasts: 3 }));
    expect(clean(casts)).toBe('3 / 3');
    expect(badgeStatus(casts)).toBe('success');
  });

  it('stays success when the player exceeds top', () => {
    expect(badgeStatus(render(row({ playerCasts: 4, topCasts: 3 })).casts)).toBe('success');
  });

  it('warns when the player is within 1 cast of top', () => {
    expect(badgeStatus(render(row({ playerCasts: 2, topCasts: 3 })).casts)).toBe('warning');
  });

  it('goes critical when the player is 2 or more casts below top', () => {
    expect(badgeStatus(render(row({ playerCasts: 1, topCasts: 3 })).casts)).toBe('critical');
  });

  it('falls back to muted, with a dash for top, when top casts are unknown', () => {
    const { casts } = render(row({ playerCasts: 2, topCasts: null }));
    expect(clean(casts)).toBe('2 / -');
    expect(badgeStatus(casts)).toBe('muted');
  });

  it('reads "passive" instead of a count for an ability that is never cast', () => {
    expect(clean(render(row({ passive: true, playerCasts: 0, topCasts: 0 })).casts)).toBe('passive');
  });

  it('shows a count, not the passive tag, for an ordinary cast row', () => {
    expect(clean(render(row({ playerCasts: 2, topCasts: 3 })).casts)).toBe('2 / 3');
  });

  it('renders no casts cell when the casts column is turned off', () => {
    expect(render(row({ playerCasts: 2, topCasts: 3 }), { showCasts: false }).casts).toBeNull();
  });
});

describe('CompactAbilityRowComponent label', () => {
  it('names the ability, and shows the game icon only when the row carries a spell id', () => {
    const LABEL = 'Shadow Blades';
    const SPELL_ID = 121471;
    const withIcon = render(row({ label: LABEL, spellId: SPELL_ID }));
    expect(withIcon.dom.query('wl-game-icon')).not.toBeNull();

    const plain = render(row({ label: LABEL }));
    expect(plain.dom.query('wl-game-icon')).toBeNull();
    expect(plain.dom.text()).toContain(LABEL);
  });
});
