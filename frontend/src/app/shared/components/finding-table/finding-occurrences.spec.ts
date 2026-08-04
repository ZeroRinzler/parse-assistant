import { describe, it, expect } from 'vitest';
import { mountVm } from '../../../../testing/component-harness';
import { FindingOccurrencesComponent } from './finding-occurrences';
import type { FindingOccurrence } from '../../../core/models/analysis.models';

function occ(over: Partial<FindingOccurrence> = {}): FindingOccurrence {
  return { ok: true, label: 'x', detail: 'detail', ...over };
}

describe('FindingOccurrencesComponent', () => {
  it('activeIndex defaults to the first failing occurrence', () => {
    const occurrences = [occ({ ok: true, label: 'a' }), occ({ ok: false, label: 'b' }), occ({ ok: false, label: 'c' })];
    const { vm } = mountVm(FindingOccurrencesComponent, { occurrences });
    expect(vm.activeIndex()).toBe(1);
    expect(vm.active()?.label).toBe('b');
  });

  it('activeIndex defaults to the first entry when nothing failed', () => {
    const occurrences = [occ({ label: 'a' }), occ({ label: 'b' })];
    const { vm } = mountVm(FindingOccurrencesComponent, { occurrences });
    expect(vm.activeIndex()).toBe(0);
  });

  it('select overrides the default and moves the active occurrence', () => {
    const occurrences = [occ({ ok: false, label: 'a' }), occ({ label: 'b' }), occ({ label: 'c' })];
    const { vm } = mountVm(FindingOccurrencesComponent, { occurrences });
    vm.select(2);
    expect(vm.activeIndex()).toBe(2);
    expect(vm.active()?.label).toBe('c');
  });

  it('computes no timeline segments when the finding carries no timeline', () => {
    const { vm } = mountVm(FindingOccurrencesComponent, { occurrences: [occ()] });
    expect(vm.segments()).toEqual([]);
  });

  it('positions timeline segments as a percentage of the fight', () => {
    const { vm } = mountVm(FindingOccurrencesComponent, {
      occurrences: [occ()],
      timeline: { segmentsMs: [[0, 25_000], [75_000, 100_000]], fightDurationMs: 100_000 },
    });
    expect(vm.segments()).toEqual([
      { leftPercentage: 0, widthPercentage: 25 },
      { leftPercentage: 75, widthPercentage: 25 },
    ]);
  });
});
