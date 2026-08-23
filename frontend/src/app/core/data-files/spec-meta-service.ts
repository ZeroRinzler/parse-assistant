import { Injectable, inject, signal } from '@angular/core';
import { DataFileApiService } from './data-file-api-service';
import type { SpecMeta } from './spec-meta.models';

export type { SpecMeta };

const ZAM = 'https://wow.zamimg.com/images/wow/icons/small';

/** A spec universe: folder key -> meta, plus the set of real class-icon stems. */
export interface SpecUniverse {
  metas: Record<string, SpecMeta>;
  classIcons: Set<string>;
}

/** The hydrated spec universe; loads itself on first injection. */
@Injectable({ providedIn: 'root' })
export class SpecMetaService {
  private readonly universe = signal<SpecUniverse>(this.buildUniverse([]));
  private markHydrated!: () => void;
  private readonly hydrated = new Promise<void>(resolve => { this.markHydrated = resolve; });

  constructor() {
    const dataFile = inject(DataFileApiService);
    // Not awaited - nothing rendered at boot reads spec-meta, so the fetch must not gate anything.
    void dataFile.getSpecMeta().then(result => { this.hydrate(result.ok ? result.value : []); });
  }

  // Idempotent - a later call replaces the cache.
  hydrate(metas: SpecMeta[]): void {
    this.universe.set(this.buildUniverse(metas));
    this.markHydrated();
  }

  /** specMetaOf, deferred until hydration lands - for callers outside a reactive context. */
  async resolve(spec: string | null | undefined): Promise<SpecMeta | undefined> {
    await this.hydrated;
    return this.specMetaOf(this.universe(), spec);
  }

  classList(): { className: string; classLabel: string; classIcon: string }[] {
    return this.classListOf(this.universe());
  }

  specsForClass(className: string, available: string[]): SpecMeta[] {
    return this.specsForClassOf(this.universe(), className, available);
  }

  classIconUrl(className: string): string {
    return this.classIconUrlOf(this.universe(), className);
  }

  specIconUrl(spec: string): string {
    return this.specIconUrlOf(this.universe(), spec);
  }

  /** Class-icon stem for a class name (space-tolerant): 'Death Knight' -> 'class_deathknight'. */
  private classIconStem(className: string): string {
    return `class_${className.toLowerCase().replace(/ /g, '')}`;
  }

  buildUniverse(metas: SpecMeta[]): SpecUniverse {
    return {
      metas: Object.fromEntries(metas.map(meta => [meta.spec, meta])),
      classIcons: new Set(metas.map(meta => meta.classIcon)),
    };
  }

  /** One entry per class, in stable display order, for the Class dropdown. */
  protected classListOf(universe: SpecUniverse): { className: string; classLabel: string; classIcon: string }[] {
    const byClass = new Map<string, { className: string; classLabel: string; classIcon: string }>();
    for (const meta of Object.values(universe.metas)) {
      if (!byClass.has(meta.className)) {
        byClass.set(meta.className, { className: meta.className, classLabel: meta.classLabel, classIcon: meta.classIcon });
      }
    }
    return [...byClass.values()].sort((first, second) => first.classLabel.localeCompare(second.classLabel));
  }

  /** Spec metas for `className`, restricted to the `available` folder keys (those with data), sorted by spec label. */
  protected specsForClassOf(universe: SpecUniverse, className: string, available: string[]): SpecMeta[] {
    return available
      .map(spec => universe.metas[spec])
      .filter((meta): meta is SpecMeta => !!meta && meta.className === className)
      .sort((first, second) => first.specLabel.localeCompare(second.specLabel));
  }

  specMetaOf(universe: SpecUniverse, spec: string | null | undefined): SpecMeta | undefined {
    return spec ? universe.metas[spec] : undefined;
  }

  // Returns '' for an unknown class, so a name-only fallback never shows a broken image.
  protected classIconUrlOf(universe: SpecUniverse, className: string): string {
    const stem = this.classIconStem(className);
    return universe.classIcons.has(stem) ? `${ZAM}/${stem}.jpg` : '';
  }

  /** zamimg spec-icon URL for a spec folder key, or '' when the spec is unknown or has no baked stem. */
  protected specIconUrlOf(universe: SpecUniverse, spec: string): string {
    const meta = universe.metas[spec];
    return meta?.specIcon ? `${ZAM}/${meta.specIcon}.jpg` : '';
  }
}
