import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SpecTalents } from '../models/talent.models';
import { Result, LoadError, ok, missing } from '../result';
import { toLoadError } from '../http-load-error';
import { logWarn } from '../log';

const DUMP_URL = 'https://www.raidbots.com/static/data/live/talents.json';
// subTreeNodes carries the hero-tree pick.
const NODE_BUCKETS = ['classNodes', 'specNodes', 'heroNodes', 'subTreeNodes'] as const;

interface RaidbotsEntry { id?: number; name?: string; icon?: string; spellId?: number }
type RaidbotsNode = Partial<Record<(typeof NODE_BUCKETS)[number], never>> & { entries?: RaidbotsEntry[] };
type RaidbotsTree = { className: string; specName: string } & Record<(typeof NODE_BUCKETS)[number], RaidbotsNode[] | undefined>;

/** Must match the app's WCL-derived `{spec}{class}` folder key. */
function specKey(tree: RaidbotsTree): string {
  return `${tree.specName}${tree.className}`.replace(/[^A-Za-z]/g, '');
}

function talentsOf(tree: RaidbotsTree): SpecTalents {
  const talents: SpecTalents = {};
  for (const bucket of NODE_BUCKETS) {
    for (const node of tree[bucket] ?? []) {
      for (const entry of node.entries ?? []) {
        if (entry.id == null) continue;
        talents[entry.id] = { name: entry.name ?? '', icon: entry.icon ?? '', ...(entry.spellId ? { spellId: entry.spellId } : {}) };
      }
    }
  }
  return talents;
}

export function indexTalentTrees(trees: RaidbotsTree[]): Map<string, SpecTalents> {
  return new Map(trees.map(tree => [specKey(tree), talentsOf(tree)]));
}

@Injectable({ providedIn: 'root' })
export class TalentDataService {
  private readonly http = inject(HttpClient);

  async getTalents(spec: string): Promise<Result<SpecTalents, LoadError>> {
    try {
      const trees = await firstValueFrom(this.http.get<RaidbotsTree[]>(DUMP_URL));
      const talents = indexTalentTrees(trees).get(spec);
      return talents ? ok(talents) : missing('No talent data for this spec.');
    } catch (cause) {
      logWarn('TalentDataService dump fetch', cause);
      return toLoadError(cause, 'talent-data.dump');
    }
  }
}
