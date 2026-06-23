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
import { MAX_GUIDE_CHARS as MAX_CONTENT_CHARS, readJson, writeJson, getKnownSpecs as listSpecs, createPrompt } from './lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(FRONTEND_ROOT, 'public', 'data', 'specs');

const { rl, ask, askList } = createPrompt();
const getKnownSpecs = () => listSpecs(DATA_DIR);

// ── Guides storage ──────────────────────────────────────────────────────────

function guidesPath(spec) {
  return path.join(DATA_DIR, spec, 'guides.json');
}

function loadGuides(spec) {
  return readJson(guidesPath(spec)) || [];
}

function saveGuides(spec, guides) {
  writeJson(guidesPath(spec), guides);
}

// ── Scraping ──────────────────────────────────────────────────────────────────

function htmlToText(html) {
  // Remove scripts, styles, nav, footer
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ');

  // Turn block elements into newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(p|div|h[1-6]|li|tr|section|article)[^>]*>/gi, '\n');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/g, ' ');

  // Collapse whitespace
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function scrapeWeb(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; warcraft-learner/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  return htmlToText(html).slice(0, MAX_CONTENT_CHARS);
}

async function scrapeSimC(url) {
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

async function scrapeYouTube(url) {
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

  // Parse <text> elements from XML
  const segments = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m =>
    m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#\d+;/g, '')
      .trim()
  );

  return segments.join(' ').slice(0, MAX_CONTENT_CHARS);
}

async function scrapeGuide(guide) {
  const { guide_type, url } = guide;
  if (guide_type === 'web') return scrapeWeb(url);
  if (guide_type === 'simc') return scrapeSimC(url);
  if (guide_type === 'youtube') return scrapeYouTube(url);
  throw new Error(`Unknown guide_type: ${guide_type}`);
}

// ── Guide management ──────────────────────────────────────────────────────────

function nextId(guides) {
  return guides.length === 0 ? 1 : Math.max(...guides.map(g => g.id || 0)) + 1;
}

async function addGuide(spec) {
  const url = (await ask('Guide URL: ')).trim();
  if (!url) return;

  const typeIdx = await askList('Guide type:', ['web', 'youtube', 'simc']);
  const guideType = ['web', 'youtube', 'simc'][typeIdx];

  const guides = loadGuides(spec);
  const newGuide = {
    id: nextId(guides),
    spec,
    url,
    guide_type: guideType,
    content: '',
    status: 'pending',
  };
  guides.push(newGuide);
  saveGuides(spec, guides);
  console.log(`Added guide #${newGuide.id}`);

  const doScrape = await ask('Scrape now? [Y/n] ');
  if (doScrape.trim().toLowerCase() !== 'n') {
    await scrapeGuideById(spec, newGuide.id);
  }
}

async function scrapeGuideById(spec, guideId) {
  const guides = loadGuides(spec);
  const idx = guides.findIndex(g => g.id === guideId);
  if (idx === -1) { console.log(`Guide #${guideId} not found`); return; }

  const guide = guides[idx];
  process.stdout.write(`  Scraping [${guide.guide_type}] ${guide.url.slice(0, 70)}...`);
  try {
    const content = await scrapeGuide(guide);
    guides[idx] = { ...guide, content, status: 'scraped' };
    saveGuides(spec, guides);
    console.log(` OK (${content.length} chars)`);
  } catch (err) {
    guides[idx] = { ...guide, content: '', status: 'error' };
    saveGuides(spec, guides);
    console.log(` ERROR: ${err.message}`);
  }
}

async function guidesMenu(spec) {
  while (true) {
    const guides = loadGuides(spec);
    console.log(`\n── Guides for ${spec} (${guides.length}) ──────────────────────────`);
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
        saveGuides(spec, guides);
        console.log(`Deleted guide #${removed.id}`);
      }
    } else {
      break;
    }
  }
}

// ── Spec selection ────────────────────────────────────────────────────────────

async function pickSpec() {
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

async function main() {
  console.log('warcraft-learner - Guide Scraper CLI');

  // ── CLI mode (non-interactive) ──────────────────────────────────────────────
  const argv = process.argv.slice(2);
  const cliSpec = argv.find((_, i) => argv[i - 1] === '--spec');
  const cliUrl  = argv.find((_, i) => argv[i - 1] === '--url');
  const cliType = argv.find((_, i) => argv[i - 1] === '--type') || 'web';

  if (cliSpec && cliUrl) {
    if (!['web', 'youtube', 'simc'].includes(cliType)) {
      console.error(`Unknown guide type: ${cliType}. Use web, youtube, or simc.`);
      process.exit(1);
    }
    const guides = loadGuides(cliSpec);
    const newGuide = { id: nextId(guides), spec: cliSpec, url: cliUrl, guide_type: cliType, content: '', status: 'pending' };
    guides.push(newGuide);
    saveGuides(cliSpec, guides);
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
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
