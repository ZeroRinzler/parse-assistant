/**
 * Ingestion code-hash.
 *
 * A short, stable fingerprint of the source files that determine the tailored output
 * the orchestrator writes. Because ingestion drives the very Angular
 * `*TransformService`s the browser uses, the files that matter are the 5 transform
 * services + their colocated pure functions, the two pass-through API services + their
 * transports, the data-file API, and the slice DataSource contracts.
 *
 * The hash folds into the per-encounter signature (see signature.ts) so any change to
 * the transform math (or to a shape the transforms emit) invalidates the cached
 * tailored files and forces a recompute on the next run.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
/** frontend/ root - the two service trees live under src/app, the transports here. */
const FRONTEND_ROOT = path.resolve(__dirname_, '..', '..');

function abs(...segments: string[]): string {
  return path.join(FRONTEND_ROOT, ...segments);
}

/**
 * The output-determining source files, in a stable order. Each is hashed by content;
 * the colocated pure functions live inside the same `*-transform.service.ts` files, so
 * no separate enumeration of helpers is needed - hashing the transform file covers both
 * its service shell and its exported pure math.
 */
export function codeHashSources(): string[] {
  return [
    // The 5 transform services (service shell + colocated pure functions).
    abs('src', 'app', 'pages', 'post-raid', 'burst-windows', 'burst-transform.service.ts'),
    abs('src', 'app', 'pages', 'post-raid', 'rotation', 'rotation-transform.service.ts'),
    abs('src', 'app', 'pages', 'post-raid', 'defensive', 'defensive-transform.service.ts'),
    abs('src', 'app', 'pages', 'post-raid', 'gear', 'gear-transform.service.ts'),
    abs('src', 'app', 'pages', 'post-raid', 'map', 'map-transform.service.ts'),
    // The slice DataSource contracts (the bench/positions shapes the transforms emit).
    abs('src', 'app', 'pages', 'post-raid', 'burst-windows', 'burst-data-source.ts'),
    abs('src', 'app', 'pages', 'post-raid', 'rotation', 'rotation-data-source.ts'),
    abs('src', 'app', 'pages', 'post-raid', 'defensive', 'defensive-data-source.ts'),
    abs('src', 'app', 'pages', 'post-raid', 'gear', 'gear-data-source.ts'),
    abs('src', 'app', 'pages', 'post-raid', 'map', 'map-data-source.ts'),
    // The two pass-through API services + their transports + the data-file API.
    abs('src', 'app', 'core', 'services', 'wcl-api.ts'),
    abs('src', 'app', 'core', 'services', 'wcl-transport.ts'),
    abs('src', 'app', 'core', 'services', 'data-file-api.ts'),
    abs('src', 'app', 'core', 'services', 'data-file-transport.ts'),
  ].sort();
}

/** sha256 (first 12 hex chars) of the concatenated content of `codeHashSources()`. */
export function computeCodeHash(): string {
  const blob = codeHashSources()
    .map(file => fs.readFileSync(file, 'utf8'))
    .join('\n');
  return crypto.createHash('sha256').update(blob).digest('hex').slice(0, 12);
}
