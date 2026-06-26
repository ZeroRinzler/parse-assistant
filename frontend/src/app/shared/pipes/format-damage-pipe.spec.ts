import { describe, it, expect } from 'vitest';
import { FormatDamagePipe } from './format-damage-pipe';

const pipe = new FormatDamagePipe();

describe('FormatDamagePipe', () => {
  it.each([
    { input: null,        expected: '',       why: 'null is falsy - no damage to show' },
    { input: undefined,   expected: '',       why: 'undefined is falsy' },
    { input: 0,           expected: '',       why: '0 is falsy - intentionally blank rather than "0"' },
    { input: 500,         expected: '500',    why: 'sub-1K rounds to integer' },
    { input: 999,         expected: '999',    why: 'just below K threshold' },
    { input: 1_000,       expected: '1K',     why: 'exact lower boundary for the K branch' },
    { input: 8_500,       expected: '9K',     why: 'rounds up to nearest K' },
    { input: 999_999,     expected: '1.0M',   why: 'rounds up to 1.0M, not the nonsensical 1000K' },
    { input: 1_000_000,   expected: '1.0M',   why: 'exact lower boundary for the M branch' },
    { input: 1_240_000,   expected: '1.2M',   why: 'typical raider damage number' },
  ] as { input: number | null | undefined; expected: string; why: string }[])(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
