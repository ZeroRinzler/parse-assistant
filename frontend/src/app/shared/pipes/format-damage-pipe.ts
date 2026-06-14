import { Pipe, PipeTransform } from '@angular/core';

/** Compact damage formatting: 1_240_000 -> "1.2M", 8_500 -> "9K". */
@Pipe({ name: 'formatDamage' })
export class FormatDamagePipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (!value) return '';
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
    return String(Math.round(value));
  }
}
