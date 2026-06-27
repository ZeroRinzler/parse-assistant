import { Pipe, PipeTransform } from '@angular/core';
import { specIconUrl } from '../../core/spec-meta';

/** Spec folder key (e.g. 'SubtletyRogue') -> zamimg spec-icon URL, or '' when unknown. */
@Pipe({ name: 'specIcon' })
export class SpecIconPipe implements PipeTransform {
  transform(spec: string | null | undefined): string {
    return spec ? specIconUrl(spec) : '';
  }
}
