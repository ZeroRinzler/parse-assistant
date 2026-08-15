import { assert, describe, it, expect } from 'vitest';
import {
  buildBenchEnchantRows,
  buildBenchTrinketRows,
  buildEnchantRows,
  buildTrinketRows,
  buildTalentDiff,
  talentStatusOf,
} from './gear-comparison';
import { SpecTalents } from '../../core/models/talent.models';
import { EncounterGearStats } from '../../core/models/encounter.models';
import { CharacterGear } from '../../core/models/wcl.models';

function stats(partial: Partial<EncounterGearStats> = {}): EncounterGearStats {
  return { talent_builds: [], trinkets: {}, enchants: {}, ...partial };
}

function gear(partial: Partial<CharacterGear> = {}): CharacterGear {
  return { found: true, ...partial };
}

describe('buildBenchEnchantRows', () => {
  it('shows the enchant name when the bench data has a name', () => {
    const rows = buildBenchEnchantRows(stats({
      enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 80 }] },
    }));
    expect(rows).toHaveLength(1);
    assert.exists(rows[0]);
    expect(rows[0].name).toBe('Sophic Devotion');
    assert.exists(rows[0]);
    expect(rows[0].slotName).toBe('Main Hand');
    assert.exists(rows[0]);
    expect(rows[0].pct).toBe(80);
  });

  it('falls back to Enchant #id when the bench enchant name is empty', () => {
    // WCL does not populate permanentEnchantName; ingest writes empty strings until gameData.enchant(id) resolves them on the next ingest run.
    const rows = buildBenchEnchantRows(stats({
      enchants: { 15: [{ id: 8041, name: '', pct: 90 }] },
    }));
    assert.exists(rows[0]);
    expect(rows[0].name).toBe('Enchant #8041');
  });

  it('skips slots below the consensus share of top parsers', () => {
    const rows = buildBenchEnchantRows(stats({
      enchants: { 15: [{ id: 8041, name: 'Rune', pct: 49 }] },
    }));
    expect(rows).toHaveLength(0);
  });

  it('includes slots at or above the consensus share of top parsers', () => {
    const rows = buildBenchEnchantRows(stats({
      enchants: {
        15: [{ id: 8041, name: 'Rune A', pct: 50 }],
        16: [{ id: 8039, name: 'Rune B', pct: 60 }],
      },
    }));
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.slotName)).toEqual(['Main Hand', 'Off Hand']);
  });

  it('returns an empty array when stats or enchants are absent', () => {
    expect(buildBenchEnchantRows(null)).toEqual([]);
    expect(buildBenchEnchantRows(stats({ enchants: {} }))).toEqual([]);
  });

  it('sorts slots by slot number', () => {
    const rows = buildBenchEnchantRows(stats({
      enchants: {
        16: [{ id: 8039, name: 'B', pct: 60 }],
        0:  [{ id: 8017, name: 'A', pct: 70 }],
        4:  [{ id: 7987, name: 'C', pct: 100 }],
      },
    }));
    expect(rows.map(r => r.slotName)).toEqual(['Head', 'Chest', 'Off Hand']);
  });
});

describe('buildBenchTrinketRows', () => {
  it('returns the two distinct trinkets ranked by overall usage', () => {
    const rows = buildBenchTrinketRows(stats({
      trinkets: {
        12: [{ id: 193701, name: "Algeth'ar Puzzle Box", icon: 'box', pct: 50 }],
        13: [{ id: 249343, name: 'Gaze of the Alnseer', icon: 'gaze', pct: 80 }],
      },
    }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ slotLabel: 'Trinket 1', id: 249343, name: 'Gaze of the Alnseer', icon: 'gaze', pct: 80 });
    expect(rows[1]).toEqual({ slotLabel: 'Trinket 2', id: 193701, name: "Algeth'ar Puzzle Box", icon: 'box', pct: 50 });
  });

  it('never repeats the same trinket when one item dominates both slots', () => {
    // The Rotmire bug: "Gaze" is the single most popular trinket, so raw per-slot aggregation ranks it #1 in both slots; the merged pair must surface it once (summed 40+30=70).
    const rows = buildBenchTrinketRows(stats({
      trinkets: {
        12: [{ id: 249343, name: 'Gaze of the Alnseer', icon: 'gaze', pct: 40 },
             { id: 193701, name: "Algeth'ar Puzzle Box", icon: 'box', pct: 30 }],
        13: [{ id: 249343, name: 'Gaze of the Alnseer', icon: 'gaze', pct: 30 },
             { id: 193701, name: "Algeth'ar Puzzle Box", icon: 'box', pct: 25 }],
      },
    }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ slotLabel: 'Trinket 1', id: 249343, name: 'Gaze of the Alnseer', icon: 'gaze', pct: 70 });
    expect(rows[1]).toEqual({ slotLabel: 'Trinket 2', id: 193701, name: "Algeth'ar Puzzle Box", icon: 'box', pct: 55 });
    expect(new Set(rows.map(r => r.id)).size).toBe(2);
  });

  it('returns a single row when only one distinct trinket has bench data', () => {
    const rows = buildBenchTrinketRows(stats({
      trinkets: { 12: [{ id: 193701, name: 'Box', icon: 'box', pct: 50 }] },
    }));
    expect(rows).toHaveLength(1);
    assert.exists(rows[0]);
    expect(rows[0].slotLabel).toBe('Trinket 1');
  });

  it('returns an empty array when stats or trinkets are absent', () => {
    expect(buildBenchTrinketRows(null)).toEqual([]);
    expect(buildBenchTrinketRows(stats({ trinkets: {} }))).toEqual([]);
  });
});

describe('buildTrinketRows', () => {
  const benchStats = stats({
    trinkets: {
      12: [{ id: 193701, name: "Algeth'ar Puzzle Box", icon: 'box', pct: 50 }],
      13: [{ id: 249343, name: 'Gaze of the Alnseer', icon: 'gaze', pct: 80 }],
    },
  });

  it('accepts both rows when the two top trinkets are worn in swapped slots', () => {
    // Player wears the same two top trinkets but with the slots reversed.
    const rows = buildTrinketRows(
      gear({
        trinkets: [
          { slot: 12, id: 249343, name: 'Gaze of the Alnseer' },
          { slot: 13, id: 193701, name: "Algeth'ar Puzzle Box" },
        ],
      }),
      benchStats,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.status === 'ok')).toBe(true);
    expect(rows.every(row => row.note === null)).toBe(true);
    // topPct comes from whichever bench slot lists the worn trinket.
    expect(rows[0]).toMatchObject({ slotLabel: 'Trinket 1', id: 249343, topPct: 80 });
    expect(rows[1]).toMatchObject({ slotLabel: 'Trinket 2', id: 193701, topPct: 50 });
  });

  it('accepts both rows when the two top trinkets are worn in the matching slots', () => {
    const rows = buildTrinketRows(
      gear({
        trinkets: [
          { slot: 12, id: 193701, name: "Algeth'ar Puzzle Box" },
          { slot: 13, id: 249343, name: 'Gaze of the Alnseer' },
        ],
      }),
      benchStats,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.status === 'ok' && row.note === null)).toBe(true);
    // Each worn trinket reports its own consensus share regardless of slot - slot position carries no meaning.
    expect(rows[0]).toMatchObject({ slotLabel: 'Trinket 1', id: 193701, topPct: 50 });
    expect(rows[1]).toMatchObject({ slotLabel: 'Trinket 2', id: 249343, topPct: 80 });
  });

  it('still flags per slot when only one of the two top trinkets is worn', () => {
    // Slot 12 holds the correct top pick; slot 13 holds an off-meta trinket.
    const rows = buildTrinketRows(
      gear({
        trinkets: [
          { slot: 12, id: 193701, name: "Algeth'ar Puzzle Box" },
          { slot: 13, id: 999999, name: 'Off Meta Trinket' },
        ],
      }),
      benchStats,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slotLabel: 'Trinket 1', status: 'ok', note: null });
    expect(rows[1]).toMatchObject({
      slotLabel: 'Trinket 2',
      status: 'info',
      note: 'Switch to Gaze of the Alnseer (80%)',
    });
  });

  it('flags a slot whose worn trinket matches neither recommended trinket', () => {
    // Neither worn trinket is recommended, so both slots get a "Switch to", assigned in overall-usage order without colliding.
    const rows = buildTrinketRows(
      gear({
        trinkets: [
          { slot: 12, id: 111111, name: 'Wrong A' },
          { slot: 13, id: 222222, name: 'Wrong B' },
        ],
      }),
      benchStats,
    );
    expect(rows[0]).toMatchObject({ status: 'info', note: 'Switch to Gaze of the Alnseer (80%)' });
    expect(rows[1]).toMatchObject({ status: 'info', note: "Switch to Algeth'ar Puzzle Box (50%)" });
  });

  it('never recommends the same trinket for both slots when one item dominates', () => {
    // Same dominant-trinket bench as the Rotmire bug; a player wearing neither recommended trinket must get two distinct suggestions, not Gaze twice.
    const dominantStats = stats({
      trinkets: {
        12: [{ id: 249343, name: 'Gaze of the Alnseer', icon: 'gaze', pct: 40 },
             { id: 193701, name: "Algeth'ar Puzzle Box", icon: 'box', pct: 30 }],
        13: [{ id: 249343, name: 'Gaze of the Alnseer', icon: 'gaze', pct: 30 },
             { id: 193701, name: "Algeth'ar Puzzle Box", icon: 'box', pct: 25 }],
      },
    });
    const rows = buildTrinketRows(
      gear({
        trinkets: [
          { slot: 12, id: 111111, name: 'Wrong A' },
          { slot: 13, id: 222222, name: 'Wrong B' },
        ],
      }),
      dominantStats,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'info', note: 'Switch to Gaze of the Alnseer (70%)' });
    expect(rows[1]).toMatchObject({ status: 'info', note: "Switch to Algeth'ar Puzzle Box (55%)" });
  });

  it('suggests the remaining trinket when the player wears one recommendation in both slots', () => {
    // A recommendation is consumed by at most one slot: the same top pick worn in both slots yields one on-plan row plus a switch, never two on-plan rows that drop the second recommendation.
    const rows = buildTrinketRows(
      gear({
        trinkets: [
          { slot: 12, id: 249343, name: 'Gaze of the Alnseer' },
          { slot: 13, id: 249343, name: 'Gaze of the Alnseer' },
        ],
      }),
      benchStats,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slotLabel: 'Trinket 1', id: 249343, status: 'ok', note: null });
    expect(rows[1]).toMatchObject({
      slotLabel: 'Trinket 2',
      status: 'info',
      note: "Switch to Algeth'ar Puzzle Box (50%)",
    });
  });

  it('surfaces the top recommendation when the player has no trinket in a slot', () => {
    const rows = buildTrinketRows(
      gear({ trinkets: [{ slot: 12, id: 193701, name: "Algeth'ar Puzzle Box" }] }),
      benchStats,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slotLabel: 'Trinket 1', status: 'ok', note: null });
    expect(rows[1]).toMatchObject({
      slotLabel: 'Trinket 2',
      id: 249343,
      icon: 'gaze',
      status: 'info',
      note: '80% run this trinket',
    });
  });

  it('returns an empty array when the player wears no trinket and there is no bench data', () => {
    // The comparison builders take real player gear; a player with no trinkets and no bench data yields no rows (the bench-only plan uses buildBenchTrinketRows).
    expect(buildTrinketRows(gear({ trinkets: [] }), null)).toEqual([]);
    expect(buildTrinketRows(gear({ trinkets: [] }), stats({ trinkets: {} }))).toEqual([]);
  });
});

describe('buildEnchantRows (comparison, real player gear)', () => {
  // The comparison builder is only ever called with a real player's gear; the bench-only /pre plan uses buildBenchEnchantRows instead, so a not-yet-loaded player never renders "Not enchanted".

  it('flags a high-consensus slot the real player left un-enchanted', () => {
    const rows = buildEnchantRows(
      gear({ enchants: [] }),
      stats({ enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 90 }] } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'warn', name: 'Not enchanted' });
  });

  it('stays silent on an un-enchanted slot below the consensus share', () => {
    const rows = buildEnchantRows(
      gear({ enchants: [] }),
      stats({ enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 49 }] } }),
    );
    expect(rows).toEqual([]);
  });

  it('marks a slot on-plan when the player runs the consensus enchant', () => {
    const rows = buildEnchantRows(
      gear({ enchants: [{ slot: 15, id: 8041, name: 'Sophic Devotion' }] }),
      stats({ enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 90 }] } }),
    );
    expect(rows[0]).toMatchObject({ status: 'ok', name: 'Sophic Devotion' });
  });

  it('returns an empty array when the player has no enchants and there is no bench data', () => {
    expect(buildEnchantRows(gear({ enchants: [] }), stats({ enchants: {} }))).toEqual([]);
  });

  it('returns a row for a player enchant on a slot with no bench data', () => {
    const rows = buildEnchantRows(
      gear({ enchants: [{ slot: 9, id: 7, name: 'Handguard' }] }),
      stats({ enchants: {} }),
    );
    expect(rows[0]).toMatchObject({ status: 'ok', name: 'Handguard', note: null });
  });
});

const BASELINE = 'v3:11.1,22.2';
const TALENTS: SpecTalents = {
  11: { name: 'Alpha', icon: 'icon_a', spellId: 111 },
  12: { name: 'Alt Alpha', icon: 'icon_alt', spellId: 112 },
  22: { name: 'Beta', icon: 'icon_b', spellId: 222 },
  33: { name: 'Gamma', icon: 'icon_c', spellId: 333 },
  44: { name: 'Hero Tree', icon: '' },
  55: { name: 'Tiered', icon: 'icon_t', spellId: 551 },
  56: { name: 'Tiered', icon: 'icon_t', spellId: 552 },
  57: { name: 'Tiered', icon: 'icon_t', spellId: 553 },
  66: { name: 'Twin', icon: 'icon_w', spellId: 661 },
  67: { name: 'Twin', icon: 'icon_w', spellId: 662 },
};
const TIERED_2_POINTS = 'v3:11.1,22.2,55.1,56.1';
const TIERED_3_POINTS = 'v3:11.1,22.2,55.1,56.2';
const TIERED_4_POINTS = 'v3:11.1,22.2,55.1,56.2,57.1';

describe('buildTalentDiff (an alt build vs the most common build)', () => {
  it('is empty when the build matches the most common one', () => {
    expect(buildTalentDiff(BASELINE, BASELINE, TALENTS)).toEqual([]);
  });

  it('reports a swapped slot as the added talent plus the dropped one', () => {
    expect(buildTalentDiff('v3:12.1,22.2', BASELINE, TALENTS)).toEqual([
      { kind: 'added', talent: TALENTS[12] },
      { kind: 'dropped', talent: TALENTS[11] },
    ]);
  });

  it('reports a talent the most common build fills and this one drops', () => {
    expect(buildTalentDiff('v3:11.1', BASELINE, TALENTS)).toEqual([
      { kind: 'dropped', talent: TALENTS[22] },
    ]);
  });

  it('reports a talent only this build adds', () => {
    expect(buildTalentDiff('v3:11.1,22.2,33.1', BASELINE, TALENTS)).toEqual([
      { kind: 'added', talent: TALENTS[33] },
    ]);
  });

  it('reports a rank difference where the talent is in both builds', () => {
    expect(buildTalentDiff('v3:11.1,22.1', BASELINE, TALENTS)).toEqual([
      { kind: 'rank', talent: TALENTS[22], rank: 1, standardRank: 2 },
    ]);
  });

  it('carries a hero-tree pick, which has no spell behind it', () => {
    expect(buildTalentDiff('v3:11.1,22.2,44.1', BASELINE, TALENTS)).toEqual([
      { kind: 'added', talent: { name: 'Hero Tree', icon: '' } },
    ]);
  });

  it('falls back to the entry id when the talents file does not name it', () => {
    expect(buildTalentDiff('v3:11.1,22.2,99.1', BASELINE, TALENTS)).toEqual([
      { kind: 'added', talent: { name: 'Talent #99', icon: '' } },
    ]);
  });

  it('reports a tiered slot both builds run as the points each spends on it', () => {
    expect(buildTalentDiff(TIERED_4_POINTS, TIERED_3_POINTS, TALENTS)).toEqual([
      { kind: 'rank', talent: TALENTS[55], rank: 4, standardRank: 3 },
    ]);
    expect(buildTalentDiff(TIERED_2_POINTS, TIERED_4_POINTS, TALENTS)).toEqual([
      { kind: 'rank', talent: TALENTS[55], rank: 2, standardRank: 4 },
    ]);
  });

  it('is empty when both builds spend the same points on a tiered slot', () => {
    expect(buildTalentDiff(TIERED_4_POINTS, TIERED_4_POINTS, TALENTS)).toEqual([]);
  });

  it('lists a talent its slot reports under several entries once', () => {
    expect(buildTalentDiff(TIERED_4_POINTS, BASELINE, TALENTS)).toEqual([
      { kind: 'added', talent: TALENTS[55] },
    ]);
  });

  it('reports an alike-named slot swapped at equal points as the added talent plus the dropped one', () => {
    expect(buildTalentDiff('v3:11.1,22.2,67.1', 'v3:11.1,22.2,66.1', TALENTS)).toEqual([
      { kind: 'added', talent: TALENTS[67] },
      { kind: 'dropped', talent: TALENTS[66] },
    ]);
  });

  it('is empty without a talents file, or when either build is unreadable', () => {
    expect(buildTalentDiff('v3:12.1', BASELINE, null)).toEqual([]);
    expect(buildTalentDiff('', BASELINE, TALENTS)).toEqual([]);
    expect(buildTalentDiff('v2:1,2', BASELINE, TALENTS)).toEqual([]);
  });
});

describe('talentStatusOf', () => {
  const topBuilds = stats({
    talent_builds: [
      { key: BASELINE, pct: 62, report_code: 'abc', fight_id: 1, player_name: 'Top', source_id: 1, diff: [] },
    ],
  });

  it('is unknown when the player has no talent key', () => {
    expect(talentStatusOf(topBuilds, '')).toEqual({ status: 'unknown', note: 'No talent data.' });
  });

  it('is ok when the player key matches the standard build', () => {
    expect(talentStatusOf(topBuilds, BASELINE)).toEqual({ status: 'ok', note: 'Standard build.' });
  });

  it('is unknown when the player key version prefix does not match the bench build key format', () => {
    expect(talentStatusOf(topBuilds, 'v2:11,22')).toEqual({ status: 'unknown', note: 'No talent data.' });
  });

  it('is warn when the player key is a comparable version but off the standard build', () => {
    expect(talentStatusOf(topBuilds, 'v3:11.1,33.1')).toEqual({
      status: 'warn', note: 'Off-meta build. 62% run the standard one.',
    });
  });
});

describe('talentStatusOf (a player build matched against the top builds)', () => {
  const MOST_COMMON = 'v3:11.1,22.2';
  const ALT_1 = 'v3:12.1,22.2';
  const ALT_2 = 'v3:11.1,22.1';
  const OFF_META = 'v3:99.1,22.2';

  function talentBuild(
    partial: Partial<EncounterGearStats['talent_builds'][number]> = {},
  ): EncounterGearStats['talent_builds'][number] {
    return { key: MOST_COMMON, pct: 50, report_code: 'ABC123', fight_id: 1, player_name: 'Player', source_id: 1, diff: [], ...partial };
  }

  const topStats = stats({
    talent_builds: [
      talentBuild({ key: MOST_COMMON, pct: 50 }),
      talentBuild({ key: ALT_1, pct: 30 }),
      talentBuild({ key: ALT_2, pct: 15 }),
    ],
  });

  it('marks a match to the most common build as standard', () => {
    expect(talentStatusOf(topStats, MOST_COMMON)).toEqual({ status: 'ok', note: 'Standard build.' });
  });

  it('marks a match to a lower-ranked top build as a known alt, not standard', () => {
    expect(talentStatusOf(topStats, ALT_1)).toEqual({
      status: 'info',
      note: 'Alt build 1. 30% run this build.',
    });
  });

  it('marks a build matching none of the top builds as off-meta', () => {
    expect(talentStatusOf(topStats, OFF_META)).toEqual({
      status: 'warn',
      note: 'Off-meta build. 50% run the standard one.',
    });
  });
});
