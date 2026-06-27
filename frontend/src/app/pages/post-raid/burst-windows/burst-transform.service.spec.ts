import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  BurstTransformService, cdTimings, findParseWindows, clusterParseWindows, cdSpellIds, ParseWindow,
  toParseRankings,
} from './burst-transform.service';

function cast(spellId: number, atS: number): WclEvent {
  return { type: 'cast', timestamp: atS * 1000, abilityGameID: spellId };
}
function damage(spellId: number, atS: number, amount: number): WclEvent {
  return { type: 'damage', timestamp: atS * 1000, abilityGameID: spellId, amount };
}

/* ----------------------------- pure functions ----------------------------- */

describe('toParseRankings', () => {
  it('maps raw rankings to fetchable parses and caps at count', () => {
    const raw = [
      { name: 'P1', report: { code: 'r1', fightID: 1 } },
      { name: 'P2', report: { code: 'r2', fightID: 2 } },
      { name: 'P3', report: { code: 'r3', fightID: 3 } },
    ];
    expect(toParseRankings(raw, 2)).toEqual([
      { player: 'P1', report_code: 'r1', fight_id: 1 },
      { player: 'P2', report_code: 'r2', fight_id: 2 },
    ]);
  });

  it('drops anonymized "Character N-N" names and rows without a report code', () => {
    const raw = [
      { name: 'Character 123-456', report: { code: 'r1', fightID: 1 } },
      { name: 'Real', report: { fightID: 2 } },
      { name: 'Keep', report: { code: 'r3', fightID: 3 } },
    ];
    expect(toParseRankings(raw, 10)).toEqual([{ player: 'Keep', report_code: 'r3', fight_id: 3 }]);
  });
});

describe('cdSpellIds', () => {
  it('maps cooldown + defensive names to spell ids, skipping missing ids', () => {
    expect(cdSpellIds(
      [{ name: 'Shadow Blades', spell_id: 121471, cooldown: 90 }, { name: 'NoId', spell_id: 0, cooldown: 60 }],
      [{ name: 'Cloak', spell_id: 31224, cooldown: 120 }],
    )).toEqual({ 'Shadow Blades': 121471, 'Cloak': 31224 });
  });
});

describe('findParseWindows', () => {
  const cooldowns = [{ name: 'Shadow Blades', spell_id: 121471, cooldown: 90, duration: 20 }];

  it('builds a [cast, cast+duration] window and breaks damage down by ability', () => {
    const timings = cdTimings([cast(121471, 10)], cooldowns, 0);
    const windows = findParseWindows([damage(279043, 12, 1000)], 0, timings, [cast(121471, 10)], new Map());
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 20, window_damage: 1000, active_cds: ['Shadow Blades'] });
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: 279043, damage: 1000 });
  });

  it('drops a window below the significance threshold', () => {
    const timings = cdTimings([cast(121471, 10)], cooldowns, 0);
    // window has 30 of 1030 total damage (<3%), so it is dropped.
    const windows = findParseWindows([damage(279043, 12, 30), damage(1, 200, 1000)], 0, timings, [], new Map());
    expect(windows).toHaveLength(0);
  });
});

describe('clusterParseWindows', () => {
  const window = (timeS: number): ParseWindow => ({
    time_s: timeS, window_length_s: 20, window_damage: 1000, active_cds: ['Shadow Blades'],
    ability_breakdown: [{ spell_id: 279043, damage: 600, casts: 2 }],
  });

  it('emits a cluster present in enough parses, with common cds + ability stats', () => {
    const out = clusterParseWindows([window(10), window(11)], 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time_s: 10.5, common_cds: ['Shadow Blades'], dmg_avg: 1000, window_length_s: 20 });
    expect(out[0].ability_breakdown[0]).toMatchObject({ spell_id: 279043, avg_damage: 600, count: 2 });
  });

  it('drops a cluster below the min-sample fraction', () => {
    // 1 window out of 10 samples is below max(2, 10*0.35).
    expect(clusterParseWindows([window(10)], 10)).toHaveLength(0);
  });
});

/* ----------------------------- service (end to end, fake client) ----------------------------- */

function reportFor(playerId: number, playerName: string, fightId: number) {
  return {
    title: 't',
    fights: [{ id: fightId, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
    masterData: {
      actors: [{ id: playerId, name: playerName, subType: 'Rogue', server: '' }],
      abilities: [{ gameID: 279043, name: 'Eviscerate', icon: 'x' }],
    },
  };
}

const wclFake = {
  getRankings: async () => [
    { name: 'P1', report: { code: 'r1', fightID: 1 } },
    { name: 'P2', report: { code: 'r2', fightID: 2 } },
  ],
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) =>
    dataType === 'Casts' ? [cast(121471, 10)] : [damage(279043, 12, 1000)],
  // Resolves a real icon + name for every requested spell id (gameData.ability).
  getAbilities: async (ids: number[]) =>
    Object.fromEntries(ids.map(id => [id, { icon: `icon_${id}`, name: `name_${id}` }])),
};
const filesFake = {
  getRulebook: async () => ({
    spec: 'SubtletyRogue',
    major_cooldowns: [{ name: 'Shadow Blades', spell_id: 121471, cooldown: 90, duration: 20 }],
    defensives: [],
  }),
};

describe('BurstTransformService (live, in-browser)', () => {
  it('computes a clustered burst bench from the top parses', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(BurstTransformService).getBurstBench('SubtletyRogue', 1);
    expect(bench).not.toBeNull();
    expect(bench!.sample_count).toBe(2);
    expect(bench!.encounter_name).toBe('Boss');
    expect(bench!.cd_spell_ids).toEqual({ 'Shadow Blades': 121471 });
    expect(bench!.windows).toHaveLength(1);
    expect(bench!.windows[0].common_cds).toContain('Shadow Blades');
    // ability_icons is complete: header cooldown AND every window ability resolved by id.
    expect(bench!.ability_icons[121471]).toEqual({ icon: 'icon_121471', name: 'name_121471' });
    expect(bench!.ability_icons[279043]).toEqual({ icon: 'icon_279043', name: 'name_279043' });
  });

  it('backfills past a private (unfetchable) top parse to keep the sample count full', async () => {
    const candidates = Array.from({ length: 11 }, (_, i) => ({ name: `P${i + 1}`, report: { code: `r${i + 1}`, fightID: i + 1 } }));
    const backfillWcl = {
      ...wclFake,
      getRankings: async () => candidates,
      getReport: async (code: string) => {
        if (code === 'r5') throw new Error('You do not have permission to view this report.');
        const idx = Number(code.slice(1));
        return reportFor(idx * 10, `P${idx}`, idx);
      },
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: backfillWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(BurstTransformService).getBurstBench('SubtletyRogue', 1);
    // 11 candidates, one private: the 11th backfills the skipped parse to a full 10.
    expect(bench!.sample_count).toBe(10);
  });

  it('returns null when the spec has no rulebook cooldowns', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: { getRulebook: async () => null } as unknown as DataFileApiService },
      ],
    });
    expect(await TestBed.inject(BurstTransformService).getBurstBench('SubtletyRogue', 1)).toBeNull();
  });
});
