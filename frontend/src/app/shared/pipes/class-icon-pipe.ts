import { Pipe, PipeTransform } from '@angular/core';
import { classIconUrl } from '../../core/spec-meta';

/** No-space class name (e.g. 'DeathKnight') -> zamimg class-icon URL, or '' when empty. */
@Pipe({ name: 'classIcon' })
export class ClassIconPipe implements PipeTransform {
  transform(className: string | null | undefined): string {
    return classIconUrl(className ?? '');
  }
}
