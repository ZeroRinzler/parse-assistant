// Orchestration only; no transformation lives here.
import { Injectable, inject } from '@angular/core';
import pLimit from 'p-limit';
import { NgHttpCachingService } from 'ng-http-caching';
import { WclApiService } from '../../core/services/wcl-api';
import { DataFileApiService } from '../../core/services/data-file-api';
import { HttpWclTransport } from '../../core/transport/http-wcl-transport';
import { SpecMetaService } from '../../core/services/spec-meta';
import { logWarn } from '../../core/log';
import { type LoadError } from '../../core/result';
import { toParseRankings, unwrapRankings } from '../../shared/analysis/wcl-projections';
import type { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';
import { RATE_LIMIT_Q, CLASSES_Q } from '../../core/services/wcl-queries';
import type { ClassesQuery, RateLimitQuery } from '../../core/services/wcl-operations.generated';
import { sliceRegistry, type SliceDescriptor } from './slice-registry';
import { getEncounters, rankingsFromPartition } from '../wcl-fetchers';
import { mapClassesToSpecMeta, parseRaidNames } from '../wcl-mappers';
import { type WclQueryClient, BudgetExceededError } from '../wcl-client';
import { INGEST_VERSION } from '../ingest-version';
import { specsForRun, orderEncountersByMissingFirst, parsePrioritySpecs, type SpecOrderEntry } from '../ordering';
import {
  encounterSkipKey, signatureAfterFetch, stampSignature, stampBurstFile,
  type SignatureRanking, type IngestStamp,
} from '../signature';
import { readStoredMetadata, signatureMatches, type StampedFile } from '../../core/data-source/metadata/stored-metadata';
import { formatSpecReport, SELECTED_MARKER, type SpecReportRow } from '../spec-report';
import type { IngestEncounter } from '../models/wcl.models';

const TOP_N = 10;
// Matches the depth the transforms over-fetch to, so a parse that backfills a private top parse is part of the skip key.
const SIGNATURE_POOL_COUNT = TOP_N * 2;
const POINTS_MARGIN = 500;
const SLICE_CONCURRENCY = 3;

/** Published on `globalThis.__INGEST_DONE__` - the headless harness's exit signal. */
export interface IngestRunSummary {
  succeeded: string[];
  failed: { spec: string; message: string }[];
  budgetStopped: boolean;
  fatal?: string;
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function publishSummary(summary: IngestRunSummary): void {
  (globalThis as { __INGEST_DONE__?: IngestRunSummary }).__INGEST_DONE__ = summary;
}

/** Zero-sample encounters stay listed, or a new raid's bosses are not selectable until its first parses land. */
export function encounterIndexEntries(current: IngestEncounter[], onDisk: EncounterEntry[]): EncounterEntry[] {
  if (!current.length) return onDisk;
  const samplesById = new Map(onDisk.map(entry => [entry.id, entry.sample_count]));
  return current.map(encounter => ({ id: encounter.id, name: encounter.name, sample_count: samplesById.get(encounter.id) ?? 0 }));
}

class ApiWclClient implements WclQueryClient {
  private _limitPerHour: number | null = null;
  private _pointsSpentThisHour = 0;

  constructor(private readonly wclApi: WclApiService) {}

  query<T>(gql: string, variables?: object): Promise<T> {
    // These reads are marked uncached (see wclCachingHeaders), so the budget gate sees fresh data.
    return this.wclApi.query<T>(gql, (variables ?? {}));
  }

  async assertBudget(margin: number): Promise<void> {
    const data = await this.query<RateLimitQuery>(RATE_LIMIT_Q);
    const rateLimit = data.rateLimitData;
    if (rateLimit) {
      this._limitPerHour = rateLimit.limitPerHour;
      this._pointsSpentThisHour = rateLimit.pointsSpentThisHour;
    }
    if (this._limitPerHour == null) return; // unknown - don't block
    const remaining = this._limitPerHour - this._pointsSpentThisHour;
    if (remaining < margin) {
      throw new BudgetExceededError(`WCL budget low: ${remaining} of ${this._limitPerHour} remaining (need ${margin})`);
    }
  }
}

@Injectable({ providedIn: 'root' })
export class IngestOrchestratorService {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFile = inject(DataFileApiService);
  private readonly specMeta = inject(SpecMetaService);
  // The orchestrator needs the transport's inaccessible-code drain, which is ingest-only surface.
  private readonly wclTransport = inject(HttpWclTransport);
  private readonly wclCache = inject(NgHttpCachingService);
  private readonly slices = sliceRegistry();

  /** Never rejects: the fire-and-forget app initializer must not see an unhandled rejection. */
  async run(): Promise<void> {
    try {
      await this.ingestAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('\nFatal error:', message);
      publishSummary({ succeeded: [], failed: [], budgetStopped: false, fatal: message });
    }
  }

  private async ingestAll(): Promise<void> {
    console.log('warcraft-learner - Parse Ingestion');
    const client = new ApiWclClient(this.wclApi);
    const version = String(INGEST_VERSION);
    console.log(`Ingest version: ${version}`);

    await this.resolveSpecMetas(client);

    const raidNames = parseRaidNames(new URLSearchParams(globalThis.location.search).get('currentRaids'));
    console.log(raidNames.length
      ? `Current raids (CURRENT_RAIDS): ${raidNames.join(', ')}`
      : 'CURRENT_RAIDS is unset - nothing to ingest, nothing pruned.');
    const { encounters, protectedIds } = await getEncounters(client, raidNames);
    console.log(`${encounters.length} encounters`);
    await this.pruneRetiredRaids(protectedIds);
    await this.refreshIndices(encounters);

    const specs = await this.orderedSpecsFromDisk();
    if (!specs.length) {
      console.log('No known specs (no rulebook.json found). Nothing to do.');
      publishSummary({ succeeded: [], failed: [], budgetStopped: false });
      return;
    }

    const summary = await this.ingestEachSpec(client, specs, encounters, version);
    this.printRunSummary(summary, specs.length);
    publishSummary(summary);
  }

  private async resolveSpecMetas(client: ApiWclClient): Promise<void> {
    // The spec icon is not on WCL, so enrich each meta from that spec's rulebook (its spec_icon stem).
    const classesData = await client.query<ClassesQuery>(CLASSES_Q);
    const metas = mapClassesToSpecMeta(classesData.gameData?.classes ?? []);
    for (const meta of metas) {
      const rulebook = await this.dataFile.getRulebook(meta.spec);
      if (rulebook.ok) {
        meta.specIcon = rulebook.value.spec_icon;
      } else {
        // Only a corrupt file (permanent) is worth logging; a missing rulebook is an un-authored spec.
        if (rulebook.error.kind === 'permanent') {
          logWarn(`ingest ${meta.spec}: corrupt rulebook.json, shipping blank spec icon`, rulebook.error);
        }
        meta.specIcon = '';
      }
    }
    this.specMeta.hydrate(metas);
    await this.dataFile.writeSpecMeta(metas);
    console.log(`Resolved ${metas.length} specs from WCL`);
  }



  /** Pruning only the selected specs would leave them at zero data and permanently re-selected. */
  private async pruneRetiredRaids(protectedIds: Set<number>): Promise<void> {
    // An unset CURRENT_RAIDS names no raid, which must not read as "prune everything".
    if (protectedIds.size === 0) return;
    for (const spec of await this.dataFile.listSpecs()) {
      const pruned = await this.pruneStaleEncounters(spec, protectedIds);
      if (pruned.length) console.log(`  [${spec}] pruned ${pruned.length} stale encounter(s): ${pruned.join(', ')}`);
    }
  }

  /** Every run, so samples ingested for a spec that is not selected again still surface in its index. */
  private async refreshIndices(encounters: IngestEncounter[]): Promise<void> {
    for (const spec of await this.dataFile.listSpecs()) {
      await this.rebuildEncountersIndex(spec, encounters);
    }
    await this.rebuildSpecIndex();
  }

  private async ingestEachSpec(
    client: ApiWclClient, specs: string[],
    encounters: IngestEncounter[], version: string,
  ): Promise<IngestRunSummary> {
    // Isolate each spec so one throw drops only that spec, not the whole run.
    const succeeded: string[] = [];
    const failed: { spec: string; message: string }[] = [];
    let budgetStopped = false;
    for (const spec of specs) {
      try {
        const budgetExhausted = await this.ingestSpec(client, spec, encounters, version);
        succeeded.push(spec);
        if (budgetExhausted) { budgetStopped = true; break; }
      } catch (err) {
        logWarn(`ingest: spec ${spec} aborted, continuing with the remaining specs`, err);
        failed.push({ spec, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { succeeded, failed, budgetStopped };
  }

  private printRunSummary({ succeeded, failed, budgetStopped }: IngestRunSummary, specCount: number): void {
    console.log('\n=== Ingestion summary ===');
    console.log(`Specs processed: ${succeeded.length} of ${specCount}`);
    if (budgetStopped) {
      console.log('Stopped early: WCL point budget exhausted; the remaining specs resume next run.');
    }
    if (failed.length) {
      console.log(`Specs failed (${failed.length}): ${failed.map(entry => entry.spec).join(', ')}`);
      for (const entry of failed) {
        console.log(`  ${entry.spec}: ${entry.message}`);
      }
    } else {
      console.log('No spec-level failures.');
    }
  }

  private async orderedSpecsFromDisk(): Promise<string[]> {
    const onDisk = await this.dataFile.listSpecs();
    const withRulebook: string[] = [];
    for (const spec of onDisk) {
      const rulebook = await this.dataFile.getRulebook(spec);
      if (rulebook.ok) {
        withRulebook.push(spec);
      } else if (rulebook.error.kind === 'permanent') {
        // A corrupt rulebook silently freezes the spec on stale data; log so it is diagnosable.
        logWarn(`ingest ${spec}: corrupt rulebook.json, excluded from this run`, rulebook.error);
      }
    }
    if (!withRulebook.length) return [];

    const orderInputs = await Promise.all(withRulebook.map(async spec => {
      const burstFiles = (await this.dataFile.listSliceFiles(spec, 'burst'))
        .filter(file => file.endsWith('.json'));
      const stamps = await Promise.all(burstFiles.map(async file => {
        const slice = await this.dataFile.getSlice<StampedFile>(spec, parseInt(file), 'burst');
        return readStoredMetadata(slice.ok ? slice.value : null);
      }));
      const versions = stamps.map(stamp => stamp.version);
      const storedVersions = versions.filter((stored): stored is number => stored !== null);
      const storedTimes = stamps
        .map(stamp => stamp.ingestedAtS)
        .filter((stored): stored is number => stored !== null);
      const entry: SpecOrderEntry = {
        spec,
        dataCount: burstFiles.length,
        onCurrentVersion: burstFiles.length > 0 && versions.every(stored => stored === INGEST_VERSION),
      };
      // Worst version but most recent write: "still on v23", "last ingested 3h ago".
      const displayVersion = storedVersions.length ? Math.min(...storedVersions) : null;
      const displayIngestedAtS = storedTimes.length ? Math.max(...storedTimes) : null;
      return { entry, displayVersion, displayIngestedAtS };
    }));
    const prioritySpecs = parsePrioritySpecs(new URLSearchParams(globalThis.location.search).get('prioritySpecs'));
    const { ordered, selected } = specsForRun(orderInputs.map(input => input.entry), prioritySpecs);
    const displayBySpec = new Map(orderInputs.map(input => [input.entry.spec, input] as const));
    const selectedSpecs = new Set(selected);
    const rows: SpecReportRow[] = ordered.map(spec => ({
      spec,
      version: displayBySpec.get(spec)?.displayVersion ?? null,
      ingestedAtS: displayBySpec.get(spec)?.displayIngestedAtS ?? null,
      selected: selectedSpecs.has(spec),
    }));
    console.log(
      `Specs (old version first, ${SELECTED_MARKER} = ingested this run):\n${formatSpecReport(rows, nowS())}`,
    );
    return selected;
  }

  /** Returns true when the run stopped on the WCL budget (remaining specs resume next run). */
  private async ingestSpec(
    client: ApiWclClient, spec: string,
    encounters: IngestEncounter[], version: string,
  ): Promise<boolean> {
    console.log(`\nIngesting ${spec} - ${encounters.length} encounters (top ${TOP_N})`);

    // Feeds the missing-first order - a file-server-only signal, zero WCL budget.
    const presentIds = new Set(
      (await this.dataFile.listSliceFiles(spec, 'burst'))
        .filter(file => file.endsWith('.json'))
        .map(file => parseInt(file))
        .filter(id => Number.isFinite(id)),
    );

    try {
      for (const encounter of orderEncountersByMissingFirst(encounters, presentIds)) {
        await client.assertBudget(POINTS_MARGIN);

        const { rows: poolRows, partition } = await this.rankingPool(spec, encounter);
        if (!poolRows.length) {
          console.log(`  [${encounter.name}] no rankings, skipped`);
          continue;
        }

        const existingResult = await this.dataFile.getSlice<StampedFile>(spec, encounter.id, 'burst');
        const existing = readStoredMetadata(existingResult.ok ? existingResult.value : null);
        const skipKey = encounterSkipKey(poolRows, existing.inaccessibleParses, version, TOP_N);
        if (signatureMatches(existing.signature, skipKey)) {
          console.log(`  [${encounter.name}] unchanged (signature ${skipKey}), skipped`);
          continue;
        }

        console.log(`  [${encounter.name}] computing slices (signature ${skipKey})...`);
        try {
          const wrote = await this.ingestEncounter(spec, encounter, version, poolRows, partition);
          console.log(`  [${encounter.name}] ${wrote ? 'done' : 'no slice data produced'}`);
        } finally {
          // Drop this encounter's cached reports/events before the next one to bound memory.
          this.wclCache.clearCache();
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.log(`\n[budget] Stopping cleanly: ${err.message}`);
        await this.rebuildEncountersIndex(spec, encounters);
        await this.rebuildSpecIndex();
        return true;
      }
      throw err;
    }

    await this.rebuildEncountersIndex(spec, encounters);
    await this.rebuildSpecIndex();
    console.log(`Ingestion complete for ${spec}.`);
    return false;
  }

  /** Resolves the partition here, once, so the signature and every slice below read the same parses. */
  private rankingPool(spec: string, encounter: IngestEncounter): Promise<{ rows: SignatureRanking[]; partition: number | null }> {
    return rankingsFromPartition(encounter.partitionIds, async partition => {
      const raw = await this.wclApi.getRankings(spec, encounter.id, partition);
      return toParseRankings(unwrapRankings(raw), SIGNATURE_POOL_COUNT);
    });
  }

  /** Compute every slice first, THEN stamp + write: the signature is known only after every transform has fetched. */
  private async ingestEncounter(
    spec: string, encounter: IngestEncounter, version: string, poolRows: SignatureRanking[], partition: number | null,
  ): Promise<boolean> {
    const encId = encounter.id;
    const limit = pLimit(SLICE_CONCURRENCY);
    const [burstSlice, ...siblings] = this.slices;
    const bench = (slice: SliceDescriptor) => limit(() => slice.transform.getBench(spec, encId, partition));
    const [burst, rest] = await Promise.all([
      bench(burstSlice),
      Promise.all(siblings.map(async slice => ({ slice, result: await bench(slice) }))),
    ]);

    const inaccessibleCodes = new Set(this.wclTransport.takeInaccessibleCodes());
    const failedCodes = new Set(this.wclTransport.takeFailedCodes());
    const { signature, inaccessibleParses } = signatureAfterFetch(poolRows, inaccessibleCodes, failedCodes, version, TOP_N);
    const stamp: IngestStamp = { version: INGEST_VERSION, ingestedAtS: nowS() };

    // Skip on any failure so a slice is never overwritten with partial data.
    const skipNote = (slice: string, error: LoadError): string =>
      error.kind === 'missing'
        ? `    [${encounter.name}] ${slice}: no data, skipped`
        : `    [${encounter.name}] ${slice}: ${error.kind} (${error.message}), skipped`;

    let wroteAny = burst.ok;
    const writes: Promise<void>[] = [];
    if (burst.ok) {
      const all = [burst, ...rest.map(entry => entry.result)];
      writes.push(burstSlice.write(spec, encId, stampBurstFile(burst.value, signature, stamp, inaccessibleParses, all)));
    } else { console.log(skipNote(burstSlice.file, burst.error)); }
    for (const { slice, result } of rest) {
      if (result.ok) {
        writes.push(slice.write(spec, encId, stampSignature(result.value, signature, stamp)));
        wroteAny ||= slice.countsAsBenchData;
      } else { console.log(skipNote(slice.file, result.error)); }
    }

    await Promise.all(writes);
    return wroteAny;
  }

  private async rebuildEncountersIndex(spec: string, current: IngestEncounter[]): Promise<void> {
    const files = await this.dataFile.listSliceFiles(spec, 'burst');
    const onDisk: EncounterEntry[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const encId = parseInt(file);
      if (!Number.isFinite(encId)) continue;
      const bench = await this.dataFile.getSlice<{ encounter_id?: number; encounter_name?: string; sample_count?: number }>(spec, encId, 'burst');
      if (!bench.ok) continue;
      onDisk.push({
        id: bench.value.encounter_id ?? encId,
        name: bench.value.encounter_name ?? file,
        sample_count: bench.value.sample_count ?? 0,
      });
    }
    await this.dataFile.writeEncounters(spec, encounterIndexEntries(current, onDisk));
  }

  private async rebuildSpecIndex(): Promise<void> {
    const specs = await this.dataFile.listSpecs();
    const entries: SpecEntry[] = [];
    for (const spec of specs.sort()) {
      const encounters = await this.dataFile.getEncounters(spec);
      // Zero-sample encounters count: gating on benched data would hide every spec while a new raid waits for its first Mythic parses.
      const count = encounters.ok ? encounters.value.length : 0;
      if (count > 0) entries.push({ spec, encounter_count: count });
    }
    await this.dataFile.writeSpecs(entries);
  }

  private async pruneStaleEncounters(spec: string, protectedIds: Set<number>): Promise<number[]> {
    const removed: number[] = [];
    const files = await this.dataFile.listSliceFiles(spec, 'burst');
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const encId = parseInt(file);
      if (!Number.isFinite(encId) || protectedIds.has(encId)) continue;
      for (const { file: slice } of this.slices) {
        try {
          await this.dataFile.removeSlice(spec, encId, slice);
        } catch (err) {
          logWarn(`pruneStaleEncounters ${spec}/${encId}/${slice}`, err);
        }
      }
      removed.push(encId);
    }
    return removed.sort((a, b) => a - b);
  }
}
