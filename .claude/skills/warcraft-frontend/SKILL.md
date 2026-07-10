---
name: warcraft-frontend
description: warcraft-learner project Angular conventions - hard rules for all Angular/TypeScript code in frontend/src. Covers Material + Tailwind styling, the no-hardcoded-colors rule, template-owns-styling, all-formatting-through-pipes, get*/GraphQL-string API service rules, polling/async state, the ESLint-enforced conventions, the lint setup, and the shared index.html head (CSP, font/icon subsetting, loaded font weights, deferred tooltips). Load this before editing or creating anything under frontend/src (components, templates, services, pipes, index.html). Pairs with the generic angular-developer skill; on conflict these project rules win.
---

# warcraft-learner frontend conventions

These are hard rules for all Angular code. The `angular-developer` skill (`.claude/skills/angular-developer`) captures the broader Angular/TypeScript best practices - use it together with this one when building or refactoring components. Where the two differ, these project rules win.

## Styling and components

- **Styling: Angular Material components + minimal TailwindCSS utilities only.** Component styling is pure Tailwind utilities with no per-component style files (no `styleUrl`, no inline `styles:` arrays). The project has exactly one stylesheet and zero `.css` files: a single global `frontend/src/styles.scss` that holds the Angular Material `mat.theme()` mixin (no plain-CSS equivalent), the `mat.*-overrides()` token mixins that restyle Material with the app tokens, the design tokens, and the semantic classes (`badge-*`, `fill-*`, `seg-*`, `icon-*`, `chip-onplan`). Angular compiles it through its built-in Sass support. Components should have no `styleUrl`/`styles` unless there is no other option. Use Material building blocks (`mat-card`, `mat-chip-set`/`mat-chip`, `mat-divider`, `mat-icon`, `mat-button`, ...) for structure, and Tailwind utility classes for layout/spacing. Theme colors come from the CSS custom properties in `styles.scss` via arbitrary values, e.g. `text-[var(--muted)]`, `border-[var(--border)]`. Status glyphs reuse the global `badge-success` / `badge-warning` / `badge-info` / `badge-critical` classes on a `mat-icon`. Look at `pages/post-raid/post-raid.html` and `shared/components/window-comparison` for the reference style.
- **Restyling Material goes through tokens, never `!important` or plain utilities.** Angular Material injects its component styles **unlayered**, while Tailwind v4 emits every utility inside `@layer utilities`; unlayered CSS beats layered CSS regardless of specificity, so a plain utility silently does nothing whenever Material sets the same property on the same element (e.g. `h-[18px]` on a `mat-icon`). Do not fight this with `!`/`!important`. Instead: (a) theme-wide looks go through the `mat.*-overrides()` token mixins in `styles.scss` (`mat.card-overrides`, `mat.toolbar-overrides`, ...); (b) mat-icon sizes use the global `mat-icon.icon-16` / `icon-18` / `icon-seg` classes (element+class specificity outranks Material's `.mat-icon` rule without `!important`). Icon buttons (`mat-icon-button`) stay at Material's default size - do not shrink them with a custom size override. Utilities on Material hosts are fine for properties Material does not set (margins, flex sizing, width on form fields).
- **No hardcoded colors anywhere - ever.** Never write a hex (`#3fb950`), `rgb()`/`rgba()`, or named CSS color in a component TS file, template, or constant. There is exactly one source of color truth: the design tokens in `styles.scss` (`--success`, `--warning`, `--critical`, `--info`, `--muted`, `--border`, `--surface`, `--bg`, `--gold`, `--accent`, `--text`). Use them via Tailwind arbitrary values (`text-[var(--success)]`, `bg-[var(--critical)]/55`, `border-[var(--border)]`) or the global `badge-*` classes. Do **not** declare local `const COLOR_GOOD = '#3fb950'` maps or `Record<Status, string>` hex/rgba lookups - they duplicate tokens that already exist. Canvas / imperative-draw components (the positioning map) that genuinely cannot consume `var(--token)` read the tokens at draw time via `getComputedStyle(...).getPropertyValue('--x')` - and carry **no hardcoded hex/rgba, not even as a fallback** (see the `token()` helper in `map-canvas.ts`).
- **Component TS never produces CSS classes or style strings; the template owns all styling.** A `computed()`/field must **never** return a CSS class name, a `badge-*`/`text-[var(--…)]` string, or a `Record<Status, classString>` map. It exposes **semantic state only** - a status enum (`'success' | 'warning' | 'critical' | 'muted'`), a raw number, or a boolean. The **template** maps that state to classes with a bracket-free `[class.badge-success]="status() === 'success'"` binding (or `@if`/`@switch`). Note `[class.x]` cannot toggle a Tailwind arbitrary-value class (`bg-[var(--success)]/55`) because of the brackets; when a status needs a token-driven multi-property look, add a **semantic class to `styles.scss`** (the `badge-*` / `fill-*` / `seg-*` family) and toggle it by name - the class definition lives in the one stylesheet, the *choice* lives in the template, and the component only emits the enum. `shared/components/compact-ability-row` and `shared/components/window-comparison` are the reference examples. **Static, non-conditional `host: { class: '…' }` strings are allowed** (idiomatic Angular host styling, e.g. `page-nav`, `game-icon`) but must contain no hardcoded colors and no conditional logic.
- **Never build inline `style` strings in component TS.** No `computed()` returning `` `left:${x}%;background:${c};border:1px solid ${c}` ``, and no `[style]="someStringExpr"` in templates. For genuinely dynamic numeric geometry (a percentage width, a computed `left`), expose the **raw number** from the `computed()` and bind a single CSS property: `[style.width.%]="widthPct()"`, `[style.left]="leftValue()"`. Everything else (colors, borders, opacity, sizing) is a Tailwind class. Tailwind v4 supports opacity on token colors via `bg-[var(--success)]/55`.
- **Layout/structure lives in the template, not in TS.** Never compute Tailwind layout class strings in a `computed()` (e.g. `gridCols = computed(() => 'grid-cols-[1fr_6rem_6rem]')`). Express conditional column counts with `@if` around the cells and fixed-width utilities (`flex-1`, `w-20`, `w-24`) directly in the template. When a child row and a parent header must align, mirror the **same literal widths** in both templates and add a comment on each pointing at the other - do not centralize them through a TS string.
- **Use an external `templateUrl` file for any component beyond a trivial handful of elements.** Inline `template:` strings are only for tiny (roughly <10-line) markup. A table row, a card, or anything with multiple `@if`/`@for` branches gets its own `.html` file next to the `.ts` (CLAUDE's inline-template note is for genuinely small components; readability wins for anything larger).
- **All formatting goes through Angular pipes**, never ad-hoc string building in component TS. Durations -> `FormatDurationPipe` (`formatDuration`), compact damage -> `FormatDamagePipe` (`formatDamage`), decimals -> the built-in `DecimalPipe` (`number`), spec names -> `FormatSpecPipe`. View-model `computed()`s should expose **raw numeric values**; the template formats them. Add a new shared pipe under `shared/pipes/` rather than formatting inline.
- Time windows are rendered as a `m:ss - m:ss` range (start to end), matching the live/post pages.

## API service conventions

- **`get*` verb for all network methods.** Never `fetch*`, noun-first (e.g. `charLookup`), or other inconsistent prefixes. Examples: `getReport`, `getUserCharacters`, `getCharacter`, `getCharGear`.
- **GraphQL query strings live in `core/services/wcl-queries.ts` only.** Never inline a query string inside a method. Each query must have a companion `*Vars` interface (e.g. `ReportQueryVars { code: string }`). Never use `Record<string, unknown>` as the variables type - use the typed interface.
- **Response-to-model mapping lives in the consuming slice/shell, not the transport.** `wcl-api.ts` is pass-through: it calls `query(...)` and returns the raw WCL shape (typed in `core/models/wcl.models.ts`). Each slice/shell colocates the small pure projection it needs (e.g. `toParseRankings`, `extractGear`, `specOf`). There is no runtime `wcl-mappers.ts`.
- **No silent error swallowing.** Any `catch` on a best-effort operation must call `logWarn(context, err)` from `core/log.ts` before discarding the error. This applies to `.catch(() => {})`, empty `catch {}` blocks, and any fallback that silently substitutes a default. The best-effort fallback itself is fine (e.g. returning `[]`); the silence is not.

## Polling and async state conventions

- **Live-sync / polling orchestration belongs in a service, not a component.** Timer and visibility machinery lives in `LiveReportSyncService` (see `core/services/live-report-sync.ts`). Components wire up polling declaratively: `combineLatest + switchMap + exhaustMap + takeUntilDestroyed`. No manual `Subscription` field or `_pollSub?.unsubscribe()` juggling in components.
- **No imperative subscription management alongside `takeUntilDestroyed`.** Pick one teardown strategy: either a stored `Subscription` unsubscribed in `ngOnDestroy`, or `takeUntilDestroyed(destroyRef)` in an RxJS chain. Do not mix both in the same pipeline.

## Angular/TypeScript conventions

These are the general Angular/TypeScript best practices for the app. The mechanizable ones are **enforced by ESLint** (`frontend/eslint.config.js`, run via `npm run lint`); the rest is **not lintable** but still expected:

- **Prefer type inference** when the type is obvious; use strict type checking.
- **Signals for state**: `signal()` for local state, `computed()` for derived state, `set`/`update` never `mutate`. Keep state transformations pure and predictable.
- **`input()`/`output()` functions** over the `@Input`/`@Output` decorators. Reactive forms over template-driven. `class`/`style` bindings over `ngClass`/`ngStyle` (the styling rules above already require this).
- **`NgOptimizedImage` for static images** (it does not work for inline base64). Templates stay simple - push complex logic into the component.
- Prefer inline `template:` only for genuinely tiny components; anything larger gets an external `templateUrl` (see the inline-template rule above). External templates/styles use paths relative to the component TS file.

## Linting

`npm run lint` (see CLAUDE.md) runs ESLint over both trees: `ng lint` covers `src/**` and a second `eslint scripts` pass covers the Node `scripts/**`. Both share the one `frontend/eslint.config.js`, which is the source of truth for the pinned convention rules and their deliberate option tweaks (each explained in an inline comment) - read it there rather than duplicating the list here. The config is split into per-`files` blocks: a base TypeScript block for `**/*.ts` (recommended + stylistic rules), an Angular block scoped to `src/**/*.ts` (component/directive selectors, `prefer-*` rules, inline-template processor), and a `scripts/**/*.{js,mjs}` block for the plain-Node ingest file server + headless harness that declares their Node globals and keeps `console` allowed since it is their user-facing output.

## index.html head

`frontend/src/index.html` is the one shell every build configuration ships, so its `<head>` is kept minimal and every entry below has a reason to be there. Keep these in sync with the app when the relevant surface changes.

### Content-Security-Policy (meta tag)

The app has no backend, so the policy is tight. Each directive lists exactly what it needs and why (the host allowlist mirrors the external-API catalog in **warcraft-wcl-data**):

- `default-src 'self'` - the baseline everything else narrows from.
- `script-src 'self' https://wow.zamimg.com` - own bundle plus the Wowhead `tooltips.js` CDN.
- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://wow.zamimg.com` - `'unsafe-inline'` is required because Angular and Angular Material inject `<style>` blocks at runtime (the standard, unavoidable Angular CSP concession); `wow.zamimg.com` is where `tooltips.js` link-injects its `universal.css`.
- `font-src 'self' https://fonts.gstatic.com` - the subset Google Fonts woff2 files.
- `img-src 'self' data: https://wow.zamimg.com https://assets.rpglogs.com` - zamimg spell/item icons plus `assets.rpglogs.com`, which serves the per-encounter boss icons (see `shared/boss-icon.ts`).
- `connect-src 'self' http://localhost:3000 https://www.warcraftlogs.com https://www.wowhead.com https://nether.wowhead.com` - the WCL API plus the wowhead hosts `tooltips.js` XHRs tooltip data from. `http://localhost:3000` is the ingest configuration's file server, listed because every configuration shares this one index; the runtime never calls it.
- `media-src 'self' blob:` - `blob:` lets the recording flyover play a MediaSource-assembled clip from the in-browser rolling buffer (nothing remote).
- `base-uri 'self'`, `object-src 'none'` - lockdown defaults.

`frame-ancestors` and `report-uri` are intentionally absent: a meta-tag CSP ignores them.

### Material Symbols - subset by ligature

The Material Symbols Outlined stylesheet is requested with an explicit `icon_names=` list, so Google serves only the glyphs the app renders (the full variable font is ~312 kB for ~17 icons). Keep `icon_names` in sync with every `<mat-icon>` ligature in the templates and every status-icon literal the view-models emit (burst / defensive / gear / finding-table / window-comparison / map / nav). `display=block` hides a glyph until the font loads, so a raw ligature name never flashes as text.

### Schibsted Grotesk - style within the loaded weights

The Google Fonts request loads weights **400, 500, 600** only. Those cover the body default and Material typography (400), Tailwind `font-medium` (500), and `font-semibold` (600). Stay within them when styling text: `font-bold` (700) is not loaded, so it renders as synthetic ("faux") bold rather than a real face - use `font-semibold` for emphasis instead. Adding a heavier weight means adding it to the `wght@` list (an extra woff2 download), so prefer reusing a loaded weight.

### Wowhead tooltips - on-demand progressive enhancement

`index.html` does not load the Wowhead scripts. `WowheadTooltipsService` injects `wh-tooltips-config.js` then zamimg `tooltips.js` the first time a Wowhead link renders (`wl-game-icon` calls `ensureLoaded()` from an `afterNextRender`); it is idempotent and `tooltips.js` self-observes the DOM, so one injection covers every later link. This keeps ~100 kB of tooltip CSS/JS off pages with no spell/item links.
