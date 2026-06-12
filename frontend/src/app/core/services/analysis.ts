import { Injectable, inject } from '@angular/core';
import { WclAuthService } from './wcl-auth';
import { AnalysisEngineService } from './analysis-engine';
import { AnalysisResult } from '../models/analysis.models';
import { WclFight } from '../models/wcl.models';

@Injectable({ providedIn: 'root' })
export class AnalysisService {
  private readonly auth = inject(WclAuthService);
  private readonly engine = inject(AnalysisEngineService);

  async analyze(
    reportCode: string,
    fightId: number,
    playerId: number,
    fights: WclFight[],
    masterAbilities: { gameID: number; name: string; icon: string }[],
  ): Promise<AnalysisResult> {
    if (this.auth.isLoggedIn()) {
      return this.engine.run(reportCode, fightId, playerId, fights, masterAbilities);
    }
    return this._analyzeBackend(reportCode, fightId, playerId);
  }

  private async _analyzeBackend(reportCode: string, fightId: number, playerId: number): Promise<AnalysisResult> {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report_url: reportCode, fight_id: fightId, player_id: playerId }),
    });
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('Backend server is not available. Run the server locally to use the analyzer.');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || `Request failed (${resp.status})`);
    return data as AnalysisResult;
  }
}
