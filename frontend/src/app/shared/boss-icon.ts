/** Boss icon URL derived from the WCL encounter id; Warcraft Logs serves the art directly, so no ingestion is needed. */
export function bossIconUrl(encounterId: number): string {
  if (!Number.isInteger(encounterId) || encounterId <= 0) return '';
  return `https://assets.rpglogs.com/img/warcraft/bosses/${encounterId}-icon.jpg`;
}
