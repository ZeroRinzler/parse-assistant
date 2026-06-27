/**
 * Boss/encounter icon URL, derived directly from the WCL encounter id (the same id stored
 * in `EncounterEntry.id` and `WclFight.encounterID`). Warcraft Logs serves a square icon
 * per encounter id, so no ingestion or extra data field is needed.
 */
export function bossIconUrl(encounterId: number): string {
  return `https://assets.rpglogs.com/img/warcraft/bosses/${encounterId}-icon.jpg`;
}
