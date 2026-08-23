import { describe, it, expect } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LoadState, RenderableLoadError } from './load-state';

const TRANSIENT_ERROR: RenderableLoadError = { kind: 'transient', message: 'WCL is unreachable right now.' };
const PERMANENT_ERROR: RenderableLoadError = {
  kind: 'permanent', message: 'Analysis data could not be loaded.', id: 'gear.combatant-info',
};

interface Rendered {
  readonly text: string;
  readonly icon: string;
}

function render(inputs: Record<string, unknown>): Rendered {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [LoadState],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(LoadState);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return {
    text: host.textContent.replace(/\s+/g, ' ').trim(),
    icon: (host.querySelector('mat-icon')?.textContent ?? '').trim(),
  };
}

describe('LoadState', () => {
  describe('waiting state (no error)', () => {
    it('renders the heading and the waiting message with the schedule icon', () => {
      const { text, icon } = render({ heading: 'Offensives' });
      expect(text).toContain('Offensives');
      expect(text).toContain('Waiting for top parses');
      expect(icon).toBe('schedule');
    });

    it('renders the optional subtitle when provided', () => {
      expect(render({ heading: 'Offensives', subtitle: 'Offensive cooldowns vs top parses.' }).text)
        .toContain('Offensive cooldowns vs top parses.');
    });

    it('shows the default caption', () => {
      expect(render({ heading: 'Defensives' }).text).toContain('Built from the top-parse bench.');
    });
  });

  describe('error state (shared UX with the waiting state)', () => {
    it('renders a transient error with its message, the cloud_off icon and a retry-on-sync guide', () => {
      const { text, icon } = render({ heading: 'Offensives', error: TRANSIENT_ERROR });
      expect(text).toContain(TRANSIENT_ERROR.message);
      expect(text).toContain('Retries on the next sync, or reselect the fight.');
      expect(text).not.toContain('Waiting for top parses');
      expect(icon).toBe('cloud_off');
    });

    it('renders a permanent error with its message, the error icon and a do-not-retry line', () => {
      const { text, icon } = render({ error: PERMANENT_ERROR });
      expect(text).toContain(PERMANENT_ERROR.message);
      expect(text).toContain('This analysis is bugged. Retrying will not fix it.');
      expect(icon).toBe('error');
    });

    it('keeps the card heading above the error body when given one', () => {
      expect(render({ heading: 'Gear', error: TRANSIENT_ERROR }).text).toContain('Gear');
    });
  });
});
