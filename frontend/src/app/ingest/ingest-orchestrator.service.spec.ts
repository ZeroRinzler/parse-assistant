import { describe, it, expect } from 'vitest';
import { discoveryBudgetSummary } from './ingest-orchestrator.service';
import { BudgetExceededError } from './wcl-client';

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
