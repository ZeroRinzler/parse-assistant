import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { TopParseSelection } from '../../../core/models/wcl.models';
import { Rulebook } from '../../../core/models/rulebook.models';
import { Result } from '../../../core/result';
import { round } from '../../../shared/analysis/analysis-math';
import { TimedEvent, abilityIcons, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { BenchParse, benchFromTopParses } from '../../../shared/analysis/bench-pipeline';
import { DataSource } from '../../../core/data-source/data-source';
import { NorthernSkyBench, NorthernSkyAbility } from './northern-sky-data-source';

interface ExportAbility { spell_id: number; name: string; kind: NorthernSkyAbility['kind']; }

// Scan this far down the ranking to skip private/unfetchable logs before giving up.
const CANDIDATE_POOL_COUNT = 10;
// One real log keeps each cooldown's cast spacing intact, so the export never blends parses.
const EXPORTED_PARSE_COUNT = 1;
const NO_EXPORT_MESSAGE = 'Not yet ingested.';

function exportAbilities(rulebook: Rulebook): ExportAbility[] | null {
  const abilities: ExportAbility[] = [
    ...rulebook.major_cooldowns.map(cd => ({ spell_id: cd.spell_id, name: cd.name, kind: 'cooldown' as const })),
    ...rulebook.defensives.map(def => ({ spell_id: def.spell_id, name: def.name, kind: 'defensive' as const })),
  ].filter(ability => ability.spell_id);
  return abilities.length ? abilities : null;
}

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

  async getBench(spec: string, encounterId: number, selection?: TopParseSelection): Promise<Result<NorthernSkyBench>> {
    return benchFromTopParses(this.wclApi, { spec, encounterId, selection }, {
      logSource: 'NorthernSkyTransformService',
      errorId: 'northern-sky.bench',
      candidatePoolCount: CANDIDATE_POOL_COUNT,
      sampleTarget: EXPORTED_PARSE_COUNT,
      noRankingsMessage: NO_EXPORT_MESSAGE,
      header: 'identity',
      rulebook: { dataFiles: this.dataFiles, plan: exportAbilities, missingMessage: NO_EXPORT_MESSAGE },
      parse: (parse, abilities) => this.parseCastTimes(parse, abilities),
      bench: async ({ parses }) => {
        const built = parses[0] ?? [];
        const icons = abilityIcons(await this.wclApi.getAbilities(built.map(entry => entry.spell_id)));
        return { abilities: built.map(entry => ({ ...entry, icon: icons[entry.spell_id]?.icon ?? '' })) };
      },
    });
  }

  // A parse that cast none of the exported abilities is no schedule at all, never an empty export.
  private async parseCastTimes(
    { ranking, fight, player }: BenchParse, abilities: ExportAbility[],
  ): Promise<NorthernSkyAbility[] | null> {
    const casts = withRelativeS(
      await this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id), fight.startTime,
    );
    const built: NorthernSkyAbility[] = [];
    for (const ability of abilities) {
      const cast_times_s = cooldownCastTimes(casts, ability.spell_id);
      if (cast_times_s.length) built.push({ spell_id: ability.spell_id, name: ability.name, icon: '', kind: ability.kind, cast_times_s });
    }
    return built.length ? built : null;
  }
}
