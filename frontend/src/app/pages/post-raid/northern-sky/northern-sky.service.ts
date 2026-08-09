import { Injectable, inject } from '@angular/core';
import { Result, LoadError } from '../../../core/result';
import { NORTHERN_SKY_DATA_SOURCE, NorthernSkyBench, NorthernSkyAbility } from './northern-sky-data-source';

const MYTHIC_DIFFICULTY = 'Mythic';
// The raid lead re-assigns lines to their roster on import; no Blizzard spec id is exposed to tag with.
const EVERYONE_TAG = 'everyone';

export function buildNorthernSkyNote(bench: NorthernSkyBench, selectedSpellIds: ReadonlySet<number>): string {
  const header = `EncounterID:${bench.encounter_id};Name:${bench.encounter_name};Difficulty:${MYTHIC_DIFFICULTY}`;
  const lines: { time_s: number; text: string }[] = [];
  for (const ability of bench.abilities) {
    if (!selectedSpellIds.has(ability.spell_id)) continue;
    for (const time_s of ability.cast_times_s) {
      lines.push({ time_s, text: `time:${time_s};tag:${EVERYONE_TAG};spellid:${ability.spell_id};text:${ability.name}` });
    }
  }
  lines.sort((a, b) => a.time_s - b.time_s);
  return [header, ...lines.map(line => line.text)].join('\n');
}

export function abilitiesByKind(abilities: NorthernSkyAbility[]): { cooldowns: NorthernSkyAbility[]; defensives: NorthernSkyAbility[] } {
  return {
    cooldowns: abilities.filter(ability => ability.kind === 'cooldown'),
    defensives: abilities.filter(ability => ability.kind === 'defensive'),
  };
}

// A spell id counts as selected unless the user excluded it, so an ability new to the list defaults on.
export function selectedIds(abilities: NorthernSkyAbility[], excluded: ReadonlySet<number>): Set<number> {
  return new Set(abilities.map(ability => ability.spell_id).filter(id => !excluded.has(id)));
}

export function isAllSelected(abilities: NorthernSkyAbility[], excluded: ReadonlySet<number>): boolean {
  return abilities.length > 0 && abilities.every(ability => !excluded.has(ability.spell_id));
}

export function toggleExclusion(excluded: ReadonlySet<number>, spellId: number, selected: boolean): Set<number> {
  const next = new Set(excluded);
  if (selected) next.delete(spellId);
  else next.add(spellId);
  return next;
}

// An empty ability list has nothing to select, so it must return the exclusions untouched rather than falling into isAllSelected's "not all selected" branch and clearing them.
export function toggleAllExclusion(abilities: NorthernSkyAbility[], excluded: ReadonlySet<number>): Set<number> {
  if (abilities.length === 0) return new Set(excluded);
  return isAllSelected(abilities, excluded) ? new Set(abilities.map(ability => ability.spell_id)) : new Set();
}

// The panel stays mounted across encounter switches, so a stale open request must not render once the bench has nothing to export.
export function isPanelOpen(requestedOpen: boolean, available: boolean): boolean {
  return requestedOpen && available;
}

@Injectable({ providedIn: 'root' })
export class NorthernSkyFeatureService {
  private readonly source = inject(NORTHERN_SKY_DATA_SOURCE);

  getExport(spec: string, encounterId: number): Promise<Result<NorthernSkyBench, LoadError>> {
    return this.source.getBench(spec, encounterId);
  }
}
