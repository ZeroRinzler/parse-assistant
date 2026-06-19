import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { WclAuthService } from '../../../core/services/wcl-auth';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-auth-banner',
  imports: [MatButtonModule, MatCardModule, MatIconModule],
  templateUrl: './auth-banner.html',
})
export class AuthBannerComponent {
  private readonly auth = inject(WclAuthService);
  protected signIn(): void { this.auth.login(); }
}
