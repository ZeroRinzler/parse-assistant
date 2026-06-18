/**
 * The data-fetching seam for the analysis orchestration.
 *
 * `runAnalysis` depends only on this interface, not on Angular services, so the
 * fetch-and-sequence logic can be tested with a plain fake (no `HttpClient`, no
 * `TestBed`). `AnalysisEngineService` provides the production implementation by
 * delegating to `WclApiService` / `EncounterService`.
 */
import { WclEvent } from '../models/wcl.models';
import { Rulebook } from '../models/rulebook.models';
import { EncounterBench } from '../models/encounter.models';

export type EventDataType = 'Casts' | 'Buffs' | 'DamageDone' | 'DamageTaken';

export interface AnalysisDataSource {
  getEvents(
    reportCode: string,
    fightId: number,
    dataType: EventDataType,
    startTime: number,
    endTime: number,
    sourceId?: number,
  ): Promise<WclEvent[]>;
  /** Map of `playerId -> spec` plus `name_${playerId} -> player name`. */
  getPlayerDetails(reportCode: string, fightId: number): Promise<Record<number | string, string>>;
  getRulebook(spec: string): Promise<Rulebook | null>;
  getBench(spec: string, encounterId: number): Promise<EncounterBench | null>;
}
