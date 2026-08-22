import { logWarn } from '../core/log';
import type { ClassesQuery, EncountersQuery } from '../core/services/wcl-operations.generated';
import type { IngestEncounter } from './models/wcl.models';
import type { SpecMeta } from '../core/models/spec-meta.models';

export type WclExpansions = NonNullable<NonNullable<EncountersQuery['worldData']>['expansions']>;
export type WclGameClasses = NonNullable<NonNullable<ClassesQuery['gameData']>['classes']>;

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

export function parseRaidNames(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').map(name => name.trim()).filter(name => name.length > 0);
}

type WclZone = NonNullable<NonNullable<NonNullable<WclExpansions[number]>['zones']>[number]>;

const zoneKey = (name: string): string => name.trim().toLowerCase();

/** WCL keeps a frozen copy of a raid under the same name, with different encounter ids. */
function currentZoneNamed(expansions: WclExpansions, name: string): WclZone | null {
  const matches = (expansions[0]?.zones ?? [])
    // WCL omits `frozen` on some zones though the schema declares it non-null, so an absent one has to read as not-frozen.
    .filter(zone => zone && !zone.frozen && zoneKey(zone.name) === zoneKey(name));
  return matches.sort((a, b) => (b?.id ?? 0) - (a?.id ?? 0))[0] ?? null;
}

export function encountersForRaids(expansions: WclExpansions, raidNames: string[]): IngestEncounter[] {
  const result: IngestEncounter[] = [];
  for (const name of raidNames) {
    const zone = currentZoneNamed(expansions, name);
    if (!zone) {
      logWarn('encountersForRaids', `no current WCL zone named "${name}" - check the CURRENT_RAIDS variable`);
      continue;
    }
    const partitionIds = (zone.partitions ?? [])
      .filter(partition => partition !== null)
      .map(partition => partition.id)
      .sort((a, b) => b - a);
    for (const encounter of (zone.encounters ?? [])) {
      if (encounter) result.push({ id: encounter.id, name: encounter.name, zone: zone.name, zoneId: zone.id, partitionIds });
    }
  }
  return result;
}
