// All ingestion logic lives in the Angular app; this file must never grow any.
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const APP_URL = 'http://localhost:4200';
const SERVER_PROBE_URL = 'http://localhost:3000/api/dirs/specs';
const READY_TIMEOUT_MS = 5 * 60_000;
const READY_POLL_MS = 500;
const DONE_POLL_MS = 1_000;
const DONE_TIMEOUT_MS = 15 * 60_000;

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
  const prioritySpecs = process.env.PRIORITY_SPECS;
  const appUrl = prioritySpecs ? `${APP_URL}?prioritySpecs=${encodeURIComponent(prioritySpecs)}` : APP_URL;
  await page.goto(appUrl);

  // Bound the wait so a bootstrap failure fails fast instead of hanging the job and stalling the shared gh-pages group.
  try {
    await page.waitForFunction(() => globalThis.__INGEST_DONE__, undefined, { timeout: DONE_TIMEOUT_MS, polling: DONE_POLL_MS });
  } catch {
    console.error(`[harness] ingestion did not signal completion within ${DONE_TIMEOUT_MS / 60_000} minutes`);
    await shutdown(1);
  }
  const summary = await page.evaluate(() => globalThis.__INGEST_DONE__);

  if (summary.fatal) {
    console.error(`[harness] ingestion failed: ${summary.fatal}`);
    await shutdown(1);
  }
  console.log(`[harness] ingestion complete: ${summary.succeeded.length} spec(s) processed, ${summary.failed.length} failed${summary.budgetStopped ? ', stopped on WCL budget' : ''}`);
  if (summary.failed.length) {
    console.error(`[harness] failed specs: ${summary.failed.map(entry => entry.spec).join(', ')}`);
  }
  // Partial per-spec failure is deliberately tolerated; only an all-failed run is a broken build.
  const allSpecsFailed = summary.failed.length > 0 && summary.succeeded.length === 0;
  await shutdown(allSpecsFailed ? 1 : 0);
}

main().catch(async err => {
  console.error('[harness] fatal:', err instanceof Error ? err.message : String(err));
  await shutdown(1);
});
