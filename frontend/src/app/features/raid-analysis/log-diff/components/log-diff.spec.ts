import { describe, it, expect } from 'vitest';
import { signal } from '@angular/core';
import { mountVm } from '../../../../../testing/component-harness';
import { LogDiffFeatureService } from '../facade/log-diff-feature-service';
import { ComparisonView } from '../domain/log-diff.models';
import { LogDiff } from './log-diff';

function stubService(comparisonValue: ComparisonView | null): Partial<LogDiffFeatureService> {
  return {
    sideA: signal({ code: '', title: '', report: null, fights: [], players: [], selectedFightId: null, selectedPlayerId: null, loading: false, error: null, notice: '' }),
    sideB: signal({ code: '', title: '', report: null, fights: [], players: [], selectedFightId: null, selectedPlayerId: null, loading: false, error: null, notice: '' }),
    visibleA: signal([]),
    visibleB: signal([]),
    comparing: signal(false),
    canCompare: signal(false),
    comparisonValue: signal(comparisonValue),
    comparisonError: signal(null),
  };
}

function comparison(over: Partial<ComparisonView>): ComparisonView {
  return { playerA: 'Ana', playerB: 'Bo', totalDpsA: 0, totalDpsB: 0, rows: [], targetRows: [], ...over };
}

describe('LogDiff labels', () => {
  it('leaves the plain "Log A" / "Log B" labels before a comparison exists', () => {
    const { vm } = mountVm(LogDiff, {}, [{ provide: LogDiffFeatureService, useValue: stubService(null) }]);
    expect(vm['labelA']()).toBe('Log A');
    expect(vm['labelB']()).toBe('Log B');
  });

  it('tags the higher-DPS side "Top DPS" and the other "Bottom DPS"', () => {
    const { vm } = mountVm(LogDiff, {}, [
      { provide: LogDiffFeatureService, useValue: stubService(comparison({ totalDpsA: 500, totalDpsB: 300 })) },
    ]);
    expect(vm['labelA']()).toBe('Log A - Top DPS');
    expect(vm['labelB']()).toBe('Log B - Bottom DPS');
  });

  it('flips the tags when B is the higher-DPS side', () => {
    const { vm } = mountVm(LogDiff, {}, [
      { provide: LogDiffFeatureService, useValue: stubService(comparison({ totalDpsA: 300, totalDpsB: 500 })) },
    ]);
    expect(vm['labelA']()).toBe('Log A - Bottom DPS');
    expect(vm['labelB']()).toBe('Log B - Top DPS');
  });

  it('leaves both plain on an exact tie', () => {
    const { vm } = mountVm(LogDiff, {}, [
      { provide: LogDiffFeatureService, useValue: stubService(comparison({ totalDpsA: 400, totalDpsB: 400 })) },
    ]);
    expect(vm['labelA']()).toBe('Log A');
    expect(vm['labelB']()).toBe('Log B');
  });
});
