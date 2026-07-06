/**
 * Boss/encounter icon URL, derived directly from the WCL encounter id (the same id stored
 * in `EncounterEntry.id` and `WclFight.encounterID`). Warcraft Logs serves a square icon
 * per encounter id, so no ingestion or extra data field is needed. A non-positive or
 * non-integer id has no art; it returns '' so the icon degrades to name-only (an `wl-art-icon`
 * with '' renders nothing), matching `classIconUrl`/`specIconUrl` for an unknown id.
 */
export function bossIconUrl(encounterId: number): string {
  if (!Number.isInteger(encounterId) || encounterId <= 0) return '';
  return `https://assets.rpglogs.com/img/warcraft/bosses/${encounterId}-icon.jpg`;
}
