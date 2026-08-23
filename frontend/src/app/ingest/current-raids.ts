import { logWarn } from '../core/log';
import type { WclApiService } from '../core/services/wcl-api';
import type { WclClass, WclExpansion, WclZone } from '../core/models/wcl.models';
import type { SpecMeta } from '../core/models/spec-meta.models';
import type { IngestEncounter } from './models/wcl.models';

interface CurrentRaids {
  encounters: IngestEncounter[];
  protectedIds: Set<number>;
}

// Not retried: the limit resets on an hourly boundary and an hourly task must not stall waiting for it.
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

export function parseRaidNames(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').map(name => name.trim()).filter(name => name.length > 0);
}

export async function discoverCurrentRaids(wclApi: WclApiService, raidNames: string[]): Promise<CurrentRaids> {
  const expansions = await wclApi.getZoneTree();
  // An absent expansion tree would resolve no encounter and prune every spec's data.
  if (!expansions) throw new Error('WCL returned no worldData.expansions.');
  const encounters = encountersForRaids(expansions, raidNames);
  return { encounters, protectedIds: new Set(encounters.map(encounter => encounter.id)) };
}

export async function discoverSpecMetas(wclApi: WclApiService): Promise<SpecMeta[]> {
  return mapClassesToSpecMeta(await wclApi.getPlayableClasses());
}

export async function assertPointsBudget(wclApi: WclApiService, margin: number): Promise<void> {
  const budget = await wclApi.getPointsBudget();
  if (!budget) return;
  const remaining = budget.limitPerHour - budget.pointsSpentThisHour;
  if (remaining < margin) {
    throw new BudgetExceededError(`WCL budget low: ${remaining} of ${budget.limitPerHour} remaining (need ${margin})`);
  }
}

const zoneKey = (name: string): string => name.trim().toLowerCase();

/** WCL keeps a frozen copy of a raid under the same name, with different encounter ids. */
function currentZoneNamed(expansions: WclExpansion[], name: string): WclZone | null {
  const matches = (expansions[0]?.zones ?? [])
    .filter(zone => !zone.frozen && zoneKey(zone.name) === zoneKey(name));
  return matches.sort((a, b) => b.id - a.id)[0] ?? null;
}

function encountersForRaids(expansions: WclExpansion[], raidNames: string[]): IngestEncounter[] {
  const result: IngestEncounter[] = [];
  for (const name of raidNames) {
    const zone = currentZoneNamed(expansions, name);
    if (!zone) {
      logWarn('encountersForRaids', `no current WCL zone named "${name}" - check the CURRENT_RAIDS variable`);
      continue;
    }
    const partitionIds = (zone.partitions ?? []).map(partition => partition.id).sort((a, b) => b - a);
    for (const encounter of (zone.encounters ?? [])) {
      result.push({ id: encounter.id, name: encounter.name, zone: zone.name, zoneId: zone.id, partitionIds });
    }
  }
  return result;
}

/** The folder key is `spec.slug + class.slug` (e.g. 'SubtletyRogue'). */
function mapClassesToSpecMeta(classes: WclClass[]): SpecMeta[] {
  const metas: SpecMeta[] = [];
  for (const cls of classes) {
    const classIcon = `class_${cls.slug.toLowerCase()}`;
    for (const spec of cls.specs ?? []) {
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
