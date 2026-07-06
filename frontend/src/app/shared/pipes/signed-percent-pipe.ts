import { Pipe, PipeTransform } from '@angular/core';

/** Signed whole-percent delta: 12 -> "+12%", -4 -> "-4%", 0 -> "0%", null/NaN -> "". */
@Pipe({ name: 'signedPercent' })
export class SignedPercentPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '';
    const sign = value > 0 ? '+' : '';
    // A small negative that rounds to zero yields "-0" from toFixed; render it as plain "0".
    const magnitude = value.toFixed(0);
    const normalized = magnitude === '-0' ? '0' : magnitude;
    return `${sign}${normalized}%`;
  }
}
