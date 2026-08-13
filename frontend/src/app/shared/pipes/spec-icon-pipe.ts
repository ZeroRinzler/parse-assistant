import { Pipe, PipeTransform, inject } from '@angular/core';
import { SpecMetaService } from '../../core/services/spec-meta';

/** Spec folder key (e.g. 'SubtletyRogue') -> zamimg spec-icon URL, or '' when unknown. */
// A pure pipe would cache the pre-hydration ''.
@Pipe({ name: 'specIcon', pure: false })
export class SpecIconPipe implements PipeTransform {
  private readonly specMeta = inject(SpecMetaService);

  transform(spec: string | null | undefined): string {
    return spec ? this.specMeta.specIconUrl(spec) : '';
  }
}
