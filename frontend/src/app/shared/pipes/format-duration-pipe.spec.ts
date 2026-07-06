import { describe, it, expect } from 'vitest';
import { FormatDurationPipe } from './format-duration-pipe';

const pipe = new FormatDurationPipe();

describe('FormatDurationPipe', () => {
  it.each([
    { input: null,      expected: '-',      why: 'null returns the dash placeholder' },
    { input: undefined, expected: '-',      why: 'undefined returns the dash placeholder' },
    { input: 0,         expected: '0:00',   why: 'zero is a valid duration, not null' },
    { input: 65,        expected: '1:05',   why: 'single-digit seconds are zero-padded; minutes are not' },
    { input: 300,       expected: '5:00',   why: 'exact five minutes' },
    { input: 3661,      expected: '61:01',  why: 'minutes can exceed 59 (no capping)' },
    { input: 9.9,       expected: '0:09',   why: 'fractional seconds are floored' },
    { input: -1,        expected: '-0:01',  why: 'a negative time keeps its sign (e.g. pre-pull)' },
    { input: -71,       expected: '-1:11',  why: 'a negative time formats mm:ss with a leading minus' },
    { input: -3661,     expected: '-61:01', why: 'minutes can exceed 59 on a negative time too' },
    { input: NaN,       expected: '0:00',   why: 'a non-finite duration falls back to the zero rendering' },
  ] as { input: number | null | undefined; expected: string; why: string }[])(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
