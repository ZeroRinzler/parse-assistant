import { describe, it, expect } from 'vitest';
import { NgHttpCachingHeaders } from 'ng-http-caching';
import { wclCachingHeaders, WCL_LIVE_CACHE_MS } from './wcl-caching';
import { REPORT_Q, REPORT_FIGHTS_Q, EVENTS_Q, TABLE_Q, RATE_LIMIT_Q, CLASSES_Q, ENCOUNTERS_Q } from './wcl-queries';

describe('wclCachingHeaders', () => {
  it('caps the code-keyed report reads at the live-cache lifetime', () => {
    // These are keyed on the report code alone, so they change as a live raid records pulls.
    for (const query of [REPORT_Q, REPORT_FIGHTS_Q]) {
      expect(wclCachingHeaders(query)).toEqual({ [NgHttpCachingHeaders.LIFETIME]: String(WCL_LIVE_CACHE_MS) });
    }
  });

  it('disables the cache for discovery and budget reads', () => {
    // The budget gate must see fresh points-spent; discovery is one-shot.
    for (const query of [RATE_LIMIT_Q, CLASSES_Q, ENCOUNTERS_Q]) {
      expect(wclCachingHeaders(query)).toEqual({ [NgHttpCachingHeaders.DISALLOW_CACHE]: '1' });
    }
  });

  it('leaves fight-window reads on the long default lifetime', () => {
    // Events/tables are keyed on an immutable fight window, so they need no override.
    for (const query of [EVENTS_Q, TABLE_Q]) {
      expect(wclCachingHeaders(query)).toEqual({});
    }
  });
});
