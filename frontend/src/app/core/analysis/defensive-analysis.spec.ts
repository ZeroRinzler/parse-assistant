import { describe, it, expect } from 'vitest';
import { analyzeDefensives, analyzeDefensiveFindings } from './defensive-analysis';
import { Events } from '../../../testing/builders/events';
import { perDefensive } from '../../../testing/builders/bench';
import { parseClock, FIGHT_START } from '../../../testing/time';
import { FEINT, EVASION } from '../../../testing/spell-ids';

const ONE_MIN = FIGHT_START + 60_000;

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
  it('flags a defensive that was never used when bench expects at least one use', () => {
    const bk = perDefensive({ uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 });
    const players = analyzeDefensives([feint], [], [], [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Feint: bk }, 300);

    expect(findings[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown' });
    expect(findings[0].message).toContain('Top parsers average');
  });

  it('warns when the first use is later than the top-parse mean + 2 sigma', () => {
    // Evasion benchmark: first use mean 20s +/- 2s -> threshold 24s. Player uses it at 1:00.
    const evasion = { name: 'Evasion', spell_id: EVASION, cooldown: 120, duration: 10 };
    const buffs = Events.start().buffWindow(EVASION, '1:00', '1:10').build();
    const players = analyzeDefensives([evasion], [], buffs, [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Evasion: perDefensive({
      uses_per_min: { avg: 0.2, stddev: 0, min: 0.2, max: 0.2 }, avg_uses_per_min: 0.2,
      avg_first_cast_s: 20, stddev_first_cast_s: 2 }) }, 300);

    expect(findings.some((f) => f.category === 'cooldown_delay')).toBe(true);
  });

  it('does not flag a talent-gated defensive with zero uses as lost', () => {
    const gated = { name: 'Feint', spell_id: FEINT, cooldown: 30, talent_gated: true };
    const bk = perDefensive({ uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 });
    const players = analyzeDefensives([gated], [], [], [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Feint: bk }, 300);

    expect(findings.find((f) => f.category === 'lost_cooldown')).toBeUndefined();
  });

  it('still flags a non-talent-gated defensive with zero uses as lost', () => {
    const bk = perDefensive({ uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 });
    const players = analyzeDefensives([feint], [], [], [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Feint: bk }, 300);

    expect(findings[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown' });
  });
});

describe('analyzeDefensives / unclosed buff window', () => {
  it('counts a use even when applybuff has no matching removebuff (log truncated or buff active at fight end)', () => {
    // wE stays null -> end falls back to wS + duration (feint.duration = 6s).
    const buffs = Events.start().applyBuff(FEINT, '1:00').build();
    const [def] = analyzeDefensives([feint], [], buffs, [], FIGHT_START, FIVE_MIN);

    expect(def.uses).toBe(1);
    expect(def.windows[0].start_s).toBe(60);
    expect(def.windows[0].end_s).toBe(66);
  });
});

describe('analyzeDefensiveFindings / held defensive gap', () => {
  it('emits a cooldown_delay warning when the gap between uses exceeds avg + 2 sigma', () => {
    // Two uses: 0:30 and 4:00 -> gap = 210s. Bench avg_gap 120s +/- 10s -> threshold 140s.
    const evasion = { name: 'Evasion', spell_id: EVASION, cooldown: 120, duration: 10 };
    const buffs = Events.start().buffWindow(EVASION, '0:30', '0:40').buffWindow(EVASION, '4:00', '4:10').build();
    const players = analyzeDefensives([evasion], [], buffs, [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, {
      Evasion: perDefensive({
        uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4,
        avg_gap_s: 120, stddev_gap_s: 10,
      }),
    }, 300);

    expect(findings.some((f) => f.category === 'cooldown_delay')).toBe(true);
  });
});

describe('analyzeDefensiveFindings / hold suggestion', () => {
  it('emits hold_suggestion when player uses a defensive earlier than the top-parse hold target', () => {
    // Use at 30s; hold_target for use #1 is 60s +/- 5s. 30 < 60 - 5 = 55 -> flag.
    const evasion = { name: 'Evasion', spell_id: EVASION, cooldown: 120, duration: 10 };
    const buffs = Events.start().buffWindow(EVASION, '0:30', '0:40').build();
    const players = analyzeDefensives([evasion], [], buffs, [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, {
      Evasion: perDefensive({
        uses_per_min: { avg: 0.2, stddev: 0, min: 0.2, max: 0.2 }, avg_uses_per_min: 0.2,
        hold_targets: { '1': { target_s: 60, stddev_s: 5, count: 8, total_samples: 10 } },
      }),
    }, 300);

    const sugg = findings.find((f) => f.category === 'hold_suggestion');
    expect(sugg?.severity).toBe('info');
    expect(sugg?.details?.remedy).toContain('Consider holding Evasion');
  });
});

describe('analyzeDefensiveFindings / bench-driven lost uses', () => {
  const cloak = { name: 'Cloak', spell_id: EVASION, cooldown: 120, duration: 5 };

  it('does not flag when player matches the cohort usage rate (hold scenario)', () => {
    // Top parsers average 1 use per 5 min fight; player uses it once - no flag.
    const bk = perDefensive({ uses_per_min: { avg: 0.2, stddev: 0, min: 0.2, max: 0.2 }, avg_uses_per_min: 0.2 });
    const buffs = Events.start().buffWindow(EVASION, '1:00', '1:05').build();
    const players = analyzeDefensives([cloak], [], buffs, [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Cloak: bk }, 300);

    expect(findings.find((f) => f.category === 'lost_cooldown')).toBeUndefined();
  });

  it('does not flag when player is at the cohort - 1 sigma floor', () => {
    // rate=0.6/min, stddev=0.2/min, fight=5min -> expected=3, floor=2
    // Player uses it twice (= floor) -> no flag (must be strictly below floor).
    const bk = perDefensive({ uses_per_min: { avg: 0.6, stddev: 0.2, min: 0.4, max: 0.8 }, avg_uses_per_min: 0.6 });
    const buffs = Events.start().buffWindow(EVASION, '1:00', '1:05').buffWindow(EVASION, '3:00', '3:05').build();
    const players = analyzeDefensives([cloak], [], buffs, [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Cloak: bk }, 300);

    expect(findings.find((f) => f.category === 'lost_cooldown')).toBeUndefined();
  });

  it('flags when player is below the cohort floor', () => {
    // rate=0.6/min, stddev=0.2/min, fight=5min -> expected=3, floor=2
    // Player uses it once (below floor) -> critical.
    const bk = perDefensive({ uses_per_min: { avg: 0.6, stddev: 0.2, min: 0.4, max: 0.8 }, avg_uses_per_min: 0.6 });
    const buffs = Events.start().buffWindow(EVASION, '1:00', '1:05').build();
    const players = analyzeDefensives([cloak], [], buffs, [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Cloak: bk }, 300);

    const lost = findings.find((f) => f.category === 'lost_cooldown');
    expect(lost?.severity).toBe('critical');
    expect(lost?.message).toContain('top parsers average');
  });

  it('flags zero uses as critical when cohort expects at least 1', () => {
    const bk = perDefensive({ uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 });
    const players = analyzeDefensives([cloak], [], [], [], FIGHT_START, FIVE_MIN);

    const findings = analyzeDefensiveFindings(players, { Cloak: bk }, 300);

    expect(findings.find((f) => f.category === 'lost_cooldown')?.severity).toBe('critical');
    expect(findings.find((f) => f.category === 'lost_cooldown')?.message).toContain('Top parsers average');
  });

  it('suppresses zero-use critical on a short fight where expected rounds to 0', () => {
    // 0.15 uses/min * 1 min = 0.15 -> rounds to 0 -> no flag
    const bk = perDefensive({ uses_per_min: { avg: 0.15, stddev: 0, min: 0.15, max: 0.15 }, avg_uses_per_min: 0.15 });
    const players = analyzeDefensives([cloak], [], [], [], FIGHT_START, ONE_MIN);

    const findings = analyzeDefensiveFindings(players, { Cloak: bk }, 60);

    expect(findings.find((f) => f.category === 'lost_cooldown')).toBeUndefined();
  });
});
