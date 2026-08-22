import { describe, it, expect } from 'vitest';
import { Signal, WritableSignal } from '@angular/core';
import { FormControl } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { PlayerDetailGroups, WclFight, WclPlayer, WclReport } from '../../core/models/wcl.models';
import { wclReport } from '../../../testing/builders/wcl-fixtures';
import { PostRaidComponent, unsupportedEncounterNotice } from './post-raid';
import { ParkedWclApi, fight, loadReport, parkedWclApi, player, postRaidProviders } from './post-raid-harness';

interface SelectionHandle {
  onFightChange(): Promise<void>;
  reportCode: WritableSignal<string>;
  fights: WritableSignal<WclFight[]>;
  players: WritableSignal<WclPlayer[]>;
  fightControl: FormControl<number | null>;
  spec: Signal<string>;
  notice: Signal<string>;
  loadingAnalysis: Signal<boolean>;
}

describe('PostRaidComponent selection latest-wins', () => {
  const REPORT_CODE = 'grBQ3vTHXAtPa4JK';
  const BOSS_ENCOUNTER_ID = 3176;
  const KEYSTONE_ENCOUNTER_ID = 112526;
  const RAID_MYTHIC_DIFFICULTY = 5;
  const MYTHIC_PLUS_DIFFICULTY = 10;
  const KEYSTONE_PULL = { id: 9, name: 'Nexus-Point Xenas' };
  const EARLIER_PULL_ID = 11;
  const LATER_PULL_ID = 12;
  const PLAYER_ID = 7;
  const PLAYER_NAME = 'Anya';
  const CLASS_NAME = 'Rogue';
  const EARLIER_SPEC_NAME = 'Subtlety';
  const LATER_SPEC_NAME = 'Assassination';
  const LATER_SPEC = LATER_SPEC_NAME + CLASS_NAME;

  const detailsFor = (spec: string): PlayerDetailGroups => ({
    dps: [{ id: PLAYER_ID, type: CLASS_NAME, name: PLAYER_NAME, specs: [{ spec }] }],
  });
  const EARLIER_DETAILS = detailsFor(EARLIER_SPEC_NAME);
  const LATER_DETAILS = detailsFor(LATER_SPEC_NAME);

  const pulls = (): WclFight[] => [
    fight({ ...KEYSTONE_PULL, encounterID: KEYSTONE_ENCOUNTER_ID, difficulty: MYTHIC_PLUS_DIFFICULTY, startTime: 0, endTime: 5_000, friendlyPlayers: [PLAYER_ID] }),
    fight({ id: EARLIER_PULL_ID, name: 'Boss', encounterID: BOSS_ENCOUNTER_ID, difficulty: RAID_MYTHIC_DIFFICULTY, startTime: 10_000, endTime: 20_000, friendlyPlayers: [PLAYER_ID] }),
    fight({ id: LATER_PULL_ID, name: 'Boss', encounterID: BOSS_ENCOUNTER_ID, difficulty: RAID_MYTHIC_DIFFICULTY, startTime: 30_000, endTime: 40_000, friendlyPlayers: [PLAYER_ID] }),
  ];

  const loadedReport = (): WclReport => wclReport({
    fights: pulls(),
    actors: [{ id: PLAYER_ID, name: PLAYER_NAME, subType: CLASS_NAME, server: '' }],
  });

  function setup(): { api: ParkedWclApi; vm: SelectionHandle } {
    const api = parkedWclApi();
    TestBed.configureTestingModule({ providers: [...postRaidProviders(api)] });
    const vm = TestBed.inject(PostRaidComponent) as unknown as SelectionHandle;
    vm.reportCode.set(REPORT_CODE);
    vm.fights.set(pulls());
    vm.players.set([player({ id: PLAYER_ID, name: PLAYER_NAME })]);
    return { api, vm };
  }

  function selectFight(vm: SelectionHandle, fightId: number): Promise<void> {
    vm.fightControl.setValue(fightId);
    return vm.onFightChange();
  }

  it('lands the resolved spec when the only selection settles in order', async () => {
    const { api, vm } = setup();

    const resolving = selectFight(vm, LATER_PULL_ID);
    expect(vm.loadingAnalysis()).toBe(true);
    api.settleDetails(LATER_PULL_ID, LATER_DETAILS);
    await resolving;

    expect(vm.spec()).toBe(LATER_SPEC);
    expect(vm.loadingAnalysis()).toBe(false);
  });

  it('keeps the newer selection\'s spec when the earlier resolve settles late', async () => {
    const { api, vm } = setup();

    const earlier = selectFight(vm, EARLIER_PULL_ID);
    const later = selectFight(vm, LATER_PULL_ID);

    api.settleDetails(LATER_PULL_ID, LATER_DETAILS);
    await later;
    expect(vm.spec()).toBe(LATER_SPEC);

    api.settleDetails(EARLIER_PULL_ID, EARLIER_DETAILS);
    await Promise.all([earlier, later]);

    expect(vm.spec()).toBe(LATER_SPEC);
    expect(vm.loadingAnalysis()).toBe(false);
  });

  it('clears the spinner when the selection that supersedes a resolve stops at the keystone notice', async () => {
    const { api, vm } = setup();

    const earlier = selectFight(vm, EARLIER_PULL_ID);
    expect(vm.loadingAnalysis()).toBe(true);

    await selectFight(vm, KEYSTONE_PULL.id);
    expect(vm.loadingAnalysis()).toBe(false);

    api.settleDetails(EARLIER_PULL_ID, EARLIER_DETAILS);
    await earlier;

    expect(vm.notice()).toBe(unsupportedEncounterNotice(KEYSTONE_PULL.name, MYTHIC_PLUS_DIFFICULTY));
    expect(vm.spec()).toBe('');
    expect(vm.loadingAnalysis()).toBe(false);
  });

  it('drops a resolve left in flight by a report load that has not fetched yet', async () => {
    const { api, vm } = setup();

    const earlier = selectFight(vm, EARLIER_PULL_ID);
    const loading = loadReport(vm, REPORT_CODE);

    api.settleDetails(EARLIER_PULL_ID, EARLIER_DETAILS);
    await earlier;
    expect(vm.spec()).toBe('');

    await api.settleReport(REPORT_CODE, loadedReport());
    api.settleDetails(LATER_PULL_ID, LATER_DETAILS);
    await Promise.all([earlier, loading]);

    expect(vm.spec()).toBe(LATER_SPEC);
  });
});

describe('PostRaidComponent loadReport latest-wins', () => {
  const CODE_A = 'aaaaaaaaaaaaaaaa'; // 16-char valid code for the slow, superseded load
  const CODE_B = 'bbbbbbbbbbbbbbbb'; // 16-char valid code for the newer, winning load
  const ENCOUNTER_ID = 3144;
  const FIGHT_B_ID = 7;
  const PLAYER_B_ID = 3;
  const REPORT_A_START = 1_000; // distinct report clocks reveal which _applyReport landed
  const REPORT_B_START = 2_000;
  const EXPECTED_SPEC = 'SubtletyRogue';

  const reportB: WclReport = wclReport({
    startTimeMs: REPORT_B_START,
    fights: [fight({ id: FIGHT_B_ID, encounterID: ENCOUNTER_ID, startTime: 0, endTime: 10_000, friendlyPlayers: [PLAYER_B_ID] })],
    actors: [{ id: PLAYER_B_ID, name: 'Bee', subType: 'Rogue', server: '' }],
  });
  const reportA: WclReport = wclReport({ startTimeMs: REPORT_A_START, fights: [], actors: [] });
  const detailsB: PlayerDetailGroups = { dps: [{ id: PLAYER_B_ID, type: 'Rogue', name: 'Bee', specs: [{ spec: 'Subtlety' }] }] };

  // Constructs the shell directly (no view attached) so loadReport runs without rendering the card templates.
  function setup(): { api: ParkedWclApi; vm: Record<string, unknown> } {
    const api = parkedWclApi();
    TestBed.configureTestingModule({ providers: [...postRaidProviders(api)] });
    return { api, vm: TestBed.inject(PostRaidComponent) as unknown as Record<string, unknown> };
  }

  it('keeps the newer report and its spinner when a slower earlier load resolves late', async () => {
    const { api, vm } = setup();
    const reportCode = vm['reportCode'] as () => string;
    const loadingReport = vm['loadingReport'] as () => boolean;
    const reportStartTime = vm['reportStartTime'] as () => number;
    const fights = vm['fights'] as () => WclFight[];
    const spec = vm['spec'] as () => string;

    const loadA = loadReport(vm, CODE_A);
    const loadB = loadReport(vm, CODE_B);

    // B's report resolves first and advances to its still-pending spec resolve.
    await api.settleReport(CODE_B, reportB);
    expect(reportCode()).toBe(CODE_B);
    expect(loadingReport()).toBe(true);

    // A's report resolves late and A runs to completion: neither its state writes nor its finally may land.
    await api.settleReport(CODE_A, reportA);
    await loadA;
    expect(reportCode()).toBe(CODE_B);
    expect(reportStartTime()).toBe(REPORT_B_START);
    expect(fights().map(f => f.id)).toEqual([FIGHT_B_ID]);
    expect(loadingReport()).toBe(true); // A's finally did not clear B's in-flight spinner

    // B finishes: its own finally clears the spinner and its spec lands.
    api.settleDetails(FIGHT_B_ID, detailsB);
    await loadB;
    expect(loadingReport()).toBe(false);
    expect(spec()).toBe(EXPECTED_SPEC);
    expect(reportCode()).toBe(CODE_B);

    await Promise.all([loadA, loadB]);
  });
});
