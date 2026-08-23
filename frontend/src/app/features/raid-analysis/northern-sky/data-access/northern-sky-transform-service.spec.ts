import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Results } from '../../../../core/http/result';
import { NorthernSkyTransformService } from './northern-sky-transform-service';
import { SHADOW_BLADES, SHADOW_DANCE, EVASION } from '../../../../../testing/spell-ids';
import { cast } from '../../../../../testing/builders/events';
import { rulebook } from '../../../../../testing/builders/rulebook';
import { abilityLookup, parseRankings, reportsByCode } from '../../../../../testing/builders/wcl-fixtures';
import { provideApiFakes } from '../../../../../testing/api-fakes';
import { WclProjectionsService } from '../../../../domain/analysis/wcl-projections-service';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';

const wclProjections = TestBed.inject(WclProjectionsService);
TestBed.resetTestingModule();
TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
] });
const svc = TestBed.inject(NorthernSkyTransformService);
TestBed.resetTestingModule();

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed: WclProjectionsService['withRelativeS'] = (events, startMs) => wclProjections.withRelativeS(events, startMs);

describe('cooldownCastTimes', () => {
  it('collects a cooldown\'s cast times in fight-relative seconds, sorted, ignoring other ids', () => {
    const casts = timed([cast(SHADOW_BLADES, 30), cast(SHADOW_BLADES, 10), cast(SHADOW_DANCE, 5)], 0);
    expect(svc['cooldownCastTimes'](casts, SHADOW_BLADES)).toEqual([10, 30]);
  });

  it('rounds each cast time to one decimal', () => {
    expect(svc['cooldownCastTimes'](timed([cast(SHADOW_BLADES, 3.612)], 0), SHADOW_BLADES)).toEqual([3.6]);
  });

  it('returns [] when the ability was never cast', () => {
    expect(svc['cooldownCastTimes'](timed([cast(SHADOW_DANCE, 5)], 0), SHADOW_BLADES)).toEqual([]);
  });
});

// P1 (id 10) is the #1 parse; P2 (id 20) casts at different times so a leak from it would be visible.
const wclFake = {
  getRankings: async () => ({ rankings: parseRankings(2) }),
  getReport: reportsByCode(),
  getAllEvents: async (_c: string, _f: number, _t: string, _s: number, _e: number, playerId: number) =>
    playerId === 10
      ? [cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 190), cast(SHADOW_DANCE, 40), cast(EVASION, 70)]
      : [cast(SHADOW_BLADES, 5), cast(SHADOW_DANCE, 44), cast(EVASION, 66)],
  getAbilities: abilityLookup(),
};
const filesFake = {
  getRulebook: async () => Results.ok(rulebook({
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
    TestBed.configureTestingModule({ providers: provideApiFakes({ wcl: wclFake, files: filesFake }) });
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

  it('returns missing when the spec rulebook has no cooldowns or defensives', async () => {
    TestBed.configureTestingModule({
      providers: provideApiFakes({ wcl: wclFake, files: { getRulebook: async () => Results.ok(rulebook({ spec: 'SubtletyRogue', cooldowns: [] })) } }),
    });
    expect(await TestBed.inject(NorthernSkyTransformService).getBench('SubtletyRogue', 1)).toEqual(Results.missing('Not yet ingested.'));
  });
});
