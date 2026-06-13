import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-loading-spinner',
  imports: [MatProgressSpinnerModule],
  template: `
    <div class="flex flex-col items-center gap-3 p-12 text-[var(--muted)]">
      <mat-spinner [diameter]="36"></mat-spinner>
      @if (message()) {
        <span class="text-sm">{{ message() }}</span>
      }
    </div>
  `,
})
export class LoadingSpinnerComponent {
  readonly message = input<string>('');
}
