import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'formatSpec' })
export class FormatSpecPipe implements PipeTransform {
  transform(spec: string | null | undefined): string {
    if (!spec) return '';
    return spec.replace(/([A-Z])/g, ' $1').trim();
  }
}
