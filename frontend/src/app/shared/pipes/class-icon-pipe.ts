import { Pipe, PipeTransform, inject } from '@angular/core';
import { SpecMetaService } from '../../core/data-files/spec-meta-service';

/** No-space class name (e.g. 'DeathKnight') -> zamimg class-icon URL, or '' when empty. */
// A pure pipe would cache the pre-hydration ''.
@Pipe({ name: 'classIcon', pure: false })
export class ClassIconPipe implements PipeTransform {
  private readonly specMeta = inject(SpecMetaService);

  transform(className: string | null | undefined): string {
    return this.specMeta.classIconUrl(className ?? '');
  }
}
