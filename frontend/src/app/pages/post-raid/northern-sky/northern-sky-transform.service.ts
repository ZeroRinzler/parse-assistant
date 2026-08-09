import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { ParseRanking } from '../../../core/models/wcl.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok, missing } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { round } from '../../../shared/analysis/analysis-math';
import { TimedEvent, abilityIcons, findParseActor, toParseRankings, unwrapRankings, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { DataSource } from '../../../core/data-source/data-source';
import { NorthernSkyBench, NorthernSkyAbility } from './northern-sky-data-source';

interface ExportAbility { spell_id: number; name: string; kind: NorthernSkyAbility['kind']; }

// Scan this far down the ranking to skip private/unfetchable logs before giving up.
const CANDIDATE_POOL_COUNT = 10;

export function cooldownCastTimes(casts: TimedEvent[], spellId: number): number[] {
  return casts
    .filter(cast => cast.type === 'cast' && cast.abilityGameID === spellId)
    .map(cast => round(cast.atS))
    .sort((a, b) => a - b);
}

@Injectable({ providedIn: 'root' })
export class NorthernSkyTransformService implements DataSource<NorthernSkyBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, partition?: number | null): Promise<Result<NorthernSkyBench, LoadError>> {
    const rulebook = await this.dataFiles.getRulebook(spec);
    if (!rulebook.ok) return rulebook;
    const abilities: ExportAbility[] = [
      ...(rulebook.value.major_cooldowns ?? []).map(cd => ({ spell_id: cd.spell_id, name: cd.name, kind: 'cooldown' as const })),
      ...(rulebook.value.defensives ?? []).map(def => ({ spell_id: def.spell_id, name: def.name, kind: 'defensive' as const })),
    ].filter(ability => ability.spell_id);
    if (!abilities.length) return missing('Not yet ingested.');

    try {
      const rankings = toParseRankings(unwrapRankings(await this.wclApi.getRankings(spec, encounterId, partition)), CANDIDATE_POOL_COUNT);
      // One real log keeps each cooldown's cast spacing intact; take the best usable parse (#1, then backfill).
      for (const ranking of rankings) {
        const parse = await this.parseCastTimes(ranking, abilities);
        if (!parse) continue;
        const built: NorthernSkyAbility[] = [];
        for (const ability of abilities) {
          const cast_times_s = parse.timesBySpellId.get(ability.spell_id) ?? [];
          if (cast_times_s.length) built.push({ spell_id: ability.spell_id, name: ability.name, icon: '', kind: ability.kind, cast_times_s });
        }
        if (!built.length) continue;

        const icons = abilityIcons(await this.wclApi.getAbilities(built.map(entry => entry.spell_id)));
        for (const entry of built) entry.icon = icons[entry.spell_id]?.icon ?? '';
        return ok({
          spec,
          encounter_id: encounterId,
          encounter_name: parse.encounterName,
          abilities: built,
        });
      }
      return missing('Not yet ingested.');
    } catch (cause) {
      logWarn('NorthernSkyTransformService.getBench', cause);
      return toLoadError(cause, 'northern-sky.bench');
    }
  }

  private async parseCastTimes(
    ranking: ParseRanking,
    abilities: ExportAbility[],
  ): Promise<{ timesBySpellId: Map<number, number[]>; encounterName: string } | null> {
    try {
      const report = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = findParseActor(report.masterData?.actors, ranking);
      if (!fight || !player) return null;

      const casts = withRelativeS(
        await this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id), fight.startTime,
      );
      const timesBySpellId = new Map<number, number[]>();
      for (const ability of abilities) timesBySpellId.set(ability.spell_id, cooldownCastTimes(casts, ability.spell_id));
      return { timesBySpellId, encounterName: fight.name ?? '' };
    } catch (cause) {
      logWarn(`NorthernSkyTransformService parse ${ranking.report_code}:${ranking.fight_id}`, cause);
      return null;
    }
  }
}
