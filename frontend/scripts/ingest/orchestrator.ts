#!/usr/bin/env node
/**
 * Ingestion orchestrator (npm run ingest). Boots the headless Angular runtime and drives
 * the same `*TransformService`s the browser uses, persisting through the same
 * DataFileApiService, so ingestion and the live browser transform share one implementation.
 * Orchestration only; no transformation lives here. Requires WCL_CLIENT_ID /
 * WCL_CLIENT_SECRET; WCL is the only network dependency.
 */
import { Command } from 'commander';
import pLimit from 'p-limit';
import { bootstrapIngestRuntime, type IngestRuntime } from './angular-runtime.ts';
import { getEncounters } from './wcl-fetchers.ts';
import { mapClassesToSpecMeta, specWclFromMetas, type SpecWclMap } from './wcl-mappers.ts';
import {
  type WclQueryClient, type EventFetchOptions, BudgetExceededError,
} from './wcl-client.ts';
import { RATE_LIMIT_QUERY, CLASSES_QUERY } from './wcl-queries.ts';
import { INGEST_VERSION } from './ingest-version.ts';
import { type LoadError } from '../../src/app/core/result.ts';
import {
  orderSpecsByVersion, orderEncountersByMissingFirst, SPEC_LIMIT, type SpecOrderEntry,
} from './ordering.ts';
import {
  encounterSkipKey, signatureAfterFetch, readStoredSignature, readStoredVersion, signatureMatches,
  stampSignature, selectSignatureRankings, readInaccessibleParses,
  type SignatureRanking, type SignedFile,
} from './signature.ts';
import { logWarn } from '../../src/app/core/log.ts';
import { unwrapRankings } from '../../src/app/shared/analysis/wcl-projections.ts';
import type { WclRateLimitData, WclResourceEvent, IngestEncounter, WclGameClass } from './models/wcl.models.ts';
import type { EncounterEntry, SpecEntry } from '../../src/app/core/models/encounter.models.ts';

const TOP_N = 10;
// Matches the depth the transforms over-fetch to (CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2),
// so a parse that backfills a private top parse is part of the skip key.
const SIGNATURE_POOL_COUNT = TOP_N * 2;
const POINTS_MARGIN = 500;     // stop cleanly when fewer than this many WCL points remain in the hour
const SLICE_CONCURRENCY = 3;

// `burst` carries the encounter's source_signature for the skip check (every slice shares the
// same parse set, so any one would do).
const SLICES = ['burst', 'rotation', 'defensive', 'gear'] as const;

/**
 * `WclQueryClient` adapter over the runtime `WclApiService`, so `getEncounters` can be reused
 * unchanged. Owns budget tracking via the rateLimitData query.
 */
class RuntimeWclClient implements WclQueryClient {
  private _limitPerHour: number | null = null;
  private _pointsSpentThisHour = 0;

  constructor(private readonly runtime: IngestRuntime) {}

  query<T = unknown, TVars extends object = Record<string, never>>(gql: string, variables?: TVars): Promise<T> {
    return this.runtime.wclApi.query<T>(gql, (variables ?? {}) as object, 'network-only');
  }

  // The runtime WclApiService has a positional signature; translate the options bag.
  getAllEvents(
    code: string, fightId: number, dataType: string,
    startTime: number, endTime: number, options: EventFetchOptions = {},
  ): Promise<WclResourceEvent[]> {
    const hostility = options.hostilityType === 'Enemies' ? 'Enemies' : options.hostilityType === 'Friendlies' ? 'Friendlies' : undefined;
    return this.runtime.wclApi.getAllEvents(
      code, fightId, dataType, startTime, endTime,
      options.sourceId, options.includeResources ?? false, hostility,
    ) as Promise<WclResourceEvent[]>;
  }

  // Discovery never resolves server slugs (that is per-parse gear enrichment the transforms
  // own internally), so a no-op satisfies the interface.
  async resolveServerSlug(): Promise<[string, string]> {
    return ['', ''];
  }

  async assertBudget(margin: number): Promise<void> {
    const data = await this.query<{ rateLimitData?: WclRateLimitData }>(RATE_LIMIT_QUERY);
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

async function rankingPool(runtime: IngestRuntime, spec: string, encounterId: number): Promise<SignatureRanking[]> {
  const raw = await runtime.wclApi.getRankings(spec, encounterId);
  return selectSignatureRankings(unwrapRankings(raw), SIGNATURE_POOL_COUNT);
}

/**
 * Compute all five slices first (concurrently, sharing fetches), THEN stamp + write: the final
 * signature and inaccessible-parse set are known only after every transform has fetched, so a
 * private top parse a transform backfilled past is excluded from the skip key.
 */
async function ingestEncounter(
  runtime: IngestRuntime, spec: string, encounter: IngestEncounter, version: string, poolRows: SignatureRanking[],
): Promise<boolean> {
  const { dataFile, transforms } = runtime;
  const encId = encounter.id;
  const limit = pLimit(SLICE_CONCURRENCY);

  const [burst, rotation, defensive, gear, map] = await Promise.all([
    limit(() => transforms.burst.getBench(spec, encId)),
    limit(() => transforms.rotation.getBench(spec, encId)),
    limit(() => transforms.defensive.getBench(spec, encId)),
    limit(() => transforms.gear.getBench(spec, encId)),
    limit(() => transforms.map.getBench(spec, encId)),
  ]);

  // signatureAfterFetch keys the stamp on the top-N accessible parses and returns the
  // inaccessible keys to persist, so the next cheap hash check can exclude them without re-fetching.
  const inaccessibleCodes = new Set(runtime.takeInaccessibleReportCodes());
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
    writes.push(dataFile.writeSlice(spec, encId, 'burst', stamped));
    wroteAny = true;
  } else { console.log(skipNote('burst', burst.error)); }
  if (rotation.ok) {
    writes.push(dataFile.writeSlice(spec, encId, 'rotation', stampSignature(rotation.value, signature, INGEST_VERSION)));
    wroteAny = true;
  } else { console.log(skipNote('rotation', rotation.error)); }
  if (defensive.ok) {
    writes.push(dataFile.writeSlice(spec, encId, 'defensive', stampSignature(defensive.value, signature, INGEST_VERSION)));
    wroteAny = true;
  } else { console.log(skipNote('defensive', defensive.error)); }
  if (gear.ok) {
    writes.push(dataFile.writeSlice(spec, encId, 'gear', stampSignature(gear.value, signature, INGEST_VERSION)));
    wroteAny = true;
  } else { console.log(skipNote('gear', gear.error)); }
  if (map.ok) {
    writes.push(dataFile.writePositions(spec, encId, stampSignature(map.value, signature, INGEST_VERSION)));
  } else { console.log(skipNote('positions', map.error)); }

  await Promise.all(writes);
  return wroteAny;
}

/** Rebuild a spec's encounters.json from the burst files present on disk. */
async function rebuildEncountersIndex(runtime: IngestRuntime, spec: string): Promise<EncounterEntry[]> {
  const { dataFile } = runtime;
  const files = await dataFile.listSliceFiles(spec, 'burst');
  const entries: EncounterEntry[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    const encId = parseInt(file);
    if (!Number.isFinite(encId)) continue;
    const bench = await dataFile.getSlice<{ encounter_id?: number; encounter_name?: string; sample_count?: number }>(spec, encId, 'burst');
    if (!bench.ok) continue;
    entries.push({
      id: bench.value.encounter_id ?? encId,
      name: bench.value.encounter_name ?? file,
      sample_count: bench.value.sample_count ?? 0,
    });
  }
  await dataFile.writeEncounters(spec, entries);
  return entries;
}

async function rebuildSpecIndex(runtime: IngestRuntime): Promise<void> {
  const { dataFile } = runtime;
  const specs = await dataFile.listSpecs();
  const entries: SpecEntry[] = [];
  for (const spec of specs.sort()) {
    const encounters = await dataFile.getEncounters(spec);
    const count = encounters.ok ? encounters.value.filter(entry => entry.sample_count > 0).length : 0;
    if (count > 0) entries.push({ spec, encounter_count: count });
  }
  await dataFile.writeSpecs(entries);
}

/**
 * Prune on-disk data for a spec's encounters whose ids are no longer in the protected set.
 * An empty protected set (a transient worldData failure) never deletes anything.
 */
async function pruneStaleEncounters(runtime: IngestRuntime, spec: string, protectedIds: Set<number>): Promise<number[]> {
  if (protectedIds.size === 0) {
    logWarn('pruneStaleEncounters', 'empty protected set - skipping prune (likely a transient WCL failure)');
    return [];
  }
  const { dataFile } = runtime;
  const removed: number[] = [];
  const files = await dataFile.listSliceFiles(spec, 'burst');
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const encId = parseInt(file);
    if (!Number.isFinite(encId) || protectedIds.has(encId)) continue;
    for (const slice of [...SLICES, 'positions']) {
      try {
        await dataFile.removeSlice(spec, encId, slice);
      } catch (err) {
        logWarn(`pruneStaleEncounters ${spec}/${encId}/${slice}`, err);
      }
    }
    removed.push(encId);
  }
  return removed.sort((a, b) => a - b);
}

async function ingestSpec(
  runtime: IngestRuntime, client: RuntimeWclClient, spec: string,
  encounters: IngestEncounter[], protectedIds: Set<number>, version: string,
): Promise<boolean> {
  console.log(`\nIngesting ${spec} - ${encounters.length} encounters (top ${TOP_N})`);

  // Process never-ingested encounters first so a partial spec fills its remaining bosses
  // before re-checking the ones already done (disk-only signal, zero WCL budget).
  const presentIds = new Set(
    (await runtime.dataFile.listSliceFiles(spec, 'burst'))
      .filter(file => file.endsWith('.json'))
      .map(file => parseInt(file))
      .filter(id => Number.isFinite(id)),
  );

  try {
    for (const encounter of orderEncountersByMissingFirst(encounters, presentIds)) {
      await client.assertBudget(POINTS_MARGIN);

      const poolRows = await rankingPool(runtime, spec, encounter.id);
      if (!poolRows.length) {
        console.log(`  [${encounter.name}] no rankings, skipped`);
        continue;
      }

      // Key on the top-N accessible parses, excluding ones a prior run found inaccessible
      // (persisted on the burst file), and compare against the stamped signature.
      const existingResult = await runtime.dataFile.getSlice<SignedFile>(spec, encounter.id, 'burst');
      const existing = existingResult.ok ? existingResult.value : null;
      const skipKey = encounterSkipKey(poolRows, readInaccessibleParses(existing), version, TOP_N);
      if (signatureMatches(readStoredSignature(existing), skipKey)) {
        console.log(`  [${encounter.name}] unchanged (signature ${skipKey}), skipped`);
        continue;
      }

      console.log(`  [${encounter.name}] computing slices (signature ${skipKey})...`);
      try {
        const wrote = await ingestEncounter(runtime, spec, encounter, version, poolRows);
        console.log(`  [${encounter.name}] ${wrote ? 'done' : 'no slice data produced'}`);
      } finally {
        // Drop this encounter's cached reports/events before the next one to bound memory.
        runtime.clearWclCache();
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.log(`\n[budget] Stopping cleanly: ${err.message}`);
      await rebuildEncountersIndex(runtime, spec);
      await rebuildSpecIndex(runtime);
      return true;
    }
    throw err;
  }

  const pruned = await pruneStaleEncounters(runtime, spec, protectedIds);
  if (pruned.length) console.log(`  Pruned ${pruned.length} stale encounter(s): ${pruned.join(', ')}`);
  await rebuildEncountersIndex(runtime, spec);
  await rebuildSpecIndex(runtime);
  console.log(`Ingestion complete for ${spec}.`);
  return false;
}

async function main(): Promise<void> {
  const program = new Command()
    .name('ingest')
    .description('v5 ingestion: drive the Angular transform services and write tailored files.')
    .option('--spec <spec>', 'target a single spec instead of all (e.g. SubtletyRogue)')
    .addHelpText('after', '\nExample spec: SubtletyRogue (the full spec list is resolved from WCL at run time)');
  program.parse(process.argv);
  const opts = program.opts<{ spec?: string }>();

  if (!process.env['WCL_CLIENT_ID'] || !process.env['WCL_CLIENT_SECRET']) {
    console.error('WCL_CLIENT_ID and WCL_CLIENT_SECRET environment variables must be set');
    process.exit(1);
  }

  console.log('warcraft-learner - Parse Ingestion CLI');
  const runtime = await bootstrapIngestRuntime();
  const client = new RuntimeWclClient(runtime);
  const version = String(INGEST_VERSION);
  console.log(`Ingest version: ${version}`);

  // The spec icon is not on WCL, so enrich each meta from that spec's rulebook (its spec_icon
  // stem). Hydrating the cache lets getRankings resolve a spec.
  const classesData = await client.query<{ gameData?: { classes?: WclGameClass[] } }>(CLASSES_QUERY);
  const metas = mapClassesToSpecMeta(classesData.gameData?.classes ?? []);
  for (const meta of metas) {
    const rulebook = await runtime.dataFile.getRulebook(meta.spec);
    if (rulebook.ok) {
      meta.specIcon = rulebook.value.spec_icon;
    } else {
      // Only a corrupt file (permanent) is worth logging; a missing rulebook is an un-authored spec.
      if (rulebook.error.kind === 'permanent') {
        logWarn(`orchestrator ${meta.spec}: corrupt rulebook.json, shipping blank spec icon`, rulebook.error);
      }
      meta.specIcon = '';
    }
  }
  const specWcl: SpecWclMap = specWclFromMetas(metas);
  runtime.hydrateSpecMeta(metas);
  await runtime.dataFile.writeSpecMeta(metas);
  console.log(`Resolved ${metas.length} specs from WCL`);

  process.stdout.write('Resolving current raids...');
  let encounters: IngestEncounter[];
  let protectedIds: Set<number>;
  try {
    ({ encounters, protectedIds } = await getEncounters(client, specWcl));
    console.log(` ${encounters.length} live encounters`);
  } catch (err) {
    console.error(`\nFailed to resolve current raids: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let specs: string[];
  if (opts.spec) {
    if (!specWcl[opts.spec]) {
      console.error(`Unknown spec "${opts.spec}". Known specs: ${Object.keys(specWcl).sort().join(', ')}`);
      process.exit(1);
    }
    specs = [opts.spec];
    console.log(`Targeting spec: ${opts.spec}`);
  } else {
    const onDisk = await runtime.dataFile.listSpecs();
    const withRulebook: string[] = [];
    for (const spec of onDisk) {
      const rulebook = await runtime.dataFile.getRulebook(spec);
      if (rulebook.ok) {
        withRulebook.push(spec);
      } else if (rulebook.error.kind === 'permanent') {
        // A corrupt rulebook silently freezes the spec on stale data; log so it is diagnosable.
        logWarn(`orchestrator ${spec}: corrupt rulebook.json, excluded from this run`, rulebook.error);
      }
    }
    if (!withRulebook.length) {
      console.log('No known specs (no rulebook.json found). Nothing to do.');
      return;
    }
    // Order specs so a budget-bounded run fixes the most out-of-date data first: empty ->
    // old-version -> current, randomized within each group. Cheap disk reads, zero WCL budget.
    const orderInputs = await Promise.all(withRulebook.map(async spec => {
      const burstFiles = (await runtime.dataFile.listSliceFiles(spec, 'burst'))
        .filter(file => file.endsWith('.json'));
      const versions = await Promise.all(burstFiles.map(async file => {
        const slice = await runtime.dataFile.getSlice<SignedFile>(spec, parseInt(file), 'burst');
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
    // Cap each run at SPEC_LIMIT specs so it stays within the WCL point budget; the randomized
    // within-group order (see orderSpecsByVersion) gives the remaining specs a turn on later runs.
    specs = orderSpecsByVersion(orderInputs.map(input => input.entry)).slice(0, SPEC_LIMIT);
    const displayBySpec = new Map(orderInputs.map(input => [input.spec, input] as const));
    const versionLines = specs.map(spec => {
      const info = displayBySpec.get(spec);
      const versionLabel = info && info.displayVersion != null ? `v${info.displayVersion}` : 'v?';
      return `${spec} ${versionLabel}`;
    });
    console.log(`Specs (old version first):\n${versionLines.join('\n')}`);
  }

  // Isolate each spec so one throw drops only that spec, not the whole hour. Publishing partial
  // progress is safe: a total WCL outage already aborted at raid resolution above, and a failed
  // spec keeps its overlaid data untouched.
  const succeeded: string[] = [];
  const failed: { spec: string; error: unknown }[] = [];
  let budgetStopped = false;
  for (const spec of specs) {
    try {
      const budgetExhausted = await ingestSpec(runtime, client, spec, encounters, protectedIds, version);
      succeeded.push(spec);
      if (budgetExhausted) { budgetStopped = true; break; }
    } catch (err) {
      logWarn(`orchestrator: spec ${spec} aborted, continuing with the remaining specs`, err);
      failed.push({ spec, error: err });
    }
  }

  // Distinguish a clean hour from one that aborted partway; otherwise failures are only scattered logs.
  console.log('\n=== Ingestion summary ===');
  console.log(`Specs processed: ${succeeded.length} of ${specs.length}`);
  if (budgetStopped) {
    console.log('Stopped early: WCL point budget exhausted; the remaining specs resume next run.');
  }
  if (failed.length) {
    console.log(`Specs failed (${failed.length}): ${failed.map(entry => entry.spec).join(', ')}`);
    for (const entry of failed) {
      console.log(`  ${entry.spec}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`);
    }
  } else {
    console.log('No spec-level failures.');
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error('\nFatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
