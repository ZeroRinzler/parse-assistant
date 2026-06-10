# WoW Active Progression Engine

A web-based diagnostic tool for Mythic WoW raiders. It fetches combat data from Warcraft Logs, evaluates it against spec-specific rulebooks (static or AI-generated from guides), and delivers prescriptive, coaching-style feedback with comparison against top-parse players.

## What it does

- **Analyzes your cooldown usage** — finds lost casts, poor BL alignment, slow openers, and held cooldowns. All thresholds are derived from real top-parse data for the same encounter, not arbitrary constants.
- **Compares you to top parsers** — uses-per-minute and first-cast timing benchmarked against the top 10 WCL parses for that boss.
- **Generates spec rulebooks from guides** — paste in Wowhead/Icy-Veins/YouTube guides; Claude extracts a structured rulebook with cooldown rules and rotation conditions.
- **Evaluates rotation rules** — the rule engine checks things like "Shadow Dance should always follow Secret Technique" or "don't use Dance within 15s of an incoming Shadow Blades" — all driven by the rulebook, not hardcoded spec logic.

## Quick start

```bash
cp .env.example .env   # fill in WCL OAuth credentials + Anthropic API key
python3 -m pip install -r requirements.txt
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

| URL | Description |
|---|---|
| `http://localhost:8000` | Player analyzer |
| `http://localhost:8000/admin` | Admin — guide management, rulebook generation, parse ingestion |

## Setup flow

1. **Admin → Guides tab**: select your spec, add one or more guide URLs (Wowhead, Icy-Veins, YouTube), scrape them.
2. **Admin → Guides tab**: click "Generate Rulebook" — Claude converts scraped text into a structured JSON rulebook.
3. **Admin → Top Parses tab**: click "Ingest All Bosses" — fetches and analyzes the top 10 WCL parses for every current-expansion boss. This powers the comparison table and data-derived thresholds.
4. **Player page**: paste a WCL report URL, select the fight and player, run analysis.

Steps 1–3 are per-spec and only need to be done once (or whenever you want to refresh the data).

## Credentials needed

| Secret | Where to get it |
|---|---|
| `WCL_CLIENT_ID` + `WCL_CLIENT_SECRET` | [Warcraft Logs API clients](https://www.warcraftlogs.com/api/clients/) |
| `ANTHROPIC_API_KEY` | [Anthropic console](https://console.anthropic.com/) — only needed for rulebook generation |

## How thresholds work

All analysis thresholds adapt to the encounter and spec via top-parse data:

| Check | Benchmark |
|---|---|
| First-cast delay | avg first-cast time across top parses ± 2σ |
| Gap between uses | avg inter-cast gap across top parses ± 2σ |
| Downtime floor | p90 of pooled inter-cast gaps from top parses |
| Efficiency warning | 1σ below top-parse avg triggers warning; 2σ triggers critical |
| BL timing | avg BL-offset across top parses ± 2σ |

If no parse samples exist for the encounter, all checks fall back to conservative static values.

## Architecture overview

```
main.py            — FastAPI app, all API routes
analyzer.py        — Deterministic rules engine (cooldown checks + rulebook rule evaluation)
parses_analyzer.py — WCL character rankings fetcher + per-parse timing analysis
wcl_client.py      — WCL OAuth2 + GraphQL client
rulebook.py        — Static fallback cooldown definitions (39 specs)
db.py              — SQLite persistence + in-memory rulebook cache
scraper.py         — Web page + YouTube transcript scraping
llm_parser.py      — Claude API — guide text → structured rulebook JSON
static/index.html  — Player UI (vanilla JS)
static/admin.html  — Admin UI (vanilla JS)
```

See `CLAUDE.md` for full technical reference including data models, API endpoints, rulebook JSON schema, and the rule condition engine.
