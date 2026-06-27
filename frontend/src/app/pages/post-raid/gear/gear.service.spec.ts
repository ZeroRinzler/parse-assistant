import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CharacterGear, WclCombatantInfo, WclGearItem } from '../../../core/models/wcl.models';
import { WclApiService } from '../../../core/services/wcl-api';
import { GEAR_DATA_SOURCE, GearBench, GearDataSource } from './gear-data-source';
import {
  GearFeatureService, benchToStats, buildGearView, emptyGearView,
} from './gear.service';

function benchWith(overrides: Partial<GearBench> = {}): GearBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 10,
    talent_builds: [{ key: 'v2:A', pct: 80, report_code: 'abc', fight_id: 2, player_name: 'Top' }],
    trinkets: { 12: [{ id: 100, name: 'A', icon: 'inv_a', pct: 70 }] },
    enchants: { 15: [{ id: 8041, name: 'Sophic', pct: 90 }] },
    ...overrides,
  };
}

/* ----------------------------- pure functions ----------------------------- */

describe('benchToStats', () => {
  it('extracts the gear stats block from a bench', () => {
    expect(benchToStats(benchWith())).toEqual({
      talent_builds: [{ key: 'v2:A', pct: 80, report_code: 'abc', fight_id: 2, player_name: 'Top' }],
      trinkets: { 12: [{ id: 100, name: 'A', icon: 'inv_a', pct: 70 }] },
      enchants: { 15: [{ id: 8041, name: 'Sophic', pct: 90 }] },
    });
  });

  it('is null for a null bench', () => {
    expect(benchToStats(null)).toBeNull();
  });
});

describe('buildGearView', () => {
  const stats = benchToStats(benchWith());

  it('bench-only mode: comparison off, bench rows populated', () => {
    const view = buildGearView(null, stats);
    expect(view.comparison).toBe(false);
    expect(view.benchTrinketRows).toEqual([{ slotLabel: 'Trinket 1', id: 100, name: 'A', icon: 'inv_a', pct: 70 }]);
    expect(view.benchEnchantRows).toEqual([{ slotName: 'Main Hand', name: 'Sophic', pct: 90 }]);
    expect(view.talentBuilds[0]).toMatchObject({ pct: 80, label: 'Most common build' });
  });

  it('comparison mode: player matching bench is on-plan (ok)', () => {
    const player: CharacterGear = {
      found: true, talent_key: 'v2:A',
      trinkets: [{ slot: 12, id: 100, name: 'A' }],
      enchants: [{ slot: 15, id: 8041, name: 'Sophic' }],
    };
    const view = buildGearView(player, stats);
    expect(view.comparison).toBe(true);
    expect(view.talentStatus.status).toBe('ok');
    expect(view.trinketStatus).toBe('ok');
    expect(view.enchantStatus).toBe('ok');
  });

  it('comparison mode: missing high-consensus enchant flags a warning', () => {
    const player: CharacterGear = {
      found: true, talent_key: 'v2:A',
      trinkets: [{ slot: 12, id: 100, name: 'A' }],
      enchants: [],
    };
    const view = buildGearView(player, stats);
    expect(view.enchantStatus).toBe('warn');
    expect(view.enchantRows.some(row => row.status === 'warn')).toBe(true);
  });
});

describe('emptyGearView', () => {
  it('is a bench-off view with no rows', () => {
    expect(emptyGearView()).toEqual({
      comparison: false,
      talentBuilds: [], talentStatus: { status: 'unknown', note: 'No talent data yet.' },
      trinketRows: [], trinketStatus: 'ok', benchTrinketRows: [],
      enchantRows: [], enchantStatus: 'ok', benchEnchantRows: [],
    });
  });
});

/* ----------------------------- feature service ---------------------------- */

// Reconstruct a raw CombatantInfo event from a desired CharacterGear so the feature
// service (which now reads raw combatant info + extracts gear itself) reproduces it.
// Names are baked onto the gear items, so getGameNames is not consulted. Talent key
// parts ride as nodeID strings (the v2:<parts> form round-trips through extraction).
function toRawEvent(gear: CharacterGear): WclCombatantInfo {
  const items: WclGearItem[] = [];
  for (const trinket of gear.trinkets ?? []) items[trinket.slot] = { id: trinket.id, name: trinket.name };
  for (const enchant of gear.enchants ?? []) {
    items[enchant.slot] = { ...(items[enchant.slot] ?? { id: 1, name: 'x' }), permanentEnchant: enchant.id, permanentEnchantName: enchant.name };
  }
  const parts = (gear.talent_key ?? '').replace(/^v2:/, '');
  const talentTree = parts ? parts.split(',').map(node => ({ nodeID: node as unknown as number })) : [];
  return { sourceID: 10, gear: items, talentTree };
}

function configure(bench: GearBench | null, gear: CharacterGear | null): GearFeatureService {
  const source: GearDataSource = { getGearBench: () => Promise.resolve(bench) };
  const wclFake = {
    getCombatantInfo: async (): Promise<WclCombatantInfo | null> => (gear?.found ? toRawEvent(gear) : null),
    getGameNames: async () => ({}),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: GEAR_DATA_SOURCE, useValue: source },
      { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
    ],
  });
  return TestBed.inject(GearFeatureService);
}

describe('GearFeatureService', () => {
  it('loadBenchView builds the bench-only view', async () => {
    const view = await configure(benchWith(), null).loadBenchView('SubtletyRogue', 1);
    expect(view.comparison).toBe(false);
    expect(view.benchTrinketRows).toHaveLength(1);
  });

  it('loadBenchView returns the empty view when no bench exists', async () => {
    const view = await configure(null, null).loadBenchView('SubtletyRogue', 1);
    expect(view).toEqual(emptyGearView());
  });

  it('loadComparisonView merges fetched player gear with the bench', async () => {
    const player: CharacterGear = {
      found: true, talent_key: 'v2:A',
      trinkets: [{ slot: 12, id: 100, name: 'A' }],
      enchants: [{ slot: 15, id: 8041, name: 'Sophic' }],
    };
    const view = await configure(benchWith(), player).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(view.comparison).toBe(true);
    expect(view.talentStatus.status).toBe('ok');
  });

  it('loadComparisonView falls back to bench-only when the player has no combatant info', async () => {
    const view = await configure(benchWith(), null).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(view.comparison).toBe(false);
    expect(view.benchTrinketRows).toHaveLength(1);
  });

  it('loadComparisonView returns the empty view when neither bench nor player gear exist', async () => {
    const view = await configure(null, null).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(view).toEqual(emptyGearView());
  });
});
