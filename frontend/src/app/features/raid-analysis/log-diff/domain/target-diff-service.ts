import { Injectable } from '@angular/core';

export interface TargetTableEntry {
  targetId: number;
  name: string;
  total: number;
}

export interface TargetDiffRow {
  key: string;
  targetId: number | null;
  name: string;
  pctA: number;
  pctB: number;
  deltaPct: number;
}

interface TargetShare {
  targetId: number;
  name: string;
  pct: number;
}

@Injectable({ providedIn: 'root' })
export class TargetDiffService {
  /** Merged by target, sorted by the biggest share gap first (either direction) - a target-priority miss surfaces at the top. */
  buildRows(entriesA: TargetTableEntry[], entriesB: TargetTableEntry[]): TargetDiffRow[] {
    const mapA = this.shareByKey(entriesA);
    const mapB = this.shareByKey(entriesB);
    const keys = new Set([...mapA.keys(), ...mapB.keys()]);

    const rows = [...keys].map(key => this.mergeRow(key, mapA.get(key), mapB.get(key)));
    return rows.sort((x, y) => Math.abs(y.deltaPct) - Math.abs(x.deltaPct));
  }

  private mergeRow(key: string, a: TargetShare | undefined, b: TargetShare | undefined): TargetDiffRow {
    const pctA = this.pctOf(a);
    const pctB = this.pctOf(b);
    const source = a ?? b;
    return {
      key,
      targetId: source ? source.targetId : null,
      name: source ? source.name : key,
      pctA,
      pctB,
      deltaPct: pctA - pctB,
    };
  }

  private pctOf(share: TargetShare | undefined): number {
    return share ? share.pct : 0;
  }

  private shareByKey(entries: TargetTableEntry[]): Map<string, TargetShare> {
    const total = entries.reduce((sum, entry) => sum + entry.total, 0);
    const map = new Map<string, TargetShare>();
    for (const entry of entries) {
      // Named entries key by name (an add and the boss can otherwise share nothing to key on); an unnamed one falls back to its id.
      const key = entry.name || String(entry.targetId);
      map.set(key, { targetId: entry.targetId, name: entry.name || key, pct: total > 0 ? (entry.total / total) * 100 : 0 });
    }
    return map;
  }
}
