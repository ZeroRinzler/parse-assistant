import { describe, it, expect } from 'vitest';
import { ok, missing, transient, permanent } from './result';

const VALUE = 42;
const PERMANENT_ID = 'gear.combatant-info';

describe('ok', () => {
  it('wraps a success value under the ok discriminant', () => {
    expect(ok(VALUE)).toEqual({ ok: true, value: VALUE });
  });
});

describe('LoadError builders', () => {
  it('builds a missing failure (an un-ingested boss, not a hard error)', () => {
    expect(missing('Not yet ingested.'))
      .toEqual({ ok: false, error: { kind: 'missing', message: 'Not yet ingested.' } });
  });

  it('builds a transient failure (retryable network/5xx)', () => {
    expect(transient('WCL is unreachable right now.'))
      .toEqual({ ok: false, error: { kind: 'transient', message: 'WCL is unreachable right now.' } });
  });

  it('carries an id and context on a permanent failure so the shell can logWarn for repro', () => {
    const cause = new Error('boom');
    expect(permanent('Analysis is bugged.', PERMANENT_ID, cause))
      .toEqual({ ok: false, error: { kind: 'permanent', message: 'Analysis is bugged.', id: PERMANENT_ID, context: cause } });
  });

  it('leaves context undefined when omitted', () => {
    expect(permanent('Analysis is bugged.', PERMANENT_ID))
      .toEqual({ ok: false, error: { kind: 'permanent', message: 'Analysis is bugged.', id: PERMANENT_ID, context: undefined } });
  });
});

