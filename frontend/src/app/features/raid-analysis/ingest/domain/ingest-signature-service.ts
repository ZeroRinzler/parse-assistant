import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class IngestSignatureService {

  /** `report_code:fight_id` key - the unit of the parse-set fingerprint and the inaccessible set. */
  private parseKey(ranking: SignatureRanking): string {
    return `${ranking.report_code}:${ranking.fight_id}`;
  }

  /** Stable `report_code:fight_id` list, sorted, so ranking order never affects the hash. */
  private rankingFingerprint(rankings: SignatureRanking[]): string {
    return rankings
      .map(ranking => `${ranking.report_code}:${ranking.fight_id}`)
      .sort()
      .join('|');
  }

  private encounterSignature(version: string, rankings: SignatureRanking[]): string {
    return bytesToHex(sha256(utf8ToBytes(`${version}\n${this.rankingFingerprint(rankings)}`))).slice(0, 16);
  }

  /** The signature over the top-`topN` ACCESSIBLE parses - the one rule both the cheap pre-check and the post-fetch stamp key on, so they can never diverge. */
  encounterSkipKey(
    poolRows: SignatureRanking[], inaccessible: ReadonlySet<string>, version: string, topN: number,
  ): string {
    const usedRows = poolRows.filter(row => !inaccessible.has(this.parseKey(row))).slice(0, topN);
    return this.encounterSignature(version, usedRows);
  }

  /** Persist only permission-denied `inaccessibleCodes`; sign the top-N minus every `failedCodes` fetch, so a backfilled bench is stamped as the set it used. */
  signatureAfterFetch(
    poolRows: SignatureRanking[], inaccessibleCodes: ReadonlySet<string>, failedCodes: ReadonlySet<string>,
    version: string, topN: number,
  ): { signature: string; inaccessibleParses: string[] } {
    const inaccessibleParses = poolRows.filter(row => inaccessibleCodes.has(row.report_code)).map(row => this.parseKey(row));
    const failedParses = poolRows.filter(row => failedCodes.has(row.report_code)).map(row => this.parseKey(row));
    const signature = this.encounterSkipKey(poolRows, new Set(failedParses), version, topN);
    return { signature, inaccessibleParses };
  }
}

// A tailored file is fresh when the ingest version AND the exact top-parse set that produced it are unchanged, folded into one short hash.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Satisfied by the shared `toParseRankings` selection's rows, so the signature keys on exactly the parses that feed the transforms. */
export interface SignatureRanking {
  report_code: string;
  fight_id: number;
}
