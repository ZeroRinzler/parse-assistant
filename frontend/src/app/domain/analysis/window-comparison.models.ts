// Kept in core/models (not in the component files) so feature/transform services can import them as plain models without reaching into a UI component.
export interface RangeRow {
  spellId?: number;
  label: string;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
  playerPct: number | null;
  // Top-parse range. All three may be null when no comparison data exists for a row.
  topAvg: number | null;
  topMin: number | null;
  topMax: number | null;
  // Cast counts for the sorted-impact table (burst windows only). Null when unavailable.
  playerCasts?: number | null;
  topCasts?: number | null;
  // Burst windows only: the ability is passive (never cast), so the casts cell shows a muted "passive" tag instead of a count.
  passive?: boolean;
}

export interface WindowSpell {
  id: number;
  icon: string;
  name: string;
}

export type WindowStatus = 'good' | 'warn' | 'bad' | 'muted' | 'info';

export interface ComparisonWindow {
  timeStartS: number;
  timeEndS: number;
  spells: WindowSpell[];
  /** Cooldown names with no spell id, rendered as plain text. */
  labels: string[];
  status: WindowStatus;
  statusIcon: string;
  overview: RangeRow;
  detailRows: RangeRow[];
}
