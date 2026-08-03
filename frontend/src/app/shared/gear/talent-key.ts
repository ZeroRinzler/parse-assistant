import { WclTalentNode } from '../../core/models/wcl.models';

export interface TalentPick {
  entryId: number;
  rank: number;
}

const KEY_PREFIX = 'v3';
const PICK_SEPARATOR = ',';
const FIELD_SEPARATOR = '.';

// Keyed by entry, not node: WCL can report the same talent under a different nodeID, which would split one build.
export function talentKeyFromTree(tree: WclTalentNode[] | undefined): string {
  const picks = (tree ?? [])
    .filter(node => node.id != null)
    .map(node => ({ entryId: node.id!, rank: node.rank ?? 1 }))
    .sort((a, b) => a.entryId - b.entryId);
  if (!picks.length) return '';
  const body = picks
    .map(pick => [pick.entryId, pick.rank].join(FIELD_SEPARATOR))
    .join(PICK_SEPARATOR);
  return `${KEY_PREFIX}:${body}`;
}

export function parseTalentKey(key: string): TalentPick[] {
  const [prefix, body] = key.split(':');
  if (prefix !== KEY_PREFIX || !body) return [];
  return body.split(PICK_SEPARATOR).reduce<TalentPick[]>((picks, part) => {
    const [entryId, rank] = part.split(FIELD_SEPARATOR).map(Number);
    if (Number.isFinite(entryId) && Number.isFinite(rank)) picks.push({ entryId, rank });
    return picks;
  }, []);
}
