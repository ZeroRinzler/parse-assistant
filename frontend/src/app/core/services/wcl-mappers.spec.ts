import { describe, it, expect } from 'vitest';
import { talentKeyFromTree, decodeHtmlEntities } from './wcl-mappers';

describe('talentKeyFromTree', () => {
  it('returns empty string for undefined input', () => {
    expect(talentKeyFromTree(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(talentKeyFromTree([])).toBe('');
  });

  it('builds a v2: key from nodeIDs in string-sorted order', () => {
    const tree = [{ nodeID: 90640 }, { nodeID: 90692 }, { nodeID: 90638 }];
    expect(talentKeyFromTree(tree)).toBe('v2:90638,90640,90692');
  });

  it('includes duplicate nodeIDs (no dedup - matches ingest)', () => {
    const tree = [{ nodeID: 110416 }, { nodeID: 110416 }, { nodeID: 110416 }, { nodeID: 90638 }];
    // string sort: '110416' < '90638' because '1' < '9'
    expect(talentKeyFromTree(tree)).toBe('v2:110416,110416,110416,90638');
  });

  it('skips entries with null/undefined nodeID', () => {
    const tree = [{ nodeID: 90640 }, { nodeID: undefined }, { nodeID: 90692 }];
    expect(talentKeyFromTree(tree)).toBe('v2:90640,90692');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes &amp; to &', () => {
    expect(decodeHtmlEntities('+41 Intellect &amp; +115 Stamina')).toBe('+41 Intellect & +115 Stamina');
  });

  it('decodes multiple entity types', () => {
    expect(decodeHtmlEntities('&lt;b&gt;test&lt;/b&gt;')).toBe('<b>test</b>');
  });

  it('leaves plain text unchanged', () => {
    expect(decodeHtmlEntities('Gaze of the Alnseer')).toBe('Gaze of the Alnseer');
  });
});
