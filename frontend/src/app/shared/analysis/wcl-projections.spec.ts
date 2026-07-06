import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import {
  abilityIcons, normalizeAbilityId, toParseRankings, unwrapRankings, windowSpells,
  WCL_MELEE_EVENT_ABILITY_ID, WOW_AUTO_ATTACK_SPELL_ID,
} from './wcl-projections';

// A raw ranking row as WCL surfaces it in the characterRankings blob.
const rankingRow = (name: string, code: string, fightID: number) => ({ name, report: { code, fightID } });

describe('unwrapRankings', () => {
  it('parses the JSON blob string form and returns its rankings', () => {
    const blob = JSON.stringify({ rankings: [rankingRow('Keep', 'r1', 3)] });
    expect(unwrapRankings(blob)).toEqual([rankingRow('Keep', 'r1', 3)]);
  });

  it('reads the already-parsed object form directly', () => {
    expect(unwrapRankings({ rankings: [rankingRow('Keep', 'r1', 3)] })).toEqual([rankingRow('Keep', 'r1', 3)]);
  });

  it('returns [] for a null / empty blob or a blob with no rankings key', () => {
    expect(unwrapRankings(null)).toEqual([]);
    expect(unwrapRankings(undefined)).toEqual([]);
    expect(unwrapRankings('')).toEqual([]);
    expect(unwrapRankings({})).toEqual([]);
  });

  it('composes with toParseRankings to yield fetchable parses', () => {
    const blob = JSON.stringify({ rankings: [rankingRow('Keep', 'r1', 3)] });
    expect(toParseRankings(unwrapRankings(blob), 10)).toEqual([{ player: 'Keep', report_code: 'r1', fight_id: 3 }]);
  });
});

describe('toParseRankings', () => {
  it('maps raw rankings to fetchable parses and caps at count', () => {
    const raw = [rankingRow('P1', 'r1', 1), rankingRow('P2', 'r2', 2), rankingRow('P3', 'r3', 3)];
    expect(toParseRankings(raw, 2)).toEqual([
      { player: 'P1', report_code: 'r1', fight_id: 1 },
      { player: 'P2', report_code: 'r2', fight_id: 2 },
    ]);
  });

  it('drops anonymized "Character <id>-<id>" names and rows without a report code', () => {
    const raw = [
      rankingRow('Character 123-456', 'r1', 1), // privacy-anonymized parse
      { name: 'NoReport', report: { fightID: 2 } }, // report code missing -> unfetchable
      rankingRow('Keep', 'r3', 3),
    ];
    expect(toParseRankings(raw, 10)).toEqual([{ player: 'Keep', report_code: 'r3', fight_id: 3 }]);
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
    expect(abilityIcons(raw)).toEqual({
      [SHADOW_BLADES]: { icon: 'ability_sb', name: 'Shadow Blades' },
      [CLOAK]: { icon: 'spell_cloak', name: 'Cloak of Shadows' },
    });
  });

  it('skips null entries (ids WCL could not resolve) and returns {} for an empty map', () => {
    const raw = { [`a${SHADOW_BLADES}`]: null };
    expect(abilityIcons(raw)).toEqual({});
    expect(abilityIcons({})).toEqual({});
  });

  it('leaves an icon with no .jpg extension untouched', () => {
    const raw = { [`a${SHADOW_BLADES}`]: { id: SHADOW_BLADES, name: 'Shadow Blades', icon: 'ability_sb' } };
    expect(abilityIcons(raw)).toEqual({ [SHADOW_BLADES]: { icon: 'ability_sb', name: 'Shadow Blades' } });
  });

});

describe('windowSpells', () => {
  const SHADOW_BLADES = 121471;
  const UNKNOWN_SPELL_ID = 999999; // an id the ability map never resolved
  const abilities = { [SHADOW_BLADES]: { icon: 'ability_sb', name: 'Shadow Blades' } };

  // A missing id is reported via logWarn -> console.warn; the spy keeps the runner
  // output clean and lets the missing-id test assert on the warning.
  let warnSpy: MockInstance<typeof console.warn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('resolves a known id to its baked icon and name', () => {
    expect(windowSpells([SHADOW_BLADES], abilities)).toEqual([
      { id: SHADOW_BLADES, icon: 'ability_sb', name: 'Shadow Blades' },
    ]);
  });

  it('emits a labelled empty-icon placeholder for an unknown id without throwing', () => {
    expect(() => windowSpells([UNKNOWN_SPELL_ID], abilities)).not.toThrow();
    expect(windowSpells([UNKNOWN_SPELL_ID], abilities)).toEqual([
      { id: UNKNOWN_SPELL_ID, icon: '', name: `Ability #${UNKNOWN_SPELL_ID}` },
    ]);
  });

  it('warns with the missing id so a bug report can reproduce it', () => {
    windowSpells([UNKNOWN_SPELL_ID], abilities);
    // logWarn(context, id) lands as two console.warn args: '[warcraft-learner] <context>:', id.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('windowSpells'), UNKNOWN_SPELL_ID);
  });
});

describe('normalizeAbilityId', () => {
  it('maps the WCL melee event id (which gameData resolves to "Word of Recall (OLD)") to Auto Attack', () => {
    expect(normalizeAbilityId(WCL_MELEE_EVENT_ABILITY_ID)).toBe(WOW_AUTO_ATTACK_SPELL_ID);
  });

  it('passes other ability ids through unchanged', () => {
    const SHADOW_BLADES = 121471;
    expect(normalizeAbilityId(SHADOW_BLADES)).toBe(SHADOW_BLADES);
  });
});
