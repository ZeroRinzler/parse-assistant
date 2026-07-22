import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Signal, WritableSignal, provideZonelessChangeDetection, signal } from '@angular/core';
import { FormControl } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { EMPTY, Subscription } from 'rxjs';
import { PlayerDetailGroups, WclFight, WclPlayer, WclReport } from '../../core/models/wcl.models';
import { WclApiService } from '../../core/services/wcl-api';
import { SelectionStore } from '../../core/services/selection-store';
import { LiveReportSyncService } from '../../core/services/live-report-sync';
import { MapFeatureService } from './map/map.service';
import { LiveCaptureFeatureService } from './live/live-capture.service';
import {
  PostRaidComponent,
  specOf, extractCode, isValidReportCode, buildFights, buildPlayers, visiblePlayersOf, pickPlayerId, pickLivePlayerId,
  livePollActionOf,
} from './post-raid';

function fight(p: Partial<WclFight>): WclFight {
  return { id: 0, name: '', startTime: 0, endTime: 0, kill: false, encounterID: 0, attempt: 0, duration_s: 0, friendlyPlayers: [], fightPercentage: 0, ...p };
}
function player(p: Partial<WclPlayer>): WclPlayer {
  return { id: 0, name: '', spec: '', server: '', ...p };
}

describe('extractCode', () => {
  it('pulls the report code out of a WCL report URL', () => {
    expect(extractCode('https://www.warcraftlogs.com/reports/grBQ3vTHXAtPa4JK#fight=1')).toBe('grBQ3vTHXAtPa4JK');
  });

  it('passes a bare code through, trimmed', () => {
    expect(extractCode('  grBQ3vTHXAtPa4JK  ')).toBe('grBQ3vTHXAtPa4JK');
  });
});

describe('isValidReportCode', () => {
  it('accepts a 16-character alphanumeric report code', () => {
    expect(isValidReportCode('grBQ3vTHXAtPa4JK')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidReportCode('')).toBe(false);
  });

  it('rejects arbitrary non-code text', () => {
    expect(isValidReportCode('hello')).toBe(false);
    expect(isValidReportCode('not a code at all')).toBe(false);
  });

  it('rejects a code of the wrong length', () => {
    expect(isValidReportCode('grBQ3vTHXAtPa4J')).toBe(false);  // 15 chars
    expect(isValidReportCode('grBQ3vTHXAtPa4JKK')).toBe(false); // 17 chars
  });

  it('rejects a 16-character string containing non-alphanumeric characters', () => {
    expect(isValidReportCode('grBQ3vTHXAtPa4J-')).toBe(false);
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
    // 94_567 ms -> 945.67 -> round 946 -> 94.6: a non-round span so the rounding step is exercised.
    const [f] = buildFights([fight({ id: 1, encounterID: 100, startTime: 1000, endTime: 95_567 })]);
    expect(f.duration_s).toBe(94.6);
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

  it('honors an explicit auto-player', () => {
    // autoPlayer 2 differs from the first-visible fallback (id 1), so this pins the honor-explicit branch.
    expect(pickPlayerId(players, 2)).toBe(2);
  });

  it('falls back to the first visible player', () => {
    expect(pickPlayerId(players, null)).toBe(1);
  });

  it('returns null when there is nobody to pick', () => {
    expect(pickPlayerId([], null)).toBeNull();
  });
});

describe('livePollActionOf', () => {
  const pulls = [fight({ id: 1, encounterID: 100 }), fight({ id: 2, encounterID: 100 })];
  const LATEST_PULL_ID = 2;
  const EARLIER_PULL_ID = 1;

  it('returns none when the report has no boss pulls', () => {
    expect(livePollActionOf([], LATEST_PULL_ID, true)).toBe('none');
  });

  it('skips when the latest pull is already the analyzed selection', () => {
    expect(livePollActionOf(pulls, LATEST_PULL_ID, true)).toBe('skip');
  });

  it('analyzes when a pull newer than the selection appears', () => {
    expect(livePollActionOf(pulls, EARLIER_PULL_ID, true)).toBe('analyze');
  });

  it('analyzes when the selected latest pull has not finished analyzing', () => {
    expect(livePollActionOf(pulls, LATEST_PULL_ID, false)).toBe('analyze');
  });

  it('analyzes when nothing is selected yet', () => {
    expect(livePollActionOf(pulls, null, false)).toBe('analyze');
  });
});

describe('pickLivePlayerId', () => {
  const players = [player({ id: 1, name: 'Anya' }), player({ id: 2, name: 'Bram' }), player({ id: 3, name: 'Cera' })];

  it('keeps the currently selected player when they appear in the new pull', () => {
    expect(pickLivePlayerId(players, 'Bram')).toBe(2);
  });

  it('matches the current player name case-insensitively', () => {
    expect(pickLivePlayerId(players, 'bram')).toBe(2);
  });

  it('falls back to the first visible player when the selected player is absent', () => {
    const newPlayers = [player({ id: 2, name: 'Bram' }), player({ id: 3, name: 'Cera' })];
    expect(pickLivePlayerId(newPlayers, 'Anya')).toBe(2);
  });

  it('falls back to the first visible player when currentPlayerName is null', () => {
    expect(pickLivePlayerId(players, null)).toBe(1);
  });
});

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

describe('PostRaidComponent sticky player name', () => {
  const REPORT_CODE = 'grBQ3vTHXAtPa4JK';                         // a valid 16-character report code
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
    return {
      title: 'Test', startTime: 0,
      fights: [fight({
        id: 10, name: 'Boss', encounterID: 100, startTime: 0, endTime: 10_000, kill: true,
        friendlyPlayers: [FALLBACK_PLAYER.id, PICKED_PLAYER.id],
      })],
      masterData: {
        actors: [FALLBACK_PLAYER, PICKED_PLAYER].map(p => ({ id: p.id, name: p.name, subType: p.spec, server: '' })),
        enemies: [], abilities: [],
      },
    };
  }

  const noop = (): void => undefined;

  function mount(): { component: PostRaidComponent & Record<string, unknown>; store: SelectionStore } {
    const wclApi = {
      getReport: () => Promise.resolve(report()),
      getReportFights: () => Promise.resolve(report().fights),
      getPlayerDetails: () => Promise.resolve(groups),
    } as unknown as WclApiService;
    const mapFeature = { clear: noop, prepare: () => Promise.resolve() } as unknown as MapFeatureService;
    const liveCapture = { liveEnabled: signal(false), clear: noop, prepare: noop, setStatus: noop } as unknown as LiveCaptureFeatureService;
    const liveSync = { pollTriggers: () => EMPTY } as unknown as LiveReportSyncService;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        PostRaidComponent,
        { provide: WclApiService, useValue: wclApi },
        { provide: MapFeatureService, useValue: mapFeature },
        { provide: LiveCaptureFeatureService, useValue: liveCapture },
        { provide: LiveReportSyncService, useValue: liveSync },
      ],
    });
    return {
      component: TestBed.inject(PostRaidComponent) as PostRaidComponent & Record<string, unknown>,
      store: TestBed.inject(SelectionStore),
    };
  }

  async function loadReport(component: Record<string, unknown>): Promise<void> {
    (component['reportControl'] as FormControl<string>).setValue(REPORT_CODE);
    await (component['loadReport'] as () => Promise<void>)();
  }

  beforeEach(() => localStorage.clear());

  it('keeps the sticky name when a loaded report auto-selects a fallback player instead', async () => {
    const { component, store } = mount();
    store.savePostRaid({ playerName: ABSENT_STICKY_NAME });

    await loadReport(component);

    // The sticky character is absent, so the page auto-selects the alphabetical fallback...
    expect((component['selectedPlayerId'] as () => number | null)()).toBe(FALLBACK_PLAYER.id);
    // ...but that automatic pick must not overwrite the sticky name the user chose earlier.
    expect(store.loadPostRaid()?.playerName).toBe(ABSENT_STICKY_NAME);
  });

  it('persists the player name when the user explicitly picks one', async () => {
    const { component, store } = mount();
    store.savePostRaid({ playerName: ABSENT_STICKY_NAME });
    await loadReport(component);

    (component['playerControl'] as FormControl<number | null>).setValue(PICKED_PLAYER.id);
    await (component['onPlayerChange'] as () => Promise<void>)();

    expect(store.loadPostRaid()?.playerName).toBe(PICKED_PLAYER.name);
  });
});

interface PollHandle {
  _pollOnce(): Promise<void>;
  reportCode: WritableSignal<string>;
  fights: WritableSignal<WclFight[]>;
  players: WritableSignal<WclPlayer[]>;
  fightControl: FormControl<number | null>;
  playerControl: FormControl<number | null>;
  selectedFightId: Signal<number | null>;
  selectedPlayerId: Signal<number | null>;
  loadError: Signal<unknown>;
}

describe('PostRaidComponent live-sync poll', () => {
  const REPORT_A = 'report-a';
  const REPORT_B = 'report-b';
  const SELECTED_PULL_ID = 11;
  const NEW_PULL_ID = 12;
  const BOSS_ENCOUNTER_ID = 100;
  const PLAYER_ID = 7;
  const PLAYER_NAME = 'Anya';

  const pull1 = () => fight({ id: SELECTED_PULL_ID, encounterID: BOSS_ENCOUNTER_ID, startTime: 1000, endTime: 2000, name: 'Pull 1' });
  const pull2 = () => fight({ id: NEW_PULL_ID, encounterID: BOSS_ENCOUNTER_ID, startTime: 3000, endTime: 4000, name: 'Pull 2' });

  function report(fights: WclFight[]): WclReport {
    return {
      title: '', startTime: 0, fights,
      masterData: { actors: [{ id: PLAYER_ID, name: PLAYER_NAME, subType: 'Rogue', server: '' }], enemies: [], abilities: [] },
    };
  }

  function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
  }

  // Yield a macrotask so every queued microtask (the poll's awaited fetches) drains first.
  const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve));

  function mountPostRaid() {
    const wcl = { getReport: vi.fn(), getReportFights: vi.fn(), getPlayerDetails: vi.fn() };
    const mapFeature = { clear: vi.fn(), prepare: vi.fn().mockResolvedValue(undefined), openAt: vi.fn(), ready: vi.fn().mockReturnValue(false) };
    const selectionStore = { loadPostRaid: vi.fn().mockReturnValue(null), savePostRaid: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: WclApiService, useValue: wcl },
        { provide: MapFeatureService, useValue: mapFeature },
        { provide: SelectionStore, useValue: selectionStore },
        { provide: LiveReportSyncService, useValue: { pollTriggers: () => EMPTY } },
      ],
    });
    // Construct viewless (the shell template needs feature data-source tokens this harness omits) and drive _pollOnce directly.
    const comp = TestBed.runInInjectionContext(() => new PostRaidComponent()) as unknown as PollHandle & { _pollingSub: Subscription };
    comp._pollingSub.unsubscribe();
    const liveCapture = TestBed.inject(LiveCaptureFeatureService);
    return { comp, wcl, liveCapture };
  }

  function seedLoaded(comp: PollHandle, liveCapture: LiveCaptureFeatureService): void {
    comp.reportCode.set(REPORT_A);
    comp.fights.set([pull1()]);
    comp.players.set([player({ id: PLAYER_ID, name: PLAYER_NAME })]);
    comp.fightControl.setValue(SELECTED_PULL_ID);
    liveCapture.setLive(true);
  }

  it('drops an in-flight poll when live sync is switched off before its report fetch resolves', async () => {
    const { comp, wcl, liveCapture } = mountPostRaid();
    const pendingReport = defer<WclReport>();
    wcl.getReportFights.mockResolvedValue([pull1(), pull2()]);
    wcl.getReport.mockReturnValue(pendingReport.promise);
    seedLoaded(comp, liveCapture);

    const pollPromise = comp._pollOnce();
    const checkingStatus = liveCapture.status();
    await flushMicrotasks();
    // Exactly one poll runs (the pipeline is torn down), so the guard is the only thing under test.
    expect(wcl.getReportFights).toHaveBeenCalledTimes(1);
    expect(wcl.getReport).toHaveBeenCalledWith(REPORT_A);

    liveCapture.setLive(false);
    pendingReport.resolve(report([pull1(), pull2()]));
    await pollPromise;

    expect(comp.fights().map(f => f.id)).toEqual([SELECTED_PULL_ID]);
    expect(comp.fightControl.value).toBe(SELECTED_PULL_ID);
    expect(comp.selectedFightId()).toBe(SELECTED_PULL_ID);
    expect(comp.loadError()).toBeNull();
    expect(liveCapture.status()).toBe(checkingStatus);
  });

  it('skips the report fetch and drops the poll when the report is switched before the probe resolves', async () => {
    const { comp, wcl, liveCapture } = mountPostRaid();
    const pendingProbe = defer<WclFight[]>();
    wcl.getReportFights.mockReturnValue(pendingProbe.promise);
    wcl.getReport.mockResolvedValue(report([pull1(), pull2()]));
    seedLoaded(comp, liveCapture);

    const pollPromise = comp._pollOnce();
    expect(wcl.getReportFights).toHaveBeenCalledWith(REPORT_A);

    comp.reportCode.set(REPORT_B);
    pendingProbe.resolve([pull1(), pull2()]);
    await pollPromise;

    expect(wcl.getReport).not.toHaveBeenCalled();
    expect(comp.fights().map(f => f.id)).toEqual([SELECTED_PULL_ID]);
    expect(comp.fightControl.value).toBe(SELECTED_PULL_ID);
    expect(comp.loadError()).toBeNull();
  });

  it('applies the newest pull when the poll is still current', async () => {
    const { comp, wcl, liveCapture } = mountPostRaid();
    wcl.getReportFights.mockResolvedValue([pull1(), pull2()]);
    wcl.getReport.mockResolvedValue(report([pull1(), pull2()]));
    wcl.getPlayerDetails.mockResolvedValue({ dps: [{ id: PLAYER_ID, type: 'Rogue', name: PLAYER_NAME, specs: [{ spec: 'Subtlety' }] }] });
    seedLoaded(comp, liveCapture);

    await comp._pollOnce();

    expect(comp.fightControl.value).toBe(NEW_PULL_ID);
    expect(comp.selectedFightId()).toBe(NEW_PULL_ID);
    expect(comp.loadError()).toBeNull();
    expect(liveCapture.status()).toMatch(/^Updated/);
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

  const reportB: WclReport = {
    title: 'B', startTime: REPORT_B_START,
    fights: [fight({ id: FIGHT_B_ID, encounterID: ENCOUNTER_ID, startTime: 0, endTime: 10_000, friendlyPlayers: [PLAYER_B_ID] })],
    masterData: { actors: [{ id: PLAYER_B_ID, name: 'Bee', subType: 'Rogue', server: '' }], enemies: [], abilities: [] },
  };
  const reportA: WclReport = {
    title: 'A', startTime: REPORT_A_START, fights: [],
    masterData: { actors: [], enemies: [], abilities: [] },
  };
  const detailsB: PlayerDetailGroups = { dps: [{ id: PLAYER_B_ID, type: 'Rogue', name: 'Bee', specs: [{ spec: 'Subtlety' }] }] };

  /** Fake WCL client whose getReport / getPlayerDetails stay pending until the test settles them. */
  class FakeWclApi {
    private readonly reportResolvers = new Map<string, (report: WclReport) => void>();
    private readonly playerDetailResolvers: ((groups: PlayerDetailGroups) => void)[] = [];
    getReport(code: string): Promise<WclReport> {
      return new Promise(resolve => this.reportResolvers.set(code, resolve));
    }
    getPlayerDetails(): Promise<PlayerDetailGroups> {
      return new Promise(resolve => this.playerDetailResolvers.push(resolve));
    }
    settleReport(code: string, report: WclReport): void { this.reportResolvers.get(code)!(report); }
    settlePlayerDetails(groups: PlayerDetailGroups): void { this.playerDetailResolvers.shift()!(groups); }
  }

  /** Drain microtasks + the macrotask queue so each awaited loadReport step settles. */
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

  // Construct the shell directly (no view attached) so loadReport runs without rendering the
  // card templates, whose own data sources are out of scope here.
  function setup(): { api: FakeWclApi; vm: Record<string, unknown> } {
    const api = new FakeWclApi();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        PostRaidComponent,
        { provide: WclApiService, useValue: api },
        { provide: MapFeatureService, useValue: { clear: vi.fn(), prepare: vi.fn(() => Promise.resolve()), ready: () => false, openAt: vi.fn() } },
        { provide: LiveCaptureFeatureService, useValue: { liveEnabled: signal(false), clear: vi.fn(), prepare: vi.fn(), setStatus: vi.fn(), clipReady: () => false, openClip: vi.fn() } },
        { provide: LiveReportSyncService, useValue: { pollTriggers: () => EMPTY } },
        { provide: SelectionStore, useValue: { loadPostRaid: () => null, savePostRaid: vi.fn() } },
      ],
    });
    return { api, vm: TestBed.inject(PostRaidComponent) as unknown as Record<string, unknown> };
  }

  it('keeps the newer report and its spinner when a slower earlier load resolves late', async () => {
    const { api, vm } = setup();
    const reportControl = vm['reportControl'] as FormControl<string>;
    const loadReport = () => (vm['loadReport'] as () => Promise<void>)();
    const reportCode = vm['reportCode'] as () => string;
    const loadingReport = vm['loadingReport'] as () => boolean;
    const reportStartTime = vm['reportStartTime'] as () => number;
    const fights = vm['fights'] as () => WclFight[];
    const spec = vm['spec'] as () => string;

    reportControl.setValue(CODE_A);
    const loadA = loadReport(); // parks on getReport(A)
    reportControl.setValue(CODE_B);
    const loadB = loadReport(); // parks on getReport(B)

    // B's report resolves first and advances to its still-pending spec resolve.
    api.settleReport(CODE_B, reportB);
    await settle();
    expect(reportCode()).toBe(CODE_B);
    expect(loadingReport()).toBe(true);

    // A's report resolves late: neither its state writes nor its finally may land.
    api.settleReport(CODE_A, reportA);
    await settle();
    expect(reportCode()).toBe(CODE_B);
    expect(reportStartTime()).toBe(REPORT_B_START);
    expect(fights().map(f => f.id)).toEqual([FIGHT_B_ID]);
    expect(loadingReport()).toBe(true); // A's finally did not clear B's in-flight spinner

    // B finishes: its own finally clears the spinner and its spec lands.
    api.settlePlayerDetails(detailsB);
    await settle();
    expect(loadingReport()).toBe(false);
    expect(spec()).toBe(EXPECTED_SPEC);
    expect(reportCode()).toBe(CODE_B);

    await Promise.all([loadA, loadB]);
  });
});
