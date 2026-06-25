#!/usr/bin/env node
/**
 * warcraft-learner - Standalone Guide Scraper CLI
 *
 * Manages guides for specs: add URLs, scrape content, view, delete.
 * Writes directly to data/specs/{spec}/guides.json
 *
 * Usage:
 *   npm run scrape
 *
 * Supported guide types:
 *   web      - HTML page scraped with fetch + text extraction
 *   youtube  - YouTube transcript via timedtext API
 *   simc     - Raw text file (GitHub raw URLs auto-converted)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { JSDOM } from 'jsdom';
import { MAX_GUIDE_CHARS as MAX_CONTENT_CHARS, readJson, writeJson, getKnownSpecs as listSpecs, createPrompt } from './lib.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(FRONTEND_ROOT, 'public', 'data', 'specs');

// ── CLI argument parsing ───────────────────────────────────────────────────────

const program = new Command()
  .name('scrape')
  .description('Manage guide URLs for specs: add, scrape, view, delete.')
  .option('--spec <spec>', 'spec name for non-interactive add-and-scrape mode')
  .option('--url <url>', 'guide URL to add (requires --spec)')
  .option('--type <type>', 'guide type: web | youtube | simc (default: web)', 'web')
  .addHelpText('after', '\nExamples:\n  npm run scrape\n  npm run scrape -- --spec SubtletyRogue --url https://example.com --type web')
  .parse(process.argv);

const opts = program.opts<{ spec?: string; url?: string; type: string }>();

if (opts.url && !opts.spec) {
  program.error('--url requires --spec');
}
if (!['web', 'youtube', 'simc'].includes(opts.type)) {
  program.error(`invalid --type: "${opts.type}". Must be web, youtube, or simc.`);
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

const { rl, ask, askList } = createPrompt();
const getKnownSpecs = (): string[] => listSpecs(DATA_DIR);

// ── Guides storage ──────────────────────────────────────────────────────────

function guidesPath(spec: string): string {
  return path.join(DATA_DIR, spec, 'guides.json');
}

async function loadGuides(spec: string): Promise<Guide[]> {
  return await readJson<Guide[]>(guidesPath(spec)) ?? [];
}

async function saveGuides(spec: string, guides: Guide[]): Promise<void> {
  await writeJson(guidesPath(spec), guides);
}

// ── Scraping ──────────────────────────────────────────────────────────────────

// Block-level tags whose boundaries should become line breaks in the extracted text,
// so adjacent blocks don't run their words together once tags are gone.
const BLOCK_SELECTOR = 'br, p, div, h1, h2, h3, h4, h5, h6, li, tr, section, article';

// A detached <textarea> whose `.innerHTML`/`.value` pair decodes HTML entities via the
// DOM (no regex). Reused across calls to avoid spinning up a JSDOM per string.
const entityDecoder = new JSDOM('').window.document.createElement('textarea');
function decodeHtmlEntities(text: string): string {
  entityDecoder.innerHTML = text;
  return entityDecoder.value;
}

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

async function scrapeWeb(url: string): Promise<string> {
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
  const res = await fetch(rawUrl, {
    headers: { 'User-Agent': 'warcraft-learner/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rawUrl}`);
  const text = await res.text();
  return text.slice(0, MAX_CONTENT_CHARS);
}

async function scrapeYouTube(url: string): Promise<string> {
  // Extract video ID from URL
  const match = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (!match) throw new Error(`Could not extract YouTube video ID from: ${url}`);
  const videoId = match[1];

  // Fetch timedtext (auto-generated captions)
  const captionsUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(captionsUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcraft-learner/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching YouTube page`);
  const html = await res.text();

  // Extract timedtext URL from page
  const ttMatch = html.match(/"captionTracks":\s*\[.*?"baseUrl":"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/);
  if (!ttMatch) {
    throw new Error('No caption tracks found for this video. Auto-captions may be disabled.');
  }
  const ttUrl = ttMatch[1].replace(/\\u0026/g, '&');

  const ttRes = await fetch(ttUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcraft-learner/1.0)' },
  });
  if (!ttRes.ok) throw new Error(`HTTP ${ttRes.status} fetching timedtext`);
  const xml = await ttRes.text();

  // Parse <text> elements from the caption XML via the DOM. textContent decodes the XML
  // entity layer; YouTube captions encode entities twice, so decodeHtmlEntities peels the
  // inner layer (e.g. "&amp;#39;" -> "&#39;" -> "'").
  const xmlDoc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
  const segments = [...xmlDoc.querySelectorAll('text')]
    .map(node => decodeHtmlEntities(node.textContent ?? '').trim())
    .filter(Boolean);

  return segments.join(' ').slice(0, MAX_CONTENT_CHARS);
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

async function addGuide(spec: string): Promise<void> {
  const url = (await ask('Guide URL: ')).trim();
  if (!url) return;

  const typeIdx = await askList('Guide type:', ['web', 'youtube', 'simc']);
  const guideType = (['web', 'youtube', 'simc'] as const)[typeIdx];

  const guides = await loadGuides(spec);
  const newGuide: Guide = {
    id: nextId(guides),
    spec,
    url,
    guide_type: guideType,
    content: '',
    status: 'pending',
  };
  guides.push(newGuide);
  await saveGuides(spec, guides);
  console.log(`Added guide #${newGuide.id}`);

  const doScrape = await ask('Scrape now? [Y/n] ');
  if (doScrape.trim().toLowerCase() !== 'n') {
    await scrapeGuideById(spec, newGuide.id);
  }
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

async function guidesMenu(spec: string): Promise<void> {
  while (true) {
    const guides = await loadGuides(spec);
    console.log(`\n-- Guides for ${spec} (${guides.length}) ----------------------------------`);
    guides.forEach((g, i) =>
      console.log(`  ${i + 1}. [${g.status.padEnd(7)}] ${g.guide_type.toUpperCase().padEnd(7)} ${g.url.slice(0, 70)}`));

    const actions = [
      'Add guide',
      'Scrape a guide',
      'Scrape all pending',
      'Delete a guide',
      'Back',
    ];
    const choice = await askList('\nAction:', actions);

    if (choice === 0) {
      await addGuide(spec);
    } else if (choice === 1) {
      if (!guides.length) { console.log('No guides.'); continue; }
      const n = parseInt(await ask('Guide number to scrape: '));
      if (n >= 1 && n <= guides.length) await scrapeGuideById(spec, guides[n - 1].id);
    } else if (choice === 2) {
      const pending = guides.filter(g => g.status !== 'scraped');
      if (!pending.length) { console.log('No pending guides.'); continue; }
      for (const g of pending) await scrapeGuideById(spec, g.id);
    } else if (choice === 3) {
      if (!guides.length) { console.log('No guides.'); continue; }
      const n = parseInt(await ask('Guide number to delete: '));
      if (n >= 1 && n <= guides.length) {
        const removed = guides.splice(n - 1, 1)[0];
        await saveGuides(spec, guides);
        console.log(`Deleted guide #${removed.id}`);
      }
    } else {
      break;
    }
  }
}

// ── Spec selection ────────────────────────────────────────────────────────────

async function pickSpec(): Promise<string> {
  const specs = getKnownSpecs();
  console.log('\nKnown specs in data/specs/:');
  if (specs.length) specs.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  else console.log('  (none yet)');
  const raw = await ask('\nEnter spec name or number (e.g. SubtletyRogue): ');
  const n = parseInt(raw);
  if (n >= 1 && n <= specs.length) return specs[n - 1];
  return raw.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('warcraft-learner - Guide Scraper CLI');

  const cliSpec = opts.spec;
  const cliUrl = opts.url;
  const cliType = opts.type as 'web' | 'youtube' | 'simc';

  // ── CLI mode (non-interactive) ──────────────────────────────────────────────
  if (cliSpec && cliUrl) {
    const guides = await loadGuides(cliSpec);
    const newGuide: Guide = { id: nextId(guides), spec: cliSpec, url: cliUrl, guide_type: cliType, content: '', status: 'pending' };
    guides.push(newGuide);
    await saveGuides(cliSpec, guides);
    console.log(`Added guide #${newGuide.id} for ${cliSpec}. Scraping...`);
    await scrapeGuideById(cliSpec, newGuide.id);
    rl.close();
    return;
  }

  // ── Interactive mode ────────────────────────────────────────────────────────
  while (true) {
    const spec = await pickSpec();
    if (!spec) break;

    await guidesMenu(spec);

    const again = await ask('\nManage another spec? [y/N] ');
    if (again.trim().toLowerCase() !== 'y') break;
  }

  rl.close();
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
