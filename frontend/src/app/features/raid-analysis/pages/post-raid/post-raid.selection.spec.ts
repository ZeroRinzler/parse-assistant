import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PlayerDetailGroups, WclReport } from '../../../../core/wcl/wcl.models';
import { SelectionStore } from '../../../../core/state/selection-store';
import { wclReport } from '../../../../../testing/builders/wcl-fixtures';
import { PostRaid } from './post-raid';
import { mapFeatureStub } from '../../../../../testing/page-stubs';
import { MapFeatureService } from '../../map/facade/map-feature-service';
import { fight } from './post-raid-harness';
import { FIGHT_SELECT, PLAYER_SELECT, postRaidPage } from './post-raid-page';

const svc = Object.create(PostRaid.prototype) as PostRaid;

const REPORT_CODE = 'grBQ3vTHXAtPa4JK'; // a valid 16-character report code
const REPORT_URL = `https://www.warcraftlogs.com/reports/${REPORT_CODE}`;
const BOSS_ENCOUNTER_ID = 3176;

describe('PostRaid sticky player name', () => {
  const ABSENT_STICKY_NAME = 'Ghost';                                     // a sticky character absent from the loaded report
  const FALLBACK_PLAYER = { id: 1, name: 'Anya', spec: 'SubtletyRogue' }; // alphabetically first -> the auto-select fallback
  const PICKED_PLAYER = { id: 2, name: 'Bram', spec: 'FrostMage' };       // the player the user explicitly switches to

  const groups: PlayerDetailGroups = {
    dps: [
      { id: FALLBACK_PLAYER.id, type: 'Rogue', name: FALLBACK_PLAYER.name, specs: [{ spec: 'Subtlety' }] },
      { id: PICKED_PLAYER.id, type: 'Mage', name: PICKED_PLAYER.name, specs: [{ spec: 'Frost' }] },
    ],
  };

  function report(): WclReport {
    return wclReport({
      fights: [fight({
        id: 10, name: 'Boss', encounterID: BOSS_ENCOUNTER_ID, startTime: 0, endTime: 10_000, kill: true,
        friendlyPlayers: [FALLBACK_PLAYER.id, PICKED_PLAYER.id],
      })],
      actors: [FALLBACK_PLAYER, PICKED_PLAYER].map(p => ({ id: p.id, name: p.name, subType: p.spec, server: '' })),
    });
  }

  // The real store, after the harness fake so it wins: these tests assert on what the page persisted.
  const open = () => postRaidPage({
    getReport: () => Promise.resolve(report()),
    getReportFights: () => Promise.resolve(report().fights),
    getPlayerDetails: () => Promise.resolve(groups),
  }, [SelectionStore]);

  beforeEach(() => { localStorage.clear(); });

  it('keeps the sticky name when a loaded report auto-selects a fallback player instead', async () => {
    const page = open();
    const store = TestBed.inject(SelectionStore);
    store.savePostRaid({ playerName: ABSENT_STICKY_NAME });

    page.submitReport(REPORT_CODE);
    await page.settled();

    // The sticky character is absent, so the page auto-selects the alphabetical fallback...
    expect(page.chosen(PLAYER_SELECT)).toBe(FALLBACK_PLAYER.name);
    // ...but that automatic pick must not overwrite the sticky name the user chose earlier.
    expect(store.loadPostRaid()?.playerName).toBe(ABSENT_STICKY_NAME);
  });

  it('persists the player name when the user explicitly picks one', async () => {
    const page = open();
    const store = TestBed.inject(SelectionStore);
    store.savePostRaid({ playerName: ABSENT_STICKY_NAME });
    page.submitReport(REPORT_CODE);
    await page.settled();

    page.choose(PLAYER_SELECT, PICKED_PLAYER.name);
    await page.settled();

    expect(page.chosen(PLAYER_SELECT)).toBe(PICKED_PLAYER.name);
    expect(store.loadPostRaid()?.playerName).toBe(PICKED_PLAYER.name);
  });
});

describe('PostRaid fight selection from URL', () => {
  const EARLIER_FIGHT_ID = 10;
  const LATEST_FIGHT_ID = 12;
  // Distinct durations so each pull reads differently in the closed select.
  const EARLIER_LABEL = '0:10';
  const LATEST_LABEL = '0:20';
  const PLAYER = { id: 1, name: 'Anya', spec: 'SubtletyRogue' };

  const groups: PlayerDetailGroups = {
    dps: [{ id: PLAYER.id, type: 'Rogue', name: PLAYER.name, specs: [{ spec: 'Subtlety' }] }],
  };

  function report(): WclReport {
    return wclReport({
      fights: [
        fight({ id: EARLIER_FIGHT_ID, name: 'Boss', encounterID: BOSS_ENCOUNTER_ID, startTime: 0, endTime: 10_000, friendlyPlayers: [PLAYER.id] }),
        fight({ id: LATEST_FIGHT_ID, name: 'Boss', encounterID: BOSS_ENCOUNTER_ID, startTime: 20_000, endTime: 40_000, friendlyPlayers: [PLAYER.id] }),
      ],
      actors: [{ id: PLAYER.id, name: PLAYER.name, subType: PLAYER.spec, server: '' }],
    });
  }

  const open = () => postRaidPage({
    getReport: () => Promise.resolve(report()),
    getReportFights: () => Promise.resolve(report().fights),
    getPlayerDetails: () => Promise.resolve(groups),
  });

  it('selects the fight named in the pasted URL instead of the latest pull', async () => {
    const page = open();

    page.submitReport(`${REPORT_URL}#fight=${EARLIER_FIGHT_ID}`);
    await page.settled();

    expect(page.chosen(FIGHT_SELECT)).toContain(EARLIER_LABEL);
  });

  it('falls back to the latest pull when the URL names no fight', async () => {
    const page = open();

    page.submitReport(REPORT_URL);
    await page.settled();

    expect(page.chosen(FIGHT_SELECT)).toContain(LATEST_LABEL);
  });

  it('falls back to the latest pull when the URL names a fight not in the report', async () => {
    const page = open();

    page.submitReport(`${REPORT_URL}#fight=999`);
    await page.settled();

    expect(page.chosen(FIGHT_SELECT)).toContain(LATEST_LABEL);
  });
});

describe('PostRaid paste', () => {
  // Parks on the fetch: these tests assert what the paste handler reads, not what the load does with the report.
  function open() {
    const getReport = vi.fn(() => new Promise<WclReport>(() => undefined));
    return { getReport, page: postRaidPage({ getReport }) };
  }

  it('loads the pasted report in the same tick, with no deferral', () => {
    const { getReport, page } = open();

    page.paste(REPORT_URL);

    // No wait: the load reads the field before its first await, which is the whole point here.
    expect(getReport).toHaveBeenCalledWith(REPORT_CODE);
    expect(page.reportValue()).toBe(REPORT_URL);
  });

  it('inserts at the caret rather than replacing what the field already holds', () => {
    const { page } = open();
    const HEAD = 'https://www.warcraftlogs.com/reports/';

    page.paste(REPORT_CODE, { value: HEAD });

    expect(page.reportValue()).toBe(REPORT_URL);
  });

  it('replaces the selected range, so a select-all paste loads the new report', () => {
    const { getReport, page } = open();
    const STALE_URL = 'https://www.warcraftlogs.com/reports/aaaaaaaaaaaaaaaa';

    page.paste(REPORT_URL, { value: STALE_URL, start: 0, end: STALE_URL.length });

    expect(page.reportValue()).toBe(REPORT_URL);
    expect(getReport).toHaveBeenCalledWith(REPORT_CODE);
  });

  it('leaves a paste carrying no text to the browser', () => {
    const { getReport, page } = open();

    page.paste('', { value: REPORT_URL });

    expect(getReport).not.toHaveBeenCalled();
  });
});

describe('PostRaid keystone fight', () => {
  const RAID_MYTHIC_DIFFICULTY = 5;
  const MYTHIC_PLUS_DIFFICULTY = 10;
  const RAID_FIGHT = { id: 5, name: 'Vorasius', encounterID: BOSS_ENCOUNTER_ID, difficulty: RAID_MYTHIC_DIFFICULTY };
  const DUNGEON_FIGHT = { id: 2, name: 'Nexus-Point Xenas', encounterID: 112526, difficulty: MYTHIC_PLUS_DIFFICULTY };
  const PLAYER = { id: 1, name: 'Anya', spec: 'Rogue' };
  const KEYSTONE_NOTICE = svc['unsupportedEncounterNotice'](DUNGEON_FIGHT.name, DUNGEON_FIGHT.difficulty);

  const groups: PlayerDetailGroups = {
    dps: [{ id: PLAYER.id, type: 'Rogue', name: PLAYER.name, specs: [{ spec: 'Subtlety' }] }],
  };

  function mixedReport(): WclReport {
    return wclReport({
      fights: [
        fight({ ...DUNGEON_FIGHT, startTime: 0, endTime: 10_000, kill: true, friendlyPlayers: [PLAYER.id] }),
        fight({ ...RAID_FIGHT, startTime: 20_000, endTime: 30_000, kill: true, friendlyPlayers: [PLAYER.id] }),
      ],
      actors: [{ id: PLAYER.id, name: PLAYER.name, subType: PLAYER.spec, server: '' }],
    });
  }

  function open() {
    const getPlayerDetails = vi.fn(() => Promise.resolve(groups));
    const prepareMap = vi.fn(() => Promise.resolve());
    const page = postRaidPage(
      { getReport: () => Promise.resolve(mixedReport()), getPlayerDetails },
      [{ provide: MapFeatureService, useValue: mapFeatureStub({ prepare: prepareMap }) }],
    );
    return { getPlayerDetails, prepareMap, page };
  }

  it('lists the keystone pull but opens on the raid pull the report also holds', async () => {
    const { prepareMap, page } = open();

    page.submitReport(REPORT_CODE);
    await page.settled();

    expect(page.options(FIGHT_SELECT).join(' ')).toContain(DUNGEON_FIGHT.name);
    expect(page.chosen(FIGHT_SELECT)).toContain(RAID_FIGHT.name);
    expect(page.text()).not.toContain(KEYSTONE_NOTICE);
    expect(prepareMap).toHaveBeenCalled();
  });

  it('stops at the notice and fetches nothing when the keystone pull is selected', async () => {
    const { getPlayerDetails, prepareMap, page } = open();
    page.submitReport(REPORT_CODE);
    await page.settled();
    getPlayerDetails.mockClear();
    prepareMap.mockClear();

    page.choose(FIGHT_SELECT, DUNGEON_FIGHT.name);
    await page.settled();

    expect(page.text()).toContain(KEYSTONE_NOTICE);
    expect(getPlayerDetails).not.toHaveBeenCalled();
    expect(prepareMap).not.toHaveBeenCalled();
  });

  it('clears the notice when the selection moves back to the raid pull', async () => {
    const { page } = open();
    page.submitReport(REPORT_CODE);
    await page.settled();
    page.choose(FIGHT_SELECT, DUNGEON_FIGHT.name);
    await page.settled();
    expect(page.text()).toContain(KEYSTONE_NOTICE);

    page.choose(FIGHT_SELECT, RAID_FIGHT.name);
    await page.settled();

    expect(page.text()).not.toContain(KEYSTONE_NOTICE);
    expect(page.chosen(FIGHT_SELECT)).toContain(RAID_FIGHT.name);
  });
});
