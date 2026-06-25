import { defineConfig } from 'vitest/config';

// Vitest config for the ingestion scripts (scripts/**). Kept separate from the
// Angular `ng test` run (which covers src/** via tsconfig.spec.json): the scripts
// use explicit `.ts` import specifiers and run in a plain Node environment.
export default defineConfig({
  test: {
    include: ['scripts/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['scripts/ingest/testing/setup-data-dir.ts'],
  },
});
