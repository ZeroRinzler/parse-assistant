#!/usr/bin/env node
/**
 * warcraft-learner - Standalone Guide Scraper CLI
 *
 * Re-scrapes every existing guide across all specs, writing fresh content to
 * data/specs/{spec}/guides.json. Pass --spec/--url to add a new guide instead.
 *
 * Usage:
 *   npm run scrape                                            # re-scrape all existing guides
 *   npm run scrape -- --spec SubtletyRogue --url <url>        # add and scrape one guide
 *
 * Supported guide types:
 *   web      - HTML page scraped with fetch + text extraction
 *   youtube  - YouTube transcript via the Supadata API (needs SUPADATA_API_KEY)
 *   simc     - Raw text file (GitHub raw URLs auto-converted)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { JSDOM } from 'jsdom';
import { MAX_GUIDE_CHARS as MAX_CONTENT_CHARS, readJson, writeJson, getKnownSpecs as listSpecs } from './lib.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(FRONTEND_ROOT, 'public', 'data', 'specs');

// ── CLI argument parsing ───────────────────────────────────────────────────────

interface CliOptions {
  spec?: string;
  url?: string;
  type: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const program = new Command()
    .name('scrape')
    .description('Re-scrape every existing guide; or add one with --spec/--url.')
    .option('--spec <spec>', 'spec name for add-and-scrape mode')
    .option('--url <url>', 'guide URL to add (requires --spec)')
    .option('--type <type>', 'guide type: web | youtube | simc (default: web)', 'web')
    .addHelpText('after', '\nExamples:\n  npm run scrape\n  npm run scrape -- --spec SubtletyRogue --url https://example.com --type web')
    .parse(argv);

  const opts = program.opts<CliOptions>();

  if (opts.url && !opts.spec) {
    program.error('--url requires --spec');
  }
  if (!['web', 'youtube', 'simc'].includes(opts.type)) {
    program.error(`invalid --type: "${opts.type}". Must be web, youtube, or simc.`);
  }
  return opts;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Guide {
  id: number;
  spec: string;
  url: string;
  guide_type: 'web' | 'youtube' | 'simc';
  content: string;
  status: 'pending' | 'scraped' | 'error';
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const getKnownSpecs = (): string[] => listSpecs(DATA_DIR);

// ── Guides storage ──────────────────────────────────────────────────────────

function guidesPath(spec: string): string {
  return path.join(DATA_DIR, spec, 'guides.json');
}

async function loadGuides(spec: string): Promise<Guide[]> {
  return await readJson<Guide[]>(guidesPath(spec)) ?? [];
}

async function saveGuides(spec: string, guides: Guide[]): Promise<void> {
  // Minified (compact): guides.json holds bulky scraped guide text and is machine-read,
  // so it follows the same no-pretty-print rule as the tailored bench data under data/specs.
  await writeJson(guidesPath(spec), guides, true);
}

// ── Scraping ──────────────────────────────────────────────────────────────────

// Block-level tags whose boundaries should become line breaks in the extracted text,
// so adjacent blocks don't run their words together once tags are gone.
const BLOCK_SELECTOR = 'br, p, div, h1, h2, h3, h4, h5, h6, li, tr, section, article';

function htmlToText(html: string): string {
  const doc = new JSDOM(html).window.document;

  // Drop non-content chrome.
  doc.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());

  // Mark block boundaries with newlines before flattening to text.
  doc.querySelectorAll(BLOCK_SELECTOR).forEach(el => el.after(doc.createTextNode('\n')));

  // textContent strips tags and decodes entities natively.
  const text = doc.body?.textContent ?? '';

  // Collapse whitespace (not tag/entity work, so plain string handling is fine).
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Guides in guides.json carry an arbitrary URL. Only fetch over TLS: a plain http:// URL would
// pull guide content over an unencrypted, tamperable connection. Reject any non-https scheme
// (and any unparseable URL) rather than silently upgrading it, so a bad entry fails loudly as a
// per-guide error instead of quietly downgrading the fetch.
function assertHttps(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid guide URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to fetch non-https guide URL (${parsed.protocol}): ${url}`);
  }
}

async function scrapeWeb(url: string): Promise<string> {
  assertHttps(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcraft-learner/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  return htmlToText(html).slice(0, MAX_CONTENT_CHARS);
}

async function scrapeSimC(url: string): Promise<string> {
  // Convert GitHub blob URLs to raw
  const rawUrl = url
    .replace('github.com', 'raw.githubusercontent.com')
    .replace('/blob/', '/');
  assertHttps(rawUrl);
  const res = await fetch(rawUrl, {
    headers: { 'User-Agent': 'warcraft-learner/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rawUrl}`);
  const text = await res.text();
  return text.slice(0, MAX_CONTENT_CHARS);
}

// Anonymous YouTube transcript fetching no longer works: YouTube gates caption/transcript data
// behind an authenticated, bot-checked session, so direct InnerTube calls (youtubei.js) and
// yt-dlp both get refused ("Sign in to confirm you're not a bot") from any IP. We delegate to
// the Supadata transcript API, which handles that on its side and returns plain text. Set the
// SUPADATA_API_KEY env var (a GHA secret for the hosted ingest); without it YouTube guides
// record a non-fatal per-guide error and the run continues.
const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY?.trim();
const SUPADATA_TRANSCRIPT_URL = 'https://api.supadata.ai/v1/youtube/transcript';

// Supadata returns the transcript either as a plain string (text=true) or as timed segments.
interface SupadataTranscript {
  content?: string | { text?: string }[];
}

async function scrapeYouTube(url: string): Promise<string> {
  if (!SUPADATA_API_KEY) {
    throw new Error('SUPADATA_API_KEY is not set; cannot fetch YouTube transcript.');
  }
  // The video URL is forwarded to Supadata as a query param; hold it to the same https bar.
  assertHttps(url);

  const query = new URLSearchParams({ url, text: 'true' });
  const res = await fetch(`${SUPADATA_TRANSCRIPT_URL}?${query}`, {
    headers: { 'x-api-key': SUPADATA_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`Supadata HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as SupadataTranscript;
  const content = typeof data.content === 'string'
    ? data.content
    : (data.content ?? []).map(segment => segment.text ?? '').join(' ');
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Supadata returned an empty transcript. Auto-captions may be disabled.');

  return text.slice(0, MAX_CONTENT_CHARS);
}

async function scrapeGuide(guide: Guide): Promise<string> {
  const { guide_type, url } = guide;
  if (guide_type === 'web') return scrapeWeb(url);
  if (guide_type === 'simc') return scrapeSimC(url);
  if (guide_type === 'youtube') return scrapeYouTube(url);
  throw new Error(`Unknown guide_type: ${guide_type}`);
}

// ── Guide management ──────────────────────────────────────────────────────────

function nextId(guides: Guide[]): number {
  return guides.length === 0 ? 1 : Math.max(...guides.map(g => g.id || 0)) + 1;
}

async function scrapeGuideById(spec: string, guideId: number): Promise<void> {
  const guides = await loadGuides(spec);
  const idx = guides.findIndex(g => g.id === guideId);
  if (idx === -1) { console.log(`Guide #${guideId} not found`); return; }

  const guide = guides[idx];
  process.stdout.write(`  Scraping [${guide.guide_type}] ${guide.url.slice(0, 70)}...`);
  try {
    const content = await scrapeGuide(guide);
    guides[idx] = { ...guide, content, status: 'scraped' };
    await saveGuides(spec, guides);
    console.log(` OK (${content.length} chars)`);
  } catch (err) {
    guides[idx] = { ...guide, content: '', status: 'error' };
    await saveGuides(spec, guides);
    console.log(` ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Bulk refresh ──────────────────────────────────────────────────────────────

// Re-scrape every existing guide across all known specs. This is the default action
// (used by the hourly ingest workflow to keep guide content fresh). Reuses
// scrapeGuideById, which records per-guide errors as status 'error' rather than
// throwing, so one dead URL never fails the run.
async function refreshAllGuides(): Promise<void> {
  const specs = getKnownSpecs();
  for (const spec of specs) {
    const guides = await loadGuides(spec);
    if (!guides.length) continue;
    console.log(`\n-- Refreshing ${spec} (${guides.length} guides) --`);
    for (const guide of guides) {
      // A YouTube transcript never changes, and the Supadata API is metered, so don't re-fetch
      // one we already have. Errored/empty YouTube guides still retry, and web/SimC always refresh.
      if (guide.guide_type === 'youtube' && guide.status === 'scraped' && guide.content) {
        console.log(`  Skipping [youtube] ${guide.url.slice(0, 70)}... (already scraped)`);
        continue;
      }
      await scrapeGuideById(spec, guide.id);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(opts: CliOptions): Promise<void> {
  console.log('warcraft-learner - Guide Scraper CLI');

  const cliSpec = opts.spec;
  const cliUrl = opts.url;
  const cliType = opts.type as 'web' | 'youtube' | 'simc';

  // ── Add mode: append and scrape a single new guide ──────────────────────────
  if (cliSpec && cliUrl) {
    const guides = await loadGuides(cliSpec);
    const newGuide: Guide = { id: nextId(guides), spec: cliSpec, url: cliUrl, guide_type: cliType, content: '', status: 'pending' };
    guides.push(newGuide);
    await saveGuides(cliSpec, guides);
    console.log(`Added guide #${newGuide.id} for ${cliSpec}. Scraping...`);
    await scrapeGuideById(cliSpec, newGuide.id);
    return;
  }

  // ── Default: re-scrape every existing guide ─────────────────────────────────
  await refreshAllGuides();
}

// Only run the CLI when invoked directly (not when imported, e.g. by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main(parseCliArgs(process.argv)).catch(err => {
    console.error('\nFatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { assertHttps };
