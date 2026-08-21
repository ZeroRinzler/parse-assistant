import { describe, it, expect, vi } from 'vitest';
import { Signal, WritableSignal, provideZonelessChangeDetection } from '@angular/core';
import { FormControl } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { EMPTY, Subscription } from 'rxjs';
import { WclFight, WclPlayer, WclReport } from '../../core/models/wcl.models';
import { WclApiService } from '../../core/services/wcl-api';
import { SelectionStore } from '../../core/services/selection-store';
import { LiveReportSyncService } from '../../core/services/live-report-sync';
import { MapFeatureService } from './map/map.service';
import { LiveCaptureFeatureService } from './live/live-capture.service';
import { PostRaidComponent } from './post-raid';
import { fight, player } from './post-raid-harness';

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
    const fightsProbe = Promise.resolve([pull1(), pull2()]);
    wcl.getReportFights.mockReturnValue(fightsProbe);
    wcl.getReport.mockReturnValue(pendingReport.promise);
    seedLoaded(comp, liveCapture);

    const pollPromise = comp._pollOnce();
    const checkingStatus = liveCapture.status();
    // The poll resumed from this probe before we reach here, so its report fetch has already gone out.
    await fightsProbe;
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
