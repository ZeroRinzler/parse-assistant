import { Pipe, PipeTransform } from '@angular/core';

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Compact damage formatting: 1_240_000 -> "1.2M", 8_500 -> "8.5K". */
@Pipe({ name: 'formatDamage' })
export class FormatDamagePipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value == null) return '';
    return COMPACT.format(value);
  }
}
