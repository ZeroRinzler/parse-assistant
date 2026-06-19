import { describe, it, expect } from 'vitest';
import { computeAnalysis, AnalysisInput } from './compute-analysis';
import { Events } from '../../../testing/builders/events';
import { rulebook } from '../../../testing/builders/rulebook';
import { bench } from '../../../testing/builders/bench';
import { parseClock, FIGHT_START } from '../../../testing/time';
import { SHADOW_BLADES, FEINT, EVISCERATE } from '../../../testing/spell-ids';

function input(over: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    playerName: 'Rogue',
    spec: 'SubtletyRogue',
    fStart: FIGHT_START,
    fEnd: parseClock('5:00'),
    castEvents: [],
    buffEvents: [],
    dmgEvents: [],
    dtEvents: [],
    rulebook: null,
    bench: null,
    masterAbilities: [],
    ...over,
  };
}

describe('computeAnalysis (end to end)', () => {
  it('carries spec, rulebook source, fight duration and the cd -> spell-id map onto the result', () => {
    const result = computeAnalysis(
      input({
        rulebook: rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }),
        bench: bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 } } }),
        castEvents: Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_BLADES, '3:05').build(),
      }),
    );

    expect(result.spec).toBe('SubtletyRogue');
    expect(result.rulebook_source).toBe('generated');
    expect(result.player_fight_duration_s).toBe(300);
    expect(result.cd_spell_ids).toEqual({ 'Shadow Blades': SHADOW_BLADES });
  });

  it('reports rulebook_source "none" when no rulebook is supplied', () => {
    expect(computeAnalysis(input()).rulebook_source).toBe('none');
  });

  it('resolves ability icons (stripping the .jpg suffix) from masterData abilities', () => {
    const result = computeAnalysis(input({ masterAbilities: [{ gameID: EVISCERATE, name: 'Eviscerate', icon: 'ability_rogue_eviscerate.jpg' }] }));

    expect(result.ability_icons[String(EVISCERATE)]).toEqual({ icon: 'ability_rogue_eviscerate', name: 'Eviscerate' });
  });

  it('produces player burst windows against the bench burst windows', () => {
    const result = computeAnalysis(
      input({
        bench: bench({ burstWindows: [{ time_s: 10, window_length_s: 20, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], avg_targets: 1, ability_breakdown: [] }] }),
        dmgEvents: Events.start().damage(EVISCERATE, '0:15', 5000).build(),
      }),
    );

    expect(result.player_burst_windows?.[0].window_damage).toBe(5000);
  });

  it('analyses defensives declared in the rulebook', () => {
    const result = computeAnalysis(
      input({
        rulebook: rulebook({ defensives: [{ name: 'Feint', spell_id: FEINT, cooldown: 30, duration: 6 }] }),
        bench: bench({ perDefensive: { 'Feint': { uses_per_min: { avg: 2, stddev: 0, min: 2, max: 2 }, avg_uses_per_min: 2 } } }),
        buffEvents: Events.start().buffWindow(FEINT, '0:10', '0:16').build(),
      }),
    );

    expect(result.player_defensives?.[0]).toMatchObject({ name: 'Feint', uses: 1 });
    expect(result.defensive_findings).toBeDefined();
  });
});
