import { Injectable } from '@angular/core';
import { WclFight, WclPlayer, WclReport } from '../../../../core/wcl/wcl.models';

@Injectable({ providedIn: 'root' })
export class SideSelectionService {
  // Mirrors the post-raid shell's own fight list; kept local since this slice never shares the report state.
  buildFights(fights: WclReport['fights'] = []): WclFight[] {
    const bossAttempt: Record<number, number> = {};
    return fights
      .filter(f => (f.encounterID || 0) > 0)
      .sort((a, b) => a.startTime - b.startTime)
      .map(f => {
        const eid = f.encounterID || 0;
        bossAttempt[eid] = (bossAttempt[eid] ?? 0) + 1;
        return { ...f, duration_s: Math.round((f.endTime - f.startTime) / 100) / 10, attempt: bossAttempt[eid] };
      });
  }

  buildPlayers(actors: NonNullable<WclReport['masterData']>['actors'] = []): WclPlayer[] {
    return actors
      .map(a => ({ id: a.id, name: a.name, spec: a.subType || 'Unknown', server: a.server || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  visiblePlayers(players: WclPlayer[], fight: WclFight | undefined): WclPlayer[] {
    const fp = fight?.friendlyPlayers;
    return fp?.length ? players.filter(p => fp.includes(p.id)) : players;
  }

  targetFightId(fights: WclFight[], requested: number | 'last' | null): number | null {
    if (requested != null && requested !== 'last') {
      const match = fights.find(f => f.id === requested);
      if (match) return match.id;
    }
    return fights[fights.length - 1]?.id ?? null;
  }

  targetPlayerId(candidates: WclPlayer[], requestedSourceId: number | null): number | null {
    if (requestedSourceId != null && candidates.some(p => p.id === requestedSourceId)) return requestedSourceId;
    return candidates[0]?.id ?? null;
  }
}
