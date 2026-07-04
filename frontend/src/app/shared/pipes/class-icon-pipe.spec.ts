import { describe, it, expect } from 'vitest';
import { ClassIconPipe } from './class-icon-pipe';

const pipe = new ClassIconPipe();

describe('ClassIconPipe', () => {
  it.each([
    { input: null,           expected: '', why: 'null coalesces to the empty class name, which is unknown' },
    { input: undefined,      expected: '', why: 'undefined coalesces to the empty class name' },
    { input: '',             expected: '', why: 'empty class name yields no icon' },
    { input: 'Rogue',        expected: 'https://wow.zamimg.com/images/wow/icons/small/class_rogue.jpg', why: 'delegation row; URL shape pinned in spec-meta.spec.ts' },
    { input: 'Death Knight', expected: 'https://wow.zamimg.com/images/wow/icons/small/class_deathknight.jpg', why: 'spaced class name from actor subType resolves' },
    { input: 'Unknown',      expected: '', why: 'unknown class yields no icon' },
  ] as { input: string | null | undefined; expected: string; why: string }[])(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
