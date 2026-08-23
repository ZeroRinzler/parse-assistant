import { Pipe, PipeTransform } from '@angular/core';

/** WCL encounter id -> boss-icon URL, or '' when there is no id. */
@Pipe({ name: 'bossIcon' })
export class BossIconPipe implements PipeTransform {
  transform(encounterId: number | null | undefined): string {
    return encounterId ? this.bossIconUrl(encounterId) : '';
  }

  /** Warcraft Logs serves the boss art directly, so no ingestion is needed. */
  private bossIconUrl(encounterId: number): string {
    if (!Number.isInteger(encounterId) || encounterId <= 0) return '';
    return `https://assets.rpglogs.com/img/warcraft/bosses/${encounterId}-icon.jpg`;
  }
}
