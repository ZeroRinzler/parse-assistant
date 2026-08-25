import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclReportUrlService } from './wcl-report-url-service';

const urlService = TestBed.inject(WclReportUrlService);

const CODE = 'AbCdEfGh12345678';

describe('WclReportUrlService.parse', () => {
  it('extracts the code from a full report URL with no fight/source', () => {
    expect(urlService.parse(`https://www.warcraftlogs.com/reports/${CODE}`))
      .toEqual({ code: CODE, fightId: null, sourceId: null });
  });

  it('accepts a bare 16-character code', () => {
    expect(urlService.parse(CODE)).toEqual({ code: CODE, fightId: null, sourceId: null });
  });

  it('reads a numeric fight and a source id from the hash', () => {
    expect(urlService.parse(`https://www.warcraftlogs.com/reports/${CODE}#fight=3&source=17`))
      .toEqual({ code: CODE, fightId: 3, sourceId: 17 });
  });

  it('keeps a literal "last" fight distinct from a resolved number', () => {
    expect(urlService.parse(`https://www.warcraftlogs.com/reports/${CODE}#fight=last`))
      .toEqual({ code: CODE, fightId: 'last', sourceId: null });
  });

  it('trims surrounding whitespace from a pasted value', () => {
    expect(urlService.parse(`  ${CODE}  `)).toEqual({ code: CODE, fightId: null, sourceId: null });
  });

  it('rejects a code shorter than 16 characters', () => {
    expect(urlService.parse(CODE.slice(0, 15))).toBeNull();
  });

  it('rejects a code exactly 16 characters, still invalid as garbage input', () => {
    // Boundary: 16 chars is the valid length, but non-alphanumeric content still fails.
    expect(urlService.parse('not a report!!!!')).toBeNull();
  });

  it('rejects an unrelated URL with no /reports/ path', () => {
    expect(urlService.parse('https://www.warcraftlogs.com/character/1')).toBeNull();
  });
});
