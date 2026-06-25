#!/usr/bin/env node
/**
 * warcraft-learner - Parse Ingestion CLI (workflow orchestrator).
 *
 * The ETL stages live under ./ingest/: wcl-client + wcl-queries + wcl-mappers +
 * wcl-fetchers (Extract / WCL network), analysis/** (Transform / pure analysis),
 * and storage.ts (Load / data/specs IO). Run with `npm run ingest`; requires
 * WCL_CLIENT_ID + WCL_CLIENT_SECRET env vars (supplied by GitHub Actions from
 * repository secrets).
 */

import { Command } from 'commander';
import pLimit from 'p-limit';
import { validateRulebook } from './lib.ts';
import { WCLClient, BudgetExceededError } from './ingest/wcl-client.ts';
import { getEncounters, getRankingsLite, enrichRanking, getParseEvents } from './ingest/wcl-fetchers.ts';
import { SPEC_TO_WCL, SPEC_TO_WCL_FORWARD } from './ingest/wcl-mappers.ts';
import { analyzeParse } from './ingest/analysis/parse-analysis.ts';
import {
  INGEST_HASH, parseKey, readSamples, getSpecCooldowns, getSpecDefensives,
  loadRulebook, saveParseSample, savePositions, syncEncounterFile, resolveEnchantNames,
  writeSpecIndex, specsByStaleness, pruneStaleEncounters,
} from './ingest/storage.ts';
import type { IngestEncounter, ParseRanking } from './ingest/models/wcl.models.ts';

const TOP_N = 10;
const FRESH_HOURS = 23;     // skip encounters whose samples were all refreshed within this window
const POINTS_MARGIN = 500;  // stop cleanly when fewer than this many WCL points remain in the hour
const PARSE_CONCURRENCY = 4; // max parses fetched/analyzed concurrently per encounter

const program = new Command()
  .name('ingest')
  .description('Fetch top WCL parses for all known specs (stalest-first) and write bench data.')
  .option('--spec <spec>', 'target a single spec instead of all (e.g. SubtletyRogue)')
  .addHelpText('after', `\nKnown specs: ${Object.keys(SPEC_TO_WCL_FORWARD).join(', ')}`);

program.parse(process.argv);
const opts = program.opts<{ spec?: string }>();

async function ingestSpecNonInteractive(wcl: WCLClient, spec: string, encounters: IngestEncounter[]): Promise<boolean> {
  console.log(`\nIngesting ${spec} - ${encounters.length} encounters (top ${TOP_N})`);

  // Pre-flight: refuse to ingest a spec whose rulebook fails schema validation.
  const rulebook = await loadRulebook(spec);
  const schemaErrors = await validateRulebook(rulebook);
  if (schemaErrors.length) {
    console.error(`\n[${spec}] rulebook.json failed schema validation (${schemaErrors.length} error(s)) - skipping ingestion:`);
    schemaErrors.forEach(err => console.error(`  - ${err}`));
    return false;
  }

  // Rulebook lists are constant across the spec; load once for the pure analyzer.
  const specCds = await getSpecCooldowns(spec) ?? [];
  const specDefensives = await getSpecDefensives(spec);

  try {
    for (const enc of encounters) {
      // Freshness short-circuit: skip the encounter (0 queries) when every sample
      // is current-hash and was collected within FRESH_HOURS. Gating on count > 0
      // (not >= TOP_N) handles anonymous parses and low-population bosses.
      const existingSamples = await readSamples(spec, enc.id);
      if (existingSamples.length > 0) {
        const allFresh = existingSamples.every(sample => sample.ingest_hash === INGEST_HASH);
        if (allFresh) {
          const newestMs = Math.max(...existingSamples.map(sample => new Date(sample.sampled_at ?? 0).getTime()));
          const ageH = (Date.now() - newestMs) / 3_600_000;
          if (ageH < FRESH_HOURS) {
            console.log(`\n[${enc.name}] Skipped (${existingSamples.length} samples fresh, ${Math.round(ageH * 10) / 10}h old)`);
            continue;
          }
        }
      }

      // Check budget before spending a query on rankings.
      await wcl.assertBudget(POINTS_MARGIN);

      process.stdout.write(`\n[${enc.name}] Fetching top ${TOP_N} rankings...`);
      let rankings: ParseRanking[];
      try {
        rankings = await getRankingsLite(wcl, spec, enc.id, TOP_N, enc.partitionIds ?? []);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        console.log(` FAILED: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      console.log(` ${rankings.length} rankings found`);

      // Build the set of cached parse keys from each sample's OWN stored ingest_hash,
      // not the current one. A ranking is keyed with the current INGEST_HASH, so when
      // the ETL logic changes the hashes differ and the parse is treated as uncached
      // and re-analyzed. Omitting sample.ingest_hash here would make both sides use the
      // current hash, silently defeating hash-based invalidation.
      const cachedKeys = new Set<string>((await readSamples(spec, enc.id)).map(sample => parseKey(sample.report_code, sample.fight_id, sample.ingest_hash)));
      const uncached = rankings.filter(ranking => !cachedKeys.has(parseKey(ranking.report_code, ranking.fight_id)));
      const cached = rankings.length - uncached.length;

      // Fetch + analyze uncached parses concurrently (network-bound, bounded by
      // PARSE_CONCURRENCY); shared files are written sequentially AFTER the batch.
      const limit = pLimit(PARSE_CONCURRENCY);
      let completed = 0;
      const settled = await Promise.allSettled(uncached.map(ranking => limit(async () => {
        // Budget gate before each parse's network work; stops the run cleanly when low.
        await wcl.assertBudget(POINTS_MARGIN);
        const enriched = await enrichRanking(wcl, ranking);
        const bundle = await getParseEvents(wcl, ranking.report_code, ranking.fight_id, ranking.player);
        const res = bundle ? analyzeParse(bundle, spec, specCds, specDefensives, enriched.combatant_info) : null;
        completed++;
        process.stdout.write(`\r  [${enc.name}] Analyzed ${completed}/${uncached.length}...    `);
        return res;
      })));

      // Persist results sequentially (in ranking order) - no concurrent writes.
      let budgetErr: BudgetExceededError | null = null;
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
          const res = outcome.value;
          if (res?.cooldown_data) {
            const ranking = uncached[i];
            await saveParseSample(spec, enc.id, enc.name, ranking.report_code, ranking.fight_id, ranking.player, res.cooldown_data);
            await savePositions(spec, enc.id, enc.name, res.positions);
          }
        } else if (outcome.reason instanceof BudgetExceededError) {
          budgetErr = outcome.reason;
        } else {
          const reason = outcome.reason;
          process.stdout.write(` (skip ${uncached[i].player}: ${reason instanceof Error ? reason.message.slice(0, 40) : String(reason)})`);
        }
      }
      process.stdout.write(`\r  [${enc.name}] ${uncached.length} analyzed, ${cached} cached.          \n`);

      // Partial progress committed; surface the budget stop to the outer handler.
      if (budgetErr) throw budgetErr;

      process.stdout.write(`  [${enc.name}] Computing bench data...`);
      await syncEncounterFile(spec, enc.id);
      await resolveEnchantNames(wcl, spec, enc.id);
      console.log(' done');
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.log(`\n[budget] Stopping cleanly: ${err.message}`);
      console.log('[budget] Partial progress committed; remaining work picked up next run.');
      await writeSpecIndex();
      return true;
    }
    throw err;
  }
  await writeSpecIndex();
  console.log(`\nIngestion complete for ${spec}.`);
  return false;
}

async function main(): Promise<void> {
  console.log('warcraft-learner - Parse Ingestion CLI');

  let wcl: WCLClient;
  try {
    wcl = new WCLClient();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  process.stdout.write('Resolving current raids...');
  let encounters: IngestEncounter[];
  let protectedIds: Set<number>;
  try {
    ({ encounters, protectedIds } = await getEncounters(wcl));
    console.log(` ${encounters.length} live encounters`);
  } catch (err) {
    console.error(`\nFailed to resolve current raids: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Prune superseded content before the spec loop (filesystem only, no WCL points).
  // Guarded inside pruneStaleEncounters against an empty protected set; reaching here
  // already means getEncounters succeeded, so a failed fetch never triggers deletion.
  const { removed } = await pruneStaleEncounters(protectedIds);
  if (removed.length) {
    console.log(`Pruned ${removed.length} stale encounter(s): ${removed.join(', ')}`);
  }

  const specArg = opts.spec ?? null;

  let specs: string[];
  if (specArg) {
    if (!SPEC_TO_WCL[specArg]) {
      console.error(`Unknown spec "${specArg}". Known specs: ${Object.keys(SPEC_TO_WCL).join(', ')}`);
      process.exit(1);
    }
    specs = [specArg];
    console.log(`Targeting spec: ${specArg}`);
  } else {
    specs = await specsByStaleness(encounters);
    if (!specs.length) {
      console.log('No known specs (no rulebook.json found). Nothing to do.');
      return;
    }
    console.log(`Stalest-first: ${specs.join(', ')}`);
  }

  for (const spec of specs) {
    const budgetExhausted = await ingestSpecNonInteractive(wcl, spec, encounters);
    if (budgetExhausted) break;
  }
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
