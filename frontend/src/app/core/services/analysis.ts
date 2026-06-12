import { Injectable, inject } from '@angular/core';
import { AnalysisEngineService } from './analysis-engine';
import { AnalysisResult } from '../models/analysis.models';
import { WclFight } from '../models/wcl.models';

@Injectable({ providedIn: 'root' })
export class AnalysisService {
  private readonly engine = inject(AnalysisEngineService);

  async analyze(
    reportCode: string,
    fightId: number,
    playerId: number,
    fights: WclFight[],
    masterAbilities: { gameID: number; name: string; icon: string }[],
  ): Promise<AnalysisResult> {
    return this.engine.run(reportCode, fightId, playerId, fights, masterAbilities);
  }
}
