/**
 * Factory for ParseSample fixtures used by gear/bench/storage tests. Supply only
 * the cooldown_data fields a test cares about; the rest get sensible defaults.
 */

import type { ParseSample, ParseCooldownData } from '../models/parse-sample.models.ts';

let seq = 0;

export function sample(cooldownData: Partial<ParseCooldownData> = {}, overrides: Partial<ParseSample> = {}): ParseSample {
  seq += 1;
  return {
    spec: 'SubtletyRogue',
    encounter_id: 1000,
    encounter_name: 'Test Boss',
    report_code: `rep${seq}`,
    fight_id: seq,
    player_name: `Player${seq}`,
    sampled_at: '2026-01-01 00:00:00',
    ingest_hash: 'testhash',
    cooldown_data: {
      player: `Player${seq}`,
      spec: 'SubtletyRogue',
      fight_duration_s: 300,
      bloodlust_s: null,
      cast_efficiency_pct: null,
      cast_gap_list_ms: [],
      cooldowns: [],
      burst_windows: [],
      defensives: [],
      defensive_windows: [],
      talent_key: '',
      trinkets: [],
      enchants: [],
      ...cooldownData,
    },
    ...overrides,
  };
}
