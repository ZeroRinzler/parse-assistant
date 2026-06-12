import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-loading-spinner',
  imports: [MatProgressSpinnerModule],
  template: `
    <div class="spinner-wrap">
      <mat-spinner [diameter]="36"></mat-spinner>
      @if (message()) {
        <span class="spinner-msg">{{ message() }}</span>
      }
    </div>
  `,
  styles: [`
    .spinner-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 48px;
      color: var(--muted);
    }
    .spinner-msg { font-size: 14px; }
  `],
})
export class LoadingSpinnerComponent {
  readonly message = input<string>('');
}
