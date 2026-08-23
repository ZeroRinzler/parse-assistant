import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { SpecTalents } from '../../domain/gear/talent.models';
import { Result, Results } from './result';
import { HttpLoadErrors } from './http-load-error';
import { LoggerService } from '../observability/logger-service';

const DUMP_URL = 'https://www.raidbots.com/static/data/live/talents.json';

// subTreeNodes carries the hero-tree pick.
const NODE_BUCKETS = ['classNodes', 'specNodes', 'heroNodes', 'subTreeNodes'] as const;

interface RaidbotsEntry { id?: number; name?: string; icon?: string; spellId?: number }
type RaidbotsNode = Partial<Record<(typeof NODE_BUCKETS)[number], never>> & { entries?: RaidbotsEntry[] };
type RaidbotsTree = { className: string; specName: string } & Record<(typeof NODE_BUCKETS)[number], RaidbotsNode[] | undefined>;

@Injectable({ providedIn: 'root' })
export class TalentDataService {
  private readonly logger = inject(LoggerService);
  private readonly http = inject(HttpClient);

  async getTalents(spec: string): Promise<Result<SpecTalents>> {
    try {
      const trees = await firstValueFrom(this.http.get<RaidbotsTree[]>(DUMP_URL));
      const talents = this.indexTalentTrees(trees).get(spec);
      return talents ? Results.ok(talents) : Results.missing('No talent data for this spec.');
    } catch (cause) {
      this.logger.logWarn('TalentDataService dump fetch', cause);
      return HttpLoadErrors.toLoadError(cause, 'talent-data.dump');
    }
  }

  /** Must match the app's WCL-derived `{spec}{class}` folder key. */
  private specKey(tree: RaidbotsTree): string {
    return `${tree.specName}${tree.className}`.replace(/[^A-Za-z]/g, '');
  }

  private nodeTalents(node: RaidbotsNode): SpecTalents {
    const talents: SpecTalents = {};
    for (const entry of node.entries ?? []) {
      if (entry.id == null) continue;
      talents[entry.id] = { name: entry.name ?? '', icon: entry.icon ?? '', ...(entry.spellId ? { spellId: entry.spellId } : {}) };
    }
    return talents;
  }

  private talentsOf(tree: RaidbotsTree): SpecTalents {
    const talents: SpecTalents = {};
    for (const bucket of NODE_BUCKETS) {
      for (const node of tree[bucket] ?? []) Object.assign(talents, this.nodeTalents(node));
    }
    return talents;
  }

  protected indexTalentTrees(trees: RaidbotsTree[]): Map<string, SpecTalents> {
    return new Map(trees.map(tree => [this.specKey(tree), this.talentsOf(tree)]));
  }
}
