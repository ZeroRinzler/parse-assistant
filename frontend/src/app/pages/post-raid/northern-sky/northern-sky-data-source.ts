import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';

export interface NorthernSkyAbility {
  spell_id: number;
  name: string;
  icon: string;
  kind: 'cooldown' | 'defensive';
  /** Seconds from pull, ascending. */
  cast_times_s: number[];
}

/** The tailored Northern Sky export bench for one encounter, read from `data/specs/{spec}/northern-sky/{enc}.json`. */
export interface NorthernSkyBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  abilities: NorthernSkyAbility[];
}

/** The slice's data-source token: prod reads the tailored file, dev/ingest computes it live. */
export const NORTHERN_SKY_DATA_SOURCE = new InjectionToken<DataSource<NorthernSkyBench>>('NORTHERN_SKY_DATA_SOURCE');
