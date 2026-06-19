import { describe, it, expect } from 'vitest';
import { extractCode, buildFights, buildPlayers, visiblePlayersOf, pickPlayerId, pickLivePlayerId } from './post-raid.vm';
import { WclFight, WclPlayer, WclReport, WclUserCharacter } from '../../core/models/wcl.models';

function fight(p: Partial<WclFight>): WclFight {
  return { id: 0, name: '', startTime: 0, endTime: 0, kill: false, encounterID: 0, attempt: 0, duration_s: 0, friendlyPlayers: [], ...p };
}
function player(p: Partial<WclPlayer>): WclPlayer {
  return { id: 0, name: '', spec: '', server: '', ...p };
}
function userChar(name: string): WclUserCharacter {
  return { id: 1, name, serverSlug: 'area-52', serverRegion: 'us' };
}

describe('extractCode', () => {
  it('pulls the report code out of a WCL report URL', () => {
    expect(extractCode('https://www.warcraftlogs.com/reports/grBQ3vTHXAtPa4JK#fight=1')).toBe('grBQ3vTHXAtPa4JK');
  });

  it('passes a bare code through, trimmed', () => {
    expect(extractCode('  grBQ3vTHXAtPa4JK  ')).toBe('grBQ3vTHXAtPa4JK');
  });
});

describe('buildFights', () => {
  it('drops trash fights, orders by start time, and numbers attempts per boss', () => {
    const fights = buildFights([
      fight({ id: 3, encounterID: 200, startTime: 3000, endTime: 3000 }),
      fight({ id: 1, encounterID: 100, startTime: 1000, endTime: 1000 }),
      fight({ id: 2, encounterID: 100, startTime: 2000, endTime: 2000 }),
      fight({ id: 9, encounterID: 0, startTime: 500, endTime: 600 }), // trash, filtered
    ]);
    expect(fights.map(f => f.id)).toEqual([1, 2, 3]);
    expect(fights.map(f => f.attempt)).toEqual([1, 2, 1]); // boss 100: #1, #2; boss 200: #1
  });

  it('derives a one-decimal duration in seconds from the millisecond span', () => {
    const [f] = buildFights([fight({ id: 1, encounterID: 100, startTime: 1000, endTime: 95500 })]);
    expect(f.duration_s).toBe(94.5);
  });

  it('handles a missing/undefined fight list', () => {
    expect(buildFights(undefined)).toEqual([]);
    expect(buildFights([])).toEqual([]);
  });
});

describe('buildPlayers', () => {
  const actors = (a: WclReport['masterData']['actors']) => buildPlayers(a);

  it('maps actors to players, defaults an unknown spec, and sorts by name', () => {
    const players = actors([
      { id: 2, name: 'Zera', subType: 'SubtletyRogue', server: 'Area-52' },
      { id: 1, name: 'Anya', subType: '', server: '' },
    ]);
    expect(players).toEqual([
      { id: 1, name: 'Anya', spec: 'Unknown', server: '' },
      { id: 2, name: 'Zera', spec: 'SubtletyRogue', server: 'Area-52' },
    ]);
  });

  it('handles a missing actor list', () => {
    expect(buildPlayers(undefined)).toEqual([]);
  });
});

describe('visiblePlayersOf', () => {
  const players = [player({ id: 1, name: 'A' }), player({ id: 2, name: 'B' }), player({ id: 3, name: 'C' })];

  it('restricts to the fight\'s friendly participants when listed', () => {
    const fights = [fight({ id: 10, friendlyPlayers: [1, 3] })];
    expect(visiblePlayersOf(fights, players, 10).map(p => p.id)).toEqual([1, 3]);
  });

  it('shows everyone when the fight lists no friendly participants', () => {
    const fights = [fight({ id: 10, friendlyPlayers: [] })];
    expect(visiblePlayersOf(fights, players, 10)).toHaveLength(3);
  });

  it('shows everyone when the selected fight is unknown', () => {
    expect(visiblePlayersOf([], players, 99)).toHaveLength(3);
  });
});

describe('pickPlayerId', () => {
  const players = [player({ id: 1, name: 'Anya' }), player({ id: 2, name: 'Bram' })];

  it('prefers the logged-in user\'s character over a URL choice', () => {
    expect(pickPlayerId(players, [userChar('Bram')], 1)).toBe(2);
  });

  it('matches the user character case-insensitively', () => {
    expect(pickPlayerId(players, [userChar('bram')], null)).toBe(2);
  });

  it('honors an explicit auto-player when no user character is present', () => {
    expect(pickPlayerId(players, [], 1)).toBe(1);
  });

  it('falls back to the first visible player', () => {
    expect(pickPlayerId(players, [userChar('Nobody')], null)).toBe(1);
  });

  it('returns null when there is nobody to pick', () => {
    expect(pickPlayerId([], [], null)).toBeNull();
  });
});

describe('pickLivePlayerId', () => {
  const players = [player({ id: 1, name: 'Anya' }), player({ id: 2, name: 'Bram' }), player({ id: 3, name: 'Cera' })];

  it('keeps the currently selected player when they appear in the new pull', () => {
    expect(pickLivePlayerId(players, 'Bram', [])).toBe(2);
  });

  it('matches the current player name case-insensitively', () => {
    expect(pickLivePlayerId(players, 'bram', [])).toBe(2);
  });

  it('falls back to the logged-in user character when the selected player is absent', () => {
    const newPlayers = [player({ id: 2, name: 'Bram' }), player({ id: 3, name: 'Cera' })];
    expect(pickLivePlayerId(newPlayers, 'Anya', [userChar('Cera')])).toBe(3);
  });

  it('falls back to first visible player when neither sticky nor user char matches', () => {
    expect(pickLivePlayerId(players, 'Nobody', [userChar('Ghost')])).toBe(1);
  });

  it('falls back through pickPlayerId when currentPlayerName is null', () => {
    expect(pickLivePlayerId(players, null, [userChar('Cera')])).toBe(3);
  });
});
