import { describe, it, expect } from 'vitest';
import { rulebookSpellIds, unresolvedSpellIds } from './rulebook-spell-ids.ts';
import type { Rulebook } from '../../src/app/core/models/rulebook.models.ts';
import type { WclRawAbility } from '../../src/app/core/models/wcl.models.ts';
import {
  SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, CLOAK_OF_SHADOWS,
} from '../../src/testing/spell-ids.ts';

/** The sentinel id the schema/collection treats as "no id" (filtered out, `id > 0`). */
const PLACEHOLDER_ID = 0;

const ability = (id: number): WclRawAbility => ({ id, name: `Spell ${id}`, icon: 'x.jpg' });
const resolvedMap = (...ids: number[]): Record<string, WclRawAbility | null> =>
  Object.fromEntries(ids.map(id => [`a${id}`, ability(id)]));

describe('rulebookSpellIds', () => {
  it('collects cooldown, defensive, and both rule-condition spell ids', () => {
    const rulebook: Rulebook = {
      spec: 'SubtletyRogue',
      major_cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }],
      defensives: [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120 }],
      rules: [
        {
          condition: {
            kind: 'cast_without_prior',
            spell_id: SHADOW_DANCE, spell_name: 'Shadow Dance',
            required_spell_id: SECRET_TECHNIQUE, required_spell_name: 'Secret Technique', window_s: 5,
            exception: { context_spell_id: SHADOW_BLADES, context_window_s: 20, position: 'before' },
          },
        },
        {
          condition: {
            kind: 'hold_cooldown_for_anchor',
            spell_ids: [SHADOW_DANCE, SECRET_TECHNIQUE], spell_names: ['Shadow Dance', 'Secret Technique'],
            anchor_spell_id: SHADOW_BLADES, anchor_spell_name: 'Shadow Blades', hold_window_s: 15,
          },
        },
      ],
    };
    // Distinct ids across every source, ascending.
    const expected = [CLOAK_OF_SHADOWS, SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE].sort((a, b) => a - b);
    expect(rulebookSpellIds(rulebook).sort((a, b) => a - b)).toEqual(expected);
  });

  it('drops the zero placeholder id and de-duplicates across sources', () => {
    const rulebook: Rulebook = {
      spec: 'SubtletyRogue',
      major_cooldowns: [
        { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 },
        { name: 'No id', spell_id: PLACEHOLDER_ID, cooldown: 90 },
      ],
      defensives: [{ name: 'Also Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }],
    };
    expect(rulebookSpellIds(rulebook)).toEqual([SHADOW_BLADES]);
  });

  it('returns an empty list for a rulebook with no ids', () => {
    expect(rulebookSpellIds({ spec: 'SubtletyRogue' })).toEqual([]);
  });

  it('ignores rules whose condition is null (display-only)', () => {
    const rulebook: Rulebook = { spec: 'SubtletyRogue', rules: [{ condition: null }, { description: 'no condition' }] };
    expect(rulebookSpellIds(rulebook)).toEqual([]);
  });
});

describe('unresolvedSpellIds', () => {
  // Two ids WCL resolves, one it maps to null, one it omits entirely.
  const RESOLVED = SHADOW_BLADES;
  const ALSO_RESOLVED = SECRET_TECHNIQUE;
  const NULLED = CLOAK_OF_SHADOWS;   // present in the map but null
  const ABSENT = SHADOW_DANCE;       // not in the map at all

  it('returns ids WCL resolved to null or omitted, ascending', () => {
    const resolved: Record<string, WclRawAbility | null> = { ...resolvedMap(RESOLVED, ALSO_RESOLVED), [`a${NULLED}`]: null };
    const unresolvedAscending = [NULLED, ABSENT].sort((a, b) => a - b);
    expect(unresolvedSpellIds([ALSO_RESOLVED, NULLED, RESOLVED, ABSENT], resolved)).toEqual(unresolvedAscending);
  });

  it('returns an empty list when every id resolves', () => {
    expect(unresolvedSpellIds([RESOLVED, ALSO_RESOLVED], resolvedMap(RESOLVED, ALSO_RESOLVED))).toEqual([]);
  });

  it('treats an empty resolved map as everything unresolved', () => {
    const bothAscending = [RESOLVED, ALSO_RESOLVED].sort((a, b) => a - b);
    expect(unresolvedSpellIds([RESOLVED, ALSO_RESOLVED], {})).toEqual(bothAscending);
  });
});
