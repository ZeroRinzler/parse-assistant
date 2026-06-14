import { Injectable, inject } from '@angular/core';
import { WclApiService } from './wcl-api';
import { EncounterService } from './encounter';
import { IconCacheService } from './icon-cache';
import { AnalysisResult } from '../models/analysis.models';
import { WclFight, WclAbility } from '../models/wcl.models';
import { AnalysisInput } from './analysis-core';

interface WorkerResponse { id: number; result?: AnalysisResult; error?: string; }

@Injectable({ providedIn: 'root' })
export class AnalysisEngineService {
  private readonly wclApi = inject(WclApiService);
  private readonly encounterSvc = inject(EncounterService);
  private readonly icons = inject(IconCacheService);

  private worker: Worker | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<number, { resolve: (r: AnalysisResult) => void; reject: (e: Error) => void }>();

  async run(
    reportCode: string,
    fightId: number,
    playerId: number,
    fights: WclFight[],
    masterAbilities: WclAbility[],
  ): Promise<AnalysisResult> {
    const fight = fights.find(f => f.id === fightId);
    if (!fight) throw new Error('Fight not found');
    const { startTime: fStart, endTime: fEnd, encounterID } = fight;

    // Kick off the heavy event queries immediately - they don't depend on spec -
    // and resolve the player's spec concurrently. Only the (small, static)
    // rulebook/bench files depend on spec, so they're fetched once it's known.
    const eventsP = Promise.all([
      this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fStart, fEnd, playerId),
      this.wclApi.getAllEvents(reportCode, fightId, 'Buffs', fStart, fEnd),
      this.wclApi.getAllEvents(reportCode, fightId, 'DamageDone', fStart, fEnd, playerId),
      this.wclApi.getAllEvents(reportCode, fightId, 'DamageTaken', fStart, fEnd, playerId),
    ]);

    const specMap = await this.wclApi.getPlayerDetails(reportCode, fightId);
    const spec = specMap[playerId];
    if (!spec) throw new Error(`Could not resolve spec for player ${playerId} in report ${reportCode}.`);
    const playerName = specMap[`name_${playerId}`] ?? `Player ${playerId}`;

    const [rulebook, bench] = await Promise.all([
      this.encounterSvc.getRulebook(spec),
      encounterID ? this.encounterSvc.getBench(spec, encounterID) : Promise.resolve(null),
    ]);

    const [castEvents, buffEvents, dmgEvents, dtEvents] = await eventsP;

    const input: AnalysisInput = {
      playerName, spec, fStart, fEnd,
      castEvents, buffEvents, dmgEvents, dtEvents,
      rulebook, bench, masterAbilities: masterAbilities || [],
    };

    const result = await this._compute(input);

    // Icon cache touches an Angular signal, so seed it on the main thread.
    this.icons.seedFromMap(result.ability_icons);
    return result;
  }

  /** Run the computation in the dedicated Web Worker. */
  private _compute(input: AnalysisInput): Promise<AnalysisResult> {
    const worker = this._ensureWorker();
    const id = this.nextRequestId++;
    return new Promise<AnalysisResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, input });
    });
  }

  private _ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./analysis.worker', import.meta.url), { type: 'module' });
    worker.addEventListener('message', ({ data }: MessageEvent<WorkerResponse>) => {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result!);
    });
    worker.addEventListener('error', () => {
      // Worker crashed - reject in-flight requests and drop it so the next call rebuilds.
      for (const { reject } of this.pending.values()) reject(new Error('Analysis worker error'));
      this.pending.clear();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }
}
