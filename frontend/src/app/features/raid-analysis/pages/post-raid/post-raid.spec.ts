import { assert, describe, it, expect } from 'vitest';
import { PlayerDetailGroups, WclReport } from '../../../../core/wcl/wcl.models';
import { PostRaid } from './post-raid';
import { fight, player } from './post-raid-harness';

const svc = Object.create(PostRaid.prototype) as PostRaid;

describe('extractCode', () => {
  it('pulls the report code out of a WCL report URL', () => {
    expect(svc['extractCode']('https://www.warcraftlogs.com/reports/grBQ3vTHXAtPa4JK#fight=1')).toBe('grBQ3vTHXAtPa4JK');
  });

  it('passes a bare code through, trimmed', () => {
    expect(svc['extractCode']('  grBQ3vTHXAtPa4JK  ')).toBe('grBQ3vTHXAtPa4JK');
  });
});

describe('extractFightId', () => {
  it('pulls the fight id out of a WCL report URL fragment', () => {
    expect(svc['extractFightId']('https://www.warcraftlogs.com/reports/grBQ3vTHXAtPa4JK#fight=42')).toBe(42);
  });

  it('reads the fight id when other parameters follow it', () => {
    expect(svc['extractFightId']('https://www.warcraftlogs.com/reports/grBQ3vTHXAtPa4JK#fight=42&type=damage-done')).toBe(42);
  });

  it('returns null for the `last` keyword so the caller falls back to the latest pull', () => {
    expect(svc['extractFightId']('https://www.warcraftlogs.com/reports/grBQ3vTHXAtPa4JK#fight=last')).toBeNull();
  });

  it('returns null when the URL names no fight', () => {
    expect(svc['extractFightId']('https://www.warcraftlogs.com/reports/grBQ3vTHXAtPa4JK')).toBeNull();
    expect(svc['extractFightId']('grBQ3vTHXAtPa4JK')).toBeNull();
  });
});

describe('isValidReportCode', () => {
  it('accepts a 16-character alphanumeric report code', () => {
    expect(svc['isValidReportCode']('grBQ3vTHXAtPa4JK')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(svc['isValidReportCode']('')).toBe(false);
  });

  it('rejects arbitrary non-code text', () => {
    expect(svc['isValidReportCode']('hello')).toBe(false);
    expect(svc['isValidReportCode']('not a code at all')).toBe(false);
  });

  it('rejects a code of the wrong length', () => {
    expect(svc['isValidReportCode']('grBQ3vTHXAtPa4J')).toBe(false);  // 15 chars
    expect(svc['isValidReportCode']('grBQ3vTHXAtPa4JKK')).toBe(false); // 17 chars
  });

  it('rejects a 16-character string containing non-alphanumeric characters', () => {
    expect(svc['isValidReportCode']('grBQ3vTHXAtPa4J-')).toBe(false);
  });
});

describe('isUnsupportedDifficulty', () => {
  const MYTHIC_PLUS = 10;
  const RAID_MYTHIC = 5;
  const RAID_HEROIC = 4;
  const RAID_NORMAL = 3;

  it('reports a keystone dungeon boss', () => {
    expect(svc['isUnsupportedDifficulty'](MYTHIC_PLUS)).toBe(true);
  });

  it('reports the raid difficulties below Mythic', () => {
    expect(svc['isUnsupportedDifficulty'](RAID_HEROIC)).toBe(true);
    expect(svc['isUnsupportedDifficulty'](RAID_NORMAL)).toBe(true);
  });

  it('does not report a Mythic raid pull', () => {
    expect(svc['isUnsupportedDifficulty'](RAID_MYTHIC)).toBe(false);
  });

  it('does not report a fight WCL sent no difficulty for', () => {
    expect(svc['isUnsupportedDifficulty'](null)).toBe(false);
    expect(svc['isUnsupportedDifficulty'](undefined)).toBe(false);
  });
});

describe('unsupportedEncounterNotice', () => {
  const MYTHIC_PLUS = 10;
  const RAID_HEROIC = 4;
  const RAID_NORMAL = 3;
  const RAID_FINDER = 1;

  it('names a keystone boss and calls for a Mythic raid pull', () => {
    expect(svc['unsupportedEncounterNotice']('Nexus-Point Xenas', MYTHIC_PLUS))
      .toBe('Nexus-Point Xenas is a Mythic+ boss. Pick a Mythic raid pull.');
  });

  it('names the raid difficulty of a Heroic or Normal pull', () => {
    expect(svc['unsupportedEncounterNotice']('Vorasius', RAID_HEROIC)).toBe('Vorasius is a Heroic pull. Pick a Mythic pull.');
    expect(svc['unsupportedEncounterNotice']('Vorasius', RAID_NORMAL)).toBe('Vorasius is a Normal pull. Pick a Mythic pull.');
  });

  it('falls back to a plain non-Mythic message for an unnamed difficulty', () => {
    expect(svc['unsupportedEncounterNotice']('Vorasius', RAID_FINDER)).toBe('Vorasius was not pulled on Mythic. Pick a Mythic pull.');
  });
});

describe('buildFights', () => {
  it('drops trash fights, orders by start time, and numbers attempts per boss', () => {
    const fights = svc['buildFights']([
      fight({ id: 3, encounterID: 200, startTime: 3000, endTime: 3000 }),
      fight({ id: 1, encounterID: 100, startTime: 1000, endTime: 1000 }),
      fight({ id: 2, encounterID: 100, startTime: 2000, endTime: 2000 }),
      fight({ id: 9, encounterID: 0, startTime: 500, endTime: 600 }), // trash, filtered
    ]);
    expect(fights.map(f => f.id)).toEqual([1, 2, 3]);
    expect(fights.map(f => f.attempt)).toEqual([1, 2, 1]); // boss 100: #1, #2; boss 200: #1
  });

  it('derives a one-decimal duration in seconds from the millisecond span', () => {
    // 94_567 ms -> 945.67 -> round 946 -> 94.6: a non-round span so the rounding step is exercised.
    const [f] = svc['buildFights']([fight({ id: 1, encounterID: 100, startTime: 1000, endTime: 95_567 })]);
    assert.exists(f);
    expect(f.duration_s).toBe(94.6);
  });

  it('handles a missing/undefined fight list', () => {
    expect(svc['buildFights'](undefined)).toEqual([]);
    expect(svc['buildFights']([])).toEqual([]);
  });
});

describe('buildPlayers', () => {
  const actors = (a: NonNullable<WclReport['masterData']>['actors']) => svc['buildPlayers'](a);

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
    expect(svc['buildPlayers'](undefined)).toEqual([]);
  });
});

describe('visiblePlayersOf', () => {
  const players = [player({ id: 1, name: 'A' }), player({ id: 2, name: 'B' }), player({ id: 3, name: 'C' })];

  it('restricts to the fight\'s friendly participants when listed', () => {
    const fights = [fight({ id: 10, friendlyPlayers: [1, 3] })];
    expect(svc['visiblePlayersOf'](fights, players, 10).map(p => p.id)).toEqual([1, 3]);
  });

  it('shows everyone when the fight lists no friendly participants', () => {
    const fights = [fight({ id: 10, friendlyPlayers: [] })];
    expect(svc['visiblePlayersOf'](fights, players, 10)).toHaveLength(3);
  });

  it('shows everyone when the selected fight is unknown', () => {
    expect(svc['visiblePlayersOf']([], players, 99)).toHaveLength(3);
  });
});

describe('livePollActionOf', () => {
  const pulls = [fight({ id: 1, encounterID: 100 }), fight({ id: 2, encounterID: 100 })];
  const LATEST_PULL_ID = 2;
  const EARLIER_PULL_ID = 1;

  it('returns none when the report has no boss pulls', () => {
    expect(svc['livePollActionOf']([], LATEST_PULL_ID, true)).toBe('none');
  });

  it('skips when the latest pull is already the analyzed selection', () => {
    expect(svc['livePollActionOf'](pulls, LATEST_PULL_ID, true)).toBe('skip');
  });

  it('analyzes when a pull newer than the selection appears', () => {
    expect(svc['livePollActionOf'](pulls, EARLIER_PULL_ID, true)).toBe('analyze');
  });

  it('analyzes when the selected latest pull has not finished analyzing', () => {
    expect(svc['livePollActionOf'](pulls, LATEST_PULL_ID, false)).toBe('analyze');
  });

  it('analyzes when nothing is selected yet', () => {
    expect(svc['livePollActionOf'](pulls, null, false)).toBe('analyze');
  });
});

describe('pickLivePlayerId', () => {
  const players = [player({ id: 1, name: 'Anya' }), player({ id: 2, name: 'Bram' }), player({ id: 3, name: 'Cera' })];

  it('keeps the currently selected player when they appear in the new pull', () => {
    expect(svc['pickLivePlayerId'](players, 'Bram')).toBe(2);
  });

  it('matches the current player name case-insensitively', () => {
    expect(svc['pickLivePlayerId'](players, 'bram')).toBe(2);
  });

  it('falls back to the first visible player when the selected player is absent', () => {
    const newPlayers = [player({ id: 2, name: 'Bram' }), player({ id: 3, name: 'Cera' })];
    expect(svc['pickLivePlayerId'](newPlayers, 'Anya')).toBe(2);
  });

  it('falls back to the first visible player when currentPlayerName is null', () => {
    expect(svc['pickLivePlayerId'](players, null)).toBe(1);
  });

  it('returns null when there is nobody to pick', () => {
    expect(svc['pickLivePlayerId']([], 'Anya')).toBeNull();
  });
});

describe('specOf', () => {
  it('builds <spec><class> with spaces removed, for the dps role', () => {
    const groups: PlayerDetailGroups = {
      dps: [{ id: 1, type: 'Rogue', name: 'Zug', specs: [{ spec: 'Subtlety' }] }],
    };
    expect(svc['specOf'](groups, 1)).toBe('SubtletyRogue');
  });

  it('searches all roles: dps, healers, tanks', () => {
    const groups: PlayerDetailGroups = {
      dps:     [{ id: 1, type: 'Rogue',   name: 'A', specs: [{ spec: 'Subtlety' }] }],
      healers: [{ id: 2, type: 'Paladin', name: 'B', specs: [{ spec: 'Holy'     }] }],
      tanks:   [{ id: 3, type: 'Warrior', name: 'C', specs: [{ spec: 'Protection' }] }],
    };
    expect(svc['specOf'](groups, 2)).toBe('HolyPaladin');
    expect(svc['specOf'](groups, 3)).toBe('ProtectionWarrior');
  });

  it('removes spaces from the class name ("Death Knight" -> "DeathKnight")', () => {
    const groups: PlayerDetailGroups = {
      dps: [{ id: 4, type: 'Death Knight', name: 'X', specs: [{ spec: 'Frost' }] }],
    };
    expect(svc['specOf'](groups, 4)).toBe('FrostDeathKnight');
  });

  it('returns "" when the player has no spec', () => {
    const groups: PlayerDetailGroups = { dps: [{ id: 5, type: 'Rogue', name: 'Y', specs: [] }] };
    expect(svc['specOf'](groups, 5)).toBe('');
  });

  it('returns "" when the class type is missing', () => {
    const groups: PlayerDetailGroups = { dps: [{ id: 6, type: '', name: 'Z', specs: [{ spec: 'Fury' }] }] };
    expect(svc['specOf'](groups, 6)).toBe('');
  });

  it('returns "" when the player id is not present', () => {
    expect(svc['specOf']({}, 99)).toBe('');
  });
});
