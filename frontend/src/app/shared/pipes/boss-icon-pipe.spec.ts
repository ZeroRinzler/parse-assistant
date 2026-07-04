import { describe, it, expect } from 'vitest';
import { BossIconPipe } from './boss-icon-pipe';

const pipe = new BossIconPipe();

describe('BossIconPipe', () => {
  it.each([
    { input: null,      expected: '', why: 'null - no encounter selected' },
    { input: undefined, expected: '', why: 'undefined is falsy' },
    { input: 0,         expected: '', why: '0 is the trash-fight encounter id and falsy - no boss icon' },
    { input: 3176,      expected: 'https://assets.rpglogs.com/img/warcraft/bosses/3176-icon.jpg', why: 'Midnight raid boss id maps straight into the rpglogs icon URL' },
  ] as { input: number | null | undefined; expected: string; why: string }[])(
    'transform($input) === "$expected" ($why)',
    ({ input, expected }) => {
      expect(pipe.transform(input)).toBe(expected);
    },
  );
});
