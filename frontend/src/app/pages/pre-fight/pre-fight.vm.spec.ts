import { describe, it, expect } from 'vitest';
import { buildCdPlan, buildDefensivePlan, buildBurstWindows } from './pre-fight.vm';
import {
  buildEnchantRows, enchantStatusOf, buildTalentBuilds, talentStatusOf,
} from '../../shared/gear/gear-comparison';
import { CharacterGear } from '../../core/models/wcl.models';
import { EncounterGearStats } from '../../core/models/encounter.models';
import { bench } from '../../../testing/builders/bench';
import { rulebook } from '../../../testing/builders/rulebook';
import {
  SHADOW_BLADES, SHADOW_DANCE, SYMBOLS_OF_DEATH, CLOAK_OF_SHADOWS,
} from '../../../testing/spell-ids';

describe('buildCdPlan', () => {
  it('orders cooldowns by opener priority, then name', () => {
    const rb = rulebook({ cooldowns: [
      { name: 'Zeal', spell_id: SHADOW_DANCE, cooldown: 60, opener_priority: 2 },
      { name: 'Apex', spell_id: SHADOW_BLADES, cooldown: 90, opener_priority: 1 },
      { name: 'Acme', spell_id: SYMBOLS_OF_DEATH, cooldown: 30, opener_priority: 1 },
    ] });
    expect(buildCdPlan(rb, bench()).map(c => c.name)).toEqual(['Acme', 'Apex', 'Zeal']);
  });

  it('only reports a bloodlust share when aligned and at least 40% of parsers do it', () => {
    const cooldowns = [{ name: 'Burst', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: true }];
    const aligned = buildCdPlan(rulebook({ cooldowns }), bench({ perCd: { Burst: { bl_pct: 80 } } }));
    const rare = buildCdPlan(rulebook({ cooldowns }), bench({ perCd: { Burst: { bl_pct: 20 } } }));
    expect(aligned[0].bloodlustPct).toBe(80);
    expect(rare[0].bloodlustPct).toBeNull();
  });

  it('omits a bloodlust share for cooldowns that do not align with bloodlust', () => {
    const rb = rulebook({ cooldowns: [{ name: 'Solo', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: false }] });
    expect(buildCdPlan(rb, bench({ perCd: { Solo: { bl_pct: 90 } } }))[0].bloodlustPct).toBeNull();
  });

  it('surfaces hold targets only when the cooldown is held by the majority', () => {
    const rb = rulebook({ cooldowns: [{ name: 'Hold', spell_id: SHADOW_DANCE, cooldown: 60 }] });
    const targets = { '2': { target_s: 30, stddev_s: 2, count: 8, total_samples: 10 } };
    const held = buildCdPlan(rb, bench({ perCd: { Hold: { majority_hold: true, hold_targets: targets } } }));
    const onCd = buildCdPlan(rb, bench({ perCd: { Hold: { majority_hold: false, hold_targets: targets } } }));
    expect(held[0].holds).toEqual([{ castIndex: 2, targetS: 30 }]);
    expect(onCd[0].holds).toEqual([]);
  });

  it('prefers the structured uses_per_min average over the legacy scalar', () => {
    const rb = rulebook({ cooldowns: [{ name: 'Cd', spell_id: SHADOW_BLADES, cooldown: 90 }] });
    const plan = buildCdPlan(rb, bench({ perCd: { Cd: {
      avg_uses_per_min: 1.1,
      uses_per_min: { avg: 1.7, stddev: 0.1, min: 1.5, max: 2 },
    } } }));
    expect(plan[0].usesPerMin).toBe(1.7);
  });

  it('returns an empty plan when the rulebook has no cooldowns', () => {
    expect(buildCdPlan(rulebook(), bench())).toEqual([]);
    expect(buildCdPlan(null, null)).toEqual([]);
  });

  it('surfaces all hold targets ordered by cast index when the majority holds', () => {
    const rb = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }] });
    const targets = {
      '2': { target_s: 121.2, stddev_s: 0.8, count: 8, total_samples: 10 },
      '4': { target_s: 393.4, stddev_s: 35.0, count: 10, total_samples: 10 },
      '3': { target_s: 257.5, stddev_s: 20.7, count: 10, total_samples: 10 },
    };
    const [item] = buildCdPlan(rb, bench({ perCd: { 'Shadow Blades': { majority_hold: true, hold_targets: targets } } }));
    expect(item.holds).toHaveLength(3);
    // Must be sorted by cast index regardless of key insertion order
    expect(item.holds.map(h => h.castIndex)).toEqual([2, 3, 4]);
    expect(item.holds[0].targetS).toBeCloseTo(121.2);
    expect(item.holds[2].targetS).toBeCloseTo(393.4);
  });
});

describe('buildDefensivePlan', () => {
  it('matches defensive windows by name, sorts them, and drops empty defensives', () => {
    const rb = rulebook({ defensives: [
      { name: 'Cloak', spell_id: CLOAK_OF_SHADOWS, cooldown: 120 },
      { name: 'Unused', spell_id: 999, cooldown: 60 },
    ] });
    const bk = bench({
      perDefensive: { Cloak: { avg_uses: 2, avg_first_cast_s: 18 } },
      defensiveWindows: [
        { time_s: 90, stddev_s: 2, window_length_s: 5, count: 6, total_samples: 10, dmg_avg: 100, dmg_min: 80, dmg_max: 120, dmg_stddev: 10, common_defensives: ['Cloak'], defensive_name: 'Cloak', spell_id: CLOAK_OF_SHADOWS, ability_breakdown: [] },
        { time_s: 30, stddev_s: 2, window_length_s: 5, count: 7, total_samples: 10, dmg_avg: 100, dmg_min: 80, dmg_max: 120, dmg_stddev: 10, common_defensives: ['Cloak'], defensive_name: 'Cloak', spell_id: CLOAK_OF_SHADOWS, ability_breakdown: [] },
      ],
    });
    const plan = buildDefensivePlan(rb, bk);
    expect(plan).toHaveLength(1);
    expect(plan[0].name).toBe('Cloak');
    expect(plan[0].windowsS).toEqual([30, 90]);
  });

  it('surfaces defensive hold targets ordered by cast index when the majority holds', () => {
    const rb = rulebook({ defensives: [{ name: 'Cloak', spell_id: CLOAK_OF_SHADOWS, cooldown: 120 }] });
    const targets = {
      '3': { target_s: 64, stddev_s: 2, count: 8, total_samples: 10 },
      '1': { target_s: 18, stddev_s: 1, count: 9, total_samples: 10 },
    };
    const held = buildDefensivePlan(rb, bench({ perDefensive: { Cloak: { majority_hold: true, hold_targets: targets } } }));
    const onCd = buildDefensivePlan(rb, bench({ perDefensive: { Cloak: { majority_hold: false, hold_targets: targets } } }));
    expect(held[0].holds).toEqual([{ castIndex: 1, targetS: 18 }, { castIndex: 3, targetS: 64 }]);
    expect(onCd[0].holds).toEqual([]);
  });

  it('returns an empty plan when the rulebook has no defensives', () => {
    expect(buildDefensivePlan(rulebook(), bench())).toEqual([]);
  });
});

describe('buildEnchantRows / enchantStatusOf', () => {
  const stats = (enchants: EncounterGearStats['enchants']): EncounterGearStats =>
    ({ talent_builds: [], trinkets: {}, enchants });
  const gear = (enchants: NonNullable<CharacterGear['enchants']>): CharacterGear =>
    ({ found: true, enchants });

  it('warns on a missing enchant the strong majority runs (>= 70%)', () => {
    const rows = buildEnchantRows(gear([]), stats({ 15: [{ id: 1, name: 'Rune', pct: 85 }] }));
    expect(rows[0]).toMatchObject({ status: 'warn', name: 'Not enchanted' });
    expect(enchantStatusOf(rows)).toBe('warn');
  });

  it('downgrades a missing enchant to info when only 40-69% run it, and skips it below 40%', () => {
    const info = buildEnchantRows(gear([]), stats({ 15: [{ id: 1, name: 'Rune', pct: 50 }] }));
    const skipped = buildEnchantRows(gear([]), stats({ 15: [{ id: 1, name: 'Rune', pct: 30 }] }));
    expect(info[0].status).toBe('info');
    expect(skipped).toEqual([]);
    expect(enchantStatusOf(info)).toBe('ok');
  });

  it('marks a matching enchant ok and a differing one info', () => {
    const match = buildEnchantRows(gear([{ slot: 15, id: 1, name: 'Rune' }]), stats({ 15: [{ id: 1, name: 'Rune', pct: 90 }] }));
    const differ = buildEnchantRows(gear([{ slot: 15, id: 2, name: 'Other' }]), stats({ 15: [{ id: 1, name: 'Rune', pct: 90 }] }));
    expect(match[0].status).toBe('ok');
    expect(differ[0]).toMatchObject({ status: 'info', name: 'Other' });
  });

  it('accepts a player enchant on a slot with no top-parse data', () => {
    const rows = buildEnchantRows(gear([{ slot: 9, id: 7, name: 'Handguard' }]), stats({}));
    expect(rows[0]).toMatchObject({ slotName: 'Hands', status: 'ok', name: 'Handguard', note: null, topPct: null });
  });

  it('is empty when neither side has enchant data', () => {
    expect(buildEnchantRows(null, null)).toEqual([]);
  });
});

describe('buildTalentBuilds', () => {
  const stats = (builds: EncounterGearStats['talent_builds']): EncounterGearStats =>
    ({ talent_builds: builds, trinkets: {}, enchants: {} });

  it('labels the first build and flags the one matching the player key', () => {
    const rows = buildTalentBuilds(stats([
      { key: 'v2:a', pct: 60, report_code: 'ABC', fight_id: 3 },
      { key: 'v2:b', pct: 25 },
    ]), 'v2:b');
    expect(rows[0].label).toBe('Most common build');
    expect(rows[1].label).toBe('Alt build 1');
    expect(rows[0].isPlayer).toBe(false);
    expect(rows[1].isPlayer).toBe(true);
    expect(rows[0].link).toBe('https://www.warcraftlogs.com/reports/ABC#fight=3');
    expect(rows[1].link).toBeNull();
  });

  it('is empty when there are no top builds', () => {
    expect(buildTalentBuilds(stats([]), 'v2:a')).toEqual([]);
  });
});


describe('buildBurstWindows', () => {
  it('resolves cooldown names to spell ids, flags AoE, and derives the end time', () => {
    const rb = rulebook({
      cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }],
      defensives: [{ name: 'Cloak', spell_id: CLOAK_OF_SHADOWS, cooldown: 120 }],
    });
    const bk = bench({ burstWindows: [
      { time_s: 10, window_length_s: 20, dmg_avg: 500, dmg_min: 400, dmg_max: 600, dmg_stddev: 50, common_cds: ['Shadow Blades', 'Mystery'], avg_targets: 3, ability_breakdown: [] },
    ] });
    const [w] = buildBurstWindows(rb, bk);
    expect(w.startS).toBe(10);
    expect(w.endS).toBe(30);
    expect(w.aoe).toBe(true);
    expect(w.cds).toEqual([
      { name: 'Shadow Blades', spellId: SHADOW_BLADES },
      { name: 'Mystery', spellId: null },
    ]);
  });

  it('treats a single-target window as non-AoE', () => {
    const bk = bench({ burstWindows: [{ time_s: 0, window_length_s: 8, dmg_avg: 1, dmg_min: 0, dmg_max: 2, dmg_stddev: 0, common_cds: [], avg_targets: 1, ability_breakdown: [] }] });
    expect(buildBurstWindows(rulebook(), bk)[0].aoe).toBe(false);
  });

  it('scores each window damage relative to the biggest window', () => {
    const bk = bench({ burstWindows: [
      { time_s: 0, window_length_s: 10, dmg_avg: 2000, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], avg_targets: 1, ability_breakdown: [] },
      { time_s: 30, window_length_s: 10, dmg_avg: 500, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], avg_targets: 1, ability_breakdown: [] },
    ] });
    const [a, b] = buildBurstWindows(rulebook(), bk);
    expect(a.dmgShare).toBe(1);
    expect(b.dmgShare).toBe(0.25);
  });
});

describe('talentStatusOf', () => {
  const stats = (builds: EncounterGearStats['talent_builds']): EncounterGearStats =>
    ({ talent_builds: builds, trinkets: {}, enchants: {} });

  it('is unknown when there is no talent data', () => {
    expect(talentStatusOf(stats([]), 'v2:a').status).toBe('unknown');
    expect(talentStatusOf(null, 'v2:a').status).toBe('unknown');
  });

  it('presents the consensus build positively when the player key is absent or a different format', () => {
    const builds = [{ key: 'v2:a', pct: 70 }];
    expect(talentStatusOf(stats(builds), '').status).toBe('ok');
    expect(talentStatusOf(stats(builds), 'v1:legacy')).toMatchObject({ status: 'ok' });
  });

  it('confirms a player who is on a top-parse build', () => {
    const status = talentStatusOf(stats([{ key: 'v2:a', pct: 70 }, { key: 'v2:b', pct: 20 }]), 'v2:b');
    expect(status).toEqual({ status: 'ok', note: 'On a top-parse build' });
  });

  it('warns when the player runs a comparable but off-meta build', () => {
    const status = talentStatusOf(stats([{ key: 'v2:a', pct: 70 }]), 'v2:offmeta');
    expect(status.status).toBe('warn');
  });
});
