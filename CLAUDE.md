# warcraft-learner

A web-based diagnostic tool for Mythic WoW raiders. It fetches combat data from Warcraft Logs, evaluates it against spec-specific rulebooks (static or AI-generated from guides), and delivers prescriptive, coaching-style feedback with comparison against top-parse players.

## URL routing

All state is persisted in the URL as query parameters. This is required for all new features - every navigable state must be linkable and bookmarkable.

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
├── main.py              # FastAPI app - all routes (player API + admin API + pre-fight API)
├── store.py             # File-based storage - guides, rulebooks, parse samples, encounter bench
├── analyzer.py          # Rules engine - evaluates cast events against a rulebook
├── wcl_client.py        # Warcraft Logs OAuth2 + GraphQL client (handles pagination)
├── rulebook.py          # Static fallback cooldowns/defensives for 22+ DPS specs (deprecated - prefer rulebook JSON)
├── scraper.py           # Web (BeautifulSoup/lxml) + YouTube transcript scraping
├── parses_analyzer.py   # WCL characterRankings + per-parse cooldown timing analysis + gear extraction
├── analysis_utils.py    # Shared aggregation - cluster_burst_windows, aggregate_gear
├── static/
│   ├── index.html       # Post-raid player analyzer UI (vanilla JS)
│   ├── pre.html         # Pre-fight gear check UI (vanilla JS)
│   ├── live.html        # Live analysis UI - polls for new pulls during raid
│   └── admin.html       # Admin guide management UI (vanilla JS)
├── data/
│   └── specs/           # All persistent data - no SQLite
│       └── {Spec}/
│           ├── rulebook.json       # Generated rulebook (includes guide_count, saved_at metadata)
│           ├── guides.json         # Guide list WITH scraped content
│           ├── encounters.json     # Index: [{id, name, sample_count}]
│           ├── encounters/
│           │   └── {enc_id}.json  # Pre-computed bench data (thresholds, burst windows, gear, dtk)
│           └── parse_samples/
│               └── {enc_id}.json  # Raw parse samples - source of truth for bench files
├── scripts/
│   ├── ingest_parses.py       # CLI / GHA: ingest top WCL parses → files
│   └── scrape_guides.py       # CLI / GHA: add + scrape a guide → guides.json
├── .env                 # Secrets (gitignored)
├── .env.example         # Credential template
└── requirements.txt
```

**No SQLite.** All data is file-based under `data/specs/`. The server reads from pre-computed files at request time - no on-the-fly aggregation from raw samples. `store.py` owns all file I/O and the in-memory rulebook cache.

## Key flows

### Player analysis (`/api/analyze`)
1. Accepts a WCL report URL + fight ID + player actor ID.
2. Fetches `playerDetails` for the fight to resolve the proper spec+class string (`SubtletyRogue`). WCL changed `actor.subType` in Midnight to return only the class name - `playerDetails` is the reliable source.
3. Fetches `Casts` and `Buffs` events for that player via `wcl_client.py`.
4. `analyzer.py` checks per cooldown:
   - **Lost cooldown casts** - `expected = 1 + floor(fight_duration / cd_cooldown)` vs actual.
   - **Bloodlust alignment** - flags any major CD (where `align_with_bloodlust: true`) whose BL-window cast timing is >2σ from the top-parse average offset. Falls back to a binary in/out-of-window check when no parse data exists.
   - **First-cast delay** - flags opener CDs whose first cast is >2σ later than the top-parse `avg_first_cast_s`. Falls back to a flat 30 s threshold when no parse data exists.
   - **Cooldown held past reset** - gap between casts is >2σ above the top-parse `avg_gap_s` for that CD. Falls back to `cooldown × 1.2` when no parse data exists.
   - **Hold suggestions** - per-cast-index check against `hold_targets` from top parses. If ≥40% of top parsers delay a specific cast past on-cooldown time, and the player uses it >max(stddev, 15s) earlier, emits a `severity: "info"` / `category: "hold_suggestion"` finding with target time.
   - **Cast efficiency** - compares player downtime (gaps above the p90 of top-parse inter-cast gaps) against the top-parse average. Warning band uses top-parse stddev rather than a fixed percentage.
   - **Success** - emits a `severity: "success"` finding if a CD had zero issues.
5. **Rule engine** - after cooldown analysis, evaluates every `rules[]` entry that has a machine-readable `condition` object. Two supported kinds:
   - `cast_without_prior` - flags each cast of `spell_id` that lacks a paired cast of `required_spell_id` within `window_s`. Optional `exception` exempts casts during a context spell window (e.g. 2nd Dance inside Shadow Blades).
   - `hold_cooldown_for_anchor` - flags casts of `spell_ids` within `hold_window_s` before each non-opener cast of `anchor_spell_id`.
   Rule findings include a `details.remedy` field with the rule's `action` text, rendered as a coaching callout in the UI.
6. Response includes: **Needs Improvement** (critical/warning), **Timing Suggestions** (info/hold_suggestion), and **Doing Well** (success). Also includes `rulebook_source` ("generated", "static", or "none") shown under the player name.
7. If parse samples exist for the fight's encounter, a **vs Top N Parses** comparison table is appended. Uses **uses-per-minute** (not raw counts) to normalize across kill-time differences between the player and top performers. A **Burst Windows** card shows the top recurring 8s damage spikes across top parses with the CDs active in them. Windows beyond the player's fight duration are shown in a dimmed "Not reached" state rather than "No data".
8. The response includes `ability_icons` - a `{spell_id: {icon, name}}` map extracted from `masterData.abilities` in the report. The frontend seeds its icon cache from this data. WCL removed `gameData.spell()` so this is now the only reliable source of spell icons and names for report abilities.
9. Cooldown rules come from the **dynamic rulebook** if one exists (loaded from `data/specs/{spec}/rulebook.json`

### Ingestion pipeline (`/admin`)
1. **Add guides** - POST `/api/admin/guides` with `{spec, url, guide_type}`. Type is `"web"`, `"youtube"`, or `"simc"`. GitHub blob URLs are auto-converted to raw.githubusercontent.com. Up to 60 k chars stored per guide.
2. **Scrape** - POST `/api/admin/guides/{id}/scrape`. `scraper.py` fetches page text (BeautifulSoup), YouTube transcript (`youtube-transcript-api`), or raw file (GitHub/SimC APL).
3. **Copy AI Prompt** - GET `/api/admin/guides/{spec}/prompt`. Assembles the skill file (`prompts/rulebook_skill.md`) with all scraped guide content into a ready-to-paste prompt. No LLM API call - the user pastes into their own LLM.
4. **Save AI output** - PUT `/api/admin/rulebook/{spec}`. Client-side schema validation runs first (checks for `spell_id` on every cooldown, etc.); then persists JSON to `data/specs/{spec}/rulebook.json` and live-loads into in-memory cache.
5. **Top parses** - Single "Ingest All Bosses" button on the parses tab. Streams progress via `GET /api/admin/parses/ingest-all-stream/{spec}` (SSE). Always ingests top 10 per boss; **overwrites** existing samples for that spec+encounter on each run. Each parse now also stores:
   - `cooldowns[].hold_windows` - per-CD list of casts delayed >8s past on-cooldown time
   - `cooldowns[].cast_pattern` - "hold" or "on_cooldown"
   - `burst_windows` - top 4 non-overlapping 8s damage peaks with active CDs
   Per-boss progress shown as a mini bar in the boss table. After ingestion, samples can be inspected per boss via "View N" (shows cast_pattern badges, hold counts, and burst window breakdown).

### Pre-fight gear check (`/pre`)
1. User enters a WCL or Armory character URL. `GET /api/pre/char-lookup?url=` parses the URL, queries `characterData.character` on WCL, and returns `{name, spec, server, region}`.
2. User selects an encounter from the dropdown (same filtered encounter list as the parses tab).
3. Three parallel requests fire on encounter change:
   - `GET /api/pre/char-gear?name&server&region&encounter_id` - queries `characterData.character.encounterRankings(includeCombatantInfo: true)` and extracts gear/talents from the player's most recent ranked kill.
   - `GET /api/pre/gear-stats/{spec}/{encounter_id}` - returns pre-aggregated talent builds, trinket usage, and enchant usage from the encounter bench file.
   - `GET /api/pre/brief?spec&encounter_id` - returns the cooldown brief text.
4. Three cards rendered client-side:
   - **Talents** - compares player's `v2:` talent fingerprint against the distribution from top parses.
   - **Trinkets** - per-slot (12 = Trinket 1, 13 = Trinket 2) comparison with top-parse usage rates.
   - **Enchants** - per-slot comparison; missing enchants on high-consensus slots (≥70% of top parsers) flagged as warnings.

### Encounter selection
Encounters auto-load on page open. Filtered to:
- Current expansion only (auto-detected as the expansion with the first unique name in the WCL API response - WCL returns newest first).
- Excludes zones matching: `beta`, `ptr`, `mythic+`, `complete raids`, `delves`, `torghast`.

The parses tab shows all current-expansion bosses in a table with sample counts and last-ingested timestamps - no manual encounter selection needed.

## Data models

### `guides.json` (`data/specs/{spec}/guides.json`)
List of guide objects. Includes scraped content (used server-side for prompt generation).

| field | notes |
|---|---|
| id | Auto-incrementing integer - max existing + 1 on add |
| spec | WCL actor subType, e.g. `SubtletyRogue` |
| url | Source URL |
| guide_type | `web`, `youtube`, or `simc` |
| content | Scraped text (up to 60 k chars) |
| status | `pending` → `scraped` → `error` |

### `rulebook.json` (`data/specs/{spec}/rulebook.json`)
Generated rulebook stored with metadata. Loaded into the in-memory cache at startup.

Extra top-level fields added by `store.save_rulebook`: `guide_count`, `saved_at`.

### `parse_samples/{enc_id}.json` (`data/specs/{spec}/parse_samples/{enc_id}.json`)
List of raw parse samples for an encounter. Written during ingestion; read only by `sync_encounter_file` to recompute bench data.

Stores per-fight cooldown timing summaries for top WCL performers.

Key fields stored inside the `cooldown_data` JSON blob:

| Field | Level | Notes |
|---|---|---|
| `fight_duration_s` | top-level | Fight length in seconds |
| `cast_efficiency_pct` | top-level | % of fight time actively casting (1500ms baseline) |
| `cast_gap_list_ms` | top-level | Sorted list of all inter-cast gaps in ms - used to derive the p90 downtime threshold |
| `cooldowns[].cast_times_s` | per-CD | List of cast timestamps relative to fight start - used to compute avg/stddev first-cast and gap benchmarks |
| `cooldowns[].bl_offset_s` | per-CD | Seconds between the BL-window cast and BL start (negative = pre-cast) - used to benchmark BL timing |
| `cooldowns[].bl_aligned` | per-CD | Whether this parse cast the CD inside the BL window |
| `cooldowns[].hold_windows` | per-CD | List of `{cast_index, expected_s, actual_s, hold_amount_s}` for casts delayed >8s past on-cooldown time |
| `cooldowns[].cast_pattern` | per-CD | `"hold"` if any cast was held >8s; `"on_cooldown"` otherwise |
| `burst_windows` | top-level | List of `{time_s, pct_of_total, active_cds}` - top 4 non-overlapping 8s damage peaks |
| `talent_key` | top-level | `v2:`-prefixed sorted talent node IDs extracted from the parser's `encounterRankings` (Midnight format) |
| `trinkets` | top-level | List of `{slot, id, name}` for trinket slots 12 and 13 |
| `enchants` | top-level | List of `{slot, id, name}` for all gear slots with a `permanentEnchant` |

### Rulebook JSON schema

**Design requirement**: All spec-specific spell IDs (cooldowns and defensives) **must** come from the generated rulebook JSON, not from static dicts. This keeps the tool accurate across WoW patches and expansions without code changes.

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
  "defensives": [
    {
      "name": "Cloak of Shadows",
      "spell_id": 31224,
      "cooldown": 120,
      "duration": 5,
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

## WCL gear API quirks

These are non-obvious and have caused bugs before - read before touching gear extraction.

| Quirk | Detail |
|---|---|
| **Gear array is positionally indexed** | WCL returns gear as a bare array; the array index (0-based) IS the slot number. There is no `slot` field on each item. |
| **Weapon slots shifted in Midnight** | In Midnight-era content the gear array has 17 entries (0–16). Weapons land at index 15 (Main Hand) and 16 (Off Hand). Index 14 is Back/Cloak (no enchant in modern WoW). Earlier code assumed 14/15 - this was wrong. |
| **Trinket slots are 12 and 13** | Confirmed from both `characterRankings` and `encounterRankings` responses. |
| **`permanentEnchant` is a string** | WCL returns it as a string even though it's a numeric ID. Cast with `int()`. `permanentEnchantName` is never populated. Enchant names are resolved at request time via `wcl.get_enchant_names()` which uses `gameData.enchant(id)` - the only WCL API that maps enchant IDs to names. |
| **Two incompatible talent formats** | `characterRankings` returns the old format (`{talentID: N, points: P}` list) → stored as `v1:` key. `encounterRankings` returns the Midnight format (`{class: {row: [{node: {nodeId: N}}]}, spec: {...}}` dict) → stored as `v2:` key. The ID spaces are genuinely different (v1: IDs are 112 000+; v2: IDs are 90 000–110 000). They cannot be compared directly. |
| **Solving the talent format problem** | During parse ingestion, `fetch_top_rankings` fires a parallel `encounterRankings` query per ranked player to obtain their `v2:` talent key. This overwrites the `v1:` key that would otherwise come from the `characterRankings` entry, ensuring top-parse talent keys use the same format as the player's gear (also fetched via `encounterRankings`). |
| **`server.region` may be a string** | In the `characterRankings` JSON blob, `server.region` is sometimes a plain string (`"EU"`) rather than an object (`{slug: "eu"}`). The `_region_slug()` helper in `parses_analyzer.py` handles both forms. |

## External APIs

| API | Auth | Used for |
|---|---|---|
| Warcraft Logs v2 (GraphQL) | OAuth2 client credentials | Report data, fight events, character rankings, playerDetails |
| YouTube (no key) | None | Transcript extraction via `youtube-transcript-api` |

## Spec naming convention
WCL `actor.subType` historically returned `{Spec}{Class}` CamelCase (e.g. `SubtletyRogue`). In Midnight this changed to class-only (`Rogue`). The codebase now resolves spec via `playerDetails(fightIDs: [...])` which still returns the full spec info. The `_build_spec_map(report)` helper in `main.py` handles the conversion.

### Rule condition schema
Rules with a machine-readable `condition` object are evaluated by the engine. Supported kinds:

**`cast_without_prior`** - spell cast without a required companion within a time window:
```json
{
  "kind": "cast_without_prior",
  "spell_id": 185313, "spell_name": "Shadow Dance",
  "required_spell_id": 280719, "required_spell_name": "Secret Technique",
  "window_s": 5,
  "exception": { "context_spell_id": 121471, "context_window_s": 25, "position": "before" }
}
```

**`hold_cooldown_for_anchor`** - spell(s) used within the hold window before an anchor spell:
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
| Hold suggestion trigger | cast index where ≥40% of samples have `hold_amount_s > 8s`; fires if player casts >max(σ, 15s) before median hold time | no suggestion emitted |
| Downtime gap floor | p90 of pooled `cast_gap_list_ms` from all samples | 1500 ms |
| Efficiency warning band | `top_efficiency_stddev` (1σ below avg triggers warning, 2σ triggers critical) | flat −7% |
| BL timing comparison | `avg_bl_offset_s ± 2σ` across top parses for that CD | binary in/out-of-window |
| Burst window clustering | windows within 15s of each other merged; ≥35% of samples required to surface | n/a |
| Comparison table green/red (uses/min) | `top_stddev_uses_per_min` per CD | ±0.05 uses/min |
| Comparison table green/red (first cast) | `top_stddev_first_cast_s` per CD | ±3 s |

### Burst window definition

Burst windows are computed in two layers.

**Per-parse** (`_find_burst_windows` in `parses_analyzer.py`):
1. Collect all `type: "damage"` events with `amount + absorbed > 0`.
2. Slide an **8-second window** across every event timestamp; for each start position, sum all damage whose timestamp falls within `[ts, ts + 8000ms]`.
3. Keep **all non-overlapping** windows above a significance threshold (≥ 3% of total fight damage). Two windows must be ≥8s apart to both qualify.
4. Each window stores: `time_s` (relative to fight start), `pct_of_total` (fraction of the parse's total damage), `window_damage`, and a per-ability breakdown (top 6 abilities by damage, each with their fraction of window damage).

**Across parses** (`cluster_burst_windows` in `analysis_utils.py`):
1. Pool all per-parse windows from every ingested sample.
2. Group windows whose `time_s` falls within **15s of the running cluster median** — greedy, first-fit.
3. Discard clusters present in fewer than **max(2, 35% of samples)** parses.
4. For surviving clusters, surface CDs active in ≥50% of member parses, and abilities appearing in ≥50% of member parses.
5. Per-ability breakdown includes `avg_pct`, `min_pct`, `max_pct` (candle range) across member parses.

### Remaining static values

| Value | Location | Notes |
|---|---|---|
| `bl_time - 30` to `bl_time + 55` BL detection window | `parses_analyzer.py` | Used when ingesting top parses to decide which CD cast counts as "BL-aligned". The 55s tail = BL duration (40s) + 15s grace. Not worth deriving from data since it defines what we measure. |

## Gap analysis vs original design documents

Source: `design-doc.md` (architecture blueprint) + `intial-research.md` (research brief).

### Built - core vision delivered

| Original goal | Status | Notes |
|---|---|---|
| Guide ingestion: scrape URLs → LLM → JSON rulebook | ✅ Done | Web + YouTube + SimC APL (GitHub); copy-prompt / paste-back workflow replaces direct LLM API |
| Deterministic rules engine evaluating rulebook | ✅ Done | `cast_without_prior`, `hold_cooldown_for_anchor`; more kinds needed |
| Cooldown analysis: lost casts, BL alignment, opener delay, held CDs | ✅ Done | All four checks live |
| Top-parse comparison with kill-time normalization | ✅ Done | Uses/min replaces raw count |
| Cast efficiency benchmarked from real top-parse data | ✅ Done | Previously hardcoded at 95%, now sourced from samples |
| Prescriptive coaching output (not just raw data) | ✅ Done | Rule `action` field surfaces as remedy text in UI |
| Admin ingestion pipeline with URL persistence and encounter filter | ✅ Done | |
| All analysis thresholds derived from top-parse data | ✅ Done | First-cast delay, gap tolerance, downtime floor, efficiency band, BL timing - all data-derived with static fallbacks |
| Single-button all-boss parse ingestion | ✅ Done | SSE-streamed per-boss progress; always top 10; overwrites on re-run; boss overview table with sample counts and last-ingested dates |
| Hold pattern detection | ✅ Done | Per-CD-cast-index hold targets aggregated from top parses; "Timing Suggestions" section in UI |
| AoE burst window analysis | ✅ Done | Variable-count 8s damage peaks (all windows > 3% of total damage); clustered across parses; candle diagrams per ability in detail breakdown; "Burst Windows" card in UI |
| Per-fight player filtering | ✅ Done | `friendlyPlayers` from WCL per fight; player dropdown updates on fight change |
| Fight dropdown attempt numbering | ✅ Done | Wipes show `✗ #N` per-boss; kills show `✓` |
| Pre-fight gear check | ✅ Done | `/pre` page; character URL input; talents/trinkets/enchants vs top-parse aggregates; enchant names resolved live via `gameData.enchant(id)` - no hardcoding |
| Defensive cooldown analysis | ✅ Done | Defensives from rulebook; per-defensive timing analysis (lost/held/hold suggestions matching offensive cd-card style); defensive windows (significant incoming damage spikes with candle diagrams) |
| GitHub Actions ingestion pipeline | ✅ Done | `.github/workflows/ingest-parses.yml` (daily schedule + manual); `scripts/ingest_parses.py` and `scripts/scrape_guides.py` work identically locally |
| File-based storage - no SQLite | ✅ Done | `store.py` replaces `db.py`; all data in `data/specs/`; guides stored WITH content; parse samples in `parse_samples/{enc_id}.json`; encounter bench files pre-computed with full aggregation; GHA commits `data/specs/**` only |
| Pre-computed encounter bench files | ✅ Done | `data/specs/{Spec}/encounters/{enc_id}.json` written after each boss ingestion; contains per-CD thresholds (with sample_count), burst windows, gear aggregates, defensive summary, and top_dtk_comparison; `analysis_utils.py` holds shared clustering/aggregation logic |

### Gaps - from design-doc.md

| Original goal | Status | Notes |
|---|---|---|
| **Frontend**: Next.js + Tailwind | ❌ Not started | Currently vanilla JS in a single HTML file |
| **Database**: PostgreSQL | ❌ Not started | Currently file-based JSON; functional at this scale |
| **Positional data**: X/Y coordinates from WCL events | ❌ Not started | WCL does provide coordinates; would enable "died 15 yards from safe zone" checks |
| **Data pipeline**: DuckDB + dbt for analytical processing | ❌ Not started | Direct Python dict processing; fine at this scale |
| **Workflow 3**: VOD synchronization (Warcraft Recorder timestamps) | ❌ Not started | Design doc's primary differentiator - click a finding → scrub to that moment in VOD |
| **Discord webhook output**: post-pull summaries to a channel | ❌ Not started | |
| **In-game export**: MRT/NSRT notes with personalized cooldown scripts | ❌ Not started | |

### Gaps - from intial-research.md

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

The implementation diverged from the design doc in one deliberate place: the research doc assumed the LLM would generate **natural language feedback** from raw anomalies. Instead, the current design uses the LLM only at ingestion time (guide → rulebook) and the analyzer produces all feedback deterministically from the rulebook's `action` field. This is strictly better - output is reproducible, auditable, and fast.

Everything else not yet built falls into two buckets:
1. **Infrastructure** (Next.js, PostgreSQL, DuckDB/dbt) - won't change product behaviour, defer until scale demands it.
2. **New data sources** (positional data, damage taken, resource events, VOD sync) - each unlocks a new class of findings. VOD sync is the single highest-leverage unbuilt feature from the original vision.
