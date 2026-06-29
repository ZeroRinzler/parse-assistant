export interface AnalysisFinding {
  severity: 'critical' | 'warning' | 'info' | 'hold_suggestion' | 'success';
  category: string;
  cd_name?: string;
  message: string;
  /**
   * The prominent metric for this finding, rendered as value-over-unit in the
   * "Measured" column of the finding table (e.g. { value: '1 / 15', unit:
   * 'cast(s)' }). Populated by the analysis engine so the UI never has to parse
   * the templated `message`. Findings without a meaningful metric omit it.
   */
  measured?: { value: string; unit?: string };
  /** Short display label for the "What" column (rule violations only). */
  label?: string;
  timestamp_ms?: number;
  details?: {
    cd_name?: string;
    remedy?: string;
  };
}

export interface AbilityBreakdown {
  spell_id: number;
  avg_damage: number;
  min_damage: number;
  max_damage: number;
  count: number;
  /** Top-parse average cast count per window. Burst windows only; absent on defensives. */
  avg_casts?: number;
  /**
   * Burst windows only: true when no top parse ever cast this ability (passive/proc,
   * auto-attack, or pet damage), so the UI shows a "passive" tag instead of a cast
   * count. Absent (treated as false) on defensives and on pre-`is_passive` baked files.
   */
  is_passive?: boolean;
}

export interface BurstWindow {
  time_s: number;
  dmg_avg: number;
  dmg_min: number;
  dmg_max: number;
  dmg_stddev: number;
  common_cds: string[];
  common_defensives?: string[];
  avg_targets?: number;
  ability_breakdown: AbilityBreakdown[];
  window_length_s: number;
  defensive_name?: string;
  spell_id?: number;
  /** Map reference for defensive windows: gameID of the enemy dealing the window's main damage. */
  ref_game_id?: number | null;
}

export interface PlayerBurstWindow {
  time_s?: number;
  window_damage: number;
  ability_breakdown?: { spell_id: number; damage: number; casts?: number }[];
}

export interface DefensiveWindow {
  start_s: number;
  end_s: number;
  dmg_during: number;
}

export interface PlayerDefensive {
  spell_id: number;
  name: string;
  cooldown: number;
  uses: number;
  cast_times_s?: number[];
  first_cast_s?: number;
  windows: DefensiveWindow[];
  talent_gated?: boolean;
}

export interface TopDefensiveSummary {
  spell_id: number;
  avg_uses: number;
  min_uses: number;
  max_uses: number;
}
