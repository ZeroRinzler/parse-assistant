import { describe, it, expect } from 'vitest';
import {
  buildBenchEnchantRows,
  buildBenchTrinketRows,
  buildEnchantRows,
} from './gear-comparison';
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
    expect(rows[0].name).toBe('Sophic Devotion');
    expect(rows[0].slotName).toBe('Main Hand');
    expect(rows[0].pct).toBe(80);
  });

  it('falls back to Enchant #id when the bench enchant name is empty', () => {
    // WCL does not populate permanentEnchantName; ingest writes empty strings
    // until gameData.enchant(id) resolves them on the next ingest run.
    const rows = buildBenchEnchantRows(stats({
      enchants: { 15: [{ id: 8041, name: '', pct: 90 }] },
    }));
    expect(rows[0].name).toBe('Enchant #8041');
  });

  it('skips slots where fewer than 40% of top parsers enchant', () => {
    const rows = buildBenchEnchantRows(stats({
      enchants: { 15: [{ id: 8041, name: 'Rune', pct: 30 }] },
    }));
    expect(rows).toHaveLength(0);
  });

  it('includes slots where at least 40% of top parsers enchant', () => {
    const rows = buildBenchEnchantRows(stats({
      enchants: {
        15: [{ id: 8041, name: 'Rune A', pct: 40 }],
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
  it('returns the top trinket for each slot', () => {
    const rows = buildBenchTrinketRows(stats({
      trinkets: {
        12: [{ id: 193701, name: "Algeth'ar Puzzle Box", pct: 50 }],
        13: [{ id: 249343, name: 'Gaze of the Alnseer', pct: 80 }],
      },
    }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ slotLabel: 'Trinket 1', id: 193701, name: "Algeth'ar Puzzle Box", pct: 50 });
    expect(rows[1]).toEqual({ slotLabel: 'Trinket 2', id: 249343, name: 'Gaze of the Alnseer', pct: 80 });
  });

  it('skips a trinket slot with no bench data', () => {
    const rows = buildBenchTrinketRows(stats({
      trinkets: { 12: [{ id: 193701, name: 'Box', pct: 50 }] },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].slotLabel).toBe('Trinket 1');
  });

  it('returns an empty array when stats or trinkets are absent', () => {
    expect(buildBenchTrinketRows(null)).toEqual([]);
    expect(buildBenchTrinketRows(stats({ trinkets: {} }))).toEqual([]);
  });
});

describe('buildEnchantRows with null playerGear', () => {
  it('shows Not enchanted for every bench slot when playerGear is null', () => {
    // This is the race-condition state: topGear loaded but playerGear not yet
    // fetched. The gear-section component uses benchEnchantRows instead of
    // enchantRows when playerGear is null to avoid this misleading display.
    const rows = buildEnchantRows(null, stats({
      enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 90 }] },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Not enchanted');
  });

  it('returns an empty array when both gear and stats are null', () => {
    expect(buildEnchantRows(null, null)).toEqual([]);
  });

  it('returns a row for a player enchant on a slot with no bench data', () => {
    const rows = buildEnchantRows(
      gear({ enchants: [{ slot: 9, id: 7, name: 'Handguard' }] }),
      stats({ enchants: {} }),
    );
    expect(rows[0]).toMatchObject({ status: 'ok', name: 'Handguard', note: null });
  });
});
