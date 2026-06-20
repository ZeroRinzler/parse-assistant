import { describe, it, expect } from 'vitest';
import { mountVm } from '../../../../testing/component-harness';
import { GearSectionComponent } from './gear-section';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { CharacterGear } from '../../../core/models/wcl.models';
import { BenchEnchantRow, BenchTrinketRow, EnchantRow } from '../../../shared/gear/gear-comparison';

function stats(partial: Partial<EncounterGearStats> = {}): EncounterGearStats {
  return { talent_builds: [], trinkets: {}, enchants: {}, ...partial };
}

function gear(partial: Partial<CharacterGear> = {}): CharacterGear {
  return { found: true, ...partial };
}

describe('GearSectionComponent - playerGear null (loading state)', () => {
  it('benchEnchantRows shows bench data, not Not enchanted, when playerGear is null', () => {
    const { vm } = mountVm(GearSectionComponent, {
      topGear: stats({ enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 90 }] } }),
      playerGear: null,
    });

    const bench = (vm['benchEnchantRows'] as () => BenchEnchantRow[])();
    expect(bench).toHaveLength(1);
    expect(bench[0].name).toBe('Sophic Devotion');
    expect(bench[0].pct).toBe(90);

    // enchantRows with null playerGear would show "Not enchanted" - the component
    // template uses benchEnchantRows instead to avoid this in the loading state.
    const comparison = (vm['enchantRows'] as () => EnchantRow[])();
    expect(comparison[0].name).toBe('Not enchanted');
  });

  it('benchTrinketRows shows bench trinkets, not No data, when playerGear is null', () => {
    const { vm } = mountVm(GearSectionComponent, {
      topGear: stats({
        trinkets: {
          12: [{ id: 193701, name: "Algeth'ar Puzzle Box", pct: 50 }],
          13: [{ id: 249343, name: 'Gaze of the Alnseer', pct: 80 }],
        },
      }),
      playerGear: null,
    });

    const rows = (vm['benchTrinketRows'] as () => BenchTrinketRow[])();
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("Algeth'ar Puzzle Box");
    expect(rows[1].name).toBe('Gaze of the Alnseer');
  });

  it('uses empty bench rows gracefully when topGear has no enchant data', () => {
    const { vm } = mountVm(GearSectionComponent, {
      topGear: stats({ enchants: {} }),
      playerGear: null,
    });

    expect((vm['benchEnchantRows'] as () => BenchEnchantRow[])()).toEqual([]);
    expect((vm['benchTrinketRows'] as () => BenchTrinketRow[])()).toEqual([]);
  });
});

describe('GearSectionComponent - playerGear loaded (comparison state)', () => {
  it('enchantRows shows ok when player matches bench enchant', () => {
    const { vm } = mountVm(GearSectionComponent, {
      topGear: stats({ enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 90 }] } }),
      playerGear: gear({ enchants: [{ slot: 15, id: 8041, name: 'Sophic Devotion' }] }),
    });

    const rows = (vm['enchantRows'] as () => EnchantRow[])();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ok', name: 'Sophic Devotion' });
  });

  it('enchantRows warns when player is missing a high-consensus enchant', () => {
    const { vm } = mountVm(GearSectionComponent, {
      topGear: stats({ enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 90 }] } }),
      playerGear: gear({ enchants: [] }),
    });

    const rows = (vm['enchantRows'] as () => EnchantRow[])();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'warn', name: 'Not enchanted' });
  });

  it('switches to bench mode when playerGear is later cleared to null', () => {
    const { vm, setInput } = mountVm(GearSectionComponent, {
      topGear: stats({ enchants: { 15: [{ id: 8041, name: 'Sophic Devotion', pct: 90 }] } }),
      playerGear: gear({ enchants: [{ slot: 15, id: 8041, name: 'Sophic Devotion' }] }),
    });

    const beforeRows = (vm['enchantRows'] as () => EnchantRow[])();
    expect(beforeRows[0].status).toBe('ok');

    setInput('playerGear', null);
    const benchRows = (vm['benchEnchantRows'] as () => BenchEnchantRow[])();
    expect(benchRows[0].name).toBe('Sophic Devotion');
    // enchantRows now shows "Not enchanted" - template uses benchEnchantRows when null
    const afterRows = (vm['enchantRows'] as () => EnchantRow[])();
    expect(afterRows[0].name).toBe('Not enchanted');
  });
});
