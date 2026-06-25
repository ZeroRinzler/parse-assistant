# warcraft-learner

A web-based diagnostic tool for Mythic WoW raiders. It fetches combat data from Warcraft Logs, evaluates it against spec-specific rulebooks (AI-generated from guides), and delivers prescriptive, coaching-style feedback with comparison against top-parse players.

The app is a **fully static Angular SPA** deployed on GitHub Pages. There is no backend server. All analysis runs client-side. WCL is queried directly from the browser via PKCE OAuth2.

## Branding & naming

- **The product name is always `warcraft-learner`** - lowercase, hyphenated, exactly that casing. Never "Warcraft Learner", "WarcraftLearner", or any other variant. This applies to the page `<title>`, nav wordmark, CLI banners, READMEs, and any new user-facing copy.
- **Do not confuse it with "Warcraft Logs"** (a.k.a. WCL) - that is the external data provider, a separate product. Leave "Warcraft Logs" / "WCL" strings as-is; only our own app name is normalized to `warcraft-learner`.
- **Logo / favicon** - a gold shield with an ascending bar chart (martial "Warcraft" + the analytics/"learner" angle). Single source of truth: `frontend/public/favicon.svg`. It also drives the `.ico` and the nav-bar mark.
  - `favicon.ico` is **regenerated from** `favicon.svg` (16/32/48px) - do not hand-edit the binary. Regen with `sharp` + `png-to-ico` (rasterize the SVG at high density, resize to each size, pack into one `.ico`).
  - `index.html` references the SVG favicon first (`type="image/svg+xml"`) with the `.ico` as legacy fallback.
  - The nav-bar logo (`shared/components/page-nav`) is the **same artwork inlined as SVG** in the template, so it themes with CSS vars. Set its fills via Tailwind utility classes (`fill-[var(--gold)]` / `fill-[var(--surface)]`) - **not** `fill="var(--…)"` presentation attributes, which browsers don't reliably honor.
  - Brand gold is `--gold` (`#e5cc80`) - the Warcraft Logs 100-parse ("Astounding") gold, chosen deliberately since the tool benchmarks against top parses. The favicon's literal hex colors must track the design tokens in `styles.scss`.

## Analysis design principles

- **All findings are bench-driven; always assume complete ingested data.** Every analysis finding derives from the top-parse bench data for the specific encounter+spec. Do not add fallbacks, null guards, or special-case code for missing bench data - if data is absent that is an ingestion problem, not an analysis problem. This applies to lost-cast detection, held-past-reset, opener delay, and any future findings.

## Writing style

- **Never use em-dashes (U+2014) or en-dashes (U+2013)** anywhere - not in docs, code comments, commit messages, UI copy, or generated output. Also avoid the Unicode minus (U+2212). Use a plain ASCII hyphen (`-`) for ranges and parenthetical asides, or rephrase. This applies to every file in the repo and any text the tooling emits.

## Frontend conventions

These are hard rules for all Angular code. The `angular-developer` skill (`.claude/skills/angular-developer`) captures the broader Angular/TypeScript best practices - use it when building or refactoring components.

- **Styling: Angular Material components + minimal TailwindCSS utilities only.** Component styling is pure Tailwind utilities with no per-component style files (no `styleUrl`, no inline `styles:` arrays). The project has exactly one stylesheet and zero `.css` files: a single global `frontend/src/styles.scss` that holds the Angular Material `mat.theme()` mixin (no plain-CSS equivalent), the design tokens, the `.mat-mdc-*` DOM overrides, and the `badge-*` classes. Angular compiles it through its built-in Sass support. Components should have no `styleUrl`/`styles` unless there is no other option. Use Material building blocks (`mat-card`, `mat-chip-set`/`mat-chip`, `mat-divider`, `mat-icon`, `mat-button`, ...) for structure, and Tailwind utility classes for layout/spacing. Theme colors come from the CSS custom properties in `styles.scss` via arbitrary values, e.g. `text-[var(--muted)]`, `border-[var(--border)]`. Status glyphs reuse the global `badge-success` / `badge-warning` / `badge-info` / `badge-critical` classes on a `mat-icon`. Look at `pages/post-raid/post-raid.html` and `shared/components/window-comparison` for the reference style.
- **No hardcoded colors anywhere - ever.** Never write a hex (`#3fb950`), `rgb()`/`rgba()`, or named CSS color in a component TS file, template, or constant. There is exactly one source of color truth: the design tokens in `styles.scss` (`--success`, `--warning`, `--critical`, `--info`, `--muted`, `--border`, `--surface`, `--bg`, `--gold`, `--accent`, `--text`). Use them via Tailwind arbitrary values (`text-[var(--success)]`, `bg-[var(--critical)]/55`, `border-[var(--border)]`) or the global `badge-*` classes. Do **not** declare local `const COLOR_GOOD = '#3fb950'` maps or `Record<Status, string>` hex/rgba lookups - they duplicate tokens that already exist. Canvas / imperative-draw components (`range-chart`, `positioning-map`) that genuinely cannot consume `var(--token)` read the tokens at draw time via `getComputedStyle(...).getPropertyValue('--x')` - and carry **no hardcoded hex/rgba, not even as a fallback** (see the `token()` helper in `range-chart.ts`).
- **Component TS never produces CSS classes or style strings; the template owns all styling.** A `computed()`/field must **never** return a CSS class name, a `badge-*`/`text-[var(--…)]` string, or a `Record<Status, classString>` map. It exposes **semantic state only** - a status enum (`'success' | 'warning' | 'critical' | 'muted'`), a raw number, or a boolean. The **template** maps that state to classes with a bracket-free `[class.badge-success]="status() === 'success'"` binding (or `@if`/`@switch`). Note `[class.x]` cannot toggle a Tailwind arbitrary-value class (`bg-[var(--success)]/55`) because of the brackets; when a status needs a token-driven multi-property look, add a **semantic class to `styles.scss`** (the `badge-*` / `fill-*` / `seg-*` family) and toggle it by name - the class definition lives in the one stylesheet, the *choice* lives in the template, and the component only emits the enum. `shared/components/compact-ability-row` and `shared/components/window-comparison` are the reference examples. **Static, non-conditional `host: { class: '…' }` strings are allowed** (idiomatic Angular host styling, e.g. `page-nav`, `callout`) but must contain no hardcoded colors and no conditional logic.
- **Never build inline `style` strings in component TS.** No `computed()` returning `` `left:${x}%;background:${c};border:1px solid ${c}` ``, and no `[style]="someStringExpr"` in templates. For genuinely dynamic numeric geometry (a percentage width, a computed `left`), expose the **raw number** from the `computed()` and bind a single CSS property: `[style.width.%]="widthPct()"`, `[style.left]="leftValue()"`. Everything else (colors, borders, opacity, sizing) is a Tailwind class. Tailwind v4 supports opacity on token colors via `bg-[var(--success)]/55`.
- **Layout/structure lives in the template, not in TS.** Never compute Tailwind layout class strings in a `computed()` (e.g. `gridCols = computed(() => 'grid-cols-[1fr_6rem_6rem]')`). Express conditional column counts with `@if` around the cells and fixed-width utilities (`flex-1`, `w-20`, `w-24`) directly in the template. When a child row and a parent header must align, mirror the **same literal widths** in both templates and add a comment on each pointing at the other - do not centralize them through a TS string.
- **Use an external `templateUrl` file for any component beyond a trivial handful of elements.** Inline `template:` strings are only for tiny (roughly <10-line) markup. A table row, a card, or anything with multiple `@if`/`@for` branches gets its own `.html` file next to the `.ts` (CLAUDE's inline-template note is for genuinely small components; readability wins for anything larger).
- **All formatting goes through Angular pipes**, never ad-hoc string building in component TS. Durations -> `FormatDurationPipe` (`formatDuration`), compact damage -> `FormatDamagePipe` (`formatDamage`), decimals -> the built-in `DecimalPipe` (`number`), spec names -> `FormatSpecPipe`. View-model `computed()`s should expose **raw numeric values**; the template formats them. Add a new shared pipe under `shared/pipes/` rather than formatting inline.
- Time windows are rendered as a `m:ss - m:ss` range (start to end), matching the live/post pages.
- **Spells and items render through the shared `wl-game-icon` component** (`shared/components/game-icon`), never ad-hoc text or `<img>`. Spell art comes from the `IconCacheService` (seeded from a report's `masterData.abilities`); item art is passed explicitly via the `icon` input (from WCL combatant-info gear). Pages with no report context (e.g. `/pre`) opportunistically seed the cache from the logged-in user's most recent report (best-effort; names render without art if unavailable).
- **`wl-game-icon` already renders both the icon and the name** (as a Wowhead link). Never place a separate `{{ label }}`/name `<span>` next to a `wl-game-icon` for the same spell/item - that double-prints the name. Render `<wl-game-icon [id]="...">` alone; use a plain `<span>` label **only** as the fallback when there is no `spellId`/`id` to give the icon component.

### API service conventions

- **`get*` verb for all network methods.** Never `fetch*`, noun-first (e.g. `charLookup`), or other inconsistent prefixes. Examples: `getReport`, `getUserCharacters`, `getCharacter`, `getCharGear`.
- **GraphQL query strings live in `core/services/wcl-queries.ts` only.** Never inline a query string inside a method. Each query must have a companion `*Vars` interface (e.g. `ReportQueryVars { code: string }`). Never use `Record<string, unknown>` as the variables type - use the typed interface.
- **Response-to-model mapping lives in `core/services/wcl-mappers.ts`.** Pure functions with no Angular/HTTP dependencies. The transport service (`wcl-api.ts`) calls `query(...)` and then a mapper - it does not contain domain logic.
- **No silent error swallowing.** Any `catch` on a best-effort operation must call `logWarn(context, err)` from `core/log.ts` before discarding the error. This applies to `.catch(() => {})`, empty `catch {}` blocks, and any fallback that silently substitutes a default. The best-effort fallback itself is fine (e.g. returning `[]`); the silence is not.
- **No single-letter identifiers for non-trivial values.** `d`, `fd`, `p`, `r`, `e` as local variable names are banned where the value has semantic content. Name by content: `result`, `fightsData`, `enchantData`, `queryParams`, `reportParam`. Short lambda params (`f`, `c`) in obvious inline callbacks (e.g. `.find(f => f.id === id)`) are acceptable.

### Polling and async state conventions

- **Live-sync / polling orchestration belongs in a service, not a component.** Timer and visibility machinery lives in `LiveReportSyncService` (see `core/services/live-report-sync.ts`). Components wire up polling declaratively: `combineLatest + switchMap + exhaustMap + takeUntilDestroyed`. No manual `Subscription` field or `_pollSub?.unsubscribe()` juggling in components.
- **No imperative subscription management alongside `takeUntilDestroyed`.** Pick one teardown strategy: either a stored `Subscription` unsubscribed in `ngOnDestroy`, or `takeUntilDestroyed(destroyRef)` in an RxJS chain. Do not mix both in the same pipeline.

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
Spec + encounter selector; all data is static (ingested bench data), no character or log required.

| Param | Description |
|---|---|
| `spec` | WCL spec name (e.g. `SubtletyRogue`) |
| `encounter` | Encounter ID |

Example: `/pre?spec=SubtletyRogue&encounter=3144`

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
│   │       │   ├── analysis-engine.ts     # Orchestrates fetch + worker dispatch
│   │       │   ├── live-report-sync.ts    # Polling timer / visibility service
│   │       │   ├── encounter.ts           # Loads static JSON bench/rulebook files
│   │       │   ├── wcl-api.ts             # WCL transport (thin: query + mappers)
│   │       │   ├── wcl-queries.ts         # GraphQL strings + typed *Vars interfaces
│   │       │   ├── wcl-mappers.ts         # Pure response-to-model mapping functions
│   │       │   └── wcl-auth.ts            # PKCE OAuth2 flow
│   │       └── models/                    # TypeScript interfaces
│   ├── public/
│   │   └── data/specs/         # Static data files - served as assets
│   │       ├── index.json              # Spec manifest: [{spec, encounter_count}] (generated by ingest.mjs)
│   │       └── {Spec}/
│   │           ├── rulebook.json       # AI-generated rulebook
│   │           ├── guides.json         # Guide list with scraped content
│   │           ├── encounters.json     # Index: [{id, name, sample_count}]
│   │           ├── encounters/
│   │           │   └── {enc_id}.json  # Pre-computed bench data
│   │           ├── parse_samples/
│   │           │   └── {enc_id}.json  # Raw parse samples
│   │           └── positions/
│   │               └── {enc_id}.json  # Top-parse position timelines (map feature)
│   └── scripts/                # Node.js CLI tools (no server needed)
│       ├── ingest.mjs   # Fetch top WCL parses → write bench + sample files
│       ├── admin.mjs    # Rulebook management (build prompt, save AI output)
│       └── scrape.mjs   # Add + scrape guide URLs
├── prompts/
│   └── rulebook_skill.md       # LLM prompt template for rulebook generation
├── .github/workflows/
│   ├── deploy-pages.yml   # Build Angular --base-href /warcraft-learner/ → GitHub Pages
│   └── ingest-parses.yml  # Daily + manual: runs ingest.mjs, commits data/specs/**
```

**Data location**: `frontend/public/data/specs/` - Angular's `public/` directory serves these at `/data/specs/` in both the dev server and the built app.

**Build output** (`static/angular/`) is gitignored - rebuilt by `deploy-pages.yml` on every push to `main`.

## Key flows

### Analysis fetch/compute boundary (intentional design)

WCL event fetching runs on the **main thread** through the `AnalysisDataSource` seam (`core/analysis/analysis-data-source.ts`). The analysis Web Worker (`core/services/analysis.worker.ts`) receives only fully-assembled, already-fetched `AnalysisInput` and runs the pure `computeAnalysis()` function - it has no Angular DI, no `HttpClient`, and no network access.

**Do not move fetching into the worker.** The seam was deliberately designed to keep the worker pure and to make the fetch-side testable without `TestBed`. Moving fetching in would require reimplementing auth/token handling with raw `fetch` inside the worker - a large, risky redesign with no functional benefit for this app's payload sizes.

### Player analysis (client-side, `analysis-engine.ts`)
1. Accepts a WCL report code + fight ID + player actor ID.
2. Fetches `playerDetails` to resolve spec (`SubtletyRogue`) - the reliable source since the Midnight `actor.subType` change (see WCL API quirks).
3. Fetches `Casts`, `Buffs`, `DamageDone`, and `DamageTaken` events directly from WCL (PKCE token).
4. Loads static bench data from `/data/specs/{spec}/encounters/{enc_id}.json` and rulebook from `/data/specs/{spec}/rulebook.json`.
5. `analysis-engine.ts` checks per offensive cooldown:
   - **Lost casts** - `expected = 1 + floor(fight_duration / cd_cooldown)` vs actual.
   - **Bloodlust alignment** - flags major CDs whose BL-window cast timing is >2σ from top-parse average. Falls back to binary in/out-of-window check.
   - **First-cast delay** - flags opener CDs whose first cast is >2σ later than `avg_first_cast_s`. Always runs when a bench entry exists.
   - **Held past reset** - gap between casts >2σ above `avg_gap_s`. Skipped when `avg_gap_s` is null (CD legitimately single-cast across all top parses).
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
11. **Gear comparison** - after analysis completes, `post-raid.ts` fetches the selected player's gear via `getCharGear(player.name, player.server, reportRegion, encounterID)`. The report region (added to `REPORT_Q` as `region{slug}`) is shared by all players in the log, so gear lookup works for any raider - not just the logged-in account's own characters. Falls back gracefully (bench-only view) when the character has no ranked kills for the encounter.

### Ingestion (`npm run ingest`)
Runs `frontend/scripts/ingest.mjs`. Also runs as `ingest-parses.yml` GHA daily + manually.

1. Authenticates to WCL with client credentials (from `WCL_CLIENT_ID`/`WCL_CLIENT_SECRET` environment variables - server-side secret, only used in GHA, never in the browser).
2. Queries `characterRankings` for each boss to find top 10 parses.
3. Fetches `Casts`, `Buffs`, `DamageDone`, `DamageTaken` per parse.
4. Computes per-parse: CD timing summaries, `burst_windows` (CD-cast-centric), `defensive_windows` (buff-window-centric), talent key, trinkets, enchants.
5. Writes raw samples → `parse_samples/{enc_id}.json`.
6. Aggregates across parses → `encounters/{enc_id}.json` (bench file: per-CD thresholds, clustered burst/defensive windows, gear aggregates).
7. Writes per-parse position timelines (ranked player + notable enemies, resampled) → `positions/{enc_id}.json` for the positioning map. Requires `includeResources`/`hostilityType` event fetches (see WCL API quirks).
8. Updates `encounters.json` index.

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
4. A unified gear card rendered client-side (shared `wl-gear-section` in bench-only mode):
   - **Talents** - compares player's `v2:` talent fingerprint against top-parse distribution.
   - **Trinkets** - per-slot (12 = Trinket 1, 13 = Trinket 2) comparison.
   - **Enchants** - per-slot; missing enchants on high-consensus slots (>=70% of top parsers) flagged as warnings.

### Encounter selection
Encounters loaded from `/data/specs/{spec}/encounters.json` (static file). Filtered client-side to:
- Current expansion only (first unique expansion name in WCL API response - WCL returns newest first).
- Excludes zones matching: `beta`, `ptr`, `mythic+`, `complete raids`, `delves`, `torghast`.

## Data models

### `index.json` (`frontend/public/data/specs/index.json`)
Spec manifest written by `ingest.mjs` `writeSpecIndex()` at the end of each spec ingestion. Rebuilt by scanning all spec folders on disk - safe to run sharded (one spec at a time). Consumed by `EncounterService.getSpecs()` to populate the spec dropdown on `/pre`.

| field | notes |
|---|---|
| spec | WCL spec folder name, e.g. `SubtletyRogue` |
| encounter_count | Number of encounters with `sample_count > 0` |

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

### `positions/{enc_id}.json`
Per-parse position timelines for the positioning map (written by `ingest.mjs` `buildParsePositions`/`savePositions`; consumed by `core/services/positioning-core.ts` + `core/models/positioning.models.ts`). Top-level: `{spec, encounter_id, encounter_name, interval_s, sample_count, parses[]}`. Each parse: `{report_code, fight_id, player_name, duration_s, interval_s, player: PosRow[], enemies: [{game_id, name, is_boss, samples: PosRow[]}]}`. A `PosRow` is `[t_s, x, y, facing|null, mapID|null]` with **raw** WCL units (x/y in hundredths of a yard, facing in milliradians) - the frontend scales them. Enemies are keyed by `game_id` so the same boss/add matches across parses; `is_boss` = the enemy with the highest `maxHitPoints`.

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
| **Event positions need `includeResources: true`** | The default `events` response carries no coordinates. Passing `includeResources: true` attaches the actor's resource snapshot, which includes position. Adds bandwidth, so it is off by default and only requested by the positioning feature. |
| **Position is flattened onto the event, not nested** | With resources on, `x`, `y`, `facing`, `mapID` (plus `hitPoints`, etc.) appear at the **top level** of the event - there is no `sourceResources`/`targetResources` object. Each event describes **one** actor; `resourceActor` says which (`1` = source, `2` = target). Attribute the coords to `resourceActor === 2 ? targetID : sourceID`. |
| **Events default to friendly only** | The `events` query defaults to `hostilityType: Friendlies`, so an all-source `Casts` fetch returns only the raid. Boss/add casts (and their positions) require a separate fetch with `hostilityType: Enemies`. |
| **Position/facing units** | `x`/`y` are in hundredths of a yard (`÷100` → yards). `facing` is in milliradians (`÷1000` → radians) and its zero-point does not match a screen "up" axis - apply a `-π/2` offset so "behind the boss" renders behind (see `FACING_OFFSET_RAD` in `positioning-core.ts`). |
| **`mapID` marks the phase/sub-map** | Coordinates are only comparable between actors sharing a `mapID`; it changes across phases that swap maps. Filter to a common `mapID` before computing relative positions. |

## External APIs

| API | Auth | Where used |
|---|---|---|
| Warcraft Logs v2 (GraphQL, `/api/v2/user`) | PKCE OAuth2 (browser) | Report events, character rankings, gear lookup |
| Warcraft Logs v2 (GraphQL, `/api/v2/client`) | Client credentials (CLI/GHA only, never browser) | `ingest.mjs` parse fetching |

## Analysis thresholds

| Threshold | Derived from | Condition |
|---|---|---|
| First-cast delay | `avg_first_cast_s + 2σ` across top parses | Always runs when a bench entry exists (field is required, never null) |
| Gap between CD uses | `avg_gap_s + 2σ` across top parses | Skipped when null - legitimately absent for single-cast CDs (cooldown > fight length) |
| Hold suggestion trigger | Cast index where ≥40% of samples have `hold_amount_s > 8s`; fires if player casts >σ before median | None emitted when `hold_targets` is empty (no parsers held at that index) |
| Downtime gap floor | p90 of pooled `cast_gap_list_ms` | Always runs when bench exists (`downtime_threshold_ms` is required, defaults to 1500ms) |
| Efficiency warning band | <1σ below Top average → warning; deeper → critical | Always runs when bench exists (`top_avg_efficiency` / `top_efficiency_stddev` are required) |
| BL timing | `avg_bl_offset_s ± 2σ` | Skipped when null - legitimately absent when a CD is never BL-aligned |

> **Stddev is always emitted by ingestion alongside its mean** (`stdev()` returns 0 for a single sample), so all required `stddev_*` fields are always a number when the bench entry exists. The gap and BL-offset fields (`avg_gap_s`, `stddev_gap_s`, `avg_bl_offset_s`, `stddev_bl_offset_s`) are the only nullable bench fields - they are legitimately null when the statistic does not apply (single-cast CD or CD never aligned with BL). All other bench fields are required; if they are absent that is an ingestion problem, not an analysis problem.
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
5. Emits **absolute damage** stats (`dmg_avg`/`dmg_min`/`dmg_max`/`dmg_stddev`, per-ability `avg_damage`/`min_damage`/`max_damage`) - **not** percentages. The player vs top-parse comparison and the Burst/Defensive Windows cards compare raw damage so the numbers stay meaningful on progression (a wipe's short fight-total would otherwise inflate every window's share).

### Defensive window definition (`ingest.mjs` → `findDefensiveWindows` / `clusterDefensiveWindows`)

**Per-parse**:
1. For each defensive in rulebook, find buff apply/remove pairs matching its `spell_id`.
2. Each apply→remove pair = window: `time_s` = apply, `window_length_s` = remove - apply.
3. `window_damage` = damage taken during window (absolute); `pct_of_total` = that / total fight damage taken (kept on the sample).

**Across parses** (`clusterDefensiveWindows` → `clusterBaseStats`):
1. Group by defensive name first.
2. `groupByTime(group, 20s)` per defensive.
3. Discard clusters in fewer than max(2, 35% of samples).
4. Each cluster: `defensive_name`, `spell_id`, `window_length_s`, absolute damage stats (`dmg_avg`/`dmg_min`/`dmg_max`/`dmg_stddev`), ability breakdown of damage sources (absolute `avg_damage`), and `ref_game_id` (the gameID of the enemy dealing the window's main damage - the positioning map's default reference for defensive windows). `ref_game_id` is null for burst clusters.

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
