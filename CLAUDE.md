# warcraft-learner

A web-based diagnostic tool for Mythic WoW raiders. It fetches combat data from Warcraft Logs, evaluates it against spec-specific rulebooks (AI-generated from guides), and delivers prescriptive, coaching-style feedback with comparison against top-parse players.

The app is a **fully static Angular SPA** deployed on GitHub Pages. There is no backend server. All analysis runs client-side. WCL is queried directly from the browser via PKCE OAuth2.

## Branding & naming

- **The product name is always `warcraft-learner`** - lowercase, hyphenated, exactly that casing. Never "Warcraft Learner", "WarcraftLearner", or any other variant. This applies to the page `<title>`, nav wordmark, CLI banners, READMEs, and any new user-facing copy.
- **Do not confuse it with "Warcraft Logs"** (a.k.a. WCL) - that is the external data provider, a separate product. Leave "Warcraft Logs" / "WCL" strings as-is; only our own app name is normalized to `warcraft-learner`.
- **Logo / favicon** - a gold shield with an ascending bar chart (martial "Warcraft" + the analytics/"learner" angle). Single source of truth: `frontend/public/favicon.svg`. It also drives the `.ico` and the nav-bar mark.
  - `favicon.ico` is **regenerated from** `favicon.svg` (16/32/48px) - do not hand-edit the binary. Regen with `sharp` + `png-to-ico` (rasterize the SVG at high density, resize to each size, pack into one `.ico`).
  - `index.html` references the SVG favicon first (`type="image/svg+xml"`) with the `.ico` as legacy fallback.
  - The nav-bar logo (`shared/components/page-nav`) is the **same artwork inlined as SVG** in the template, so it themes with CSS vars. Set its fills via SCSS classes (`fill: var(--gold)` / `var(--surface)`) - **not** `fill="var(--…)"` presentation attributes, which browsers don't reliably honor.
  - Brand gold is `--gold` (`#e5cc80`) - the Warcraft Logs 100-parse ("Astounding") gold, chosen deliberately since the tool benchmarks against top parses. The favicon's literal hex colors must track the design tokens in `styles.scss`.

## Writing style

- **Never use em-dashes (U+2014) or en-dashes (U+2013)** anywhere - not in docs, code comments, commit messages, UI copy, or generated output. Also avoid the Unicode minus (U+2212). Use a plain ASCII hyphen (`-`) for ranges and parenthetical asides, or rephrase. This applies to every file in the repo and any text the tooling emits.

## URL routing

All state is persisted in URL query parameters. Every navigable state must be linkable and bookmarkable.

### Player page (`/`)
| Param | Description |
|---|---|
| `report` | WCL report code (e.g. `grBQ3vTHXAtPa4JK`) |
| `fight` | Fight actor ID |
| `player` | Player actor ID |

Example: `/?report=grBQ3vTHXAtPa4JK&fight=1&player=10`

If all three params are present on load, the page auto-fetches and runs analysis immediately.

### Pre-fight page (`/pre`)
Character URL input + encounter dropdown; no persistent URL state beyond navigation.

## Architecture

```
warcraft-learner/
├── frontend/                   # The entire application - Angular 22
│   ├── src/app/
│   │   ├── pages/
│   │   │   ├── post-raid/      # Main player analyzer (/)
│   │   │   ├── pre-fight/      # Pre-fight gear check (/pre)
│   │   │   ├── live/           # Live analysis - polls for new pulls (/live)
│   │   │   └── callback/       # OAuth2 PKCE callback (/callback)
│   │   └── core/
│   │       ├── services/
│   │       │   ├── analysis-engine.ts  # Client-side rules engine
│   │       │   ├── encounter.ts        # Loads static JSON bench/rulebook files
│   │       │   ├── wcl-api.ts          # WCL GraphQL queries (direct, PKCE token)
│   │       │   └── wcl-auth.ts         # PKCE OAuth2 flow
│   │       └── models/                 # TypeScript interfaces
│   ├── public/
│   │   └── data/specs/         # Static data files - served as assets
│   │       └── {Spec}/
│   │           ├── rulebook.json       # AI-generated rulebook
│   │           ├── guides.json         # Guide list with scraped content
│   │           ├── encounters.json     # Index: [{id, name, sample_count}]
│   │           ├── encounters/
│   │           │   └── {enc_id}.json  # Pre-computed bench data
│   │           └── parse_samples/
│   │               └── {enc_id}.json  # Raw parse samples
│   └── scripts/                # Node.js CLI tools (no server needed)
│       ├── ingest.mjs   # Fetch top WCL parses → write bench + sample files
│       ├── admin.mjs    # Rulebook management (build prompt, save AI output)
│       └── scrape.mjs   # Add + scrape guide URLs
├── prompts/
│   └── rulebook_skill.md       # LLM prompt template for rulebook generation
├── .github/workflows/
│   ├── deploy-pages.yml   # Build Angular --base-href /warcraft-learner/ → GitHub Pages
│   └── ingest-parses.yml  # Daily + manual: runs ingest.mjs, commits data/specs/**
├── .env                   # WCL_CLIENT_ID + WCL_CLIENT_SECRET (gitignored)
└── .env.example
```

**Data location**: `frontend/public/data/specs/` - Angular's `public/` directory serves these at `/data/specs/` in both the dev server and the built app. The dev server also has a `proxy.conf.json` wired in (stale - points to a `localhost:8000` that no longer exists; can be removed).

**Build output** (`static/angular/`) is gitignored - rebuilt by `deploy-pages.yml` on every push to `main`.

## Key flows

### Player analysis (client-side, `analysis-engine.ts`)
1. Accepts a WCL report code + fight ID + player actor ID.
2. Fetches `playerDetails` to resolve spec (`SubtletyRogue`). WCL changed `actor.subType` in Midnight to return class-only - `playerDetails` is the reliable source.
3. Fetches `Casts`, `Buffs`, `DamageDone`, and `DamageTaken` events directly from WCL (PKCE token).
4. Loads static bench data from `/data/specs/{spec}/encounters/{enc_id}.json` and rulebook from `/data/specs/{spec}/rulebook.json`.
5. `analysis-engine.ts` checks per offensive cooldown:
   - **Lost casts** - `expected = 1 + floor(fight_duration / cd_cooldown)` vs actual.
   - **Bloodlust alignment** - flags major CDs whose BL-window cast timing is >2σ from top-parse average. Falls back to binary in/out-of-window check.
   - **First-cast delay** - flags opener CDs whose first cast is >2σ later than `avg_first_cast_s`. Skipped when no bench.
   - **Held past reset** - gap between casts >2σ above `avg_gap_s`. Skipped when no bench.
   - **Hold suggestions** - cast index where ≥40% of top parsers delay >8s past on-cooldown time; fires if player casts >σ before median hold time.
   - **Cast efficiency** - player downtime (gaps above p90 of top-parse inter-cast gaps) vs top-parse average.
   - **Success** - emitted when a CD has zero issues.
6. **Rule engine** - evaluates `rules[]` entries with a machine-readable `condition`. Two kinds:
   - `cast_without_prior` - spell cast without a required companion within `window_s`.
   - `hold_cooldown_for_anchor` - spell(s) used within `hold_window_s` before an anchor spell.
   Rule findings include a `details.remedy` field (the rule's `action` text) shown as a coaching callout.
7. **Defensive analysis** mirrors offensive: `_analyzeDefensiveFindings` produces lost/held/hold-suggestion findings per defensive. Defensive windows are **buff-window-centric** - each window = when the defensive was actually active (apply→remove), compared against top-parse averages.
8. Response sections: **Needs Improvement** (critical/warning), **Timing Suggestions** (info/hold_suggestion), **Doing Well** (success).
9. **Burst Windows** card shows top recurring damage windows from top parses (CD-cast-centric, variable length). **Defensive Windows** shows when top parsers used each defensive and how much damage they mitigated.
10. Ability icons come from `masterData.abilities` in the WCL report response - the only reliable source since WCL removed `gameData.spell()`.

### Ingestion (`npm run ingest`)
Runs `frontend/scripts/ingest.mjs`. Also runs as `ingest-parses.yml` GHA daily + manually.

1. Authenticates to WCL with client credentials (from `.env` - server-side secret, only used in CLI/GHA, never in the browser).
2. Queries `characterRankings` for each boss to find top 10 parses.
3. Fetches `Casts`, `Buffs`, `DamageDone`, `DamageTaken` per parse.
4. Computes per-parse: CD timing summaries, `burst_windows` (CD-cast-centric), `defensive_windows` (buff-window-centric), talent key, trinkets, enchants.
5. Writes raw samples → `parse_samples/{enc_id}.json`.
6. Aggregates across parses → `encounters/{enc_id}.json` (bench file: per-CD thresholds, clustered burst/defensive windows, gear aggregates).
7. Updates `encounters.json` index.

GHA commits `frontend/public/data/specs/**`, which triggers `deploy-pages.yml` to rebuild and redeploy.

> **Keep data shapes in sync.** The bench/sample shape that `ingest.mjs` writes is mirrored in the frontend consumers - `core/models/analysis.models.ts`, `core/models/encounter.models.ts`, `core/services/analysis-core.ts` - and documented in the **Data models** section below. **Whenever you change what ingestion emits (add/remove/rename a field), check and update all of these together, plus the rulebook skill + schema** (`prompts/rulebook_skill.md`, `prompts/rulebook.schema.json`) since ingestion consumes the rulebook (`duration`, `spell_id`s). Dropping a feature end-to-end means removing it from ingestion **and** every consumer above. Already-committed JSON under `data/specs/**` keeps stale fields until the next re-ingest - harmless, since consumers ignore unknown fields.

### Rulebook management (`npm run admin` / `npm run scrape`)
No web UI for admin. Everything is CLI.

1. **Add + scrape guides** - `npm run scrape`: add guide URLs, scrape content (web/YouTube/SimC APL), store in `guides.json`.
2. **Build AI prompt** - `npm run admin` → "Copy prompt": assembles `prompts/rulebook_skill.md` + all scraped guide content into a clipboard-ready prompt.
3. **Save rulebook** - paste AI output → `npm run admin` → "Save rulebook": writes to `rulebook.json`. No validation server needed - the CLI validates schema directly.

### Pre-fight gear check (`/pre`)
Entirely client-side. No backend calls.

1. User enters a character name/server/region (or WCL character URL).
2. `wcl-api.ts` queries `characterData.character.encounterRankings(includeCombatantInfo: true)` directly on WCL for the selected encounter - extracts gear, talents from the player's most recent ranked kill.
3. Bench data (talent distributions, trinket usage, enchant usage) loaded from static `/data/specs/{spec}/encounters/{enc_id}.json`.
4. Three cards rendered client-side:
   - **Talents** - compares player's `v2:` talent fingerprint against top-parse distribution.
   - **Trinkets** - per-slot (12 = Trinket 1, 13 = Trinket 2) comparison.
   - **Enchants** - per-slot; missing enchants on high-consensus slots (≥70% of top parsers) flagged as warnings.

### Encounter selection
Encounters loaded from `/data/specs/{spec}/encounters.json` (static file). Filtered client-side to:
- Current expansion only (first unique expansion name in WCL API response - WCL returns newest first).
- Excludes zones matching: `beta`, `ptr`, `mythic+`, `complete raids`, `delves`, `torghast`.

## Data models

### `guides.json` (`frontend/public/data/specs/{spec}/guides.json`)
| field | notes |
|---|---|
| id | Auto-incrementing integer |
| spec | WCL spec name, e.g. `SubtletyRogue` |
| url | Source URL |
| guide_type | `web`, `youtube`, or `simc` |
| content | Scraped text (up to 60k chars) |
| status | `pending` → `scraped` → `error` |

### `rulebook.json` (`frontend/public/data/specs/{spec}/rulebook.json`)
AI-generated rulebook. Extra top-level fields added on save: `guide_count`, `saved_at`.

### `parse_samples/{enc_id}.json`
List of raw parse samples. Source of truth for bench files.

| Field | Level | Notes |
|---|---|---|
| `fight_duration_s` | top-level | Fight length in seconds |
| `cast_efficiency_pct` | top-level | % of fight time actively casting |
| `cast_gap_list_ms` | top-level | Sorted inter-cast gaps - used to derive p90 downtime threshold |
| `cooldowns[].cast_times_s` | per-CD | Cast timestamps relative to fight start |
| `cooldowns[].bl_offset_s` | per-CD | Seconds between BL-window cast and BL start |
| `cooldowns[].bl_aligned` | per-CD | Whether this parse cast the CD inside BL window |
| `cooldowns[].hold_windows` | per-CD | `{cast_index, expected_s, actual_s, hold_amount_s}` for casts delayed >8s |
| `cooldowns[].cast_pattern` | per-CD | `"hold"` or `"on_cooldown"` |
| `burst_windows` | top-level | Variable-count, variable-length windows anchored to CD cast times |
| `defensive_windows` | top-level | Per-defensive buff windows with absolute `window_damage` (taken) + `pct_of_total` |
| `talent_key` | top-level | `v2:`-prefixed sorted talent node IDs (Midnight format) |
| `trinkets` | top-level | `{slot, id, name}` for slots 12 and 13 |
| `enchants` | top-level | `{slot, id, name}` for all enchanted slots |

### Rulebook JSON schema

All spell IDs **must** come from the rulebook - never hardcode spec-specific IDs.

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

### Rule condition schema

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

**`hold_cooldown_for_anchor`** - spell(s) used within hold window before an anchor spell:
```json
{
  "kind": "hold_cooldown_for_anchor",
  "spell_ids": [185313, 280719], "spell_names": ["Shadow Dance", "Secret Technique"],
  "anchor_spell_id": 121471, "anchor_spell_name": "Shadow Blades",
  "hold_window_s": 15
}
```

Rules without a `condition` (or `null`) are silently skipped.

## WCL API quirks

Non-obvious things that have caused bugs - read before touching gear extraction or spec resolution.

| Quirk | Detail |
|---|---|
| **`actor.subType` changed in Midnight** | Now returns class-only (`Rogue`). Use `playerDetails(fightIDs:[...])` to get full spec info. `_build_spec_map()` in `analysis-engine.ts` handles the conversion. |
| **Gear array is positionally indexed** | WCL returns gear as a bare array; the array index (0-based) IS the slot number. No `slot` field. |
| **Weapon slots shifted in Midnight** | Gear array has 17 entries (0-16). Weapons at index 15 (MH) and 16 (OH). Index 14 is Back/Cloak. |
| **Trinket slots are 12 and 13** | Confirmed from `encounterRankings` responses. |
| **`permanentEnchant` is a string** | Numeric ID returned as string. `permanentEnchantName` is never populated. Enchant names resolved via `gameData.enchant(id)` in `ingest.mjs`. |
| **Two incompatible talent formats** | `characterRankings` → old format (`{talentID, points}` list) → `v1:` key. `encounterRankings` → Midnight format (nested `nodeId` dict) → `v2:` key. ID spaces are incompatible; cannot compare directly. |
| **Solving the talent format problem** | `ingest.mjs` fires a parallel `encounterRankings` query per ranked player to get the `v2:` talent key, overwriting the `v1:` key from `characterRankings`. |
| **`server.region` may be a string** | In `characterRankings` JSON blob, `server.region` is sometimes `"EU"` (string) rather than `{slug: "eu"}`. Handle both forms. |
| **`gameData.spell()` was removed** | Spell icons and names must come from `masterData.abilities` in the report response. |

## External APIs

| API | Auth | Where used |
|---|---|---|
| Warcraft Logs v2 (GraphQL, `/api/v2/user`) | PKCE OAuth2 (browser) | Report events, character rankings, gear lookup |
| Warcraft Logs v2 (GraphQL, `/api/v2/client`) | Client credentials (CLI/GHA only, never browser) | `ingest.mjs` parse fetching |

## Analysis thresholds

| Threshold | Derived from | Fallback |
|---|---|---|
| First-cast delay | `avg_first_cast_s + 2σ` across top parses | None - finding skipped without bench |
| Gap between CD uses | `avg_gap_s + 2σ` across top parses | None - finding skipped without bench |
| Hold suggestion trigger | Cast index where ≥40% of samples have `hold_amount_s > 8s`; fires if player casts >σ before median | None emitted |
| Downtime gap floor | p90 of pooled `cast_gap_list_ms` | None - finding skipped without bench (ingest writes 1500ms only if zero gaps) |
| Efficiency warning band | <1σ below Top average → warning; deeper → critical | None - finding skipped without bench |
| BL timing | `avg_bl_offset_s ± 2σ` | binary in/out-of-window |

> **Stddev is always emitted by ingestion alongside its mean** (`stdev()` returns 0 for a single sample), so the per-CD/defensive `stddev_*` fields are non-null whenever the matching mean is. The analysis engine relies on the bench value directly - there is no hardcoded-σ secondary fallback. By design, once every spec/encounter has bench data, the "skipped without bench" cases never occur in practice.
| Burst window clustering | windows within 15s merged; ≥35% of samples required | n/a |
| Defensive window clustering | per-defensive grouping, within 20s merged; ≥35% of samples required | n/a |
| Comparison table (uses/min) | `top_stddev_uses_per_min` per CD | ±0.05 |
| Comparison table (first cast) | `top_stddev_first_cast_s` per CD | ±3s |

### Burst window definition (`ingest.mjs` → `findBurstWindows` / `clusterBurstWindows`)

**Per-parse**:
1. Build candidate windows from CD cast times × CD durations (from rulebook `duration`).
2. Merge overlapping or near-adjacent windows (≤3s gap) into one.
3. Compute `window_damage` (absolute) plus `pct_of_total` = window damage / total fight damage (kept for the ≥3% significance gate).
4. Discard windows below ≥3% significance threshold.
5. Each window: `time_s`, `window_length_s` (variable), `window_damage`, `pct_of_total`, `active_cds`, ability breakdown (top 6, each with absolute `damage`).
6. Falls back to 8s sliding window if no CD duration data.

**Across parses** (`clusterBurstWindows` → `clusterBaseStats`):
1. `groupByTime(windows, 15s)` - greedy: windows within 15s of cluster median go in same group.
2. Discard clusters in fewer than max(2, 35% of samples).
3. Surface CDs and abilities in ≥50% of member parses.
4. `window_length_s` = mean of member window lengths.
5. Emits **absolute damage** stats (`dmg_avg`/`dmg_min`/`dmg_max`/`dmg_stddev`, per-ability `avg_damage`/`min_damage`/`max_damage`) - **not** percentages. The player vs top-parse comparison and the Burst/Defensive Windows cards compare raw damage so the numbers stay meaningful on progression (a wipe's short fight-total would otherwise inflate every window's share). `top_dtk_comparison` (the separate Damage Taken card) still uses percentages.

### Defensive window definition (`ingest.mjs` → `findDefensiveWindows` / `clusterDefensiveWindows`)

**Per-parse**:
1. For each defensive in rulebook, find buff apply/remove pairs matching its `spell_id`.
2. Each apply→remove pair = window: `time_s` = apply, `window_length_s` = remove - apply.
3. `window_damage` = damage taken during window (absolute); `pct_of_total` = that / total fight damage taken (kept on the sample).

**Across parses** (`clusterDefensiveWindows` → `clusterBaseStats`):
1. Group by defensive name first.
2. `groupByTime(group, 20s)` per defensive.
3. Discard clusters in fewer than max(2, 35% of samples).
4. Each cluster: `defensive_name`, `spell_id`, `window_length_s`, absolute damage stats (`dmg_avg`/`dmg_min`/`dmg_max`/`dmg_stddev`), ability breakdown of damage sources (absolute `avg_damage`).

Both cluster functions share `groupByTime()` and `clusterBaseStats()` helpers.

### Remaining static values

| Value | Location | Notes |
|---|---|---|
| `bl_time - 30` to `bl_time + 55` BL window | `ingest.mjs` | BL duration (40s) + 15s grace. Defines what we measure - not worth deriving from data. |

### Built

| Feature | Notes |
|---|---|
| Guide ingestion → LLM → rulebook | `scrape.mjs` + `admin.mjs`; copy-prompt / paste-back workflow |
| Deterministic rules engine | `cast_without_prior`, `hold_cooldown_for_anchor` |
| Cooldown analysis | Lost casts, BL alignment, opener delay, held CDs, hold suggestions, cast efficiency |
| Top-parse comparison | Uses/min normalization; per-CD first cast comparison |
| Burst window analysis | CD-cast-centric, variable count + length, candle diagrams |
| Defensive analysis | Per-defensive lost/held/suggestions; buff-window-centric defensive windows |
| Pre-fight gear check | Talents, trinkets, enchants vs top-parse aggregates (all client-side WCL queries) |
| Hold pattern detection | Per-cast-index hold targets; "Timing Suggestions" section |
| Fight dropdown with attempt numbering | Wipes `✗ #N`, kills `✓` |
| GHA ingestion pipeline | Daily + manual; commits `frontend/public/data/specs/**` |
| GitHub Pages deployment | `deploy-pages.yml`; builds with `--base-href /warcraft-learner/` |
| Angular 22 SPA | Replaced old vanilla JS; fully client-side; no backend |
