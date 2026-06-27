import { Pipe, PipeTransform } from '@angular/core';
import { bossIconUrl } from '../boss-icon';

/** WCL encounter id -> boss-icon URL, or '' when there is no id. */
@Pipe({ name: 'bossIcon' })
export class BossIconPipe implements PipeTransform {
  transform(encounterId: number | null | undefined): string {
    return encounterId ? bossIconUrl(encounterId) : '';
  }
}
