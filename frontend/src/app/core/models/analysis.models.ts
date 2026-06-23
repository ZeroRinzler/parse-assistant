import { CharacterGear } from './wcl.models';

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
  damage?: number;
  count: number;
  /** Top-parse average cast count per window. Burst windows only; absent on defensives. */
  avg_casts?: number;
}

export interface BurstWindow {
  time_s: number;
  dmg_avg: number;
  dmg_min: number;
  dmg_max: number;
  dmg_stddev: number;
  common_cds?: string[];
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
  ability_breakdown?: Array<{ spell_id: number; damage: number; casts?: number }>;
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

export interface AnalysisResult {
  player: string;
  spec: string;
  rulebook_source: 'generated' | 'static' | 'none';
  findings: AnalysisFinding[];
  cd_spell_ids: Record<string, number>;
  ability_icons: Record<string, { icon: string; name: string }>;
  burst_windows?: BurstWindow[];
  player_burst_windows?: PlayerBurstWindow[];
  player_fight_duration_s?: number;
  player_defensives?: PlayerDefensive[];
  top_defensives_summary?: TopDefensiveSummary[];
  defensive_findings?: AnalysisFinding[];
  top_defensive_windows?: BurstWindow[];
  player_defensive_windows?: PlayerBurstWindow[];
  comparison_table?: ComparisonEntry[];
  /** Player's own gear from their most recent ranked kill of this encounter. */
  player_gear?: CharacterGear;
}

export interface ComparisonEntry {
  cd_name: string;
  spell_id?: number;
  player_uses?: number;
  top_uses?: number;
  player_uses_per_min?: number;
  top_avg_uses_per_min?: number;
  top_stddev_uses_per_min?: number;
  player_first_cast_s?: number;
  top_avg_first_cast_s?: number;
  top_stddev_first_cast_s?: number;
}
