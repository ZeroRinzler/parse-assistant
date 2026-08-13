import { describe, it, expect, beforeAll } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ClassIconPipe } from './class-icon-pipe';
import { SpecMetaService } from '../../core/services/spec-meta';
import { DataFileApiService } from '../../core/services/data-file-api';

let pipe: ClassIconPipe;

// The class icon comes from the hydrated spec universe; seed the one spec these rows use.
beforeAll(() => {
  TestBed.configureTestingModule({
    providers: [{ provide: DataFileApiService, useValue: { getSpecMeta: () => new Promise(() => undefined) } }],
  });
  TestBed.inject(SpecMetaService).hydrate([
    { spec: 'SubtletyRogue', className: 'Rogue', specName: 'Subtlety', classLabel: 'Rogue', specLabel: 'Subtlety', classIcon: 'class_rogue', specIcon: 'ability_stealth' },
  ]);
  pipe = TestBed.runInInjectionContext(() => new ClassIconPipe());
});

describe('ClassIconPipe', () => {
  it.each([
    { input: null,           expected: '', why: 'null coalesces to the empty class name, which is unknown' },
    { input: undefined,      expected: '', why: 'undefined coalesces to the empty class name' },
    { input: '',             expected: '', why: 'empty class name yields no icon' },
    { input: 'Rogue',        expected: 'https://wow.zamimg.com/images/wow/icons/small/class_rogue.jpg', why: 'delegation row; URL shape pinned in spec-meta.spec.ts' },
    { input: 'Unknown',      expected: '', why: 'unknown class yields no icon' },
  ] as { input: string | null | undefined; expected: string; why: string }[])(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
