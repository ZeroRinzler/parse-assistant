import { describe, it, expect } from 'vitest';
import { FormatSpecPipe } from './format-spec-pipe';

const pipe = new FormatSpecPipe();

describe('FormatSpecPipe', () => {
  it.each([
    { input: null,                  expected: '',                    why: 'null is falsy' },
    { input: undefined,             expected: '',                    why: 'undefined is falsy' },
    { input: '',                    expected: '',                    why: 'empty string is falsy' },
    { input: 'Rogue',               expected: 'Rogue',               why: 'single-word spec: regex inserts leading space then trim removes it' },
    { input: 'SubtletyRogue',       expected: 'Subtlety Rogue',      why: 'typical WCL two-word spec name' },
    { input: 'BeastMasteryHunter',  expected: 'Beast Mastery Hunter', why: 'three words' },
    { input: 'FrostDeathKnight',    expected: 'Frost Death Knight',  why: 'multi-word class name' },
  ] as Array<{ input: string | null | undefined; expected: string; why: string }>)(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
