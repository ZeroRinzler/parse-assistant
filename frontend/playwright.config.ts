import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const APP_URL = 'http://localhost:4200';

// Covers the optimized ng build that precedes serving.
const SERVE_TIMEOUT_MS = 300_000;

// Without the pulled dataset every card renders its empty-bench state and each assertion fails confusingly.
const dataIndex = fileURLToPath(new URL('./public/data/specs/index.json', import.meta.url));
if (!existsSync(dataIndex)) {
  throw new Error('No ingested data under public/data/specs - run `npm run data:pull` (from frontend/) first.');
}

export default defineConfig({
  testDir: 'e2e',
  // A retry re-runs a spec file's whole serial chain, spending a second WCL analysis on an already-failing run.
  retries: 0,
  // The `github` reporter annotates failing spec lines in the PR checks, as the unit suite's Vitest reporter does.
  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Production reads the pulled bench files, so the post-raid analysis is the run's only WCL traffic.
    command: 'npm start -- --configuration production',
    url: APP_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: SERVE_TIMEOUT_MS,
  },
});
