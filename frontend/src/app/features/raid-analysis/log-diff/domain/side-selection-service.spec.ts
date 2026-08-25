import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclFight, WclPlayer } from '../../../../core/wcl/wcl.models';
import { SideSelectionService } from './side-selection-service';

const sel = TestBed.inject(SideSelectionService);

const TRASH_ENCOUNTER_ID = 0;
const BOSS_ENCOUNTER_ID = 3183;

function rawFight(over: Partial<WclFight & { id: number }> = {}): WclFight {
  return {
    id: 1, name: 'Boss', startTime: 0, endTime: 10_000, kill: false,
    encounterID: BOSS_ENCOUNTER_ID, attempt: 0, duration_s: 0, friendlyPlayers: [], fightPercentage: 0,
    ...over,
  };
}

describe('SideSelectionService.buildFights', () => {
  it('drops trash segments (encounterID 0) and numbers repeat attempts on the same boss', () => {
    const fights = sel.buildFights([
      rawFight({ id: 1, startTime: 0, encounterID: TRASH_ENCOUNTER_ID }),
      rawFight({ id: 2, startTime: 1000, encounterID: BOSS_ENCOUNTER_ID }),
      rawFight({ id: 3, startTime: 2000, encounterID: BOSS_ENCOUNTER_ID }),
    ]);
    expect(fights.map(f => f.id)).toEqual([2, 3]);
    expect(fights.map(f => f.attempt)).toEqual([1, 2]);
  });

  it('sorts oldest pull first regardless of input order', () => {
    const fights = sel.buildFights([rawFight({ id: 2, startTime: 2000 }), rawFight({ id: 1, startTime: 1000 })]);
    expect(fights.map(f => f.id)).toEqual([1, 2]);
  });
});

describe('SideSelectionService.buildPlayers', () => {
  it('sorts alphabetically and falls back to Unknown for a blank class', () => {
    const players = sel.buildPlayers([
      { id: 2, name: 'Zed', subType: 'Rogue', server: 'eu' },
      { id: 1, name: 'Ana', subType: '', server: 'eu' },
    ]);
    expect(players).toEqual([
      { id: 1, name: 'Ana', spec: 'Unknown', server: 'eu' },
      { id: 2, name: 'Zed', spec: 'Rogue', server: 'eu' },
    ]);
  });
});

describe('SideSelectionService.visiblePlayers', () => {
  const roster: WclPlayer[] = [{ id: 1, name: 'A', spec: 'Rogue', server: '' }, { id: 2, name: 'B', spec: 'Priest', server: '' }];

  it('narrows to the pull\'s friendlyPlayers when present', () => {
    expect(sel.visiblePlayers(roster, rawFight({ friendlyPlayers: [2] }))).toEqual([roster[1]]);
  });

  it('falls back to the full roster when friendlyPlayers is empty', () => {
    expect(sel.visiblePlayers(roster, rawFight({ friendlyPlayers: [] }))).toEqual(roster);
  });

  it('falls back to the full roster when no fight is selected', () => {
    expect(sel.visiblePlayers(roster, undefined)).toEqual(roster);
  });
});

describe('SideSelectionService.targetFightId', () => {
  const fights = [rawFight({ id: 1 }), rawFight({ id: 2 })];

  it('resolves a requested numeric id present in the list', () => {
    expect(sel.targetFightId(fights, 1)).toBe(1);
  });

  it('falls back to the last pull when the requested id is not in the list', () => {
    expect(sel.targetFightId(fights, 99)).toBe(2);
  });

  it('falls back to the last pull for a literal "last"', () => {
    expect(sel.targetFightId(fights, 'last')).toBe(2);
  });

  it('falls back to the last pull when nothing was requested', () => {
    expect(sel.targetFightId(fights, null)).toBe(2);
  });
});

describe('SideSelectionService.targetPlayerId', () => {
  const players: WclPlayer[] = [{ id: 5, name: 'A', spec: 'Rogue', server: '' }, { id: 6, name: 'B', spec: 'Priest', server: '' }];

  it('picks the requested source id when it is a visible player', () => {
    expect(sel.targetPlayerId(players, 6)).toBe(6);
  });

  it('falls back to the first visible player when the requested id is not visible', () => {
    expect(sel.targetPlayerId(players, 999)).toBe(5);
  });

  it('falls back to the first visible player when nothing was requested', () => {
    expect(sel.targetPlayerId(players, null)).toBe(5);
  });
});
