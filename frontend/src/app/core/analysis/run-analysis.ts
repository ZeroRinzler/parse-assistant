/**
 * Framework-free orchestration of a single player analysis.
 *
 * Holds the fetch sequencing that used to live in `AnalysisEngineService.run()`:
 * fire the heavy event queries immediately (they do not depend on spec), resolve
 * the player's spec, then fetch the small static rulebook/bench concurrently once
 * the spec is known, and finally hand the assembled input to `compute`.
 *
 * `compute` is injected so production can route it through the Web Worker while
 * tests pass `computeAnalysis` directly - no worker, no Angular.
 */
import { AnalysisResult } from '../models/analysis.models';
import { WclFight, WclAbility } from '../models/wcl.models';
import { AnalysisDataSource } from './analysis-data-source';
import { AnalysisInput } from './compute-analysis';

export interface RunAnalysisArgs {
  reportCode: string;
  fight: WclFight;
  playerId: number;
  masterAbilities: WclAbility[];
}

export async function runAnalysis(
  src: AnalysisDataSource,
  compute: (input: AnalysisInput) => Promise<AnalysisResult>,
  args: RunAnalysisArgs,
): Promise<AnalysisResult> {
  const { reportCode, fight, playerId, masterAbilities } = args;
  const { id: fightId, startTime: fStart, endTime: fEnd, encounterID } = fight;

  // Kick off the heavy event queries immediately - they don't depend on spec.
  const eventsP = Promise.all([
    src.getEvents(reportCode, fightId, 'Casts', fStart, fEnd, playerId),
    src.getEvents(reportCode, fightId, 'Buffs', fStart, fEnd),
    src.getEvents(reportCode, fightId, 'DamageDone', fStart, fEnd, playerId),
    src.getEvents(reportCode, fightId, 'DamageTaken', fStart, fEnd, playerId),
  ]);

  const specMap = await src.getPlayerDetails(reportCode, fightId);
  const spec = specMap[playerId];
  if (!spec) throw new Error(`Could not resolve spec for player ${playerId} in report ${reportCode}.`);
  const playerName = specMap[`name_${playerId}`] ?? `Player ${playerId}`;

  // Only the small, static rulebook/bench files depend on spec.
  const [rulebook, bench] = await Promise.all([
    src.getRulebook(spec),
    encounterID ? src.getBench(spec, encounterID) : Promise.resolve(null),
  ]);

  const [castEvents, buffEvents, dmgEvents, dtEvents] = await eventsP;

  const input: AnalysisInput = {
    playerName,
    spec,
    fStart,
    fEnd,
    castEvents,
    buffEvents,
    dmgEvents,
    dtEvents,
    rulebook,
    bench,
    masterAbilities: masterAbilities || [],
  };

  return compute(input);
}
