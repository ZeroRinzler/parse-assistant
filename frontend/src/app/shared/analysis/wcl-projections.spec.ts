import { describe, it, expect } from 'vitest';
import { abilityIcons, toParseRankings, unwrapRankings } from './wcl-projections';

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
