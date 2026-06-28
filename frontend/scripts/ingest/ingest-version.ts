/**
 * Ingestion data version.
 *
 * A single manual integer that stamps the tailored output and folds into the
 * per-encounter skip signature (see signature.ts) in place of the old source-file
 * code-hash. Bumping it invalidates every cached tailored file and forces a recompute
 * on the next run.
 *
 * Why manual instead of an auto content-hash: not every change that warrants new data is
 * a change to a hashed source file (a rulebook fix, a WCL-side data correction, a
 * deliberate refresh). The flip side is that transform-math edits no longer auto-trigger
 * a re-ingest, so bumping this constant is a REQUIRED step whenever a change should
 * produce different tailored data. Claude bumps it (or suggests bumping it) as part of any
 * such change.
 *
 * Current value:
 *   1 - the `source_id` change is incorporated (gear parses carry `source_id` for the
 *       "View parse" deep-link). Data produced before it is v0.
 */
export const INGEST_VERSION = 1;
