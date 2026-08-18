// Ranking selection is the shared `toParseRankings` (shared/analysis/wcl-projections.ts).

import type { ClassesQuery, EncountersQuery } from '../core/services/wcl-operations.generated';
import type { IngestEncounter } from './models/wcl.models';
import type { SpecMeta } from '../core/models/spec-meta.models';

export type WclExpansions = NonNullable<NonNullable<EncountersQuery['worldData']>['expansions']>;
export type WclGameClasses = NonNullable<NonNullable<ClassesQuery['gameData']>['classes']>;

/** Folder key -> [WCL className, WCL specName] - the small map the discovery fetchers read. */
export type SpecWclMap = Record<string, [string, string]>;

/** The folder key is `spec.slug + class.slug` (e.g. 'SubtletyRogue'). */
export function mapClassesToSpecMeta(classes: WclGameClasses): SpecMeta[] {
  const metas: SpecMeta[] = [];
  for (const cls of classes) {
    if (!cls) continue;
    const classIcon = `class_${cls.slug.toLowerCase()}`;
    for (const spec of cls.specs ?? []) {
      if (!spec) continue;
      const folder = `${spec.slug}${cls.slug}`;
      metas.push({
        spec: folder,
        className: cls.slug,
        specName: spec.slug,
        classLabel: cls.name,
        specLabel: spec.name,
        classIcon,
        specIcon: '',
      });
    }
  }
  return metas;
}

export function specWclFromMetas(metas: SpecMeta[]): SpecWclMap {
  const map: SpecWclMap = {};
  for (const meta of metas) map[meta.spec] = [meta.className, meta.specName];
  return map;
}

const EXCLUDE_ZONE_PATTERNS = ['beta', 'ptr', 'mythic+', 'complete raids', 'delves', 'torghast'];

// WCL returns newest expansion first, so only the first expansion's zones are used.
export function filterEncounters(expansions: WclExpansions): IngestEncounter[] {
  const result: IngestEncounter[] = [];
  const firstExpansion = expansions[0];
  if (!firstExpansion) return result;

  for (const zone of (firstExpansion.zones ?? [])) {
    // WCL omits `frozen` on some zones though the schema declares it non-null, so an absent one has to read as not-frozen.
    if (!zone || zone.frozen) continue;
    const zoneName = zone.name.toLowerCase();
    if (EXCLUDE_ZONE_PATTERNS.some(pattern => zoneName.includes(pattern))) continue;
    const partitionIds = (zone.partitions ?? [])
      .filter(partition => partition !== null)
      .map(partition => partition.id)
      .sort((a, b) => b - a);
    for (const encounter of (zone.encounters ?? [])) {
      if (!encounter) continue;
      result.push({ id: encounter.id, name: encounter.name, zone: zone.name, zoneId: zone.id, partitionIds });
    }
  }
  return result;
}

// Keyed by zone id, since zones can share a name - e.g. a live and a PTR copy of the same raid.
export function groupEncountersByZone(encounters: IngestEncounter[]): Map<number, IngestEncounter[]> {
  const groups = new Map<number, IngestEncounter[]>();
  for (const encounter of encounters) {
    const group = groups.get(encounter.zoneId);
    if (group) group.push(encounter);
    else groups.set(encounter.zoneId, [encounter]);
  }
  return groups;
}

// This is the prune-protected set: pruning never deletes on-disk data for an id here, so a live zone that transiently fails its liveness probe is never wiped.
export function protectedEncounterIds(expansions: WclExpansions): Set<number> {
  const ids = new Set<number>();
  const firstExpansion = expansions[0];
  if (!firstExpansion) return ids;
  for (const zone of (firstExpansion.zones ?? [])) {
    if (!zone || zone.frozen) continue;
    for (const encounter of (zone.encounters ?? [])) {
      if (encounter) ids.add(encounter.id);
    }
  }
  return ids;
}
