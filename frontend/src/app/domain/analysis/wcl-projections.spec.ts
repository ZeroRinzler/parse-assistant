import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import { WclProjectionsService } from './wcl-projections-service';
import { WCL_SYNTHETIC_SOURCE_FALLBACK_ID } from '../../../testing/spell-ids';
import { ParseRanking } from '../../core/wcl/wcl.models';
import { TestBed } from '@angular/core/testing';

const wclProjections = TestBed.inject(WclProjectionsService);

// A raw ranking row as WCL surfaces it in the characterRankings blob.
const rankingRow = (name: string, code: string, fightID: number) => ({ name, report: { code, fightID } });

const TWISTING_NETHER = 'Twisting Nether';
const AREA_52 = 'Area 52';

describe('unwrapRankings', () => {
  it('parses the JSON blob string form and returns its rankings', () => {
    const blob = JSON.stringify({ rankings: [rankingRow('Keep', 'r1', 3)] });
    expect(wclProjections.unwrapRankings(blob)).toEqual([rankingRow('Keep', 'r1', 3)]);
  });

  it('reads the already-parsed object form directly', () => {
    expect(wclProjections.unwrapRankings({ rankings: [rankingRow('Keep', 'r1', 3)] })).toEqual([rankingRow('Keep', 'r1', 3)]);
  });

  it('returns [] for a null / empty blob or a blob with no rankings key', () => {
    expect(wclProjections.unwrapRankings(null)).toEqual([]);
    expect(wclProjections.unwrapRankings(undefined)).toEqual([]);
    expect(wclProjections.unwrapRankings('')).toEqual([]);
    expect(wclProjections.unwrapRankings({})).toEqual([]);
  });

  it('returns [] without throwing for an unparseable string blob, warning for repro', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => wclProjections.unwrapRankings('{ not json')).not.toThrow();
    expect(wclProjections.unwrapRankings('{ not json')).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('composes with toParseRankings to yield fetchable parses', () => {
    const blob = JSON.stringify({ rankings: [rankingRow('Keep', 'r1', 3)] });
    expect(wclProjections.toParseRankings(wclProjections.unwrapRankings(blob), 10)).toEqual([{ player: 'Keep', server: '', report_code: 'r1', fight_id: 3 }]);
  });
});

describe('toParseRankings', () => {
  it('maps raw rankings to fetchable parses and caps at count', () => {
    const raw = [rankingRow('P1', 'r1', 1), rankingRow('P2', 'r2', 2), rankingRow('P3', 'r3', 3)];
    expect(wclProjections.toParseRankings(raw, 2)).toEqual([
      { player: 'P1', server: '', report_code: 'r1', fight_id: 1 },
      { player: 'P2', server: '', report_code: 'r2', fight_id: 2 },
    ]);
  });

  it('carries the ranked character\'s realm, and an empty realm when the row omits it', () => {
    const raw = [{ ...rankingRow('P1', 'r1', 1), server: { name: TWISTING_NETHER } }, rankingRow('P2', 'r2', 2)];
    expect(wclProjections.toParseRankings(raw, 10).map(ranking => ranking.server)).toEqual([TWISTING_NETHER, '']);
  });

  it('drops anonymized "Character <id>-<id>" names and rows without a report code', () => {
    const raw = [
      rankingRow('Character 123-456', 'r1', 1), // privacy-anonymized parse
      { name: 'NoReport', report: { fightID: 2 } }, // report code missing -> unfetchable
      rankingRow('Keep', 'r3', 3),
    ];
    expect(wclProjections.toParseRankings(raw, 10)).toEqual([{ player: 'Keep', server: '', report_code: 'r3', fight_id: 3 }]);
  });
});

describe('findParseActor', () => {
  const RANKED_NAME = 'Keep';
  const TWIN_ID = 20;
  const actor = (id: number, name: string, server: string) => ({ id, name, subType: 'Rogue', server });
  const ranked = (server: string): ParseRanking => ({ player: RANKED_NAME, server, report_code: 'r1', fight_id: 1 });

  it('binds the one actor carrying the ranked name', () => {
    const actors = [actor(10, 'Other', AREA_52), actor(TWIN_ID, RANKED_NAME, TWISTING_NETHER)];
    expect(wclProjections.findParseActor(actors, ranked(TWISTING_NETHER))?.id).toBe(TWIN_ID);
  });

  it('binds a lone name match even when its realm differs from the ranked realm', () => {
    expect(wclProjections.findParseActor([actor(TWIN_ID, RANKED_NAME, TWISTING_NETHER)], ranked(AREA_52))?.id).toBe(TWIN_ID);
  });

  it('is null when no actor carries the ranked name, and for an absent actor list', () => {
    expect(wclProjections.findParseActor([actor(10, 'Other', AREA_52)], ranked(AREA_52))).toBeNull();
    expect(wclProjections.findParseActor(undefined, ranked(AREA_52))).toBeNull();
  });

  it('separates two same-named raiders by realm, ignoring spacing and case', () => {
    const actors = [actor(10, RANKED_NAME, 'Twisting-Nether'), actor(TWIN_ID, RANKED_NAME, 'area 52')];
    expect(wclProjections.findParseActor(actors, ranked(AREA_52))?.id).toBe(TWIN_ID);
  });

  it('is null for two same-named raiders when the ranking carries no realm', () => {
    const actors = [actor(10, RANKED_NAME, TWISTING_NETHER), actor(TWIN_ID, RANKED_NAME, AREA_52)];
    expect(wclProjections.findParseActor(actors, ranked(''))).toBeNull();
  });

  it('is null for two same-named raiders when neither sits on the ranked realm', () => {
    const actors = [actor(10, RANKED_NAME, TWISTING_NETHER), actor(TWIN_ID, RANKED_NAME, '')];
    expect(wclProjections.findParseActor(actors, ranked(AREA_52))).toBeNull();
  });
});

describe('abilityIcons', () => {
  const SHADOW_BLADES = 121471;
  const CLOAK = 31224;

  it('keys by ability id and strips the trailing .jpg (case-insensitive)', () => {
    const raw = {
      [`a${SHADOW_BLADES}`]: { id: SHADOW_BLADES, name: 'Shadow Blades', icon: 'ability_sb.jpg' },
      [`a${CLOAK}`]: { id: CLOAK, name: 'Cloak of Shadows', icon: 'spell_cloak.JPG' },
    };
    expect(wclProjections.abilityIcons(raw)).toEqual({
      [SHADOW_BLADES]: { icon: 'ability_sb', name: 'Shadow Blades' },
      [CLOAK]: { icon: 'spell_cloak', name: 'Cloak of Shadows' },
    });
  });

  it('skips null entries (ids WCL could not resolve) and returns {} for an empty map', () => {
    const raw = { [`a${SHADOW_BLADES}`]: null };
    expect(wclProjections.abilityIcons(raw)).toEqual({});
    expect(wclProjections.abilityIcons({})).toEqual({});
  });

  it('leaves an icon with no .jpg extension untouched', () => {
    const raw = { [`a${SHADOW_BLADES}`]: { id: SHADOW_BLADES, name: 'Shadow Blades', icon: 'ability_sb' } };
    expect(wclProjections.abilityIcons(raw)).toEqual({ [SHADOW_BLADES]: { icon: 'ability_sb', name: 'Shadow Blades' } });
  });

  it('projects a resolved entry with a null icon to an empty icon (name-only)', () => {
    const raw = { [`a${SHADOW_BLADES}`]: { id: SHADOW_BLADES, name: 'Shadow Blades', icon: null } };
    expect(wclProjections.abilityIcons(raw)).toEqual({ [SHADOW_BLADES]: { icon: '', name: 'Shadow Blades' } });
  });

});

describe('windowSpells', () => {
  const SHADOW_BLADES = 121471;
  const UNKNOWN_SPELL_ID = 999999; // an id the ability map never resolved
  const abilities = { [SHADOW_BLADES]: { icon: 'ability_sb', name: 'Shadow Blades' } };

  // A missing id is reported via logWarn -> console.warn; the spy keeps runner output clean and lets the test assert on it.
  let warnSpy: MockInstance<typeof console.warn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('resolves a known id to its baked icon and name', () => {
    expect(wclProjections.windowSpells([SHADOW_BLADES], abilities)).toEqual([
      { id: SHADOW_BLADES, icon: 'ability_sb', name: 'Shadow Blades' },
    ]);
  });

  it('emits a labelled empty-icon placeholder for an unknown id without throwing', () => {
    expect(() => wclProjections.windowSpells([UNKNOWN_SPELL_ID], abilities)).not.toThrow();
    expect(wclProjections.windowSpells([UNKNOWN_SPELL_ID], abilities)).toEqual([
      { id: UNKNOWN_SPELL_ID, icon: '', name: `Ability #${UNKNOWN_SPELL_ID}` },
    ]);
  });

  it('falls back to the placeholder label when the map resolved the id but WCL left it unnamed', () => {
    // WCL declares every ability field nullable, so a bench can carry a resolved id whose name never arrived.
    const unnamed = { [SHADOW_BLADES]: { icon: 'ability_sb', name: null as unknown as string } };
    expect(wclProjections.windowSpells([SHADOW_BLADES], unnamed)).toEqual([
      { id: SHADOW_BLADES, icon: 'ability_sb', name: `Ability #${SHADOW_BLADES}` },
    ]);
  });

  it('warns with the missing id so a bug report can reproduce it', () => {
    wclProjections.windowSpells([UNKNOWN_SPELL_ID], abilities);
    // logWarn(context, id) lands as two console.warn args: '[warcraft-learner] <context>:', id.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('windowSpells'), UNKNOWN_SPELL_ID);
  });
});

describe('normalizeAbilityId', () => {
  it('maps the WCL melee event id (which gameData resolves to "Word of Recall (OLD)") to Auto Attack', () => {
    // Independent literals, not the SUT constants, so a drift in either wire value fails here.
    const WCL_MELEE_WIRE_ID = 1;
    const AUTO_ATTACK_GAME_SPELL_ID = 6603;
    expect(wclProjections.normalizeAbilityId(WCL_MELEE_WIRE_ID)).toBe(AUTO_ATTACK_GAME_SPELL_ID);
  });

  it('folds every negative (synthetic, sourceless) id onto the "I Don\'t Know" catch-all', () => {
    // -32 is the priest-log id that warned; any negative id WCL synthesizes maps the same way.
    const SHADOWFIEND_MELEE = -32;
    const ENVIRONMENTAL = -5;
    expect(wclProjections.normalizeAbilityId(SHADOWFIEND_MELEE)).toBe(WCL_SYNTHETIC_SOURCE_FALLBACK_ID);
    expect(wclProjections.normalizeAbilityId(ENVIRONMENTAL)).toBe(WCL_SYNTHETIC_SOURCE_FALLBACK_ID);
  });

  it('passes other ability ids through unchanged', () => {
    const SHADOW_BLADES = 121471;
    expect(wclProjections.normalizeAbilityId(SHADOW_BLADES)).toBe(SHADOW_BLADES);
  });
});
