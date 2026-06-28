#!/usr/bin/env node
/**
 * warcraft-learner - ingestion orchestrator (npm run ingest).
 *
 * The single ingestion path. Instead of a duplicated Node ETL, it boots the headless
 * Angular runtime (bootstrapIngestRuntime) and drives the very `*TransformService`s
 * the browser uses to compute each slice's tailored data, then persists it through the
 * same DataFileApiService. So local dev (the `useLiveTransform` flag computes the same
 * benches live in the browser) and the hourly GHA run share one transform implementation.
 *
 * Orchestration only (no transformation lives here):
 *   - discover specs that have a rulebook + validate it (reuses validateRulebook),
 *   - discover current-expansion live encounters (reuses getEncounters via a thin
 *     WclQueryClient adapter over the runtime WclApiService),
 *   - per encounter: assert WCL budget, fetch rankings (cheap, cached), compute the
 *     encounter signature, SKIP when it matches the stored source_signature,
 *   - otherwise run the 5 transforms (bounded concurrency), stamp + write each file,
 *   - rebuild encounters.json + index.json, prune stale encounters.
 *
 * Requires WCL_CLIENT_ID / WCL_CLIENT_SECRET (already wired into WclAuthService via the
 * node WCL transport). WCL is the only network dependency.
 */
import { Command } from 'commander';
import pLimit from 'p-limit';
import { validateRulebook } from '../lib.ts';
import { bootstrapIngestRuntime, type IngestRuntime } from './angular-runtime.ts';
import { getEncounters } from './wcl-fetchers.ts';
import { SPEC_TO_WCL } from './wcl-mappers.ts';
import {
  type WclQueryClient, type EventFetchOptions, BudgetExceededError,
} from './wcl-client.ts';
import { RATE_LIMIT_QUERY } from './wcl-queries.ts';
import { INGEST_VERSION } from './ingest-version.ts';
import { specDataMtime } from './git-mtime.ts';
import {
  orderSpecsByVersionThenTime, orderEncountersByMissingFirst, type SpecOrderEntry,
} from './ordering.ts';
import {
  encounterSignature, readStoredSignature, readStoredVersion, signatureMatches, stampSignature,
  type SignatureRanking, type SignedFile,
} from './signature.ts';
import { logWarn } from '../../src/app/core/log.ts';
import type { WclRateLimitData, WclResourceEvent, IngestEncounter } from './models/wcl.models.ts';
import type { EncounterEntry, SpecEntry } from '../../src/app/core/models/encounter.models.ts';

const TOP_N = 10;
const POINTS_MARGIN = 500;     // stop cleanly when fewer than this many WCL points remain in the hour
const SLICE_CONCURRENCY = 3;   // max transforms run concurrently per encounter

// The tailored slice files the transforms write (directory name under {spec}/).
// `burst` is the canonical carrier of the encounter's source_signature for the skip
// check (every slice for an encounter shares the same parse set, so any one would do).
const SLICES = ['burst', 'rotation', 'defensive', 'gear'] as const;

/**
 * A `WclQueryClient` adapter over the runtime `WclApiService`, so the pure
 * orchestration helper `getEncounters` (worldData discovery + liveness probe) can be
 * reused unchanged. The adapter owns budget tracking via the rateLimitData query.
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

  // Discovery never resolves server slugs (that is per-parse gear enrichment, which the
  // transforms own internally), so a no-op satisfies the interface.
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

/** Rankings reduced to the signature shape (report + fight identity), via getRankings. */
async function rankingSignatureRows(runtime: IngestRuntime, spec: string, encounterId: number): Promise<SignatureRanking[]> {
  const raw = await runtime.wclApi.getRankings(spec, encounterId);
  return raw
    .filter(ranking => ranking.report?.code)
    .slice(0, TOP_N)
    .map(ranking => ({ report_code: ranking.report?.code ?? '', fight_id: ranking.report?.fightID ?? 0 }));
}

/** Compute every slice for one encounter and write the tailored files, stamped. */
async function ingestEncounter(
  runtime: IngestRuntime, spec: string, encounter: IngestEncounter, signature: string,
): Promise<boolean> {
  const { dataFile, transforms } = runtime;
  const encId = encounter.id;
  const limit = pLimit(SLICE_CONCURRENCY);

  // Each task computes one slice and writes it; null result -> skip that file.
  let wroteAny = false;
  const tasks = [
    limit(async () => {
      const bench = await transforms.burst.getBurstBench(spec, encId);
      if (!bench) { console.log(`    [${encounter.name}] burst: no data, skipped`); return; }
      await dataFile.writeSlice(spec, encId, 'burst', stampSignature(bench, signature, INGEST_VERSION));
      wroteAny = true;
    }),
    limit(async () => {
      const bench = await transforms.rotation.getRotationBench(spec, encId);
      if (!bench) { console.log(`    [${encounter.name}] rotation: no data, skipped`); return; }
      await dataFile.writeSlice(spec, encId, 'rotation', stampSignature(bench, signature, INGEST_VERSION));
      wroteAny = true;
    }),
    limit(async () => {
      const bench = await transforms.defensive.getDefensiveBench(spec, encId);
      if (!bench) { console.log(`    [${encounter.name}] defensive: no data, skipped`); return; }
      await dataFile.writeSlice(spec, encId, 'defensive', stampSignature(bench, signature, INGEST_VERSION));
      wroteAny = true;
    }),
    limit(async () => {
      const bench = await transforms.gear.getGearBench(spec, encId);
      if (!bench) { console.log(`    [${encounter.name}] gear: no data, skipped`); return; }
      await dataFile.writeSlice(spec, encId, 'gear', stampSignature(bench, signature, INGEST_VERSION));
      wroteAny = true;
    }),
    limit(async () => {
      const map = await transforms.map.getMapData(spec, encId);
      if (!map) { console.log(`    [${encounter.name}] positions: no data, skipped`); return; }
      await dataFile.writePositions(spec, encId, stampSignature(map, signature, INGEST_VERSION));
    }),
  ];
  await Promise.all(tasks);
  return wroteAny;
}

/**
 * Rebuild a spec's encounters.json from the tailored burst files actually present on
 * disk (the canonical per-encounter carrier). sample_count comes from the burst bench.
 */
async function rebuildEncountersIndex(runtime: IngestRuntime, spec: string): Promise<EncounterEntry[]> {
  const { dataFile } = runtime;
  const files = await dataFile.listSliceFiles(spec, 'burst');
  const entries: EncounterEntry[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    const encId = parseInt(file);
    if (!Number.isFinite(encId)) continue;
    const bench = await dataFile.getSlice<{ encounter_id?: number; encounter_name?: string; sample_count?: number }>(spec, encId, 'burst');
    if (!bench) continue;
    entries.push({
      id: bench.encounter_id ?? encId,
      name: bench.encounter_name ?? file,
      sample_count: bench.sample_count ?? 0,
    });
  }
  await dataFile.writeEncounters(spec, entries);
  return entries;
}

/** Rebuild the top-level index.json by scanning every spec's encounters.json. */
async function rebuildSpecIndex(runtime: IngestRuntime): Promise<void> {
  const { dataFile } = runtime;
  const specs = await dataFile.listSpecs();
  const entries: SpecEntry[] = [];
  for (const spec of specs.sort()) {
    const encounters = await dataFile.getEncounters(spec);
    const count = encounters.filter(entry => entry.sample_count > 0).length;
    if (count > 0) entries.push({ spec, encounter_count: count });
  }
  await dataFile.writeSpecs(entries);
}

/**
 * Prune on-disk data for a spec's encounters whose ids are no longer in the protected
 * set. Mirrors the legacy pruneStaleEncounters safety: an empty protected set (a
 * transient worldData failure) never deletes anything.
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

  // Pre-flight: refuse a spec whose rulebook fails schema validation.
  const rulebook = await runtime.dataFile.getRulebook(spec);
  const schemaErrors = await validateRulebook(rulebook);
  if (schemaErrors.length) {
    console.error(`[${spec}] rulebook.json failed schema validation (${schemaErrors.length} error(s)) - skipping:`);
    schemaErrors.forEach(err => console.error(`  - ${err}`));
    return false;
  }

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

      const rankings = await rankingSignatureRows(runtime, spec, encounter.id);
      if (!rankings.length) {
        console.log(`  [${encounter.name}] no rankings, skipped`);
        continue;
      }
      const signature = encounterSignature(version, rankings);

      // Skip check: compare against the signature stamped on the existing burst file.
      const existing = await runtime.dataFile.getSlice<{ source_signature?: string }>(spec, encounter.id, 'burst');
      if (signatureMatches(readStoredSignature(existing), signature)) {
        console.log(`  [${encounter.name}] unchanged (signature ${signature}), skipped`);
        continue;
      }

      console.log(`  [${encounter.name}] computing slices (signature ${signature})...`);
      try {
        const wrote = await ingestEncounter(runtime, spec, encounter, signature);
        console.log(`  [${encounter.name}] ${wrote ? 'done' : 'no slice data produced'}`);
      } finally {
        // Drop this encounter's cached reports/events before the next one (bound memory;
        // the 5 transforms have already shared their fetches within this encounter).
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
    .addHelpText('after', `\nKnown specs: ${Object.keys(SPEC_TO_WCL).join(', ')}`);
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

  process.stdout.write('Resolving current raids...');
  let encounters: IngestEncounter[];
  let protectedIds: Set<number>;
  try {
    ({ encounters, protectedIds } = await getEncounters(client));
    console.log(` ${encounters.length} live encounters`);
  } catch (err) {
    console.error(`\nFailed to resolve current raids: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Specs to process: the --spec arg, or every spec that has a rulebook on disk.
  let specs: string[];
  if (opts.spec) {
    if (!SPEC_TO_WCL[opts.spec]) {
      console.error(`Unknown spec "${opts.spec}". Known specs: ${Object.keys(SPEC_TO_WCL).join(', ')}`);
      process.exit(1);
    }
    specs = [opts.spec];
    console.log(`Targeting spec: ${opts.spec}`);
  } else {
    const onDisk = await runtime.dataFile.listSpecs();
    const withRulebook: string[] = [];
    for (const spec of onDisk) {
      if (await runtime.dataFile.getRulebook(spec)) withRulebook.push(spec);
    }
    if (!withRulebook.length) {
      console.log('No known specs (no rulebook.json found). Nothing to do.');
      return;
    }
    // Order specs so a budget-bounded run fixes the most out-of-date data first: empty ->
    // old-version -> current, oldest git-commit time within each group. All cheap disk + git
    // reads, zero WCL budget.
    const entries: SpecOrderEntry[] = await Promise.all(withRulebook.map(async spec => {
      const burstFiles = (await runtime.dataFile.listSliceFiles(spec, 'burst'))
        .filter(file => file.endsWith('.json'));
      const versions = await Promise.all(burstFiles.map(async file => {
        const slice = await runtime.dataFile.getSlice<SignedFile>(spec, parseInt(file), 'burst');
        return slice ? readStoredVersion(slice) : null;
      }));
      return {
        spec,
        dataCount: burstFiles.length,
        onCurrentVersion: burstFiles.length > 0 && versions.every(stored => stored === INGEST_VERSION),
        lastChange: specDataMtime(spec),
      };
    }));
    specs = orderSpecsByVersionThenTime(entries);
    console.log(`Specs (old version + oldest-updated first): ${specs.join(', ')}`);
  }

  for (const spec of specs) {
    const budgetExhausted = await ingestSpec(runtime, client, spec, encounters, protectedIds, version);
    if (budgetExhausted) break;
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error('\nFatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
