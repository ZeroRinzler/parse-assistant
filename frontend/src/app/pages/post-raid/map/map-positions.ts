/**
 * Slice-local position projection helpers shared between the map transform service
 * (ingest / live position bench) and the map feature service (live overlay). This is
 * a within-slice, map-domain module - analogous to the gear slice's `gear-extract.ts`
 * - so both files import one copy instead of duplicating the projection. It owns no
 * Angular / IO; pure functions only.
 */
import { WclEvent } from '../../../core/models/wcl.models';

/** The actor a resource-bearing event's flattened position describes (1 = source, 2 = target). */
export function posActorId(event: WclEvent): number | null {
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return null;
  return event.resourceActor === 2 ? (event.sourceID === undefined ? null : event.targetID ?? null) : (event.sourceID ?? null);
}
