import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from './wcl-api';
import { WclAuthService } from './wcl-auth';
import { LiveModeState } from './live-mode-state';
import { WCL_TRANSPORT, WCL_INGEST_MODE, WclTransport } from './wcl-transport';

/**
 * Records the `cacheFirst` flag of every query so the fetch policy can be asserted, and
 * returns minimal valid shapes so `getReport` / `getAllEvents` complete without a network.
 */
class RecordingTransport implements WclTransport {
  readonly cacheFirstCalls: boolean[] = [];
  async query<TData>(_gqlString: string, _variables: object, _token: string, cacheFirst: boolean): Promise<TData> {
    this.cacheFirstCalls.push(cacheFirst);
    return {
      reportData: { report: { fights: [], masterData: {}, events: { data: [], nextPageTimestamp: undefined } } },
    } as unknown as TData;
  }
}

const authStub = { getToken: async () => 'test-token', invalidate: () => undefined };

function setup(opts: { ingest: boolean }): { api: WclApiService; transport: RecordingTransport; live: LiveModeState } {
  const transport = new RecordingTransport();
  TestBed.configureTestingModule({
    providers: [
      WclApiService,
      { provide: WclAuthService, useValue: authStub as unknown as WclAuthService },
      { provide: WCL_TRANSPORT, useValue: transport },
      { provide: WCL_INGEST_MODE, useValue: opts.ingest },
    ],
  });
  return { api: TestBed.inject(WclApiService), transport, live: TestBed.inject(LiveModeState) };
}

describe('WclApiService fetch policy', () => {
  it('reads the report cache-first for a saved (non-live) report', async () => {
    const { api, transport, live } = setup({ ingest: false });
    live.active.set(false);
    await api.getReport('code');
    expect(transport.cacheFirstCalls).toEqual([true]);
  });

  it('reads the report network-only while live-syncing', async () => {
    const { api, transport, live } = setup({ ingest: false });
    live.active.set(true);
    await api.getReport('code');
    expect(transport.cacheFirstCalls).toEqual([false]);
  });

  it('reads events cache-first for a saved report and network-only while live-syncing', async () => {
    const { api, transport, live } = setup({ ingest: false });
    live.active.set(false);
    await api.getAllEvents('code', 1, 'Casts', 0, 100, 6);
    live.active.set(true);
    await api.getAllEvents('code', 1, 'Casts', 0, 100, 6);
    expect(transport.cacheFirstCalls).toEqual([true, false]);
  });

  it('always reads cache-first under ingest mode, regardless of live state', async () => {
    const { api, transport, live } = setup({ ingest: true });
    live.active.set(true);
    await api.getReport('code');
    await api.getAllEvents('code', 1, 'Casts', 0, 100, 6);
    expect(transport.cacheFirstCalls).toEqual([true, true]);
  });
});
