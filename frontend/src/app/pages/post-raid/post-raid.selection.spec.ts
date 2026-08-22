import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FormControl } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { PlayerDetailGroups, WclFight, WclReport } from '../../core/models/wcl.models';
import { SelectionStore } from '../../core/services/selection-store';
import { wclReport } from '../../../testing/builders/wcl-fixtures';
import { PostRaidComponent, unsupportedEncounterNotice } from './post-raid';
import { fight, loadReport, postRaidProviders } from './post-raid-harness';

describe('PostRaidComponent sticky player name', () => {
  const REPORT_CODE = 'grBQ3vTHXAtPa4JK';                         // a valid 16-character report code
  const BOSS_ENCOUNTER_ID = 3176;
  const ABSENT_STICKY_NAME = 'Ghost';                            // a sticky character not present in the loaded report
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

  function mount(): { component: PostRaidComponent & Record<string, unknown>; store: SelectionStore } {
    const wclApi = {
      getReport: () => Promise.resolve(report()),
      getReportFights: () => Promise.resolve(report().fights),
      getPlayerDetails: () => Promise.resolve(groups),
    };
    TestBed.configureTestingModule({
      // The real store, last so it wins over the harness fake: these tests assert on what the page persisted.
      providers: [...postRaidProviders(wclApi), SelectionStore],
    });
    return {
      component: TestBed.inject(PostRaidComponent) as PostRaidComponent & Record<string, unknown>,
      store: TestBed.inject(SelectionStore),
    };
  }

  beforeEach(() => { localStorage.clear(); });

  it('keeps the sticky name when a loaded report auto-selects a fallback player instead', async () => {
    const { component, store } = mount();
    store.savePostRaid({ playerName: ABSENT_STICKY_NAME });

    await loadReport(component, REPORT_CODE);

    // The sticky character is absent, so the page auto-selects the alphabetical fallback...
    expect((component['selectedPlayerId'] as () => number | null)()).toBe(FALLBACK_PLAYER.id);
    // ...but that automatic pick must not overwrite the sticky name the user chose earlier.
    expect(store.loadPostRaid()?.playerName).toBe(ABSENT_STICKY_NAME);
  });

  it('persists the player name when the user explicitly picks one', async () => {
    const { component, store } = mount();
    store.savePostRaid({ playerName: ABSENT_STICKY_NAME });
    await loadReport(component, REPORT_CODE);

    (component['playerControl']).setValue(PICKED_PLAYER.id);
    await (component['onPlayerChange'])();

    expect(store.loadPostRaid()?.playerName).toBe(PICKED_PLAYER.name);
  });
});

describe('PostRaidComponent fight selection from URL', () => {
  const REPORT_CODE = 'grBQ3vTHXAtPa4JK';
  const BOSS_ENCOUNTER_ID = 3176;
  const EARLIER_FIGHT_ID = 10;
  const LATEST_FIGHT_ID = 12;
  const PLAYER = { id: 1, name: 'Anya', spec: 'SubtletyRogue' };

  const groups: PlayerDetailGroups = {
    dps: [{ id: PLAYER.id, type: 'Rogue', name: PLAYER.name, specs: [{ spec: 'Subtlety' }] }],
  };

  function report(): WclReport {
    return wclReport({
      fights: [
        fight({ id: EARLIER_FIGHT_ID, name: 'Boss', encounterID: BOSS_ENCOUNTER_ID, startTime: 0, endTime: 10_000, friendlyPlayers: [PLAYER.id] }),
        fight({ id: LATEST_FIGHT_ID, name: 'Boss', encounterID: BOSS_ENCOUNTER_ID, startTime: 20_000, endTime: 30_000, friendlyPlayers: [PLAYER.id] }),
      ],
      actors: [{ id: PLAYER.id, name: PLAYER.name, subType: PLAYER.spec, server: '' }],
    });
  }

  function mount(): PostRaidComponent & Record<string, unknown> {
    const wclApi = {
      getReport: () => Promise.resolve(report()),
      getReportFights: () => Promise.resolve(report().fights),
      getPlayerDetails: () => Promise.resolve(groups),
    };
    TestBed.configureTestingModule({ providers: [...postRaidProviders(wclApi)] });
    return TestBed.inject(PostRaidComponent) as PostRaidComponent & Record<string, unknown>;
  }

  it('selects the fight named in the pasted URL instead of the latest pull', async () => {
    const component = mount();
    await loadReport(component, `https://www.warcraftlogs.com/reports/${REPORT_CODE}#fight=${EARLIER_FIGHT_ID}`);
    expect((component['selectedFightId'] as () => number | null)()).toBe(EARLIER_FIGHT_ID);
  });

  it('falls back to the latest pull when the URL names no fight', async () => {
    const component = mount();
    await loadReport(component, `https://www.warcraftlogs.com/reports/${REPORT_CODE}`);
    expect((component['selectedFightId'] as () => number | null)()).toBe(LATEST_FIGHT_ID);
  });

  it('falls back to the latest pull when the URL names a fight not in the report', async () => {
    const component = mount();
    await loadReport(component, `https://www.warcraftlogs.com/reports/${REPORT_CODE}#fight=999`);
    expect((component['selectedFightId'] as () => number | null)()).toBe(LATEST_FIGHT_ID);
  });
});

describe('PostRaidComponent paste', () => {
  const REPORT_CODE = 'grBQ3vTHXAtPa4JK';
  const PASTED_URL = `https://www.warcraftlogs.com/reports/${REPORT_CODE}`;

  interface PasteHandle {
    reportControl: FormControl<string>;
    onPaste: (event: ClipboardEvent, input: HTMLInputElement) => void;
  }

  function setup(): { getReport: ReturnType<typeof vi.fn>; vm: PasteHandle } {
    // Parks on the fetch: these tests assert what loadReport reads, not what it does with the report.
    const getReport = vi.fn(() => new Promise<WclReport>(() => undefined));
    TestBed.configureTestingModule({
      providers: [...postRaidProviders({ getReport })],
    });
    return { getReport, vm: TestBed.inject(PostRaidComponent) as unknown as PasteHandle };
  }

  function paste(vm: PasteHandle, text: string, value = '', start = value.length, end = start): void {
    const input = { value, selectionStart: start, selectionEnd: end } as HTMLInputElement;
    const event = { clipboardData: { getData: () => text }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    vm.onPaste(event, input);
  }

  it('loads the pasted report in the same tick, with no deferral', () => {
    const { getReport, vm } = setup();

    paste(vm, PASTED_URL);

    // No wait: loadReport reads the control before its first await, which is the whole point here.
    expect(getReport).toHaveBeenCalledWith(REPORT_CODE);
    expect(vm.reportControl.value).toBe(PASTED_URL);
  });

  it('inserts at the caret rather than replacing what the field already holds', () => {
    const { vm } = setup();
    const HEAD = 'https://www.warcraftlogs.com/reports/';

    paste(vm, REPORT_CODE, HEAD);

    expect(vm.reportControl.value).toBe(PASTED_URL);
  });

  it('replaces the selected range, so a select-all paste loads the new report', () => {
    const { getReport, vm } = setup();
    const STALE_URL = 'https://www.warcraftlogs.com/reports/aaaaaaaaaaaaaaaa';

    paste(vm, PASTED_URL, STALE_URL, 0, STALE_URL.length);

    expect(vm.reportControl.value).toBe(PASTED_URL);
    expect(getReport).toHaveBeenCalledWith(REPORT_CODE);
  });

  it('leaves a paste carrying no text to the browser', () => {
    const { getReport, vm } = setup();

    paste(vm, '', PASTED_URL);

    expect(getReport).not.toHaveBeenCalled();
    expect(vm.reportControl.value).toBe('');
  });
});

describe('PostRaidComponent keystone fight', () => {
  const REPORT_CODE = 'grBQ3vTHXAtPa4JK';
  const RAID_MYTHIC_DIFFICULTY = 5;
  const MYTHIC_PLUS_DIFFICULTY = 10;
  const RAID_FIGHT = { id: 5, name: 'Vorasius', encounterID: 3176, difficulty: RAID_MYTHIC_DIFFICULTY };
  const DUNGEON_FIGHT = { id: 2, name: 'Nexus-Point Xenas', encounterID: 112526, difficulty: MYTHIC_PLUS_DIFFICULTY };
  const PLAYER = { id: 1, name: 'Anya', spec: 'Rogue' };
  const EXPECTED_SPEC = 'SubtletyRogue';

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

  function mount(): { vm: Record<string, unknown>; prepareMap: ReturnType<typeof vi.fn>; getPlayerDetails: ReturnType<typeof vi.fn> } {
    const getPlayerDetails = vi.fn(() => Promise.resolve(groups));
    const wclApi = { getReport: () => Promise.resolve(mixedReport()), getPlayerDetails };
    const prepareMap = vi.fn(() => Promise.resolve());
    TestBed.configureTestingModule({ providers: [...postRaidProviders(wclApi, prepareMap)] });
    return { vm: TestBed.inject(PostRaidComponent) as unknown as Record<string, unknown>, prepareMap, getPlayerDetails };
  }

  async function selectFight(vm: Record<string, unknown>, fightId: number): Promise<void> {
    (vm['fightControl'] as FormControl<number | null>).setValue(fightId);
    await (vm['onFightChange'] as () => Promise<void>)();
  }

  it('lists the keystone fight and analyzes the raid pull the report also holds', async () => {
    const { vm, prepareMap } = mount();

    await loadReport(vm, REPORT_CODE);

    expect((vm['fights'] as () => WclFight[])().map(f => f.id)).toEqual([DUNGEON_FIGHT.id, RAID_FIGHT.id]);
    expect((vm['selectedFightId'] as () => number | null)()).toBe(RAID_FIGHT.id);
    expect((vm['spec'] as () => string)()).toBe(EXPECTED_SPEC);
    expect((vm['notice'] as () => string)()).toBe('');
    expect(prepareMap).toHaveBeenCalled();
  });

  it('stops at the notice and fetches nothing when the keystone fight is selected', async () => {
    const { vm, prepareMap, getPlayerDetails } = mount();
    await loadReport(vm, REPORT_CODE);
    prepareMap.mockClear();
    getPlayerDetails.mockClear();

    await selectFight(vm, DUNGEON_FIGHT.id);

    expect((vm['notice'] as () => string)()).toBe(unsupportedEncounterNotice(DUNGEON_FIGHT.name, DUNGEON_FIGHT.difficulty));
    expect((vm['spec'] as () => string)()).toBe('');
    expect((vm['ready'] as () => boolean)()).toBe(false);
    expect(getPlayerDetails).not.toHaveBeenCalled();
    expect(prepareMap).not.toHaveBeenCalled();
    expect((vm['loadingAnalysis'] as () => boolean)()).toBe(false);
  });

  it('clears the notice when the selection moves back to the raid pull', async () => {
    const { vm } = mount();
    await loadReport(vm, REPORT_CODE);
    await selectFight(vm, DUNGEON_FIGHT.id);

    await selectFight(vm, RAID_FIGHT.id);

    expect((vm['notice'] as () => string)()).toBe('');
    expect((vm['spec'] as () => string)()).toBe(EXPECTED_SPEC);
  });
});
