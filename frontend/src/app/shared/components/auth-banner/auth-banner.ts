import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { WclAuthService } from '../../../core/services/wcl-auth';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-auth-banner',
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './auth-banner.html',
  styleUrl: './auth-banner.scss',
})
export class AuthBannerComponent {
  private readonly auth = inject(WclAuthService);
  protected signIn(): void { this.auth.login(); }
}
