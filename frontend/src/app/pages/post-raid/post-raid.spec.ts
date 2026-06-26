import { describe, it, expect } from 'vitest';
import { PlayerDetailGroups } from '../../core/models/wcl.models';
import { specOf } from './post-raid';

describe('specOf', () => {
  it('builds <spec><class> with spaces removed, for the dps role', () => {
    const groups: PlayerDetailGroups = {
      dps: [{ id: 1, type: 'Rogue', name: 'Zug', specs: [{ spec: 'Subtlety' }] }],
    };
    expect(specOf(groups, 1)).toBe('SubtletyRogue');
  });

  it('searches all roles: dps, healers, tanks', () => {
    const groups: PlayerDetailGroups = {
      dps:     [{ id: 1, type: 'Rogue',   name: 'A', specs: [{ spec: 'Subtlety' }] }],
      healers: [{ id: 2, type: 'Paladin', name: 'B', specs: [{ spec: 'Holy'     }] }],
      tanks:   [{ id: 3, type: 'Warrior', name: 'C', specs: [{ spec: 'Protection' }] }],
    };
    expect(specOf(groups, 2)).toBe('HolyPaladin');
    expect(specOf(groups, 3)).toBe('ProtectionWarrior');
  });

  it('removes spaces from the class name ("Death Knight" -> "DeathKnight")', () => {
    const groups: PlayerDetailGroups = {
      dps: [{ id: 4, type: 'Death Knight', name: 'X', specs: [{ spec: 'Frost' }] }],
    };
    expect(specOf(groups, 4)).toBe('FrostDeathKnight');
  });

  it('returns "" when the player has no spec', () => {
    const groups: PlayerDetailGroups = { dps: [{ id: 5, type: 'Rogue', name: 'Y', specs: [] }] };
    expect(specOf(groups, 5)).toBe('');
  });

  it('returns "" when the class type is missing', () => {
    const groups: PlayerDetailGroups = { dps: [{ id: 6, type: '', name: 'Z', specs: [{ spec: 'Fury' }] }] };
    expect(specOf(groups, 6)).toBe('');
  });

  it('returns "" when the player id is not present', () => {
    expect(specOf({}, 99)).toBe('');
  });
});
