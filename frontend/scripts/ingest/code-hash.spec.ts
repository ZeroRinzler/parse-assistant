import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { computeCodeHash, codeHashSources } from './code-hash.ts';

describe('codeHashSources', () => {
  it('lists every output-determining source file and they all exist on disk', () => {
    const files = codeHashSources();
    // 5 transforms + 5 data-sources + 4 API/transport files.
    expect(files).toHaveLength(14);
    for (const file of files) {
      expect(fs.existsSync(file), `missing source file: ${file}`).toBe(true);
    }
  });

  it('returns the files in a stable, sorted order', () => {
    const files = codeHashSources();
    expect(files).toEqual([...files].sort());
  });

  it('covers all 5 transform services and the two API services', () => {
    const joined = codeHashSources().join('\n');
    for (const slice of ['burst', 'rotation', 'defensive', 'gear', 'map']) {
      expect(joined).toContain(`${slice}-transform.service.ts`);
    }
    expect(joined).toContain('wcl-api.ts');
    expect(joined).toContain('data-file-api.ts');
  });
});

describe('computeCodeHash', () => {
  it('produces a 12-char lowercase hex hash', () => {
    const hash = computeCodeHash();
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic across calls', () => {
    expect(computeCodeHash()).toBe(computeCodeHash());
  });
});
