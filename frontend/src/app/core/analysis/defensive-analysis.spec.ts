import { describe, it, expect } from 'vitest';
import { analyzeDefensives, analyzeDefensiveFindings } from './defensive-analysis';
import { Events } from '../../../testing/builders/events';
import { perDefensive } from '../../../testing/builders/bench';
import { parseClock, FIGHT_START } from '../../../testing/time';
import { FEINT, EVASION } from '../../../testing/spell-ids';

const FIVE_MIN = parseClock('5:00');
const feint = { name: 'Feint', spell_id: FEINT, cooldown: 30, duration: 6 };

describe('analyzeDefensives', () => {
  it('derives a usage window from each buff apply -> remove pair and sums damage taken inside it', () => {
    const buffs = Events.start().buffWindow(FEINT, '0:10', '0:16').build();
    // 1000 taken inside the window, 500 (with 200 absorbed) just after it.
    const dt = Events.start().damageTaken(1, '0:12', 1000).damageTaken(1, '0:30', 500, { absorbed: 200 }).build();

    const [def] = analyzeDefensives([feint], [], buffs, dt, FIGHT_START, FIVE_MIN);

    expect(def.uses).toBe(1);
    expect(def.cast_times_s).toEqual([10]);
    expect(def.windows[0]).toMatchObject({ start_s: 10, end_s: 16, dmg_during: 1000 });
  });

  it('falls back to cast + duration when there are no buff events', () => {
    const casts = Events.cast(FEINT, '1:00').build();

    const [def] = analyzeDefensives([feint], casts, [], [], FIGHT_START, FIVE_MIN);

    expect(def.uses).toBe(1);
    expect(def.windows[0]).toMatchObject({ start_s: 60, end_s: 66 });
  });

  it('returns an empty list when the rulebook has no defensives', () => {
    expect(analyzeDefensives([], [], [], [], FIGHT_START, FIVE_MIN)).toEqual([]);
  });
});

describe('analyzeDefensiveFindings', () => {
  it('flags a defensive that was never used', () => {
    const players = analyzeDefensives([feint], [], [], [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, {}, 300);

    expect(findings[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown' });
    expect(findings[0].message).toContain('was never used');
  });

  it('warns when the first use is later than the top-parse mean + 2 sigma', () => {
    // Evasion benchmark: first use mean 20s +/- 2s -> threshold 24s. Player uses it at 1:00.
    const evasion = { name: 'Evasion', spell_id: EVASION, cooldown: 120, duration: 10 };
    const buffs = Events.start().buffWindow(EVASION, '1:00', '1:10').build();
    const players = analyzeDefensives([evasion], [], buffs, [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Evasion: perDefensive({ avg_first_cast_s: 20, stddev_first_cast_s: 2 }) }, 300);

    expect(findings.some((f) => f.category === 'cooldown_delay')).toBe(true);
  });

  it('does not flag a talent-gated defensive with zero uses as lost', () => {
    const gated = { name: 'Feint', spell_id: FEINT, cooldown: 30, talent_gated: true };
    const players = analyzeDefensives([gated], [], [], [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, {}, 300);

    expect(findings.find((f) => f.category === 'lost_cooldown')).toBeUndefined();
  });

  it('still flags a non-talent-gated defensive with zero uses as lost', () => {
    const players = analyzeDefensives([feint], [], [], [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, {}, 300);

    expect(findings[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown' });
  });
});
