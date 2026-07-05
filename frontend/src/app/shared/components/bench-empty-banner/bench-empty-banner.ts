import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/** Which page the banner explains: the post-raid analysis or the pre-fight plan. */
export type BenchEmptyVariant = 'post' | 'pre';

/**
 * Top-of-page banner for an encounter with no ingested bench yet: names it and lays out the
 * three-step ingest pipeline. Inputs-only leaf. `variant` switches the body + final step
 * between the post-raid ("Comparisons unlock") and pre-fight ("Plan unlocks") copy.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-bench-empty-banner',
  imports: [MatIconModule],
  host: { class: 'block' },
  templateUrl: './bench-empty-banner.html',
})
export class BenchEmptyBannerComponent {
  readonly encounter = input<string>('');
  readonly variant = input<BenchEmptyVariant>('post');
}
