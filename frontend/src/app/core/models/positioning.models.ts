/**
 * Shapes for the ingested top-parse position file
 * (`data/specs/{spec}/positions/{enc_id}.json`).
 *
 * Mirrors what `ingest.mjs` writes via `buildParsePositions` / `savePositions`.
 * Coordinates are raw WCL units (x/y in hundredths of a yard, facing in
 * milliradians); the frontend scales them in `positioning-core`.
 */

/** A resampled position row: [t_s, x, y, facing | null, mapID | null]. */
export type PosRow = [number, number, number, number | null, number | null];

export interface ParseEnemyTimeline {
  game_id: number | null;
  name: string;
  is_boss: boolean;
  samples: PosRow[];
}

export interface ParsePositions {
  report_code: string;
  fight_id: number;
  player_name: string;
  duration_s: number;
  interval_s: number;
  /** The ranked player's resampled timeline. */
  player: PosRow[];
  enemies: ParseEnemyTimeline[];
}

export interface EncounterPositions {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  interval_s: number;
  sample_count: number;
  parses: ParsePositions[];
}

/** How the map chooses the reference actor a parse's player position is measured against. */
export type ReferenceSelector =
  | { kind: 'boss' }
  | { kind: 'enemy'; gameId: number };
