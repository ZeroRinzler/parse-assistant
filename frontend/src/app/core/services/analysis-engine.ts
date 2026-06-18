import { Injectable, inject } from '@angular/core';
import { WclApiService } from './wcl-api';
import { EncounterService } from './encounter';
import { IconCacheService } from './icon-cache';
import { AnalysisResult } from '../models/analysis.models';
import { WclFight, WclAbility } from '../models/wcl.models';
import { AnalysisInput } from '../analysis';
import { AnalysisDataSource } from '../analysis/analysis-data-source';
import { runAnalysis } from '../analysis/run-analysis';

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
    const fight = fights.find((f) => f.id === fightId);
    if (!fight) throw new Error('Fight not found');

    // Adapt the Angular services to the framework-free data-source seam, then
    // let the pure orchestrator sequence the fetches and the worker compute.
    const src: AnalysisDataSource = {
      getEvents: (rc, fid, dt, s, e, sid) => this.wclApi.getAllEvents(rc, fid, dt, s, e, sid),
      getPlayerDetails: (rc, fid) => this.wclApi.getPlayerDetails(rc, fid),
      getRulebook: (spec) => this.encounterSvc.getRulebook(spec),
      getBench: (spec, enc) => this.encounterSvc.getBench(spec, enc),
    };

    const result = await runAnalysis(src, (input) => this._compute(input), { reportCode, fight, playerId, masterAbilities });

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
