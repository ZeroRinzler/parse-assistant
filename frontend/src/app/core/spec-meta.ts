// The browser hydrates the cache once at startup (an app initializer); the headless ingest runtime hydrates it explicitly.
import type { SpecMeta } from './models/spec-meta.models';

export type { SpecMeta };

const ZAM = 'https://wow.zamimg.com/images/wow/icons/small';

/** Class-icon stem for a class name (space-tolerant): 'Death Knight' -> 'class_deathknight'. */
function classIconStem(className: string): string {
  return `class_${className.toLowerCase().replace(/ /g, '')}`;
}

/** The hydrated spec universe (folder key -> meta) and the set of real class-icon stems. */
let META: Record<string, SpecMeta> = {};
let KNOWN_CLASS_ICONS = new Set<string>();

// Idempotent - a later call replaces the cache.
export function hydrateSpecMeta(metas: SpecMeta[] | Record<string, SpecMeta>): void {
  const list = Array.isArray(metas) ? metas : Object.values(metas);
  META = Object.fromEntries(list.map(meta => [meta.spec, meta]));
  KNOWN_CLASS_ICONS = new Set(list.map(meta => meta.classIcon));
}

/** One entry per class, in stable display order, for the Class dropdown. */
export function classList(): { className: string; classLabel: string; classIcon: string }[] {
  const byClass = new Map<string, { className: string; classLabel: string; classIcon: string }>();
  for (const meta of Object.values(META)) {
    if (!byClass.has(meta.className)) {
      byClass.set(meta.className, { className: meta.className, classLabel: meta.classLabel, classIcon: meta.classIcon });
    }
  }
  return [...byClass.values()].sort((first, second) => first.classLabel.localeCompare(second.classLabel));
}

/** Spec metas for `className`, restricted to the `available` folder keys (those with data), sorted by spec label. */
export function specsForClass(className: string, available: string[]): SpecMeta[] {
  return available
    .map(spec => META[spec])
    .filter((meta): meta is SpecMeta => !!meta && meta.className === className)
    .sort((first, second) => first.specLabel.localeCompare(second.specLabel));
}

export function specMetaOf(spec: string | null | undefined): SpecMeta | undefined {
  return spec ? META[spec] : undefined;
}

// Returns '' for an unknown class, so a name-only fallback never shows a broken image.
export function classIconUrl(className: string): string {
  const stem = classIconStem(className);
  return KNOWN_CLASS_ICONS.has(stem) ? `${ZAM}/${stem}.jpg` : '';
}

/** zamimg spec-icon URL for a spec folder key, or '' when the spec is unknown or has no baked stem. */
export function specIconUrl(spec: string): string {
  const meta = META[spec];
  return meta && meta.specIcon ? `${ZAM}/${meta.specIcon}.jpg` : '';
}
