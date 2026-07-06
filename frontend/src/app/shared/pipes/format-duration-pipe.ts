import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'formatDuration' })
export class FormatDurationPipe implements PipeTransform {
  transform(seconds: number | null | undefined): string {
    if (seconds == null) return '-';
    if (!Number.isFinite(seconds)) return '0:00';
    // A negative time is a real value (e.g. pre-pull, before the fight start), so keep the sign.
    const sign = seconds < 0 ? '-' : '';
    const abs = Math.abs(seconds);
    const m = Math.floor(abs / 60);
    const s = Math.floor(abs % 60);
    return `${sign}${m}:${String(s).padStart(2, '0')}`;
  }
}
