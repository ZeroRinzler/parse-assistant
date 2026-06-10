# WoW Active Progression Engine

A web-based diagnostic tool for Mythic WoW raiders. It fetches combat data from Warcraft Logs, evaluates it against spec-specific rulebooks (static or AI-generated from guides), and delivers prescriptive, coaching-style feedback with comparison against top-parse players.

## What it does

- **Analyzes your cooldown usage** — finds lost casts, poor BL alignment, slow openers, and held cooldowns. All thresholds are derived from real top-parse data for the same encounter, not arbitrary constants.
- **Compares you to top parsers** — uses-per-minute and first-cast timing benchmarked against the top 10 WCL parses for that boss.
- **Detects hold patterns** — identifies when top parsers consistently delay a cooldown past its reset time, and flags when you're using it earlier than they do.
- **Maps burst windows** — finds the top recurring 8-second damage spikes across top parses and shows which cooldowns are active in them.
- **Evaluates rotation rules** — the rule engine checks things like "Shadow Dance should always follow Secret Technique" or "don't use Dance within 15s of an incoming Shadow Blades" — all driven by a rulebook, not hardcoded spec logic.
- **Per-fight player filtering** — the player dropdown shows only participants in the selected fight (no roster-swap clutter from earlier or later attempts).

## Quick start

```bash
cp .env.example .env   # fill in WCL OAuth credentials
python3 -m pip install -r requirements.txt
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

| URL | Description |
|---|---|
| `http://localhost:8000/pre` | Pre-fight brief — what top parsers do on each boss |
| `http://localhost:8000/live` | Live mode — auto-selects newest pull, polls every 12s |
| `http://localhost:8000` | Post-raid — full cooldown analysis for any fight |
| `http://localhost:8000/admin` | Admin — guide management, rulebook generation, parse ingestion |

## Setup flow

1. **Admin → Guides tab**: select your spec, add one or more guide URLs (Wowhead, Icy-Veins, YouTube, or SimC APL GitHub URLs), scrape them.
2. **Admin → Guides tab**: click "Copy AI Prompt" — copies a complete prompt including the skill instructions and all scraped guide content. Paste it into any LLM (Claude, ChatGPT, etc.).
3. **Admin → Guides tab**: paste the LLM's JSON output back and click "Save & Activate" — the rulebook goes live immediately.
4. **Admin → Top Parses tab**: click "Ingest All Bosses" — fetches and analyzes the top 10 WCL parses for every current-expansion boss. This powers the comparison table, data-derived thresholds, hold pattern detection, and burst window analysis.
5. **Player page**: paste a WCL report URL — fight and player selectors appear automatically. Analysis runs on selection.

Steps 1–4 are per-spec and only need to be done once (or whenever you want to refresh the data).

## Credentials needed

| Secret | Where to get it |
|---|---|
| `WCL_CLIENT_ID` + `WCL_CLIENT_SECRET` | [Warcraft Logs API clients](https://www.warcraftlogs.com/api/clients/) |

No Anthropic API key is required. The rulebook generation workflow uses a copy-prompt → paste-back flow that works with any LLM.

## How thresholds work

All analysis thresholds adapt to the encounter and spec via top-parse data:

| Check | Benchmark |
|---|---|
| First-cast delay | avg first-cast time across top parses ± 2σ |
| Gap between uses | avg inter-cast gap across top parses ± 2σ |
| Hold suggestion | cast index where ≥40% of top parsers delay past on-cooldown time |
| Downtime floor | p90 of pooled inter-cast gaps from top parses |
| Efficiency warning | 1σ below top-parse avg triggers warning; 2σ triggers critical |
| BL timing | avg BL-offset across top parses ± 2σ |
| Burst windows | top 4 non-overlapping 8s damage peaks, clustered across top parses |

If no parse samples exist for the encounter, all checks fall back to conservative static values.

## Rulebook workflow

The AI integration was replaced with a copy-prompt / paste-back workflow:

1. Scrape one or more guides for a spec.
2. Click "Copy AI Prompt" — this assembles the skill file (`prompts/rulebook_skill.md`) with your guide content into a single prompt ready to paste.
3. Paste it into any LLM, copy the JSON output.
4. Paste the JSON into the "Step 2 — Paste AI Output" panel and click "Save & Activate".

The `prompts/rulebook_skill.md` file controls the schema and instructions the LLM receives. Edit it to improve outputs over time.

## Architecture overview

```
main.py            — FastAPI app, all API routes
analyzer.py        — Deterministic rules engine (cooldown checks + hold suggestions)
parses_analyzer.py — WCL rankings fetcher, per-parse timing + hold pattern + burst window analysis
wcl_client.py      — WCL OAuth2 + GraphQL client (with friendlyPlayers per-fight)
rulebook.py        — Static fallback cooldown definitions (22+ DPS specs)
db.py              — SQLite persistence + in-memory rulebook cache
scraper.py         — Web page + YouTube transcript + GitHub raw file scraping
prompts/
  rulebook_skill.md — LLM skill file: schema, field reference, condition examples
static/index.html  — Player UI (vanilla JS, URL-persistent state)
static/admin.html  — Admin UI (vanilla JS)
```

See `CLAUDE.md` for full technical reference including data models, API endpoints, rulebook JSON schema, and the rule condition engine.

## Hosting assessment: GitHub Pages migration

The current stack (FastAPI + SQLite + Python scraping) cannot run on GitHub Pages — it only serves static files. This section documents what a static rewrite would look like and where the open questions are.

### What is incompatible with GitHub Pages

| Component | Technology | Reason |
|---|---|---|
| Web server | FastAPI + uvicorn | Python ASGI server — no server-side execution |
| Database | SQLite via aiosqlite | Requires a running process |
| WCL authentication | OAuth2 client credentials | Needs a server to hold the `WCL_CLIENT_SECRET` safely |
| Admin ingestion pipeline | All `/api/admin/*` routes | Depend on the Python backend and DB |
| Web scraping | BeautifulSoup / lxml | Python library, server-side only |
| YouTube transcript fetching | `youtube-transcript-api` | Python library, server-side only |
| Parse ingestion streaming | SSE endpoint | Requires a persistent HTTP connection to a running server |
| All WCL GraphQL queries | `/api/analyze` + parse fetch | Go through the Python backend which holds WCL credentials |

### Proposed static architecture

**Data layer — JSON files in the repo**

Rulebooks, parse samples, burst windows, and hold patterns are all naturally JSON. They would be committed to the repo under a `data/` directory and fetched client-side at runtime. No database process needed.

**Scraping and ingestion — GitHub Actions**

GitHub Actions can run the existing Python scraper and WCL ingestion scripts on a schedule or via manual trigger (`workflow_dispatch`). The Action writes output as JSON files and commits them back to the repo. GitHub Pages then serves the updated files on next deploy. WCL credentials and other secrets live in GitHub Actions secrets — never in client-side JS.

Trade-off: parse data is only as fresh as the last Action run. For a tool used between raid nights this is acceptable.

**Analysis engine — rewrite in JavaScript**

`analyzer.py` logic would be ported to JS and run entirely in the browser against the pre-fetched JSON data.

**WCL live report analysis — open question**

The current backend fetches WCL data on behalf of the user using client credentials (client ID + secret). A static site cannot hold a secret safely. Two options:

1. **PKCE flow** — WCL may support OAuth2 authorization code flow with PKCE, which is browser-safe and requires no secret. The user would log in via WCL and grant access. This needs to be confirmed against WCL's API documentation before building around it.
2. **Minimal proxy** — a single serverless function (Cloudflare Worker, Netlify Function, etc.) handles only the token exchange. All other logic stays static. This avoids a full backend while keeping the secret off the client.

### Summary

| Piece | Approach |
|---|---|
| Rulebooks / parse data | JSON files in repo, fetched client-side |
| Scraping / ingestion | GitHub Actions (scheduled or manual), commits JSON back |
| Analysis engine | Port `analyzer.py` to JS, runs in browser |
| Admin UI | Replaced by GitHub Actions manual triggers |
| WCL live report fetch | Needs PKCE support confirmed — or a small proxy function |
