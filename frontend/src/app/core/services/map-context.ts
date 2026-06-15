import { Injectable, inject } from '@angular/core';
import { WclApiService } from './wcl-api';
import { EncounterService } from './encounter';
import { PositioningPanelService } from './positioning-panel';
import { buildActorTimelines, listReferenceEnemies } from './positioning-core';
import { LiveOverlay } from '../../shared/components/positioning-map/positioning-map';
import { EncounterPositions } from '../models/positioning.models';
import { WclFight } from '../models/wcl.models';

type EnemyActor = { id: number; name: string; gameID: number };

/**
 * Loads the ingested top-parse positions for the analysed fight and assembles
 * the live-player overlay, then hands both to the PositioningPanelService.
 * Shared by the post-raid and live pages.
 */
@Injectable({ providedIn: 'root' })
export class MapContextService {
  private readonly wclApi = inject(WclApiService);
  private readonly encounterSvc = inject(EncounterService);
  private readonly panel = inject(PositioningPanelService);

  async prepare(reportCode: string, fight: WclFight, playerId: number, spec: string, enemies: EnemyActor[]): Promise<void> {
    if (!fight?.encounterID) { this.panel.setContext(null, null); return; }
    try {
      const positions = await this.encounterSvc.getPositions(spec, fight.encounterID);
      if (!positions) { this.panel.setContext(null, null); return; }
      const live = await this._buildLiveOverlay(reportCode, positions, fight, playerId, enemies);
      this.panel.setContext(positions, live);
    } catch {
      this.panel.setContext(null, null);
    }
  }

  private async _buildLiveOverlay(
    reportCode: string, positions: EncounterPositions, fight: WclFight, playerId: number, enemies: EnemyActor[],
  ): Promise<LiveOverlay | null> {
    const { startTime, endTime } = fight;
    const refActorByGameId = new Map<number, number>();
    for (const e of enemies) if (e.gameID != null) refActorByGameId.set(e.gameID, e.id);
    const bossGameId = listReferenceEnemies(positions).find(e => e.isBoss)?.gameId;
    const bossActorId = bossGameId != null ? (refActorByGameId.get(bossGameId) ?? null) : null;

    const [playerCasts, enemyCasts, bossDamage] = await Promise.all([
      this.wclApi.getAllEvents(reportCode, fight.id, 'Casts', startTime, endTime, playerId, true),
      this.wclApi.getAllEvents(reportCode, fight.id, 'Casts', startTime, endTime, undefined, true, 'Enemies'),
      bossActorId != null
        ? this.wclApi.getAllEvents(reportCode, fight.id, 'DamageDone', startTime, endTime, bossActorId, true)
        : Promise.resolve([]),
    ]);
    const timelines = buildActorTimelines([...playerCasts, ...enemyCasts, ...bossDamage], startTime);
    if (!timelines.get(playerId)?.samples.length) return null;
    return { timelines, playerId, bossActorId, refActorByGameId };
  }
}
