import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';
import type { FindingOccurrence, FindingTimeline } from '../../../core/models/analysis.models';

export interface TimelineBand {
  leftPercentage: number;
  widthPercentage: number;
}

// Distinguishes option ids when several occurrence strips are open across the page.
let nextInstanceSeq = 0;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-finding-occurrences',
  host: { class: 'block' },
  imports: [FormatDurationPipe],
  templateUrl: './finding-occurrences.html',
})
export class FindingOccurrencesComponent {
  readonly occurrences = input.required<FindingOccurrence[]>();
  readonly target = input<string>('');
  readonly timeline = input<FindingTimeline | undefined>(undefined);

  private readonly selectedIndex = signal<number | null>(null);

  /** Defaults to the first failing instance, so opening a finding points straight at a moment worth reading. */
  private readonly firstBadIndex = computed(() => {
    const index = this.occurrences().findIndex(occ => !occ.ok);
    return index === -1 ? 0 : index;
  });

  readonly activeIndex = computed(() => this.selectedIndex() ?? this.firstBadIndex());
  readonly active = computed<FindingOccurrence | undefined>(() => this.occurrences()[this.activeIndex()]);

  readonly segments = computed<TimelineBand[]>(() => {
    const t = this.timeline();
    if (!t || t.fightDurationS <= 0) return [];
    return t.segmentsS.map(([start, end]) => ({
      leftPercentage: (start / t.fightDurationS) * 100,
      widthPercentage: ((end - start) / t.fightDurationS) * 100,
    }));
  });

  private readonly instanceId = `wl-finding-occurrences-${nextInstanceSeq++}`;

  optionId(index: number): string {
    return `${this.instanceId}-opt-${index}`;
  }

  // The listbox keeps focus; aria-activedescendant points screen readers at the active chip.
  readonly activeOptionId = computed(() => this.optionId(this.activeIndex()));

  select(index: number): void {
    this.selectedIndex.set(index);
  }

  onKeydown(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = this.activeIndex() + delta;
    if (next >= 0 && next < this.occurrences().length) this.select(next);
  }
}
