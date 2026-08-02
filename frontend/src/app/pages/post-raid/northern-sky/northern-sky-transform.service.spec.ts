import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { ok, missing } from '../../../core/result';
import { NorthernSkyTransformService, cooldownCastTimes } from './northern-sky-transform.service';
import { SHADOW_BLADES, SHADOW_DANCE, EVASION } from '../../../../testing/spell-ids';
import { cast } from '../../../../testing/builders/events';
import { rulebook } from '../../../../testing/builders/rulebook';

describe('cooldownCastTimes', () => {
  it('collects a cooldown\'s cast times in fight-relative seconds, sorted, ignoring other ids', () => {
    const casts = [cast(SHADOW_BLADES, 30), cast(SHADOW_BLADES, 10), cast(SHADOW_DANCE, 5)];
    expect(cooldownCastTimes(casts, SHADOW_BLADES, 0)).toEqual([10, 30]);
  });

  it('rounds each cast time to one decimal', () => {
    expect(cooldownCastTimes([cast(SHADOW_BLADES, 3.612)], SHADOW_BLADES, 0)).toEqual([3.6]);
  });

  it('returns [] when the ability was never cast', () => {
    expect(cooldownCastTimes([cast(SHADOW_DANCE, 5)], SHADOW_BLADES, 0)).toEqual([]);
  });
});

function reportFor(playerId: number, playerName: string, fightId: number) {
  return {
    title: 't',
    fights: [{ id: fightId, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
    masterData: { actors: [{ id: playerId, name: playerName, subType: 'Rogue', server: '' }], abilities: [] },
  };
}

// P1 (id 10) is the #1 parse; P2 (id 20) casts at different times so a leak from it would be visible.
const wclFake = {
  getRankings: async () => ({
    rankings: [{ name: 'P1', report: { code: 'r1', fightID: 1 } }, { name: 'P2', report: { code: 'r2', fightID: 2 } }],
  }),
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  getAllEvents: async (_c: string, _f: number, _t: string, _s: number, _e: number, playerId: number) =>
    playerId === 10
      ? [cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 190), cast(SHADOW_DANCE, 40), cast(EVASION, 70)]
      : [cast(SHADOW_BLADES, 5), cast(SHADOW_DANCE, 44), cast(EVASION, 66)],
  getAbilities: async (ids: number[]) => Object.fromEntries(ids.map(id => [id, { id, icon: `icon_${id}`, name: `name_${id}` }])),
};
const filesFake = {
  getRulebook: async () => ok(rulebook({
    spec: 'SubtletyRogue',
    cooldowns: [
      { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 },
      { name: 'Shadow Dance', spell_id: SHADOW_DANCE, cooldown: 60 },
    ],
    defensives: [{ name: 'Evasion', spell_id: EVASION, cooldown: 120 }],
  })),
};

describe('NorthernSkyTransformService (live, in-browser)', () => {
  it('bakes the #1 log\'s own cast schedule for cooldowns and defensives, with icons', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(NorthernSkyTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    expect(bench.value.encounter_name).toBe('Boss');
    // Both of P1's Shadow Blades casts survive intact - a real schedule, not a cross-parse median.
    expect(bench.value.abilities).toEqual([
      { spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: `icon_${SHADOW_BLADES}`, kind: 'cooldown', cast_times_s: [10, 190] },
      { spell_id: SHADOW_DANCE, name: 'Shadow Dance', icon: `icon_${SHADOW_DANCE}`, kind: 'cooldown', cast_times_s: [40] },
      { spell_id: EVASION, name: 'Evasion', icon: `icon_${EVASION}`, kind: 'defensive', cast_times_s: [70] },
    ]);
  });

  it('backfills to the next parse when the #1 log is unfetchable', async () => {
    const backfill = {
      ...wclFake,
      // r1 has no P1 actor, so its parse is dropped and P2's log is used instead.
      getReport: async (code: string) => (code === 'r1' ? reportFor(99, 'Other', 1) : reportFor(20, 'P2', 2)),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: backfill as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(NorthernSkyTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    expect(bench.value.abilities).toEqual([
      { spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: `icon_${SHADOW_BLADES}`, kind: 'cooldown', cast_times_s: [5] },
      { spell_id: SHADOW_DANCE, name: 'Shadow Dance', icon: `icon_${SHADOW_DANCE}`, kind: 'cooldown', cast_times_s: [44] },
      { spell_id: EVASION, name: 'Evasion', icon: `icon_${EVASION}`, kind: 'defensive', cast_times_s: [66] },
    ]);
  });

  it('returns missing when the spec rulebook has no cooldowns or defensives', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: { getRulebook: async () => ok(rulebook({ spec: 'SubtletyRogue', cooldowns: [] })) } as unknown as DataFileApiService },
      ],
    });
    expect(await TestBed.inject(NorthernSkyTransformService).getBench('SubtletyRogue', 1)).toEqual(missing('Not yet ingested.'));
  });

  it('propagates a failed rulebook read unchanged', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: { getRulebook: async () => missing('Not yet ingested.') } as unknown as DataFileApiService },
      ],
    });
    expect(await TestBed.inject(NorthernSkyTransformService).getBench('SubtletyRogue', 1)).toEqual(missing('Not yet ingested.'));
  });

  it('returns a load error when a WCL fetch throws', async () => {
    const throwing = { ...wclFake, getRankings: async () => { throw new Error('WCL down'); } };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: throwing as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    expect((await TestBed.inject(NorthernSkyTransformService).getBench('SubtletyRogue', 1)).ok).toBe(false);
  });
});
