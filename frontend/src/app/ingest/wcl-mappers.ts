/**
 * Pure response-to-model mappers for the ingest discovery layer: no network, no
 * filesystem, no client. Ranking selection is the shared `toParseRankings`
 * (shared/analysis/wcl-projections.ts).
 */

import type { WclExpansion, IngestEncounter, WclGameClass } from './models/wcl.models';
import type { SpecMeta } from '../core/models/spec-meta.models';

/** Folder key -> [WCL className, WCL specName] - the small map the discovery fetchers read. */
export type SpecWclMap = Record<string, [string, string]>;

/**
 * Derive the full spec universe from a WCL `gameData.classes` response. The folder key is
 * `spec.slug + class.slug` (e.g. 'SubtletyRogue'); `className`/`specName` are the class/spec
 * slugs (exactly what the rankings query takes); labels are WCL display names; the class icon
 * is formulaic. The spec icon is left empty here - the orchestrator fills it from the spec's
 * rulebook (`spec_icon`).
 */
export function mapClassesToSpecMeta(classes: WclGameClass[]): SpecMeta[] {
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

/** Project the spec metas to the folder -> [className, specName] map the fetchers read. */
export function specWclFromMetas(metas: SpecMeta[]): SpecWclMap {
  const map: SpecWclMap = {};
  for (const meta of metas) map[meta.spec] = [meta.className, meta.specName];
  return map;
}

const EXCLUDE_ZONE_PATTERNS = ['beta', 'ptr', 'mythic+', 'complete raids', 'delves', 'torghast'];

// Build the candidate current-expansion encounter list from the worldData blob.
// WCL returns newest expansion first, so only the first expansion's zones are used.
// Three structural drops, cheapest first: `frozen: true` zones (superseded tiers and
// aggregate "complete raid" pseudo-zones), then name-excluded zones (Mythic+ dungeons -
// which DO have rankings - plus obvious `(PTR)`/`(Beta)` suffixes). The remaining
// `frozen: false` non-excluded zones are *candidates*; a network liveness probe
// (wcl-fetchers) drops the ones that are still beta/PTR/test (no real rankings).
// Partition IDs are sorted descending so the newest patch partition is tried first.
export function filterEncounters(expansions: WclExpansion[]): IngestEncounter[] {
  const result: IngestEncounter[] = [];
  const firstExpansion = expansions[0];
  if (!firstExpansion) return result;

  for (const zone of (firstExpansion.zones ?? [])) {
    if (zone.frozen === true) continue;
    const zoneName = zone.name.toLowerCase();
    if (EXCLUDE_ZONE_PATTERNS.some(pattern => zoneName.includes(pattern))) continue;
    const partitionIds = (zone.partitions ?? [])
      .map(partition => partition.id)
      .sort((a, b) => b - a);
    for (const encounter of (zone.encounters ?? [])) {
      result.push({ id: encounter.id, name: encounter.name, zone: zone.name, zoneId: zone.id, expansion: firstExpansion.name, partitionIds });
    }
  }
  return result;
}

// Group candidate encounters by their zone (keyed by zone id, since zones can share a
// name - e.g. a live and a PTR copy of the same raid). The liveness probe uses one
// representative encounter per group; all encounters in a zone share liveness.
export function groupEncountersByZone(encounters: IngestEncounter[]): Map<number, IngestEncounter[]> {
  const groups = new Map<number, IngestEncounter[]>();
  for (const encounter of encounters) {
    const group = groups.get(encounter.zoneId);
    if (group) group.push(encounter);
    else groups.set(encounter.zoneId, [encounter]);
  }
  return groups;
}

// Every encounter id in the current expansion's non-frozen zones, regardless of
// name-exclude or probe outcome. This is the prune-protected set: pruning never
// deletes on-disk data for an id here, so a live zone that transiently fails its
// liveness probe (or is briefly name-matched) is never wiped. An encounter only
// becomes prunable once WCL freezes its zone or it leaves the current expansion.
export function protectedEncounterIds(expansions: WclExpansion[]): Set<number> {
  const ids = new Set<number>();
  const firstExpansion = expansions[0];
  if (!firstExpansion) return ids;
  for (const zone of (firstExpansion.zones ?? [])) {
    if (zone.frozen === true) continue;
    for (const encounter of (zone.encounters ?? [])) ids.add(encounter.id);
  }
  return ids;
}
