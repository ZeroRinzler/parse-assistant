/** Shared between the map transform service and the map feature service so both import one copy instead of duplicating the projection. */
import { WclEvent } from '../../../core/models/wcl.models';

/** The actor a resource-bearing event's flattened position describes (1 = source, 2 = target). */
export function posActorId(event: WclEvent): number | null {
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return null;
  return event.resourceActor === 2 ? event.targetID ?? null : event.sourceID ?? null;
}
