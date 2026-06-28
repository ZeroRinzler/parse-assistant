/**
 * Git last-commit time for a spec's tailored data, used by the work-ordering.
 *
 * The orchestrator orders specs oldest-updated first within each version group, and the
 * source of truth for "when was this spec last ingested" is git: the ingest workflow
 * commits `frontend/public/data/specs/**` each run, so the last commit touching a spec's
 * data dir is when it was last refreshed. File mtime is useless here - a fresh CI clone
 * stamps every file with the checkout time - hence git history (the workflow checks out
 * with `fetch-depth: 0`).
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logWarn } from '../../src/app/core/log.ts';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
/** Repo root - two levels above frontend/ (this file lives in frontend/scripts/ingest). */
const REPO_ROOT = path.resolve(__dirname_, '..', '..', '..');

/**
 * Unix seconds of the last commit touching a spec's data dir, or null when the path has no
 * history (never-committed / never-ingested spec). Best-effort: any git failure is logged
 * and returns null (treated as oldest by the ordering).
 */
export function specDataMtime(spec: string): number | null {
  const relPath = `frontend/public/data/specs/${spec}`;
  try {
    const out = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'log', '-1', '--format=%ct', '--', relPath],
      { encoding: 'utf8' },
    ).trim();
    if (!out) return null;
    const seconds = parseInt(out, 10);
    return Number.isFinite(seconds) ? seconds : null;
  } catch (err) {
    logWarn(`specDataMtime ${spec}`, err);
    return null;
  }
}
