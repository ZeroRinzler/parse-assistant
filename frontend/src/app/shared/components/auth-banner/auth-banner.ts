import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { WclAuthService } from '../../../core/services/wcl-auth';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-auth-banner',
  imports: [MatButtonModule, MatIconModule],
  template: `
    <div class="auth-banner">
      <mat-icon class="banner-icon">lock_open</mat-icon>
      <h3>Connect Warcraft Logs</h3>
      <p>
        This analyzer fetches your combat data directly from Warcraft Logs.<br>
        Sign in once and your browser remembers your session.
      </p>
      <button mat-flat-button color="primary" (click)="signIn()">
        <mat-icon>login</mat-icon>
        Sign in with Warcraft Logs
      </button>
    </div>
  `,
  styleUrl: './auth-banner.scss',
})
export class AuthBannerComponent {
  private readonly auth = inject(WclAuthService);
  protected signIn(): void { this.auth.login(); }
}
