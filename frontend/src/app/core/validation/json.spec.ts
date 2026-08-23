import { describe, it, expect, vi, afterEach } from 'vitest';
import * as z from './zod-mini';
import { JsonCodecService } from './json-codec-service';
import { TestBed } from '@angular/core/testing';

const json = TestBed.inject(JsonCodecService);

const SCHEMA = z.object({ name: z.string() });

const CONTEXT = 'parseJson.spec';

const MATCHING_BLOB = '{"name":"Shadowmaster"}';

const TRUNCATED_BLOB = '{"name":';

const WRONG_SHAPE_BLOB = '{"name":7}';

function spyOnWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('parseJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the validated value for a blob matching the schema', () => {
    expect(json.parseJson(SCHEMA, MATCHING_BLOB, CONTEXT)).toEqual({ name: 'Shadowmaster' });
  });

  it('returns null and warns for a blob JSON.parse rejects', () => {
    const warn = spyOnWarn();

    expect(json.parseJson(SCHEMA, TRUNCATED_BLOB, CONTEXT)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null and warns for valid JSON the schema rejects, matching the unparseable case', () => {
    const warn = spyOnWarn();

    expect(json.parseJson(SCHEMA, WRONG_SHAPE_BLOB, CONTEXT)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
