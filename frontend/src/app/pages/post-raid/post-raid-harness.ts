import { vi } from 'vitest';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { WclFight, WclPlayer } from '../../core/models/wcl.models';
import { WclApiService } from '../../core/services/wcl-api';
import { SelectionStore } from '../../core/services/selection-store';
import { LiveReportSyncService } from '../../core/services/live-report-sync';
import { MapFeatureService } from './map/map.service';
import { LiveCaptureFeatureService } from './live/live-capture.service';
import { PostRaidComponent } from './post-raid';

export function fight(p: Partial<WclFight>): WclFight {
  return { id: 0, name: '', startTime: 0, endTime: 0, kill: false, encounterID: 0, attempt: 0, duration_s: 0, friendlyPlayers: [], fightPercentage: 0, ...p };
}
export function player(p: Partial<WclPlayer>): WclPlayer {
  return { id: 0, name: '', spec: '', server: '', ...p };
}
export function postRaidProviders(wclApi: unknown, prepareMap = vi.fn(() => Promise.resolve())): unknown[] {
  return [
    provideZonelessChangeDetection(),
    PostRaidComponent,
    { provide: WclApiService, useValue: wclApi },
    { provide: MapFeatureService, useValue: { clear: vi.fn(), prepare: prepareMap, ready: () => false, openAt: vi.fn() } },
    { provide: LiveCaptureFeatureService, useValue: { liveEnabled: signal(false), clear: vi.fn(), prepare: vi.fn(), setStatus: vi.fn(), clipReady: () => false, openClip: vi.fn() } },
    { provide: LiveReportSyncService, useValue: { pollTriggers: () => EMPTY } },
    { provide: SelectionStore, useValue: { loadPostRaid: () => null, savePostRaid: vi.fn() } },
  ];
}
