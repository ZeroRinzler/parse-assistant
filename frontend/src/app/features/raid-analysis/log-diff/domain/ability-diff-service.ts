import { Injectable } from '@angular/core';

export interface AbilityTableEntry {
  abilityId: number;
  name: string;
  total: number;
}

export interface AbilityDiffRow {
  key: string;
  abilityId: number | null;
  name: string;
  dpsA: number;
  dpsB: number;
  deltaDps: number;
}

interface AbilityDps {
  abilityId: number;
  name: string;
  dps: number;
}

@Injectable({ providedIn: 'root' })
export class AbilityDiffService {
  /** Merged by ability, sorted by the biggest DPS gap first (either direction) - a mistimed cooldown or a missed cast surfaces at the top. */
  buildRows(
    entriesA: AbilityTableEntry[], durationSA: number,
    entriesB: AbilityTableEntry[], durationSB: number,
  ): AbilityDiffRow[] {
    const mapA = this.dpsByKey(entriesA, durationSA);
    const mapB = this.dpsByKey(entriesB, durationSB);
    const keys = new Set([...mapA.keys(), ...mapB.keys()]);

    const rows = [...keys].map(key => this.mergeRow(key, mapA.get(key), mapB.get(key)));
    return rows.sort((x, y) => Math.abs(y.deltaDps) - Math.abs(x.deltaDps));
  }

  private mergeRow(key: string, a: AbilityDps | undefined, b: AbilityDps | undefined): AbilityDiffRow {
    const dpsA = this.dpsOf(a);
    const dpsB = this.dpsOf(b);
    const source = a ?? b;
    return {
      key,
      abilityId: source ? source.abilityId : null,
      name: source ? source.name : key,
      dpsA,
      dpsB,
      deltaDps: dpsA - dpsB,
    };
  }

  private dpsOf(entry: AbilityDps | undefined): number {
    return entry ? entry.dps : 0;
  }

  private dpsByKey(entries: AbilityTableEntry[], durationS: number): Map<string, AbilityDps> {
    const map = new Map<string, AbilityDps>();
    for (const entry of entries) {
      // Named entries key by name (WCL can reuse an ability id across ranks); an unnamed one falls back to its id.
      const key = entry.name || String(entry.abilityId);
      map.set(key, { abilityId: entry.abilityId, name: entry.name || key, dps: durationS > 0 ? entry.total / durationS : 0 });
    }
    return map;
  }
}
