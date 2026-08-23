import { assert, vi } from 'vitest';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { FormControl } from '@angular/forms';
import { EMPTY } from 'rxjs';
import { PlayerDetailGroups, WclFight, WclPlayer, WclReport } from '../../../../core/wcl/wcl.models';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { SelectionStore } from '../../../../core/state/selection-store';
import { LiveReportSyncService } from '../../../../core/wcl/live-report-sync-service';
import { Deferred, deferred } from '../../../../../testing/deferred';
import { MapFeatureService } from '../../map/facade/map-feature-service';
import { LiveCaptureFeatureService } from '../../live/facade/live-capture-feature-service';
import { PostRaid } from './post-raid';

export function fight(p: Partial<WclFight>): WclFight {
  return { id: 0, name: '', startTime: 0, endTime: 0, kill: false, encounterID: 0, attempt: 0, duration_s: 0, friendlyPlayers: [], fightPercentage: 0, ...p };
}
export function player(p: Partial<WclPlayer>): WclPlayer {
  return { id: 0, name: '', spec: '', server: '', ...p };
}
export function postRaidProviders(wclApi: unknown, prepareMap = vi.fn(() => Promise.resolve())): unknown[] {
  return [
    provideZonelessChangeDetection(),
    PostRaid,
    { provide: WclApiService, useValue: wclApi },
    { provide: MapFeatureService, useValue: { clear: vi.fn(), prepare: prepareMap, ready: () => false, openAt: vi.fn() } },
    { provide: LiveCaptureFeatureService, useValue: { liveEnabled: signal(false), clear: vi.fn(), prepare: vi.fn(), setStatus: vi.fn(), clipReady: () => false, openClip: vi.fn() } },
    { provide: LiveReportSyncService, useValue: { pollTriggers: () => EMPTY } },
    { provide: SelectionStore, useValue: { loadPostRaid: () => null, savePostRaid: vi.fn() } },
  ];
}

interface ReportLoadHandle {
  reportControl: FormControl<string>;
  loadReport(): Promise<void>;
}

export function loadReport(vm: unknown, input: string): Promise<void> {
  const handle = vm as ReportLoadHandle;
  handle.reportControl.setValue(input);
  return handle.loadReport();
}

export interface ParkedWclApi {
  getReport(code: string): Promise<WclReport>;
  getPlayerDetails(code: string, fightId: number): Promise<PlayerDetailGroups>;
  settleReport(code: string, report: WclReport): Promise<void>;
  settleDetails(fightId: number, groups: PlayerDetailGroups): void;
}

function take<K, T>(pending: Map<K, Deferred<T>>, key: K): Deferred<T> {
  const parked = pending.get(key);
  assert.exists(parked);
  return parked;
}

export function parkedWclApi(): ParkedWclApi {
  const reports = new Map<string, Deferred<WclReport>>();
  const details = new Map<number, Deferred<PlayerDetailGroups>>();
  return {
    getReport(code) {
      const parked = deferred<WclReport>();
      reports.set(code, parked);
      return parked.promise;
    },
    getPlayerDetails(_code, fightId) {
      const parked = deferred<PlayerDetailGroups>();
      details.set(fightId, parked);
      return parked.promise;
    },
    async settleReport(code, report) {
      const parked = take(reports, code);
      parked.resolve(report);
      // Awaiting the parked fetch resumes the caller first, so the load has moved on by the time this returns.
      await parked.promise;
    },
    settleDetails(fightId, groups) {
      take(details, fightId).resolve(groups);
    },
  };
}
