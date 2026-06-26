/**
 * Pure view-model helpers for the post-raid analyzer.
 *
 * `PostRaidComponent` injects eight services and drives its state through async
 * WCL fetches, so it is impractical to mount for a unit test. The pure pieces -
 * parsing a report code out of a URL, numbering pull attempts, projecting the
 * report's actors into player rows, filtering players to the selected fight, and
 * choosing which player to auto-select - live here and are tested directly.
 */
import { WclFight, WclPlayer, WclReport } from '../../core/models/wcl.models';

/** Pull a report code out of a WCL report URL, or pass through a bare code. */
export function extractCode(url: string): string {
  const m = url.match(/\/reports\/([a-zA-Z0-9]+)/);
  return m ? m[1] : url.trim();
}

/**
 * Project the report's fights into encounter pulls: drop trash fights, order by
 * start time, and number each boss's attempts (1, 2, 3 ...) with a derived
 * duration in seconds.
 */
export function buildFights(fights: WclReport['fights'] = []): WclFight[] {
  const bossAttempt: Record<number, number> = {};
  return (fights || [])
    .filter(f => (f.encounterID || 0) > 0)
    .sort((a, b) => a.startTime - b.startTime)
    .map(f => {
      const eid = f.encounterID || 0;
      bossAttempt[eid] = (bossAttempt[eid] || 0) + 1;
      return { ...f, duration_s: Math.round((f.endTime - f.startTime) / 100) / 10, attempt: bossAttempt[eid] };
    });
}

/** Project the report's master-data actors into player rows, sorted by name. */
export function buildPlayers(actors: WclReport['masterData']['actors'] = []): WclPlayer[] {
  return (actors || [])
    .map(a => ({ id: a.id, name: a.name, spec: a.subType || 'Unknown', server: a.server || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The players to offer for the selected fight: when the fight lists its friendly
 * participants, restrict to those; otherwise show everyone in the report.
 */
export function visiblePlayersOf(
  fights: WclFight[],
  players: WclPlayer[],
  selectedFightId: number | null | undefined,
): WclPlayer[] {
  const fight = fights.find(f => f.id === selectedFightId);
  const fp = fight?.friendlyPlayers;
  return fp?.length ? players.filter(p => fp.includes(p.id)) : players;
}

/**
 * Choose which player to auto-select: honor an explicit (URL) choice, otherwise
 * fall back to the first visible player. Returns null when there is nobody to pick.
 */
export function pickPlayerId(
  visiblePlayers: WclPlayer[],
  autoPlayer: number | null,
): number | null {
  if (autoPlayer) return autoPlayer;
  return visiblePlayers[0]?.id ?? null;
}

/**
 * Choose which player to track across live-sync pulls.
 *
 * If the currently selected player is visible in the new pull (matched by name,
 * case-insensitively), keep them - this lets you watch a raidmate and have the
 * selection persist pull-to-pull. If they are absent, fall back to the first
 * visible player.
 */
export function pickLivePlayerId(
  visiblePlayers: WclPlayer[],
  currentPlayerName: string | null,
): number | null {
  if (currentPlayerName) {
    const sticky = visiblePlayers.find(
      p => p.name.toLowerCase() === currentPlayerName.toLowerCase(),
    );
    if (sticky) return sticky.id;
  }
  return pickPlayerId(visiblePlayers, null);
}
