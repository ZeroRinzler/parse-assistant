/**
 * Extract layer - pure response-to-model mappers and the spec lookup table.
 *
 * No network, no filesystem, no client: every function takes a raw WCL response
 * fragment and returns an ingest model. Mirrors the role of
 * `src/app/core/services/wcl-mappers.ts` for the frontend. Unit-tested in
 * wcl-mappers.spec.ts.
 */

import type {
  WclRawRanking, WclExpansion, ParseRanking, IngestEncounter,
} from './models/wcl.models.ts';

// WCL spec folder name -> [WCL className, WCL specName].
export const SPEC_TO_WCL_FORWARD: Record<string, [string, string]> = {
  RetributionPaladin:    ['Paladin',    'Retribution'],
  HolyPaladin:           ['Paladin',    'Holy'],
  ProtectionPaladin:     ['Paladin',    'Protection'],
  FireMage:              ['Mage',       'Fire'],
  ArcaneMage:            ['Mage',       'Arcane'],
  FrostMage:             ['Mage',       'Frost'],
  HavocDemonHunter:      ['DemonHunter','Havoc'],
  VengeanceDemonHunter:  ['DemonHunter','Vengeance'],
  FuryWarrior:           ['Warrior',    'Fury'],
  ArmsWarrior:           ['Warrior',    'Arms'],
  ProtectionWarrior:     ['Warrior',    'Protection'],
  UnholyDeathKnight:     ['DeathKnight','Unholy'],
  FrostDeathKnight:      ['DeathKnight','Frost'],
  BloodDeathKnight:      ['DeathKnight','Blood'],
  BalanceDruid:          ['Druid',      'Balance'],
  FeralDruid:            ['Druid',      'Feral'],
  GuardianDruid:         ['Druid',      'Guardian'],
  RestorationDruid:      ['Druid',      'Restoration'],
  BeastMasteryHunter:    ['Hunter',     'BeastMastery'],
  MarksmanshipHunter:    ['Hunter',     'Marksmanship'],
  SurvivalHunter:        ['Hunter',     'Survival'],
  BrewmasterMonk:        ['Monk',       'Brewmaster'],
  WindwalkerMonk:        ['Monk',       'Windwalker'],
  MistweaverMonk:        ['Monk',       'Mistweaver'],
  DisciplinePriest:      ['Priest',     'Discipline'],
  HolyPriest:            ['Priest',     'Holy'],
  ShadowPriest:          ['Priest',     'Shadow'],
  AssassinationRogue:    ['Rogue',      'Assassination'],
  OutlawRogue:           ['Rogue',      'Outlaw'],
  SubtletyRogue:         ['Rogue',      'Subtlety'],
  ElementalShaman:       ['Shaman',     'Elemental'],
  EnhancementShaman:     ['Shaman',     'Enhancement'],
  RestorationShaman:     ['Shaman',     'Restoration'],
  AfflictionWarlock:     ['Warlock',    'Affliction'],
  DemonologyWarlock:     ['Warlock',    'Demonology'],
  DestructionWarlock:    ['Warlock',    'Destruction'],
  DevastationEvoker:     ['Evoker',     'Devastation'],
  PreservationEvoker:    ['Evoker',     'Preservation'],
  AugmentationEvoker:    ['Evoker',     'Augmentation'],
};

export const SPEC_TO_WCL = SPEC_TO_WCL_FORWARD;

export const EXCLUDE_ZONE_PATTERNS = ['beta', 'ptr', 'mythic+', 'complete raids', 'delves', 'torghast'];

const TRINKET_INDICES = new Set([12, 13]);

// Trinkets (gear slots 12/13) and permanent enchants. Gear shape is identical
// across both ranking APIs, so this is shared. The gear array is positionally
// indexed - the array index IS the slot number (WCL returns no `slot` field).
export function extractGear(rankingEntry: WclRawRanking): {
  trinkets: Array<{ slot: number; id: number | string; name: string }>;
  enchants: Array<{ slot: number; id: number | string; name: string }>;
} {
  const gear = rankingEntry.gear ?? [];
  const trinkets: Array<{ slot: number; id: number | string; name: string }> = [];
  const enchants: Array<{ slot: number; id: number | string; name: string }> = [];
  for (let idx = 0; idx < gear.length; idx++) {
    const item = gear[idx];
    if (!item || !item.id) continue;
    const itemId = typeof item.id === 'number' ? item.id : (parseInt(String(item.id)) || item.id);
    const name = item.name ?? '';

    if (TRINKET_INDICES.has(idx)) {
      trinkets.push({ slot: idx, id: itemId, name });
    }

    const rawEnchant = item.permanentEnchant;
    if (rawEnchant) {
      const enchantId = typeof rawEnchant === 'number' ? rawEnchant : (parseInt(String(rawEnchant)) || rawEnchant);
      enchants.push({ slot: idx, id: enchantId, name: item.permanentEnchantName ?? '' });
    }
  }
  return { trinkets, enchants };
}

// WCL replaces a privacy-anonymized parse's player name with "Character <id>-<id>".
// Such a name can never match a report actor (real WoW names are letters only), so the
// parse is unfetchable - getParseEvents would throw "Player not found". We treat these
// as non-real: they neither count toward a zone's liveness nor get fetched.
const ANONYMIZED_NAME = /^Character \d+-\d+$/;
export function isAnonymizedPlayerName(name: string): boolean {
  return ANONYMIZED_NAME.test(name);
}

// Filter raw rankings to public, fetchable, non-anonymized parses and map the top
// `count` into ParseRanking rows. Parses with no report (report: null) and
// privacy-anonymized parses are dropped before slicing so we always keep `count` rows
// we can actually fetch. The raw entry is preserved on `_raw` for later gear extraction.
export function mapRankings(rawRankings: WclRawRanking[], count: number): ParseRanking[] {
  return rawRankings
    .filter(rawRanking => rawRanking.report?.code && !isAnonymizedPlayerName(rawRanking.name ?? ''))
    .slice(0, count)
    .map((rawRanking, index) => ({
      rank: index + 1,
      player: rawRanking.name ?? '',
      amount: Math.round(rawRanking.amount ?? 0),
      duration_s: Math.round((rawRanking.duration ?? 0) / 100) / 10,
      report_code: rawRanking.report?.code ?? '',
      fight_id: rawRanking.report?.fightID ?? 0,
      server: rawRanking.server?.name ?? '',
      _raw: rawRanking,
    }));
}

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

// Extract resolved enchant names from a batched `gameData` alias response (alias
// `eN` for id `N`, see buildEnchantQuery). Only ids that resolved to a non-empty
// trimmed name appear in the returned map.
export function parseEnchantResults(
  gameData: Record<string, { id: number; name: string } | null | undefined>,
  ids: Array<number | string>,
): Map<number | string, string> {
  const names = new Map<number | string, string>();
  for (const id of ids) {
    const name = (gameData[`e${id}`]?.name ?? '').trim();
    if (name) names.set(id, name);
  }
  return names;
}
