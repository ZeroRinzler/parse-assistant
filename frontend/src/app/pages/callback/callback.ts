import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { WclAuthService } from '../../core/services/wcl-auth';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-callback',
  imports: [LoadingSpinnerComponent],
  template: `
    @if (error()) {
      <div class="callback-error">
        <h3>Authentication Error</h3>
        <p>{{ error() }}</p>
        <a href="/">Return home</a>
      </div>
    } @else {
      <wl-loading-spinner message="Completing sign in…"></wl-loading-spinner>
    }
  `,
  styles: [`
    .callback-error {
      text-align: center;
      padding: 48px 24px;
      color: var(--critical);
    }
    a { color: var(--gold); }
  `],
})
export class CallbackComponent implements OnInit {
  private readonly auth = inject(WclAuthService);
  private readonly router = inject(Router);

  protected readonly error = signal<string>('');

  async ngOnInit(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const oauthError = params.get('error');
    const oauthDesc = params.get('error_description');
    const returnPath = sessionStorage.getItem('wcl_return_path') || '/';

    if (oauthError) {
      const desc = oauthDesc ? `: ${decodeURIComponent(oauthDesc.replace(/\+/g, ' '))}` : '';
      this.error.set(`WCL OAuth error - ${oauthError}${desc}`);
      return;
    }

    if (!code) {
      const expectedUri = new URL('callback', document.baseURI).href;
      this.error.set(
        'No authorization code received from Warcraft Logs. ' +
        'Make sure your WCL API client has the redirect URI ' +
        `"${expectedUri}" registered at warcraftlogs.com/api/clients/.`
      );
      return;
    }

    try {
      await this.auth.exchangeCode(code);
      sessionStorage.removeItem('wcl_return_path');
      const url = new URL(returnPath);
      await this.router.navigateByUrl(url.pathname + url.search);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Authentication failed.');
    }
  }
}
