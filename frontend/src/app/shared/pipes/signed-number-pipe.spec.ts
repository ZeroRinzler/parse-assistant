import { describe, it, expect } from 'vitest';
import { SignedNumberPipe } from './signed-number-pipe';

const pipe = new SignedNumberPipe();

describe('SignedNumberPipe', () => {
  it.each([
    { input: null,      expected: '',    why: 'null returns blank - no delta to show' },
    { input: undefined, expected: '',    why: 'undefined returns blank' },
    { input: 0,         expected: '0',   why: 'zero is neither ahead nor behind, so no sign' },
    { input: 123,       expected: '+123', why: 'positive delta gets an explicit plus sign' },
    { input: -981,      expected: '-981', why: 'negative delta keeps its natural minus sign' },
    { input: 12.4,      expected: '+12',  why: 'fractional delta rounds to whole number' },
    { input: -4.6,      expected: '-5',   why: 'negative fractional delta rounds to nearest whole' },
    { input: -0.4,      expected: '0',    why: 'a small negative that rounds to zero drops the sign (no "-0")' },
    { input: 0.4,       expected: '0',    why: 'a small positive that rounds to zero drops the sign (no "+0")' },
    { input: 0.6,       expected: '+1',   why: 'a positive rounding up keeps its plus sign' },
    { input: NaN,       expected: '',    why: 'NaN returns blank, never the literal "NaN"' },
    { input: Infinity,  expected: '',    why: 'a non-finite delta returns blank' },
  ] as { input: number | null | undefined; expected: string; why: string }[])(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
