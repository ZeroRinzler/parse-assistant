/**
 * Headless ingest harness (npm run ingest): drives the browser ingestion unattended
 * for CI. All ingestion logic lives in the Angular app; this file must never grow any.
 * If no browser resolves, run `npx playwright install chromium` once.
 */
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const APP_URL = 'http://localhost:4200';
const SERVER_PROBE_URL = 'http://localhost:3000/api/dirs/specs';
const READY_TIMEOUT_MS = 5 * 60_000;
const READY_POLL_MS = 500;
const DONE_POLL_MS = 1_000;

const children = [];

function startChild(name, command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const forward = chunk => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.log(`[${name}] ${line}`);
    }
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  child.on('exit', code => {
    // A dead child can never finish the run - fail loudly instead of hanging.
    if (!shuttingDown) {
      console.error(`[harness] ${name} exited early (code ${code})`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
let browser = null;

async function shutdown(exitCode) {
  shuttingDown = true;
  if (browser) await browser.close().catch(() => undefined);
  for (const child of children) child.kill('SIGTERM');
  // Give the children a moment to die before the process exit reaps them hard.
  await new Promise(resolve => setTimeout(resolve, 500));
  process.exit(exitCode);
}

async function waitForHttp(url, name) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Refusals are expected while the process boots, so the swallow is deliberate.
    }
    if (Date.now() > deadline) throw new Error(`${name} did not become ready at ${url}`);
    await new Promise(resolve => setTimeout(resolve, READY_POLL_MS));
  }
}

async function launchBrowser() {
  const executablePath = process.env.INGEST_CHROMIUM_PATH;
  if (executablePath) return await chromium.launch({ executablePath });
  try {
    return await chromium.launch();
  } catch {
    console.log('[harness] no Playwright-managed Chromium; falling back to the system Chrome channel');
    return await chromium.launch({ channel: 'chrome' });
  }
}

async function main() {
  startChild('server', 'node', ['scripts/ingest-server.js']);
  startChild('serve', 'npx', ['ng', 'serve', '--configuration', 'ingest']);
  await waitForHttp(SERVER_PROBE_URL, 'ingest file server');
  await waitForHttp(APP_URL, 'ng serve');

  browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', message => console.log(`[app] ${message.text()}`));
  page.on('pageerror', err => console.error(`[app] pageerror: ${err.message}`));
  await page.goto(APP_URL);

  // No timeout: the WCL point budget bounds the run, so it always ends.
  await page.waitForFunction(() => globalThis.__INGEST_DONE__, undefined, { timeout: 0, polling: DONE_POLL_MS });
  const summary = await page.evaluate(() => globalThis.__INGEST_DONE__);

  if (summary.fatal) {
    console.error(`[harness] ingestion failed: ${summary.fatal}`);
    await shutdown(1);
  }
  console.log(`[harness] ingestion complete: ${summary.succeeded.length} spec(s) processed, ${summary.failed.length} failed${summary.budgetStopped ? ', stopped on WCL budget' : ''}`);
  await shutdown(0);
}

main().catch(async err => {
  console.error('[harness] fatal:', err instanceof Error ? err.message : String(err));
  await shutdown(1);
});
