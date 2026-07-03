import { Pipe, PipeTransform } from '@angular/core';

/** Signed whole-percent delta: 12 -> "+12%", -4 -> "-4%", 0 -> "0%", null -> "". */
@Pipe({ name: 'signedPercent' })
export class SignedPercentPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value == null) return '';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(0)}%`;
  }
}
