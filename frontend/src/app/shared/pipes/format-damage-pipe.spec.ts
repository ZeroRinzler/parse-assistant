import { describe, it, expect } from 'vitest';
import { FormatDamagePipe } from './format-damage-pipe';

const pipe = new FormatDamagePipe();

describe('FormatDamagePipe', () => {
  it.each([
    { input: null,        expected: '',       why: 'null means no measurement to show' },
    { input: undefined,   expected: '',       why: 'undefined means no measurement to show' },
    { input: 0,           expected: '0',      why: '0 is a real measurement (a fully immuned window), not absent' },
    { input: 500,         expected: '500',    why: 'sub-1K rounds to integer' },
    { input: 999,         expected: '999',    why: 'just below K threshold' },
    { input: 1_000,       expected: '1K',     why: 'exact lower boundary for the K unit' },
    { input: 8_500,       expected: '8.5K',   why: 'one decimal keeps the tenths of a K' },
    { input: 999_999,     expected: '1M',     why: 'rounds up to 1M, not the nonsensical 1000K' },
    { input: 1_000_000,   expected: '1M',     why: 'exact lower boundary for the M unit' },
    { input: 1_240_000,   expected: '1.2M',   why: 'typical raider damage number' },
  ] as { input: number | null | undefined; expected: string; why: string }[])(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
