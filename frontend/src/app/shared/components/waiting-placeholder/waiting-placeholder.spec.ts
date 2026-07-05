import { describe, it, expect } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WaitingPlaceholderComponent } from './waiting-placeholder';

function render(inputs: Record<string, unknown>): string {
  TestBed.configureTestingModule({
    imports: [WaitingPlaceholderComponent],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(WaitingPlaceholderComponent);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return fixture.nativeElement.textContent ?? '';
}

describe('WaitingPlaceholderComponent', () => {
  it('renders the heading and the waiting message', () => {
    const text = render({ heading: 'Offensives' });
    expect(text).toContain('Offensives');
    expect(text).toContain('Waiting for top parses');
  });

  it('renders the optional subtitle when provided', () => {
    const text = render({ heading: 'Offensives', subtitle: 'Offensive cooldowns vs top parses.' });
    expect(text).toContain('Offensive cooldowns vs top parses.');
  });

  it('shows the default caption', () => {
    expect(render({ heading: 'Defensives' })).toContain('Built from the top-parse bench.');
  });
});
