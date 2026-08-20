import { describe, it, expect } from 'vitest';
import { discoveryBudgetSummary, encounterIndexEntries } from './ingest-orchestrator.service';
import { BudgetExceededError } from './wcl-client';
import type { IngestEncounter } from './models/wcl.models';
import type { EncounterEntry } from '../core/models/encounter.models';

describe('discoveryBudgetSummary', () => {
  it('maps a budget exhaustion at discovery to a clean budgetStopped summary: no fatal, no specs failed', () => {
    const summary = discoveryBudgetSummary(new BudgetExceededError('WCL budget low'));
    expect(summary).not.toBeNull();
    expect(summary?.budgetStopped).toBe(true);
    expect(summary?.fatal).toBeUndefined();
    expect(summary?.failed).toEqual([]);
    expect(summary?.succeeded).toEqual([]);
  });

  it('returns null for any non-budget error so it propagates to the fatal handler', () => {
    expect(discoveryBudgetSummary(new Error('worldData request failed'))).toBeNull();
  });
});

describe('encounterIndexEntries', () => {
  const SAMPLED_COUNT = 25;
  const enc = (id: number, name: string): IngestEncounter =>
    ({ id, name, zone: 'New Raid', zoneId: 60, partitionIds: [] });

  const FIRST_BOSS = enc(9100, 'First Boss');
  const SECOND_BOSS = enc(9101, 'Second Boss');
  const ON_DISK: EncounterEntry[] = [{ id: 9101, name: 'Second Boss', sample_count: SAMPLED_COUNT }];

  it('lists every current encounter in zone order, at zero samples when nothing is on disk yet', () => {
    expect(encounterIndexEntries([FIRST_BOSS, SECOND_BOSS], [])).toEqual([
      { id: 9100, name: 'First Boss', sample_count: 0 },
      { id: 9101, name: 'Second Boss', sample_count: 0 },
    ]);
  });

  it('carries the on-disk sample count for a benched encounter and 0 for the rest', () => {
    expect(encounterIndexEntries([FIRST_BOSS, SECOND_BOSS], ON_DISK)).toEqual([
      { id: 9100, name: 'First Boss', sample_count: 0 },
      { id: 9101, name: 'Second Boss', sample_count: SAMPLED_COUNT },
    ]);
  });

  it('drops on-disk entries outside the current zone (the phased-out tier)', () => {
    const stale: EncounterEntry[] = [{ id: 3176, name: 'Old Boss', sample_count: SAMPLED_COUNT }];
    expect(encounterIndexEntries([FIRST_BOSS], stale)).toEqual([{ id: 9100, name: 'First Boss', sample_count: 0 }]);
  });

  it('keeps the on-disk entries untouched when no live zone was resolved', () => {
    expect(encounterIndexEntries([], ON_DISK)).toEqual(ON_DISK);
  });
});
