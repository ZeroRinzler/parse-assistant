/**
 * Types for the parse_samples/{enc_id}.json format.
 *
 * Written and read by ingest.ts only - the Angular frontend does not consume
 * parse_samples. Defined here (not in src/app/core/models/) so the file format
 * contract lives outside the ingest script itself.
 */

import type { DefensiveWindow } from '../src/app/core/models/analysis.models.ts';

export interface HoldWindow {
  cast_index: number;
  expected_s: number;
  actual_s: number;
  hold_amount_s: number;
}

export interface CdCastSummary {
  name: string;
  spell_id: number;
  total_uses: number;
  first_cast_s: number | null;
  bl_aligned: boolean;
  bl_offset_s: number | null;
  cast_times_s: number[];
  hold_windows: HoldWindow[];
  cast_pattern: 'hold' | 'on_cooldown';
}

export interface DefensiveCastSummary {
  name: string;
  spell_id: number;
  cooldown: number;
  uses: number;
  cast_times_s: number[];
  first_cast_s: number;
  hold_windows: HoldWindow[];
  cast_pattern: 'hold' | 'on_cooldown';
  windows: DefensiveWindow[];
  fight_duration_s?: number;
}

export interface RawBurstWindowAbility { spell_id: number; damage: number; pct: number; casts: number; }

export interface RawBurstWindow {
  time_s: number;
  window_length_s: number;
  pct_of_total: number;
  window_damage: number;
  total_damage: number;
  ability_breakdown: RawBurstWindowAbility[];
  active_cds: string[];
  target_count: number;
}

export interface RawDefensiveWindowAbility { spell_id: number; damage: number; pct: number; }

export interface RawDefensiveWindow {
  time_s: number;
  window_length_s: number;
  pct_of_total: number;
  window_damage: number;
  total_damage: number;
  ability_breakdown: RawDefensiveWindowAbility[];
  active_cds: string[];
  defensive_name: string;
  spell_id: number;
  ref_game_id: number | null;
}

export interface ParseCooldownData {
  player: string;
  spec: string;
  fight_duration_s: number;
  bloodlust_s: number | null;
  cast_efficiency_pct: number | null;
  cast_gap_list_ms: number[];
  cooldowns: CdCastSummary[];
  burst_windows: RawBurstWindow[];
  defensives: DefensiveCastSummary[];
  defensive_windows: RawDefensiveWindow[];
  talent_key: string;
  trinkets: Array<{ slot: number; id: number | string; name: string }>;
  enchants: Array<{ slot: number; id: number | string; name: string }>;
}

export interface ParseSample {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  report_code: string;
  fight_id: number;
  player_name: string;
  sampled_at: string;
  ingest_hash: string;
  cooldown_data: ParseCooldownData;
}
