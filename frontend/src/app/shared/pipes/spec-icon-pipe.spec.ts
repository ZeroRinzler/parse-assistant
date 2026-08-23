import { describe, it, expect, beforeAll } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SpecIconPipe } from './spec-icon-pipe';
import { SpecMetaService } from '../../core/data-files/spec-meta-service';
import { DataFileApiService } from '../../core/data-files/data-file-api-service';

let pipe: SpecIconPipe;

// The spec icon comes from the hydrated spec universe; seed the spec this row uses.
beforeAll(() => {
  TestBed.configureTestingModule({
    providers: [{ provide: DataFileApiService, useValue: { getSpecMeta: () => new Promise(() => undefined) } }],
  });
  TestBed.inject(SpecMetaService).hydrate([
    { spec: 'SubtletyRogue', className: 'Rogue', specName: 'Subtlety', classLabel: 'Rogue', specLabel: 'Subtlety', classIcon: 'class_rogue', specIcon: 'ability_stealth' },
  ]);
  pipe = TestBed.runInInjectionContext(() => new SpecIconPipe());
});

describe('SpecIconPipe', () => {
  it.each([
    { input: null,            expected: '', why: 'null is falsy - no spec selected' },
    { input: undefined,       expected: '', why: 'undefined is falsy' },
    { input: '',              expected: '', why: 'empty string is falsy' },
    { input: 'SubtletyRogue', expected: 'https://wow.zamimg.com/images/wow/icons/small/ability_stealth.jpg', why: 'delegation row; shape pinned in spec-meta.spec.ts' },
    { input: 'Bogus',         expected: '', why: 'unknown spec folder yields no icon' },
  ] as { input: string | null | undefined; expected: string; why: string }[])(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
