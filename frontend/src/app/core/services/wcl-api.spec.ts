import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from './wcl-api';
import { WclAuthService } from './wcl-auth';
import { DataFileApiService } from './data-file-api';
import { ok } from '../result';
import { WclCombatantInfo } from '../models/wcl.models';
import { WCL_TRANSPORT, WclTransport, WclTransportError, WCL_UNUSABLE_STATUS } from './wcl-transport';

const UNAUTHORIZED_STATUS = 401;

/** Records the token of every query so the 401 refresh-and-retry can be asserted. */
class RecordingTransport implements WclTransport {
  readonly tokens: string[] = [];
  /** Status to throw on the first call, then succeed (null = always succeed). */
  failFirstWith: number | null = null;
  /** Payload for the next query; null uses the default served-report shape. */
  response: unknown = null;
  async query<TData>(_gqlString: string, _variables: object, token: string): Promise<TData> {
    this.tokens.push(token);
    if (this.failFirstWith != null && this.tokens.length === 1) {
      throw new WclTransportError('rejected', this.failFirstWith);
    }
    if (this.response !== null) return this.response as TData;
    return {
      reportData: { report: { fights: [], masterData: {}, events: { data: [], nextPageTimestamp: undefined } } },
    } as unknown as TData;
  }
}

function setup(): { api: WclApiService; transport: RecordingTransport; tokens: string[] } {
  const transport = new RecordingTransport();
  const tokens = ['token-1', 'token-2'];
  let idx = 0;
  const authStub = {
    getToken: async () => tokens[Math.min(idx, tokens.length - 1)],
    invalidate: () => { idx++; },
  };
  TestBed.configureTestingModule({
    providers: [
      WclApiService,
      { provide: WclAuthService, useValue: authStub as unknown as WclAuthService },
      { provide: WCL_TRANSPORT, useValue: transport },
      // Satisfies the SpecMetaService constructor fetch behind getRankings' spec resolution.
      { provide: DataFileApiService, useValue: { getSpecMeta: async () => ok([]) } },
    ],
  });
  return { api: TestBed.inject(WclApiService), transport, tokens };
}

describe('WclApiService', () => {
  it('reads a report through the transport with no per-call fetch policy', async () => {
    const { api, transport } = setup();
    await api.getReport('code');
    // The transport receives (query, variables, token) - caching is the query's own concern.
    expect(transport.tokens).toEqual(['token-1']);
  });

  it('on a 401 refreshes the token and retries the query once', async () => {
    const { api, transport } = setup();
    transport.failFirstWith = UNAUTHORIZED_STATUS;
    await api.getReport('code');
    // First attempt with the stale token, second with the refreshed one.
    expect(transport.tokens).toEqual(['token-1', 'token-2']);
  });

  it('propagates a non-401 transport error without retrying', async () => {
    const { api, transport } = setup();
    transport.failFirstWith = 500;
    await expect(api.getReport('code')).rejects.toMatchObject({ name: 'WclTransportError', status: 500 });
    expect(transport.tokens).toEqual(['token-1']);
  });

  describe('getAllEvents', () => {
    // Well past the ~22k rows a 34-minute pull returned in one page, and past the argument count push tolerates when a page is spread into it.
    const OVERSIZED_PAGE = 200_000;

    function servePage(transport: RecordingTransport, count: number, nextPageTimestamp?: number) {
      transport.response = {
        reportData: {
          report: {
            events: {
              data: Array.from({ length: count }, (_, i) => ({ type: 'damage', timestamp: i, abilityGameID: 1 })),
              nextPageTimestamp,
            },
          },
        },
      };
    }

    it('accumulates a page far larger than the requested limit', async () => {
      const { api, transport } = setup();
      servePage(transport, OVERSIZED_PAGE);
      const events = await api.getAllEvents('code', 1, 'DamageDone', 0, 1000, 5);
      expect(events).toHaveLength(OVERSIZED_PAGE);
    });

    it('follows nextPageTimestamp and returns every page in order', async () => {
      const { api, transport } = setup();
      const FIRST_PAGE = 3, NEXT_START = 500;
      let call = 0;
      transport.query = async <TData>(): Promise<TData> => {
        call++;
        servePage(transport, FIRST_PAGE, call === 1 ? NEXT_START : undefined);
        return (transport.response as TData);
      };
      const events = await api.getAllEvents('code', 1, 'Casts', 0, 1000, 5);
      expect(events).toHaveLength(FIRST_PAGE * 2);
    });
  });

  describe('getCombatantInfo', () => {
    const FIGHT_ID = 5;
    const PLAYER_ID = 10;

    it('returns the combatant-info events of a served report', async () => {
      const { api, transport } = setup();
      const events: WclCombatantInfo[] = [{ sourceID: PLAYER_ID }];
      transport.response = { reportData: { report: { events: { data: events } } } };
      expect(await api.getCombatantInfo('code', FIGHT_ID, PLAYER_ID)).toEqual(events);
    });

    it('returns [] when a served report carries no combatant-info events', async () => {
      const { api, transport } = setup();
      transport.response = { reportData: { report: { events: { data: [] } } } };
      expect(await api.getCombatantInfo('code', FIGHT_ID, PLAYER_ID)).toEqual([]);
    });

    it('throws the permanent unavailable error when the report is unserved (report: null)', async () => {
      const { api, transport } = setup();
      transport.response = { reportData: { report: null } };
      await expect(api.getCombatantInfo('code', FIGHT_ID, PLAYER_ID))
        .rejects.toMatchObject({ name: 'WclTransportError', status: WCL_UNUSABLE_STATUS });
    });
  });
});
