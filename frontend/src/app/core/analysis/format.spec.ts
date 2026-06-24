import { describe, it, expect } from 'vitest';
import { fmtClock } from './format';

describe('fmtClock', () => {
  it.each([
    { input: 0,    expected: '00:00', why: 'zero: both parts zero-padded' },
    { input: 9,    expected: '00:09', why: 'single-digit seconds, zero-padded minutes too' },
    { input: 65,   expected: '01:05', why: 'both minutes and seconds are zero-padded when < 10' },
    { input: 600,  expected: '10:00', why: 'exact ten minutes' },
    { input: 3661, expected: '61:01', why: 'minutes can exceed 59 (long fights / wipes)' },
  ])('fmtClock($input) === "$expected" ($why)', ({ input, expected }) => {
    expect(fmtClock(input)).toBe(expected);
  });
});
