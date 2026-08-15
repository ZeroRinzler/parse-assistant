import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CharacterGear, WclCombatantInfo, WclGearItem } from '../../../core/models/wcl.models';
import { WclApiService } from '../../../core/services/wcl-api';
import { GEAR_DATA_SOURCE, GearBench } from './gear-data-source';
import { DataSource } from '../../../core/data-source/data-source';
import { Result, ok, permanent, missing } from '../../../core/result';
import {
  GearFeatureService, benchToStats, buildGearView, buildBenchGearView,
  buildCharacterGear, emptyGearView,
} from './gear.service';

const STANDARD_KEY = 'v3:11.1,22.1';

function benchWith(overrides: Partial<GearBench> = {}): GearBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 10,
    talent_builds: [{ key: STANDARD_KEY, pct: 80, report_code: 'abc', fight_id: 2, player_name: 'Top', source_id: 5, diff: [] }],
    trinkets: { 12: [{ id: 100, name: 'A', icon: 'inv_a', pct: 70 }] },
    enchants: { 15: [{ id: 8041, name: 'Sophic', pct: 90 }] },
    ...overrides,
  };
}

// Reconstructs a raw CombatantInfo event; names are baked onto the gear items, so getGameNames is not consulted.
function toRawEvent(gear: CharacterGear): WclCombatantInfo {
  const items: WclGearItem[] = [];
  for (const trinket of gear.trinkets ?? []) items[trinket.slot] = { id: trinket.id, name: trinket.name };
  for (const enchant of gear.enchants ?? []) {
    items[enchant.slot] = { ...(items[enchant.slot] ?? { id: 1, name: 'x' }), permanentEnchant: enchant.id, permanentEnchantName: enchant.name };
  }
  const body = (gear.talent_key ?? '').replace(/^v3:/, '');
  const talentTree = body ? body.split(',').map(pick => {
    const [id, rank] = pick.split('.').map(Number);
    return { id, rank };
  }) : [];
  return { sourceID: 10, gear: items, talentTree };
}

describe('benchToStats', () => {
  it('extracts the gear stats block from a bench', () => {
    expect(benchToStats(benchWith())).toEqual({
      talent_builds: [{ key: STANDARD_KEY, pct: 80, report_code: 'abc', fight_id: 2, player_name: 'Top', source_id: 5, diff: [] }],
      trinkets: { 12: [{ id: 100, name: 'A', icon: 'inv_a', pct: 70 }] },
      enchants: { 15: [{ id: 8041, name: 'Sophic', pct: 90 }] },
    });
  });
});

describe('buildCharacterGear', () => {
  it('is a permanent error when the log has no combatant info', () => {
    expect(buildCharacterGear(null, {}))
      .toEqual(permanent('No combatant info in this log.', 'gear.combatant-info'));
  });

  it('builds the gear fingerprint when the event carries gear', () => {
    const event = toRawEvent({
      talent_key: STANDARD_KEY,
      trinkets: [{ slot: 12, id: 100, name: 'A' }],
      enchants: [{ slot: 15, id: 8041, name: 'Sophic' }],
    });
    const result = buildCharacterGear(event, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ talent_key: STANDARD_KEY });
  });
});

describe('buildBenchGearView', () => {
  const stats = benchToStats(benchWith());

  it('comparison off, bench rows populated from the dedicated bench builders', () => {
    const view = buildBenchGearView(stats);
    expect(view.comparison).toBe(false);
    expect(view.benchTrinketRows).toEqual([{ slotLabel: 'Trinket 1', id: 100, name: 'A', icon: 'inv_a', pct: 70 }]);
    expect(view.benchEnchantRows).toEqual([{ slotName: 'Main Hand', name: 'Sophic', pct: 90 }]);
    expect(view.talentBuilds[0]).toMatchObject({ pct: 80, label: 'Most common build' });
    // The comparison rows stay empty in bench-only mode (no player to compare).
    expect(view.enchantRows).toEqual([]);
    expect(view.trinketRows).toEqual([]);
  });
});

describe('buildGearView', () => {
  const stats = benchToStats(benchWith());

  it('comparison mode: player matching bench is on-plan (ok)', () => {
    const player: CharacterGear = {
      talent_key: STANDARD_KEY,
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
      talent_key: STANDARD_KEY,
      trinkets: [{ slot: 12, id: 100, name: 'A' }],
      enchants: [],
    };
    const view = buildGearView(player, stats);
    expect(view.enchantStatus).toBe('warn');
    expect(view.enchantRows.some(row => row.status === 'warn')).toBe(true);
  });
});

describe('emptyGearView', () => {
  it('is a bench-off placeholder with no rows', () => {
    expect(emptyGearView()).toEqual({
      comparison: false,
      talentBuilds: [], talentStatus: { status: 'unknown', note: 'No talent data.' },
      trinketRows: [], trinketStatus: 'ok', benchTrinketRows: [],
      enchantRows: [], enchantStatus: 'ok', benchEnchantRows: [],
    });
  });
});

function configure(bench: Result<GearBench>, gear: CharacterGear | null): GearFeatureService {
  const source: DataSource<GearBench> = { getBench: () => Promise.resolve(bench) };
  const wclFake = {
    getCombatantInfo: async (): Promise<WclCombatantInfo[]> => (gear ? [toRawEvent(gear)] : []),
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
    const result = await configure(ok(benchWith()), null).loadBenchView('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comparison).toBe(false);
    expect(result.value.benchTrinketRows).toHaveLength(1);
  });

  it('loadBenchView propagates a missing bench unchanged', async () => {
    const result = await configure(missing('Not yet ingested.'), null).loadBenchView('SubtletyRogue', 1);
    expect(result).toEqual(missing('Not yet ingested.'));
  });

  it('loadComparisonView merges fetched player gear with the bench', async () => {
    const player: CharacterGear = {
      talent_key: STANDARD_KEY,
      trinkets: [{ slot: 12, id: 100, name: 'A' }],
      enchants: [{ slot: 15, id: 8041, name: 'Sophic' }],
    };
    const result = await configure(ok(benchWith()), player).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comparison).toBe(true);
    expect(result.value.talentStatus.status).toBe('ok');
  });

  it('loadComparisonView surfaces a permanent error when the player has no combatant info', async () => {
    const result = await configure(ok(benchWith()), null).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result).toEqual(permanent('No combatant info in this log.', 'gear.combatant-info'));
  });

  it('loadComparisonView propagates a missing bench before fetching player gear', async () => {
    const result = await configure(missing('Not yet ingested.'), null).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result).toEqual(missing('Not yet ingested.'));
  });
});
