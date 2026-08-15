import { Injectable, inject, signal } from '@angular/core';
import { DataFileApiService } from './data-file-api';
import type { SpecMeta } from '../models/spec-meta.models';

export type { SpecMeta };

const ZAM = 'https://wow.zamimg.com/images/wow/icons/small';

/** A spec universe: folder key -> meta, plus the set of real class-icon stems. */
export interface SpecUniverse {
  metas: Record<string, SpecMeta>;
  classIcons: Set<string>;
}

/** Class-icon stem for a class name (space-tolerant): 'Death Knight' -> 'class_deathknight'. */
function classIconStem(className: string): string {
  return `class_${className.toLowerCase().replace(/ /g, '')}`;
}

export function buildUniverse(metas: SpecMeta[]): SpecUniverse {
  return {
    metas: Object.fromEntries(metas.map(meta => [meta.spec, meta])),
    classIcons: new Set(metas.map(meta => meta.classIcon)),
  };
}

/** One entry per class, in stable display order, for the Class dropdown. */
export function classList(universe: SpecUniverse): { className: string; classLabel: string; classIcon: string }[] {
  const byClass = new Map<string, { className: string; classLabel: string; classIcon: string }>();
  for (const meta of Object.values(universe.metas)) {
    if (!byClass.has(meta.className)) {
      byClass.set(meta.className, { className: meta.className, classLabel: meta.classLabel, classIcon: meta.classIcon });
    }
  }
  return [...byClass.values()].sort((first, second) => first.classLabel.localeCompare(second.classLabel));
}

/** Spec metas for `className`, restricted to the `available` folder keys (those with data), sorted by spec label. */
export function specsForClass(universe: SpecUniverse, className: string, available: string[]): SpecMeta[] {
  return available
    .map(spec => universe.metas[spec])
    .filter((meta): meta is SpecMeta => !!meta && meta.className === className)
    .sort((first, second) => first.specLabel.localeCompare(second.specLabel));
}

export function specMetaOf(universe: SpecUniverse, spec: string | null | undefined): SpecMeta | undefined {
  return spec ? universe.metas[spec] : undefined;
}

// Returns '' for an unknown class, so a name-only fallback never shows a broken image.
export function classIconUrl(universe: SpecUniverse, className: string): string {
  const stem = classIconStem(className);
  return universe.classIcons.has(stem) ? `${ZAM}/${stem}.jpg` : '';
}

/** zamimg spec-icon URL for a spec folder key, or '' when the spec is unknown or has no baked stem. */
export function specIconUrl(universe: SpecUniverse, spec: string): string {
  const meta = universe.metas[spec];
  return meta?.specIcon ? `${ZAM}/${meta.specIcon}.jpg` : '';
}

/** The hydrated spec universe; loads itself on first injection. */
@Injectable({ providedIn: 'root' })
export class SpecMetaService {
  private readonly universe = signal<SpecUniverse>(buildUniverse([]));
  private markHydrated!: () => void;
  private readonly hydrated = new Promise<void>(resolve => { this.markHydrated = resolve; });

  constructor() {
    const dataFile = inject(DataFileApiService);
    // Not awaited - nothing rendered at boot reads spec-meta, so the fetch must not gate anything.
    void dataFile.getSpecMeta().then(result => { this.hydrate(result.ok ? result.value : []); });
  }

  // Idempotent - a later call replaces the cache.
  hydrate(metas: SpecMeta[]): void {
    this.universe.set(buildUniverse(metas));
    this.markHydrated();
  }

  /** specMetaOf, deferred until hydration lands - for callers outside a reactive context. */
  async resolve(spec: string | null | undefined): Promise<SpecMeta | undefined> {
    await this.hydrated;
    return this.specMetaOf(spec);
  }

  classList(): { className: string; classLabel: string; classIcon: string }[] {
    return classList(this.universe());
  }

  specsForClass(className: string, available: string[]): SpecMeta[] {
    return specsForClass(this.universe(), className, available);
  }

  specMetaOf(spec: string | null | undefined): SpecMeta | undefined {
    return specMetaOf(this.universe(), spec);
  }

  classIconUrl(className: string): string {
    return classIconUrl(this.universe(), className);
  }

  specIconUrl(spec: string): string {
    return specIconUrl(this.universe(), spec);
  }
}
