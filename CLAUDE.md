# WoW Active Progression Engine

A web-based diagnostic tool for Mythic WoW raiders. It fetches combat data from Warcraft Logs, evaluates it against spec-specific rulebooks (static or AI-generated from guides), and delivers prescriptive, coaching-style feedback with comparison against top-parse players.

## Running locally

```bash
cp .env.example .env   # fill in credentials
python3 -m pip install -r requirements.txt
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

- Player UI: `http://localhost:8000`
- Admin UI:  `http://localhost:8000/admin`

## URL routing

All state is persisted in the URL as query parameters. This is required for all new features — every navigable state must be linkable and bookmarkable.

### Player page (`/`)
| Param | Description |
|---|---|
| `report` | WCL report code (e.g. `grBQ3vTHXAtPa4JK`) |
| `fight` | Fight actor ID |
| `player` | Player actor ID |

Example: `/?report=grBQ3vTHXAtPa4JK&fight=1&player=10`

If all three params are present on load, the page auto-fetches the report and runs analysis immediately.

### Admin page (`/admin`)
| Param | Description |
|---|---|
| `spec` | WCL spec name (e.g. `SubtletyRogue`) |
| `tab` | Active tab: `guides`, `parses`, or `rulebook` |

Example: `/admin?spec=SubtletyRogue&tab=rulebook`

## Architecture

```
warcraft-learner/
├── main.py              # FastAPI app — all routes (player API + admin API)
├── analyzer.py          # Rules engine — evaluates cast events against a rulebook
├── wcl_client.py        # Warcraft Logs OAuth2 + GraphQL client (handles pagination)
├── rulebook.py          # Static fallback cooldowns for 22+ DPS specs
├── db.py                # SQLite via aiosqlite — guide CRUD, generated rulebook cache
├── scraper.py           # Web (BeautifulSoup/lxml) + YouTube transcript scraping
├── llm_parser.py        # Claude API — converts guide text → structured JSON rulebook
├── parses_analyzer.py   # WCL characterRankings + per-parse cooldown timing analysis
├── static/
│   ├── index.html       # Player-facing analyzer UI (vanilla JS)
│   └── admin.html       # Admin guide management UI (vanilla JS)
├── data/
│   └── warcraft.db      # SQLite DB (gitignored — created at startup)
├── .env                 # Secrets (gitignored)
├── .env.example         # Credential template
└── requirements.txt
```

## Key flows

### Player analysis (`/api/analyze`)
1. Accepts a WCL report URL + fight ID + player actor ID.
2. Fetches `playerDetails` for the fight to resolve the proper spec+class string (`SubtletyRogue`). WCL changed `actor.subType` in Midnight to return only the class name — `playerDetails` is the reliable source.
3. Fetches `Casts` and `Buffs` events for that player via `wcl_client.py`.
4. `analyzer.py` checks per cooldown:
   - **Lost cooldown casts** — `expected = 1 + floor(fight_duration / cd_cooldown)` vs actual.
   - **Bloodlust alignment** — flags any major CD (where `align_with_bloodlust: true`) not cast within the BL window.
   - **First-cast delay** — flags opener CDs used >30 s into the fight.
   - **Cooldown held past reset** — gap between casts > cooldown × 1.2.
   - **Success** — emits a `severity: "success"` finding if a CD had zero issues.
5. Response includes two sections: **Needs Improvement** (critical/warning) and **Doing Well** (success).
6. If parse samples exist for the fight's encounter, a **vs Top N Parses** comparison table is appended showing per-CD uses, first-cast timing, and BL-alignment rate vs top performers.
7. Cooldown rules come from the **dynamic rulebook** if one exists (SQLite + in-memory cache in `db.py`), otherwise from the static `SPEC_COOLDOWNS` dict in `rulebook.py`.

### Ingestion pipeline (`/admin`)
1. **Add guides** — POST `/api/admin/guides` with `{spec, url, guide_type}`. Type is `"web"` or `"youtube"`. Stored in `guides` SQLite table.
2. **Scrape** — POST `/api/admin/guides/{id}/scrape`. `scraper.py` fetches page text (BeautifulSoup) or YouTube transcript (`youtube-transcript-api`). Up to 60 k chars stored per guide.
3. **Generate rulebook** — POST `/api/admin/rulebook/{spec}/generate-stream`. `llm_parser.py` batches all scraped guide content and optionally top-parse context, sends to Claude (`claude-sonnet-4-6`), receives structured JSON with `major_cooldowns[]` and `rules[]`. Saved to `generated_rulebooks` table and loaded into in-memory cache — live immediately with no restart.
4. **Manual rulebook** — PUT `/api/admin/rulebook/{spec}`. Persists hand-crafted JSON directly, bypassing the LLM. Must include `major_cooldowns` key.
5. **Top parses** — POST `/api/admin/parses/analyze-stream`. Fetches WCL `characterRankings` for spec + encounter, then deep-analyzes each top player's events using the **dynamic rulebook** (not the static fallback). Results saved to `parse_samples` table.

### Encounter selection (admin parses tab)
Encounters auto-load on page open. Filtered to:
- Current expansion only (auto-detected as the expansion with the first unique name in the WCL API response — WCL returns newest first).
- Excludes zones matching: `beta`, `ptr`, `mythic+`, `complete raids`, `delves`, `torghast`.

## Data models

### `guides` table
| field | notes |
|---|---|
| spec | WCL actor subType, e.g. `SubtletyRogue` |
| url | Source URL |
| guide_type | `web` or `youtube` |
| content | Scraped text (up to 60 k chars) |
| status | `pending` → `scraped` → (used in generation) |

### `generated_rulebooks` table
| field | notes |
|---|---|
| spec | Unique per spec |
| rulebook | Full JSON blob from LLM or manual editor |
| guide_count | Number of guides used |

### `parse_samples` table
Stores per-fight cooldown timing summaries for top WCL performers. Used for the vs-top-parses comparison on the analyzer page and as grounding context for LLM rulebook generation.

### Rulebook JSON schema
```json
{
  "spec": "SubtletyRogue",
  "major_cooldowns": [
    {
      "name": "Shadow Blades",
      "spell_id": 121471,
      "cooldown": 90,
      "duration": 20,
      "align_with_bloodlust": true,
      "opener_priority": 1,
      "usage_rule": "..."
    }
  ],
  "rules": [
    {
      "type": "cooldown",
      "priority": "critical",
      "description": "...",
      "condition": "...",
      "action": "..."
    }
  ],
  "source_summary": "..."
}
```

## External APIs

| API | Auth | Used for |
|---|---|---|
| Warcraft Logs v2 (GraphQL) | OAuth2 client credentials | Report data, fight events, character rankings, playerDetails |
| Anthropic (Claude) | API key | Guide text → structured rulebook JSON |
| YouTube (no key) | None | Transcript extraction via `youtube-transcript-api` |

## Spec naming convention
WCL `actor.subType` historically returned `{Spec}{Class}` CamelCase (e.g. `SubtletyRogue`). In Midnight this changed to class-only (`Rogue`). The codebase now resolves spec via `playerDetails(fightIDs: [...])` which still returns the full spec info. The `_build_spec_map(report)` helper in `main.py` handles the conversion.

## What's not yet built (from design doc)
- PostgreSQL migration (currently SQLite)
- VOD synchronization (Workflow 3)
- Discord webhook output
- Frontend Next.js migration
- Deeper use of generated `rules[]` array in the analyzer (currently only `major_cooldowns[]` is used)
