import { InjectionToken } from '@angular/core';
import { BurstWindow, TopDefensiveSummary } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';

/** One defensive's static plan metadata (drives the /pre defensive plan). */
export interface DefensivePlanMeta {
  name: string;
  spell_id: number;
  cooldown: number;
  duration: number | null;
  usage_rule: string | null;
  talent_gated: boolean;
}

/** Baked icon + name for one spell id, looked up by `ability_icons[id]`. */
export interface BakedAbility {
  icon: string;
  name: string;
}

/**
 * The tailored, ready-to-render defensive bench for one encounter, read from
 * `data/specs/{spec}/defensive/{enc}.json` (a reshape of the generic bench). This is
 * the slice's own storage shape - the defensive card + the /pre defensive plan need
 * nothing else from disk.
 */
export interface DefensiveBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  /** Per-defensive usage benchmarks (lost/held/hold-suggestion thresholds). */
  per_defensive_benchmarks: Record<string, PerDefensiveBenchmark>;
  /** Clustered top-parse defensive windows (buff-window-centric). */
  defensive_windows: BurstWindow[];
  /** Top-parse defensive usage summary. */
  top_defensives_summary: TopDefensiveSummary[];
  /** Rulebook defensive metadata, drives the /pre defensive plan. */
  defensives: DefensivePlanMeta[];
  /** Defensive name -> spell id, for the window header icons. */
  cd_spell_ids: Record<string, number>;
  /** Baked spell-id -> {icon, name}, so the runtime renders art without the icon cache. */
  ability_icons: Record<number, BakedAbility>;
}

/**
 * A source of defensive bench data: the production file reader (`DefensiveDataFileService`)
 * or the dev-flag live transform (`DefensiveTransformService`). The two implement the
 * same contract and are swapped by `provideDataSource` per `environment.useLiveTransform`.
 */
export interface DefensiveDataSource {
  getDefensiveBench(spec: string, encounterId: number): Promise<DefensiveBench | null>;
}

export const DEFENSIVE_DATA_SOURCE = new InjectionToken<DefensiveDataSource>('DEFENSIVE_DATA_SOURCE');
