/**
 * Ingestion orchestrator: drives the same `*TransformService`s the runtime uses and
 * persists through the same `DataFileApiService`, so ingestion and the live browser
 * transform share one implementation. Orchestration only; no transformation lives here.
 */
import { Injectable, inject } from '@angular/core';
import pLimit from 'p-limit';
import { NgHttpCachingService } from 'ng-http-caching';
import { WclApiService } from '../core/services/wcl-api';
import { DataFileApiService } from '../core/services/data-file-api';
import { HttpWclTransport } from '../core/services/http-wcl-transport';
import { hydrateSpecMeta } from '../core/spec-meta';
import { logWarn } from '../core/log';
import { type LoadError } from '../core/result';
import { toParseRankings, unwrapRankings } from '../shared/analysis/wcl-projections';
import type { EncounterEntry, SpecEntry } from '../core/models/encounter.models';
import { RATE_LIMIT_Q, CLASSES_Q } from '../core/services/wcl-queries';
import { BurstTransformService } from '../pages/post-raid/burst-windows/burst-transform.service';
import { RotationTransformService } from '../pages/post-raid/rotation/rotation-transform.service';
import { DefensiveTransformService } from '../pages/post-raid/defensive/defensive-transform.service';
import { GearTransformService } from '../pages/post-raid/gear/gear-transform.service';
import { MapTransformService } from '../pages/post-raid/map/map-transform.service';
import { environment } from '../../environments/environment';
import { getEncounters } from './wcl-fetchers';
import { mapClassesToSpecMeta, specWclFromMetas, type SpecWclMap } from './wcl-mappers';
import { type WclQueryClient, BudgetExceededError } from './wcl-client';
import { INGEST_VERSION } from './ingest-version';
import { orderSpecsByVersion, orderEncountersByMissingFirst, SPEC_LIMIT, type SpecOrderEntry } from './ordering';
import {
  encounterSkipKey, signatureAfterFetch, readStoredSignature, readStoredVersion, signatureMatches,
  stampSignature, readInaccessibleParses,
  type SignatureRanking, type SignedFile,
} from './signature';
import type { WclRateLimitData, IngestEncounter, WclGameClass } from './models/wcl.models';

const TOP_N = 10;
// Matches the depth the transforms over-fetch to (CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2),
// so a parse that backfills a private top parse is part of the skip key.
const SIGNATURE_POOL_COUNT = TOP_N * 2;
const POINTS_MARGIN = 500;     // stop cleanly when fewer than this many WCL points remain in the hour
const SLICE_CONCURRENCY = 3;

// `burst` carries the encounter's source_signature for the skip check (every slice shares the
// same parse set, so any one would do).
const SLICES = ['burst', 'rotation', 'defensive', 'gear'] as const;

/** Published on `globalThis.__INGEST_DONE__` - the headless harness's exit signal. */
export interface IngestRunSummary {
  succeeded: string[];
  failed: { spec: string; message: string }[];
  budgetStopped: boolean;
  fatal?: string;
}

function publishSummary(summary: IngestRunSummary): void {
  (globalThis as { __INGEST_DONE__?: IngestRunSummary }).__INGEST_DONE__ = summary;
}

/** Budget-gated `WclQueryClient` over `WclApiService`. */
class ApiWclClient implements WclQueryClient {
  private _limitPerHour: number | null = null;
  private _pointsSpentThisHour = 0;

  constructor(private readonly wclApi: WclApiService) {}

  query<T = unknown, TVars extends object = Record<string, never>>(gql: string, variables?: TVars): Promise<T> {
    // network-only: the budget gate must see fresh rateLimitData, and discovery reads are one-shot.
    return this.wclApi.query<T>(gql, (variables ?? {}) as object, 'network-only');
  }

  async assertBudget(margin: number): Promise<void> {
    const data = await this.query<{ rateLimitData?: WclRateLimitData }>(RATE_LIMIT_Q);
    const rateLimit = data.rateLimitData ?? {};
    if (rateLimit.limitPerHour != null) this._limitPerHour = rateLimit.limitPerHour;
    if (rateLimit.pointsSpentThisHour != null) this._pointsSpentThisHour = rateLimit.pointsSpentThisHour;
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
  // The concrete transport (WCL_TRANSPORT aliases the same singleton): the orchestrator
  // needs its inaccessible-code drain, which is ingest-only surface.
  private readonly wclTransport = inject(HttpWclTransport);
  private readonly wclCache = inject(NgHttpCachingService);
  private readonly transforms = {
    burst: inject(BurstTransformService),
    rotation: inject(RotationTransformService),
    defensive: inject(DefensiveTransformService),
    gear: inject(GearTransformService),
    map: inject(MapTransformService),
  };

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

    // The spec icon is not on WCL, so enrich each meta from that spec's rulebook (its spec_icon
    // stem). Hydrating the cache lets getRankings resolve a spec.
    const classesData = await client.query<{ gameData?: { classes?: WclGameClass[] } }>(CLASSES_Q);
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
    const specWcl: SpecWclMap = specWclFromMetas(metas);
    hydrateSpecMeta(metas);
    await this.dataFile.writeSpecMeta(metas);
    console.log(`Resolved ${metas.length} specs from WCL`);

    console.log('Resolving current raids...');
    const { encounters, protectedIds } = await getEncounters(client, specWcl);
    console.log(`${encounters.length} live encounters`);

    let specs: string[];
    if (environment.ingestSpec) {
      if (!specWcl[environment.ingestSpec]) {
        throw new Error(`Unknown spec "${environment.ingestSpec}". Known specs: ${Object.keys(specWcl).sort().join(', ')}`);
      }
      specs = [environment.ingestSpec];
      console.log(`Targeting spec: ${environment.ingestSpec}`);
    } else {
      specs = await this.orderedSpecsFromDisk();
      if (!specs.length) {
        console.log('No known specs (no rulebook.json found). Nothing to do.');
        publishSummary({ succeeded: [], failed: [], budgetStopped: false });
        return;
      }
    }

    // Isolate each spec so one throw drops only that spec, not the whole run. Publishing partial
    // progress is safe: a total WCL outage already aborted at raid resolution above, and a failed
    // spec keeps its existing data untouched.
    const succeeded: string[] = [];
    const failed: { spec: string; message: string }[] = [];
    let budgetStopped = false;
    for (const spec of specs) {
      try {
        const budgetExhausted = await this.ingestSpec(client, spec, encounters, protectedIds, version);
        succeeded.push(spec);
        if (budgetExhausted) { budgetStopped = true; break; }
      } catch (err) {
        logWarn(`ingest: spec ${spec} aborted, continuing with the remaining specs`, err);
        failed.push({ spec, message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Distinguish a clean run from one that aborted partway; otherwise failures are only scattered logs.
    console.log('\n=== Ingestion summary ===');
    console.log(`Specs processed: ${succeeded.length} of ${specs.length}`);
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
    publishSummary({ succeeded, failed, budgetStopped });
  }

  /** Rulebook-bearing specs in the orderSpecsByVersion work order, capped at SPEC_LIMIT (cheap file reads, zero WCL budget). */
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
      const versions = await Promise.all(burstFiles.map(async file => {
        const slice = await this.dataFile.getSlice<SignedFile>(spec, parseInt(file), 'burst');
        return slice.ok ? readStoredVersion(slice.value) : null;
      }));
      const storedVersions = versions.filter((stored): stored is number => stored !== null);
      const entry: SpecOrderEntry = {
        spec,
        dataCount: burstFiles.length,
        onCurrentVersion: burstFiles.length > 0 && versions.every(stored => stored === INGEST_VERSION),
      };
      // The lowest on-disk version decides the spec's old/current group.
      const displayVersion = storedVersions.length ? Math.min(...storedVersions) : null;
      return { spec, entry, displayVersion };
    }));
    const specs = orderSpecsByVersion(orderInputs.map(input => input.entry)).slice(0, SPEC_LIMIT);
    const displayBySpec = new Map(orderInputs.map(input => [input.spec, input] as const));
    const versionLines = specs.map(spec => {
      const info = displayBySpec.get(spec);
      const versionLabel = info && info.displayVersion != null ? `v${info.displayVersion}` : 'v?';
      return `${spec} ${versionLabel}`;
    });
    console.log(`Specs (old version first):\n${versionLines.join('\n')}`);
    return specs;
  }

  /** Returns true when the run stopped on the WCL budget (remaining specs resume next run). */
  private async ingestSpec(
    client: ApiWclClient, spec: string,
    encounters: IngestEncounter[], protectedIds: Set<number>, version: string,
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

        const poolRows = await this.rankingPool(spec, encounter.id);
        if (!poolRows.length) {
          console.log(`  [${encounter.name}] no rankings, skipped`);
          continue;
        }

        const existingResult = await this.dataFile.getSlice<SignedFile>(spec, encounter.id, 'burst');
        const existing = existingResult.ok ? existingResult.value : null;
        const skipKey = encounterSkipKey(poolRows, readInaccessibleParses(existing), version, TOP_N);
        if (signatureMatches(readStoredSignature(existing), skipKey)) {
          console.log(`  [${encounter.name}] unchanged (signature ${skipKey}), skipped`);
          continue;
        }

        console.log(`  [${encounter.name}] computing slices (signature ${skipKey})...`);
        try {
          const wrote = await this.ingestEncounter(spec, encounter, version, poolRows);
          console.log(`  [${encounter.name}] ${wrote ? 'done' : 'no slice data produced'}`);
        } finally {
          // Drop this encounter's cached reports/events before the next one to bound memory.
          this.wclCache.clearCache();
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.log(`\n[budget] Stopping cleanly: ${err.message}`);
        await this.rebuildEncountersIndex(spec);
        await this.rebuildSpecIndex();
        return true;
      }
      throw err;
    }

    const pruned = await this.pruneStaleEncounters(spec, protectedIds);
    if (pruned.length) console.log(`  Pruned ${pruned.length} stale encounter(s): ${pruned.join(', ')}`);
    await this.rebuildEncountersIndex(spec);
    await this.rebuildSpecIndex();
    console.log(`Ingestion complete for ${spec}.`);
    return false;
  }

  private async rankingPool(spec: string, encounterId: number): Promise<SignatureRanking[]> {
    const raw = await this.wclApi.getRankings(spec, encounterId);
    return toParseRankings(unwrapRankings(raw), SIGNATURE_POOL_COUNT);
  }

  /**
   * Compute all five slices first (concurrently, sharing fetches), THEN stamp + write: the final
   * signature and inaccessible-parse set are known only after every transform has fetched, so a
   * private top parse a transform backfilled past is excluded from the skip key.
   */
  private async ingestEncounter(
    spec: string, encounter: IngestEncounter, version: string, poolRows: SignatureRanking[],
  ): Promise<boolean> {
    const encId = encounter.id;
    const limit = pLimit(SLICE_CONCURRENCY);

    const [burst, rotation, defensive, gear, map] = await Promise.all([
      limit(() => this.transforms.burst.getBench(spec, encId)),
      limit(() => this.transforms.rotation.getBench(spec, encId)),
      limit(() => this.transforms.defensive.getBench(spec, encId)),
      limit(() => this.transforms.gear.getBench(spec, encId)),
      limit(() => this.transforms.map.getBench(spec, encId)),
    ]);

    const inaccessibleCodes = new Set(this.wclTransport.takeInaccessibleCodes());
    const { signature, inaccessibleParses } = signatureAfterFetch(poolRows, inaccessibleCodes, version, TOP_N);

    // Skip on any failure so a slice is never overwritten with partial data.
    const skipNote = (slice: string, error: LoadError): string =>
      error.kind === 'missing'
        ? `    [${encounter.name}] ${slice}: no data, skipped`
        : `    [${encounter.name}] ${slice}: ${error.kind} (${error.message}), skipped`;

    let wroteAny = false;
    const writes: Promise<unknown>[] = [];
    if (burst.ok) {
      // burst also persists the inaccessible set the skip check reads.
      const stamped = { ...stampSignature(burst.value, signature, INGEST_VERSION), inaccessible_parses: inaccessibleParses };
      writes.push(this.dataFile.writeSlice(spec, encId, 'burst', stamped));
      wroteAny = true;
    } else { console.log(skipNote('burst', burst.error)); }
    if (rotation.ok) {
      writes.push(this.dataFile.writeSlice(spec, encId, 'rotation', stampSignature(rotation.value, signature, INGEST_VERSION)));
      wroteAny = true;
    } else { console.log(skipNote('rotation', rotation.error)); }
    if (defensive.ok) {
      writes.push(this.dataFile.writeSlice(spec, encId, 'defensive', stampSignature(defensive.value, signature, INGEST_VERSION)));
      wroteAny = true;
    } else { console.log(skipNote('defensive', defensive.error)); }
    if (gear.ok) {
      writes.push(this.dataFile.writeSlice(spec, encId, 'gear', stampSignature(gear.value, signature, INGEST_VERSION)));
      wroteAny = true;
    } else { console.log(skipNote('gear', gear.error)); }
    if (map.ok) {
      writes.push(this.dataFile.writePositions(spec, encId, stampSignature(map.value, signature, INGEST_VERSION)));
    } else { console.log(skipNote('positions', map.error)); }

    await Promise.all(writes);
    return wroteAny;
  }

  private async rebuildEncountersIndex(spec: string): Promise<EncounterEntry[]> {
    const files = await this.dataFile.listSliceFiles(spec, 'burst');
    const entries: EncounterEntry[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const encId = parseInt(file);
      if (!Number.isFinite(encId)) continue;
      const bench = await this.dataFile.getSlice<{ encounter_id?: number; encounter_name?: string; sample_count?: number }>(spec, encId, 'burst');
      if (!bench.ok) continue;
      entries.push({
        id: bench.value.encounter_id ?? encId,
        name: bench.value.encounter_name ?? file,
        sample_count: bench.value.sample_count ?? 0,
      });
    }
    await this.dataFile.writeEncounters(spec, entries);
    return entries;
  }

  private async rebuildSpecIndex(): Promise<void> {
    const specs = await this.dataFile.listSpecs();
    const entries: SpecEntry[] = [];
    for (const spec of specs.sort()) {
      const encounters = await this.dataFile.getEncounters(spec);
      const count = encounters.ok ? encounters.value.filter(entry => entry.sample_count > 0).length : 0;
      if (count > 0) entries.push({ spec, encounter_count: count });
    }
    await this.dataFile.writeSpecs(entries);
  }

  /**
   * Prune on-disk data for a spec's encounters whose ids are outside the protected set.
   * An empty protected set (a transient worldData failure) never deletes anything.
   */
  private async pruneStaleEncounters(spec: string, protectedIds: Set<number>): Promise<number[]> {
    if (protectedIds.size === 0) {
      logWarn('pruneStaleEncounters', 'empty protected set - skipping prune (likely a transient WCL failure)');
      return [];
    }
    const removed: number[] = [];
    const files = await this.dataFile.listSliceFiles(spec, 'burst');
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const encId = parseInt(file);
      if (!Number.isFinite(encId) || protectedIds.has(encId)) continue;
      for (const slice of [...SLICES, 'positions']) {
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
