export interface FindingOccurrence {
  atS?: number;
  ok: boolean;
  label: string;
  /** Rendered only when `atS` is absent - never alongside it. */
  note?: string;
  detail: string;
  /** Excludes this entry from the ok/violation tone the template otherwise applies. */
  marker?: boolean;
}

export interface FindingTimeline {
  segmentsS: [number, number][];
  fightDurationS: number;
}

export interface AnalysisFinding {
  severity: 'critical' | 'warning' | 'info' | 'hold_suggestion' | 'success';
  category: string;
  cd_name?: string;
  message: string;
  // Populated by the analysis engine so the UI never has to parse the templated `message`.
  measured?: { value: string; unit?: string };
  /** Short display label for the "What" column (rule violations only). */
  label?: string;
  /** Rulebook `type` of the rule that produced this finding (rule violations only). */
  rule_type?: string;
  timestamp_s?: number;
  details?: {
    cd_name?: string;
    remedy?: string;
  };
  occurrences: FindingOccurrence[];
  occurrenceTarget?: string;
  /** Only aura_uptime_below sets this; every other kind renders occurrences with no timeline. */
  timeline?: FindingTimeline;
}

interface AbilityBreakdown {
  spell_id: number;
  avg_damage: number;
  min_damage: number;
  max_damage: number;
  /** Top-parse average cast count per window. Burst windows only; absent on defensives. */
  avg_casts?: number;
  // Burst windows only: true when no top parse ever cast this ability, so the UI shows a "passive" tag instead of a cast count.
  is_passive?: boolean;
}

export interface BurstWindow {
  time_s: number;
  dmg_avg: number;
  dmg_min: number;
  dmg_max: number;
  dmg_stddev: number;
  common_cds: string[];
  ability_breakdown: AbilityBreakdown[];
  window_length_s: number;
  defensive_name?: string;
  spell_id?: number;
  /** Map reference for defensive windows: gameID of the enemy dealing the window's main damage. */
  ref_game_id?: number | null;
}

export interface PlayerBurstWindow {
  window_damage: number;
  ability_breakdown?: { spell_id: number; damage: number; casts?: number }[];
}

interface DefensiveWindow {
  start_s: number;
  end_s: number;
}

export interface PlayerDefensive {
  name: string;
  uses: number;
  cast_times_s?: number[];
  windows: DefensiveWindow[];
  talent_gated?: boolean;
}
