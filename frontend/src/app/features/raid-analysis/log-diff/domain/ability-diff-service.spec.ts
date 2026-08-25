import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AbilityDiffService, AbilityTableEntry } from './ability-diff-service';

const diffService = TestBed.inject(AbilityDiffService);

const EVISCERATE = 196819;
const RUPTURE = 1943;
const SHADOW_BLADES_DAMAGE = 279043;

const DURATION_A_S = 100;
const DURATION_B_S = 200;

function entry(abilityId: number, name: string, total: number): AbilityTableEntry {
  return { abilityId, name, total };
}

describe('AbilityDiffService.buildRows', () => {
  it('divides each side total by its own pull duration before comparing', () => {
    const rows = diffService.buildRows(
      [entry(EVISCERATE, 'Eviscerate', 10_000)], DURATION_A_S,
      [entry(EVISCERATE, 'Eviscerate', 10_000)], DURATION_B_S,
    );
    expect(rows).toEqual([{ key: 'Eviscerate', abilityId: EVISCERATE, name: 'Eviscerate', dpsA: 100, dpsB: 50, deltaDps: 50 }]);
  });

  it('sorts the biggest absolute gap first, regardless of direction', () => {
    const rows = diffService.buildRows(
      [entry(EVISCERATE, 'Eviscerate', 1_000), entry(RUPTURE, 'Rupture', 500)], DURATION_A_S,
      [entry(EVISCERATE, 'Eviscerate', 1_000), entry(RUPTURE, 'Rupture', 4_000)], DURATION_A_S,
    );
    // Eviscerate: no gap (0). Rupture: -35 dps (B way ahead) -> the bigger |delta| leads.
    expect(rows.map(r => r.name)).toEqual(['Rupture', 'Eviscerate']);
    expect(rows[0]?.deltaDps).toBeLessThan(0);
  });

  it('treats an ability cast only on one side as a full-value gap, the other side scored 0', () => {
    const rows = diffService.buildRows(
      [entry(SHADOW_BLADES_DAMAGE, 'Shadow Blades', 5_000)], DURATION_A_S,
      [], DURATION_B_S,
    );
    expect(rows).toEqual([{ key: 'Shadow Blades', abilityId: SHADOW_BLADES_DAMAGE, name: 'Shadow Blades', dpsA: 50, dpsB: 0, deltaDps: 50 }]);
  });

  it('scores 0 dps for a zero-length pull rather than dividing by zero', () => {
    const rows = diffService.buildRows([entry(EVISCERATE, 'Eviscerate', 1_000)], 0, [], DURATION_B_S);
    expect(rows[0]?.dpsA).toBe(0);
  });

  it('keeps stable ordering when two rows tie on |delta|', () => {
    const rows = diffService.buildRows(
      [entry(EVISCERATE, 'Eviscerate', 1_000), entry(RUPTURE, 'Rupture', 1_000)], DURATION_A_S,
      [], DURATION_A_S,
    );
    expect(rows.map(r => r.name)).toEqual(['Eviscerate', 'Rupture']);
  });
});
