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
   - **Bloodlust alignment** — flags any major CD (where `align_with_bloodlust: true`) whose BL-window cast timing is >2σ from the top-parse average offset. Falls back to a binary in/out-of-window check when no parse data exists.
   - **First-cast delay** — flags opener CDs whose first cast is >2σ later than the top-parse `avg_first_cast_s`. Falls back to a flat 30 s threshold when no parse data exists.
   - **Cooldown held past reset** — gap between casts is >2σ above the top-parse `avg_gap_s` for that CD. Falls back to `cooldown × 1.2` when no parse data exists.
   - **Cast efficiency** — compares player downtime (gaps above the p90 of top-parse inter-cast gaps) against the top-parse average. Warning band uses top-parse stddev rather than a fixed percentage.
   - **Success** — emits a `severity: "success"` finding if a CD had zero issues.
5. **Rule engine** — after cooldown analysis, evaluates every `rules[]` entry that has a machine-readable `condition` object. Two supported kinds:
   - `cast_without_prior` — flags each cast of `spell_id` that lacks a paired cast of `required_spell_id` within `window_s`. Optional `exception` exempts casts during a context spell window (e.g. 2nd Dance inside Shadow Blades).
   - `hold_cooldown_for_anchor` — flags casts of `spell_ids` within `hold_window_s` before each non-opener cast of `anchor_spell_id`.
   Rule findings include a `details.remedy` field with the rule's `action` text, rendered as a coaching callout in the UI.
6. Response includes two sections: **Needs Improvement** (critical/warning) and **Doing Well** (success).
7. If parse samples exist for the fight's encounter, a **vs Top N Parses** comparison table is appended. Uses **uses-per-minute** (not raw counts) to normalize across kill-time differences between the player and top performers.
8. Cooldown rules come from the **dynamic rulebook** if one exists (SQLite + in-memory cache in `db.py`), otherwise from the static `SPEC_COOLDOWNS` dict in `rulebook.py`.

### Ingestion pipeline (`/admin`)
1. **Add guides** — POST `/api/admin/guides` with `{spec, url, guide_type}`. Type is `"web"` or `"youtube"`. Stored in `guides` SQLite table.
2. **Scrape** — POST `/api/admin/guides/{id}/scrape`. `scraper.py` fetches page text (BeautifulSoup) or YouTube transcript (`youtube-transcript-api`). Up to 60 k chars stored per guide.
3. **Generate rulebook** — POST `/api/admin/rulebook/{spec}/generate-stream`. `llm_parser.py` batches all scraped guide content and optionally top-parse context, sends to Claude (`claude-sonnet-4-6`), receives structured JSON with `major_cooldowns[]` and `rules[]`. Saved to `generated_rulebooks` table and loaded into in-memory cache — live immediately with no restart.
4. **Manual rulebook** — PUT `/api/admin/rulebook/{spec}`. Persists hand-crafted JSON directly, bypassing the LLM. Must include `major_cooldowns` key.
5. **Top parses** — Single "Ingest All Bosses" button on the parses tab. Streams progress via `GET /api/admin/parses/ingest-all-stream/{spec}` (SSE). Always ingests top 10 per boss; **overwrites** existing samples for that spec+encounter on each run. Per-boss progress shown as a mini bar in the boss table. After ingestion, stored samples can be inspected per boss via the "View N" button (calls `GET /api/admin/parses/samples/{spec}/{encounter_id}`).

### Encounter selection
Encounters auto-load on page open. Filtered to:
- Current expansion only (auto-detected as the expansion with the first unique name in the WCL API response — WCL returns newest first).
- Excludes zones matching: `beta`, `ptr`, `mythic+`, `complete raids`, `delves`, `torghast`.

The encounter selector on the guides tab is used solely as optional context when generating a rulebook (passes top-parse samples from that boss to the LLM). The parses tab shows all current-expansion bosses in a table with sample counts and last-ingested timestamps — no manual encounter selection needed.

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

Key fields stored inside the `cooldown_data` JSON blob:

| Field | Level | Notes |
|---|---|---|
| `fight_duration_s` | top-level | Fight length in seconds |
| `cast_efficiency_pct` | top-level | % of fight time actively casting (1500ms baseline) |
| `cast_gap_list_ms` | top-level | Sorted list of all inter-cast gaps in ms — used to derive the p90 downtime threshold |
| `cooldowns[].cast_times_s` | per-CD | List of cast timestamps relative to fight start — used to compute avg/stddev first-cast and gap benchmarks |
| `cooldowns[].bl_offset_s` | per-CD | Seconds between the BL-window cast and BL start (negative = pre-cast) — used to benchmark BL timing |
| `cooldowns[].bl_aligned` | per-CD | Whether this parse cast the CD inside the BL window |

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
      "type": "cooldown_pairing|cd_hold|opener|rotation|positioning|aoe_switch",
      "priority": "critical|high|medium|low",
      "description": "Rule title shown in the UI",
      "condition": null,
      "action": "Prescriptive coaching text shown as remedy"
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

### Rule condition schema
Rules with a machine-readable `condition` object are evaluated by the engine. Supported kinds:

**`cast_without_prior`** — spell cast without a required companion within a time window:
```json
{
  "kind": "cast_without_prior",
  "spell_id": 185313, "spell_name": "Shadow Dance",
  "required_spell_id": 280719, "required_spell_name": "Secret Technique",
  "window_s": 5,
  "exception": { "context_spell_id": 121471, "context_window_s": 25, "position": "before" }
}
```

**`hold_cooldown_for_anchor`** — spell(s) used within the hold window before an anchor spell:
```json
{
  "kind": "hold_cooldown_for_anchor",
  "spell_ids": [185313, 280719], "spell_names": ["Shadow Dance", "Secret Technique"],
  "anchor_spell_id": 121471, "anchor_spell_name": "Shadow Blades",
  "hold_window_s": 15
}
```

Rules without a `condition` (or with `null`) are silently skipped by the engine.

## Analysis thresholds

All thresholds are now derived from top-parse data when samples exist for the encounter, with static fallbacks when they do not.

| Threshold | How it is derived | Fallback (no parse data) |
|---|---|---|
| First-cast delay | `avg_first_cast_s + 2σ` across top parses for that CD | 30 s |
| Gap between CD uses | `avg_gap_s + 2σ` across top parses for that CD | `cooldown × 1.2` |
| Downtime gap floor | p90 of pooled `cast_gap_list_ms` from all samples | 1500 ms |
| Efficiency warning band | `top_efficiency_stddev` (1σ below avg triggers warning, 2σ triggers critical) | flat −7% |
| BL timing comparison | `avg_bl_offset_s ± 2σ` across top parses for that CD | binary in/out-of-window |
| Comparison table green/red (uses/min) | `top_stddev_uses_per_min` per CD | ±0.05 uses/min |
| Comparison table green/red (first cast) | `top_stddev_first_cast_s` per CD | ±3 s |

### Remaining static values

| Value | Location | Notes |
|---|---|---|
| `bl_time - 30` to `bl_time + 55` BL detection window | `parses_analyzer.py` | Used when ingesting top parses to decide which CD cast counts as "BL-aligned". The 55s tail = BL duration (40s) + 15s grace. Not worth deriving from data since it defines what we measure. |

## Gap analysis vs original design documents

Source: `design-doc.md` (architecture blueprint) + `intial-research.md` (research brief).

### Built — core vision delivered

| Original goal | Status | Notes |
|---|---|---|
| Guide ingestion: scrape URLs → LLM → JSON rulebook | ✅ Done | Web + YouTube, streaming progress UI |
| Deterministic rules engine evaluating rulebook | ✅ Done | `cast_without_prior`, `hold_cooldown_for_anchor`; more kinds needed |
| Cooldown analysis: lost casts, BL alignment, opener delay, held CDs | ✅ Done | All four checks live |
| Top-parse comparison with kill-time normalization | ✅ Done | Uses/min replaces raw count |
| Cast efficiency benchmarked from real top-parse data | ✅ Done | Previously hardcoded at 95%, now sourced from samples |
| Prescriptive coaching output (not just raw data) | ✅ Done | Rule `action` field surfaces as remedy text in UI |
| Admin ingestion pipeline with URL persistence and encounter filter | ✅ Done | |
| All analysis thresholds derived from top-parse data | ✅ Done | First-cast delay, gap tolerance, downtime floor, efficiency band, BL timing — all data-derived with static fallbacks |
| Single-button all-boss parse ingestion | ✅ Done | SSE-streamed per-boss progress; always top 10; overwrites on re-run; boss overview table with sample counts and last-ingested dates |

### Gaps — from design-doc.md

| Original goal | Status | Notes |
|---|---|---|
| **Frontend**: Next.js + Tailwind | ❌ Not started | Currently vanilla JS in a single HTML file |
| **Database**: PostgreSQL | ❌ Not started | Currently SQLite; functional but not production-grade |
| **Positional data**: X/Y coordinates from WCL events | ❌ Not started | WCL does provide coordinates; would enable "died 15 yards from safe zone" checks |
| **Data pipeline**: DuckDB + dbt for analytical processing | ❌ Not started | Direct Python dict processing; fine at this scale |
| **Workflow 3**: VOD synchronization (Warcraft Recorder timestamps) | ❌ Not started | Design doc's primary differentiator — click a finding → scrub to that moment in VOD |
| **Discord webhook output**: post-pull summaries to a channel | ❌ Not started | |
| **In-game export**: MRT/NSRT notes with personalized cooldown scripts | ❌ Not started | |

### Gaps — from intial-research.md

| Research claim | Status | Notes |
|---|---|---|
| **Defensive cooldown audit**: flag deaths with unused defensives | ⏸ Skipped | Explicitly deferred by user; would need Damage Taken + inventory state events |
| **Healing efficiency**: raid cooldown timing vs incoming damage spikes | ❌ Not started | Healer-specific; needs raid-wide damage event aggregation |
| **Resource capping**: flag combo point / mana waste | ❌ Not started | Would need Resource events from WCL; highly spec-specific |
| **Roster composition suggestions**: flag suboptimal spec for encounter | ❌ Not started | Out of scope for single-player tooling |
| **WeakAura suggestions**: detect slow debuff reaction → suggest import | ❌ Not started | Research doc specific, very complex |
| **Encounter-phase context**: different CD expectations per phase | ⏸ Skipped | Deferred by user; needs fight-phase timeline from WCL |
| **Side-by-side VOD vs rank-1 player** | ❌ Not started | Depends on VOD sync (Workflow 3) |
| **Kill-time-adjusted personal cooldown script** (Lorrgs-style) | ⬜ Partial | Comparison table shows top-parse timing; a full scripted timeline is not generated |

### Architecture delta

The implementation diverged from the design doc in one deliberate place: the research doc assumed the LLM would generate **natural language feedback** from raw anomalies. Instead, the current design uses the LLM only at ingestion time (guide → rulebook) and the analyzer produces all feedback deterministically from the rulebook's `action` field. This is strictly better — output is reproducible, auditable, and fast.

Everything else not yet built falls into two buckets:
1. **Infrastructure** (Next.js, PostgreSQL, DuckDB/dbt) — won't change product behaviour, defer until scale demands it.
2. **New data sources** (positional data, damage taken, resource events, VOD sync) — each unlocks a new class of findings. VOD sync is the single highest-leverage unbuilt feature from the original vision.
