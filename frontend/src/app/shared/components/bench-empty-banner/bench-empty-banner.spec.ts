import { describe, it, expect } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BenchEmptyBannerComponent } from './bench-empty-banner';

function render(inputs: Record<string, unknown>): string {
  TestBed.configureTestingModule({
    imports: [BenchEmptyBannerComponent],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(BenchEmptyBannerComponent);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return (fixture.nativeElement.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('BenchEmptyBannerComponent', () => {
  it('names the encounter in the headline', () => {
    expect(render({ encounter: 'Chimaerus, the Undreamt God' }))
      .toContain('No benchmark for Chimaerus, the Undreamt God yet');
  });

  it('lists the three ingest steps', () => {
    const text = render({ encounter: 'Boss' });
    expect(text).toContain('Mythic kills logged');
    expect(text).toContain('Ingest samples them');
    expect(text).toContain('waiting');
    expect(text).toContain('hourly');
    expect(text).toContain('automatic');
  });

  it('uses the post-raid copy by default (Comparisons unlock)', () => {
    const text = render({ encounter: 'Boss' });
    expect(text).toContain('Your pull graded against the spec rulebook below.');
    expect(text).toContain('Comparisons unlock');
    expect(text).toContain('The sections below fill in.');
  });

  it('uses the pre-fight copy for the pre variant (Plan unlocks)', () => {
    const text = render({ encounter: 'Boss', variant: 'pre' });
    expect(text).toContain('The pre-fight plan is built entirely from top-parse logs.');
    expect(text).toContain('Plan unlocks');
    expect(text).toContain('The cards below fill in.');
  });
});
